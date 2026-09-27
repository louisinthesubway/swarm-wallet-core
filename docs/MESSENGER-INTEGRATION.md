# Putting the SWARM wallet inside SWARM Messenger (Signal-Desktop)

**Status: this is a design.** Written 2026-09-26 against the Signal-Desktop clone
at `D:\swarm-messenger\Signal-Desktop` (`abe80d324`, v8.31.0-alpha.1), which is
being rebranded by another agent. Nothing in that tree was edited to write this.
Every section below is labelled:

* **IMPLEMENTED** — exists in `swarm-wallet-core` today, tested, in CI.
* **PROPOSED** — the design. No code in the messenger yet.

Nothing in this document requires a change to libsignal, to any cryptographic
primitive, or to Signal's protocol. The messenger's own end-to-end encryption is
untouched; the wallet is a second, independent thing living in the same process
tree.

---

## 0. What the whole thing looks like

```
 ┌─ renderer (sandbox: false, contextIsolation: true) ──────────────────┐
 │  Wallet pane (NavTab.Wallet)  ──►  window.SignalContext.SwarmWallet  │
 │  In-chat payment bubble        (a thin typed client; no wallet code) │
 └──────────────────────────────────────┬───────────────────────────────┘
                                        │ ipcRenderer.invoke('swarm-wallet:*')
 ┌─ preload (ts/windows/context.preload.ts) ────────────────────────────┐
 │  Exposes the channel list and nothing else. No addon, no key.        │
 └──────────────────────────────────────┬───────────────────────────────┘
                                        │ ipcMain.handle('swarm-wallet:*')
 ┌─ main process (app/SwarmWalletService.main.ts) ───────────────────────┐
 │  swarm-wallet-core:  SwarmWallet + WalletStore + native.node         │
 │  safeStorage  ──►  32-byte wallet key  ──►  AES-256-GCM at rest      │
 │  <userData>/swarm-wallet/<ourAci>/swarm-mainnet/swarm-wallet.dat.enc │
 └──────────────────────────────────────┬───────────────────────────────┘
                                        │ gRPC over TLS
                                  lwd-main.swarm.green:8443
```

The wallet never talks to the chat server, and the chat server never sees a
wallet key, a seed, an address or a balance. A payment notice travels **inside** an
ordinary end-to-end encrypted `DataMessage`, so the server sees ciphertext, as it
does for a text message.

---

## 1. Loading the addon in the main process

**IMPLEMENTED in `swarm-wallet-core`:** `loadNativeAddon(path)` loads the binary
and refuses a module that loads but has no `init_new` — the symptom of a
wrong-architecture build, which otherwise surfaces as four unrelated
"cannot read properties of null" errors further up.

**PROPOSED for the messenger.** A new service file beside the others in `app/`,
following the repository's own suffix convention (`.main.ts` = main process only,
`.preload.ts` = preload, `.std.ts` = either, `.dom.tsx` = renderer):

```
app/SwarmWalletService.main.ts      the service: addon, key, wallet, IPC handlers
ts/types/SwarmWallet.std.ts         the shared types the renderer may see
ts/services/swarmWallet.preload.ts  the renderer-side client over IPC
ts/components/WalletPane.dom.tsx    the pane
```

### Where the binary is

Signal-Desktop bundles with rolldown into `bundles/` and packages with
electron-builder. A `.node` file inside an asar cannot be `dlopen`ed, so it has to
be unpacked — the desktop wallet does exactly this (`asarUnpack: ["build/native.node"]`),
and Electron then redirects the `require` to `app.asar.unpacked/` automatically.
So:

```jsonc
// package.json → build.asarUnpack (PROPOSED)
"asarUnpack": ["node_modules/swarm-wallet-core/native.node"]
```

```ts
// app/SwarmWalletService.main.ts (PROPOSED)
import { app } from 'electron';
import { join } from 'node:path';
import { loadNativeAddon } from 'swarm-wallet-core';

const addonPath = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'swarm-wallet-core', 'native.node')
  : join(__dirname, '..', 'node_modules', 'swarm-wallet-core', 'native.node');

const addon = loadNativeAddon(addonPath);
```

### Why the main process and not the renderer

Three reasons, all of them the desktop wallet's, learned there:

1. **The renderer must not be able to choose where the wallet is written.** The
   addon's `set_wallet_base_dir` is a `OnceCell`: the first caller in the process
   wins, for the process lifetime. The wallet calls it from main "so a compromised
   renderer cannot redirect wallet storage to an arbitrary path". Same here.
2. **The key must never enter the renderer.** `safeStorage` is main-only, and
   there is no reason for a renderer to hold 32 bytes it cannot protect.
3. **The addon blocks.** `init_new` is synchronous and dials the indexer for the
   chain tip; the promise-returning calls run on a tokio blocking pool but settle
   on the calling thread's channel. In the renderer that is a frozen window.

Signal-Desktop's **main window** is `sandbox: false` with `contextIsolation: true`,
so its preload could technically `require` a `.node`. It should not: put the
addon in main and let the preload carry nothing but `ipcRenderer.invoke`
wrappers. Every other window (`pdf`, `about`, `screenShare`, `debuglog`,
`permissions`) is `sandbox: true` and must get no wallet surface at all.

### One wallet per process

**IMPLEMENTED:** `SwarmWallet.openOrCreate` refuses a second open in the same
process, because the addon keeps one global `LightClient` and a second open would
replace the first silently.

**PROPOSED consequence for the messenger:** one linked device holds one account,
so one wallet per main process is the right shape and no multi-account work is
needed. If phase 2 ever puts two accounts in one app, the second wallet needs its
own utility process; the service should be written so that is a move, not a
rewrite (keep all addon access behind the service's own async methods).

---

## 2. The IPC surface

**PROPOSED.** Channel names are `swarm-wallet:<verb>`, matching the repository's
existing `crash-reports:get-count`, `windows-notifications:clear-all`,
`OptionalResourceService:getData` style. All are `ipcMain.handle` /
`ipcRenderer.invoke` (request/response); the two push channels are
`webContents.send`.

| Channel | Direction | Payload in | Payload out |
| --- | --- | --- | --- |
| `swarm-wallet:get-state` | invoke | — | `{ status: 'absent' \| 'locked' \| 'open', chain, encrypted, hasKey }` |
| `swarm-wallet:create` | invoke | — | `{ status: 'open' }` — **the seed is not returned** |
| `swarm-wallet:reveal-seed` | invoke | `{ confirmToken }` | `{ phrase, birthdayHeight }` |
| `swarm-wallet:restore` | invoke | `{ phrase, birthdayHeight? }` | `{ status: 'open' }` |
| `swarm-wallet:balance` | invoke | — | `{ totalZat, spendableZat, pendingZat }` as **decimal strings** |
| `swarm-wallet:addresses` | invoke | — | `{ unified: string[], transparent: string[] }` |
| `swarm-wallet:new-address` | invoke | `{ receivers? }` | `{ address }` |
| `swarm-wallet:transactions` | invoke | `{ limit?, before? }` | `WalletTransactionDTO[]` |
| `swarm-wallet:parse-address` | invoke | `{ address }` | `ParsedAddress` |
| `swarm-wallet:quote-send` | invoke | `{ to, amount, memo? }` | `{ quoteId, feeZat }` — **transmits nothing** |
| `swarm-wallet:confirm-send` | invoke | `{ quoteId }` | `{ txids, saved }` — the txids are the fact; `saved: false` means the wallet file did not follow and the pane should say the file is behind, not that the payment failed |
| `swarm-wallet:sync` | invoke | — | `{ started: true }` |
| `swarm-wallet:sync-status` | invoke | — | `SyncStatus` |
| `swarm-wallet:close` | invoke | — | `{ closed: true }` |
| `swarm-wallet:status` | send → renderer | — | `SyncStatus`, at the poll interval |
| `swarm-wallet:event` | send → renderer | — | `{ kind: 'synced' \| 'sync-error' \| 'payment-received', … }` |

Rules the service enforces, and why each one is there:

* **`bigint` does not cross IPC.** Electron's structured clone can carry a
  `BigInt`, but the renderer's redux store and React devtools cannot serialise
  one, and a silent `JSON.stringify` failure in a store is a blank pane. Amounts
  cross as **decimal zatoshi strings** and become `bigint` again on both sides.
* **`quote-send` and `confirm-send` are two channels, not one.** The quote is held
  in the main process against an opaque `quoteId`; the renderer never holds a
  proposal. A renderer that asks to confirm a `quoteId` it was not given gets
  nothing. This is the shape `swarm-wallet-core` already has
  (`proposeSend` → `SendQuote.confirm`) and it exists so a fee can be shown
  before money moves.
* **`reveal-seed` needs a token the renderer cannot mint.** PROPOSED: the main
  process shows the OS re-authentication itself — Windows Hello / Touch ID via the
  addon's own `checkWindowsHello` / `verifyWindowsUser` / `checkMacAuth` /
  `verifyMacUser`, which are in `native/` and kept deliberately (see
  `native/PROVENANCE.md`) — and only then returns the phrase. On Linux, where
  there is no such prompt, the fallback is a typed confirmation phrase, and the
  screen says which protection it has.
* **Sender validation.** Every handler checks `event.senderFrame` belongs to the
  main window, as the repository already does for its own sensitive channels.
  A sandboxed helper window must not reach the wallet.
* **No handler takes a path.** Not the wallet directory, not the addon path, not
  a file name. The service decides all three.

---

## 3. Where the wallet directory lives

**IMPLEMENTED:** `WalletStore` resolves
`<dataDir>/<chain subdirectory>/<walletName>` and hands the addon `<dataDir>`,
because the addon appends the chain subdirectory itself
(`swarm-mainnet`, `swarm-testnet`, `testnet3`, `regtest`, or nothing for Zcash
mainnet). Handing it the chain directory would produce
`…/swarm-mainnet/swarm-mainnet/…`, and there is a test for that.

**PROPOSED for the messenger:**

```
<userData>/swarm-wallet/<ourAci>/swarm-mainnet/swarm-wallet.dat.enc   ← at rest
<userData>/swarm-wallet/<ourAci>/swarm-mainnet/swarm-wallet.dat       ← only while open
```

* `<userData>` is `app.getPath('userData')`, the same root the message database
  lives in, already inside the OS-ACLed user profile. Signal-Desktop supports a
  `--user-data-dir` style override for development profiles; the wallet inherits
  it for free, which is what makes two test clients on one machine possible.
* `<ourAci>` is the account's ACI (`itemStorage.user.getCheckedAci()`). Per
  account, so relinking as a different account cannot open the previous
  account's wallet, and so the phase-2 two-account case is a directory and not a
  migration.
* The ACI is only known **after** the device is linked and storage is unlocked.
  So the wallet is opened lazily, on the first `swarm-wallet:get-state` after
  `database-ready`, and never during startup. Before that the state is
  `'absent'` and the pane shows its empty state.
* **Backups:** Signal's own backup (`ts/services/backups/`) must NOT carry the
  wallet file. A wallet in a chat backup is a seed in a chat backup. The wallet's
  own backup is the seed phrase the user wrote down, and that is the only one.
  This needs an explicit exclusion when the backup export walks `userData` —
  a line to write and a test to write with it.

---

## 4. Key handling via `safeStorage`

**IMPLEMENTED:** `WalletStore` takes a 32-byte key and seals the wallet file with
AES-256-GCM, fresh nonce per save, magic + nonce as AAD, temp-file + fsync +
rename + directory fsync on write. With no key it leaves the file in plaintext and
says so (`store.encrypted === false`). The honest limitation — **the plaintext
exists on disk while the wallet is open** — is written at the top of
`src/walletStore.ts` and is not hidden anywhere else.

**PROPOSED for the messenger.** Signal-Desktop already does exactly this dance
for the SQLCipher key in `app/main.main.ts` (`getSQLKey`), and the wallet key
should follow it rather than invent a second pattern:

```ts
// app/SwarmWalletService.main.ts (PROPOSED)
function getWalletKey(): Buffer {
  const stored = userConfig.get('swarmWalletEncryptedKey');
  if (typeof stored === 'string') {
    return Buffer.from(safeStorage.decryptString(Buffer.from(stored, 'hex')), 'hex');
  }
  const key = randomBytes(32);
  if (isEncryptionAvailable()) {
    userConfig.set('swarmWalletEncryptedKey', safeStorage.encryptString(key.toString('hex')).toString('hex'));
    return key;
  }
  // No keychain: do NOT write the key in the clear beside the ciphertext, which
  // would be encryption theatre. Run the wallet in plaintext mode and say so on
  // screen and in the log.
  return PLAINTEXT_MODE;
}
```

Four things this has to get right, and three of them are problems the messenger
already knows:

1. **`isEncryptionAvailable()` is not always true.** On Linux `safeStorage` can
   select the `basic_text` backend, which is obfuscation and not encryption;
   `getSQLKey` already refuses it. The wallet must refuse it too and fall back to
   **plaintext mode with the user told**, not to a key stored in the clear.
2. **The Linux backend can change between runs** (desktop environment, command
   line flags), and then the key will not decrypt. `getSQLKey` records
   `safeStorageBackend` and throws `SafeStorageBackendChangeError`. The wallet
   must record it the same way and, when it changes, say the wallet cannot be
   opened on this machine any more and that the seed phrase is the way back —
   **never** silently create a new wallet over it.
3. **Flatpak** can appear to encrypt on first run and fail afterwards; the
   messenger has `handleSafeStorageDecryptionError` for that. The wallet's answer
   to an undecryptable file is a screen offering restore-from-seed, never a
   delete.
4. **The key is not the seed.** Losing the key loses the *file*, not the money:
   the seed phrase restores the wallet on any device. That sentence belongs on
   the screen where the user is shown their seed, because it is the difference
   between a lost laptop and a lost fortune.

### What is protected, said plainly

| Threat | Protected |
| --- | --- |
| Stolen or lost laptop, powered off | yes — the wallet file at rest is AES-256-GCM |
| A synced folder, a Time Machine / File History copy, a disk image | yes |
| Another user account on the same machine | yes (keychain is per user) |
| A chat backup carrying the wallet | yes, by excluding it (§3) |
| Malware running as the user while the wallet is open | **no** — the plaintext is on disk and the keys are in the addon's memory |
| Malware running as the user while the wallet is closed | the file is sealed; the key is in the keychain, which is reachable by a process running as that user on most desktops |
| A filesystem that keeps old blocks (APFS, btrfs, SSD wear levelling) | **no** — `close()` overwrites the plaintext, and an overwrite is not a guarantee there |

The last two lines are why this is called "encrypted at rest" and not "secure".

---

## 5. The wallet pane in the left navigation

**PROPOSED.** Signal-Desktop's left rail is `ts/components/NavTabs.dom.tsx`, and
each destination is a `NavTab` in `ts/types/Nav.std.ts` with an
`iconClassName` and a `TabPanel`. Adding one is a small, well-trodden change:

```ts
// ts/types/Nav.std.ts (PROPOSED)
export enum NavTab {
  Chats = 'Chats',
  Calls = 'Calls',
  Stories = 'Stories',
  Wallet = 'Wallet',     // ← new, between Stories and Settings
  Settings = 'Settings',
}
```

plus a `NavTabsItem` with `iconClassName="NavTabs__ItemIcon--Wallet"` (the hive
bee mark, monochrome, per the style guide: **never with a face**), a `TabPanel`
rendering `WalletPane`, and a `Location` variant in the same file so deep links
(`tab: NavTab.Wallet, details: { page: 'receive' }`) work like the Settings ones.

### The pane, per Style Guide v2

Source of truth: `D:\privacy\Style guide\Swarm Style Guide v2.dc.html` and
`D:\privacy\privacy\Style Guide and Branding.md`. The tokens that matter here:

| | |
| --- | --- |
| Surfaces | warm black `#0A0908`; panels `#100E0C`, `#171411`, `#0C0B09` |
| Text | `#F5EFE4` primary, `#D9D1C4`, `#A89F92`, `#7D746A` |
| Brand / shielded | **Hive Orange `#FF8A1F`**; honey `#FFB020`, `#FFD08A` |
| Privacy OFF | **Clear Blue `#6FB6FF`** — and only then |
| Success / failure | `#3DD68C` / `#FF5C5C` |
| Type | Sora (display), Manrope (text), **JetBrains Mono for every amount, address and hash** |
| Amounts | ticker `SWM`; masked as `⬢⬢⬢.⬢⬢ SWM` |

Four screens, and nothing else in phase 1:

1. **Balance.** One number, Sora, JetBrains Mono digits, Hive Orange when the
   value is shielded. A tap masks it to `⬢⬢⬢.⬢⬢ SWM`. Under it the sync state as
   a sentence, not a spinner: "synced to block 12 041" / "scanning, 84%".
2. **Receive.** The `swm1…` address in JetBrains Mono, wrapped, with copy and a
   QR. A "new address" button. A line saying an address is not secret but is
   linkable, which is true and is why a new one per counterparty is offered.
3. **Send.** Address field with the pre-check's own refusal sentence shown
   inline (§7) — the one that names which network the address belongs to. Amount
   in SWM with the `parseSwm` rules (no ninth decimal, no exponent). Optional
   memo, with the 512-byte limit and the words "only the recipient can read it".
   Then **the fee, from the quote, before the confirm button is live.**
4. **Activity.** `wallet.transactions()`, newest first, signed amounts, memo
   shown when there is one, txid in JetBrains Mono linking to
   `mainnet.explore.swarm.green`.

**Not in phase 1:** the Ironwood migration surface, swap deposits, the Nym mixnet
switches and the price fetch. They exist in the addon (nothing was removed) and
the TypeScript wrapper deliberately does not expose them.

---

## 6. The in-chat payment message

**PROPOSED — none of this exists yet, in this package or in the messenger.**

### What upstream already has

`protos/SignalService.proto` carries `DataMessage.payment = 20`, and it is
MobileCoin-shaped end to end:

```proto
message Payment {
  message Amount {
    message MobileCoin { optional uint64 picoMob = 1; }
    oneof Amount { MobileCoin mobileCoin = 1; }
  }
  message Notification {
    message MobileCoin { optional bytes receipt = 1; }
    oneof Transaction { MobileCoin mobileCoin = 1; }
    optional string note = 2;
  }
  message Activation { enum Type { REQUEST = 0; ACTIVATED = 1; } optional Type type = 1; }
  oneof Item { Notification notification = 1; Activation activation = 2; }
}
```

The client side is small and already generic in the right place:
`ts/textsecure/processDataMessage.preload.ts` (`processPayment`) flattens it to
`AnyPaymentEvent` in `ts/types/Payment.std.ts`, `ts/messages/payments.std.ts`
turns that into a sentence, and `ts/components/conversation/PaymentEventNotification.dom.tsx`
renders it. Notably, **the notification's `mobileCoin.receipt` is never read** —
the rendered notice is `icu:payment-event-notification-label` and the amount
comes from the client's own MobileCoin wallet. So the seam for a SWARM variant is
exactly where it should be.

### The proposed extension

A new variant inside the existing `oneof`, taking the next free field numbers.
Nothing upstream is renumbered, and an old client that receives one falls through
`processPayment`'s final `return undefined` — it shows the message body and no
payment notice, rather than crashing.

```proto
message Payment {
  // ... Amount, Notification, Activation unchanged ...

  // PROPOSED. The SWARM payment has already happened on-chain, shielded, when
  // this message is sent. This carries only what a recipient needs in order to
  // recognise it in their own wallet — never a key, never a viewing key, never
  // anything that lets the SERVER see a payment at all, because the whole
  // DataMessage is end-to-end encrypted.
  message SwarmNotification {
    // The transaction id, 32 bytes, as a node prints it.
    optional bytes txid = 1;
    // The amount in zatoshi. 100,000,000 zatoshi = 1 SWM.
    optional uint64 amountZat = 2;
    // SHA-256 of the memo bytes that were put in the shielded output, so the
    // recipient's wallet can bind THIS notice to THAT note without the memo
    // being repeated here in a second place.
    optional bytes memoHash = 3;
    // The sender's own SWARM unified address, swm1…, so the recipient can pay
    // back without asking. Sent only when the sender chose to; optional.
    optional string senderAddress = 4;
    // Which SWARM network. The chain label, e.g. "swarm-mainnet". A notice from
    // another chain must be refused, not displayed.
    optional string chain = 5;
    // Free text the sender typed with the payment. Same role as `note` above.
    optional string note = 6;
  }

  oneof Item {
    Notification notification = 1;
    Activation activation = 2;
    SwarmNotification swarmNotification = 3;   // PROPOSED
  }
}
```

Design decisions, each with its reason:

* **The chain is in the message.** Without it, a testnet notice and a mainnet
  notice are the same bytes, and a recipient's wallet cannot refuse the wrong
  one. `swarm-wallet-core` refuses cross-network addresses already; the notice
  must be refusable the same way.
* **`amountZat` is `uint64` zatoshi and not a decimal string.** One
  representation, no locale, no rounding. The renderer formats it with
  `formatSwm`.
* **`memoHash`, not the memo.** The memo is already on-chain, encrypted to the
  recipient. Repeating it here would mean two copies with two lifetimes and a way
  for them to disagree. A hash lets the wallet say "this notice is about that
  note" and lets a mismatch be visible.
* **The notice is not the payment.** The money moved on-chain before the message
  was sent. A lost, blocked or deleted message loses the *notice*, never the
  funds — the recipient's own sync finds the note regardless. So the notice is
  presentation, and the UI must say "received" only from the wallet's own sync,
  using the notice for the memo and the sender's name. **A notice alone must
  never be rendered as money received**, or the message channel becomes a way to
  claim a payment that never happened.
* **Nothing new is unencrypted.** `DataMessage` is inside the Signal envelope,
  which is PQXDH + the sparse post-quantum ratchet. The server sees a payment
  message as it sees a "hello".

### Client work the variant needs (PROPOSED)

| File | Change |
| --- | --- |
| `protos/SignalService.proto` | the `SwarmNotification` message and the `oneof` arm |
| `ts/types/Payment.std.ts` | `PaymentEventKind.SwarmNotification` and its event type |
| `ts/textsecure/processDataMessage.preload.ts` | a branch in `processPayment`, refusing a notice whose `chain` is not this build's |
| `ts/messages/payments.std.ts` | the sentence, with the amount via `formatSwm` |
| `ts/components/conversation/PaymentEventNotification.dom.tsx` | the bubble: amount, memo, txid, and a "verify in wallet" affordance that shows the wallet's own view |
| `ts/models/messages` + a SQL migration | the stored shape, if the notice is to survive a restart with its own columns |
| `ts/services/swarmWallet.preload.ts` | binding a notice to a synced transaction by txid + memo hash |

`build:protobuf` (`@indutny/protopiler`) regenerates
`ts/protobuf/compiled.std.{js,d.ts}`, so the types follow from the `.proto`
change.

---

## 7. Exchanging addresses

**PROPOSED.** The rule the plan sets and this design keeps: **a SWARM address
travels only inside an encrypted message. Never through the server, never in a
profile, never in a directory.**

Two messages, and they are deliberately boring:

* **Share address.** A `DataMessage` carrying a
  `SwarmNotification`-shaped item with `senderAddress` set and no `txid` — or,
  cleaner, a small sibling message so a share is never mistaken for a payment:

  ```proto
  // PROPOSED, DataMessage field 30 (next free after adminDelete = 29)
  message SwarmAddress {
    enum Type { SHARE = 0; REQUEST = 1; }
    optional Type type = 1;
    // Set for SHARE, absent for REQUEST.
    optional string address = 2;
    // The chain the address belongs to, e.g. "swarm-mainnet".
    optional string chain = 3;
  }
  optional SwarmAddress swarmAddress = 30;
  ```

* **Request address.** The same message with `type = REQUEST` and no address. The
  recipient's client shows "N wants your SWARM address" with **Share** and
  **Ignore**, and shares nothing automatically. A request is an ask, not a
  permission.

Rules:

* A received address is **checked before it is stored**, with
  `wallet.parseAddress` — which on SWARM production answers from this package's
  own HRP and version-byte check, because the addon cannot decode `swm1…`
  (see §8). An address for the wrong chain is refused with the sentence that
  names both networks.
* An address is stored against the conversation, not against a contact record
  that syncs. It is not a profile field, so it never reaches storage service.
* **A fresh unified address per conversation** is offered, because an address
  reused across counterparties links them to each other. The wallet supports it
  (`newAddress()`), so the UI should default to it.
* The send screen prefers the address the conversation already holds and shows
  which message it came from, so a swapped address is visible rather than
  silent.

---

## 8. The three limitations to design around

All three are real, all three are in this package's tests, and none should be
discovered by a user.

**1. `parse_address` cannot decode SWARM production addresses.** The addon tries
`ChainType::Mainnet`, `Testnet` and `Regtest` and no more, because an address
string cannot supply the genesis that `ChainType::SwarmMainnet` requires. A
perfectly good `swm1…` therefore comes back `{"status":"Invalid address"}`.
`swarm-wallet-core` runs its own bech32m HRP and Base58Check version-byte check
in front (`src/addressCheck.ts`, ported from the wallet) and reports
`decodedBy: "prefix"`. **Consequence for the UI:** never show the addon's verdict
directly, always show `ParsedAddress`, and never write "verified" where "looks
like a SWARM address" is what is true. The fix belongs upstream in the SDK/addon;
until then this is the honest state.

**2. The plaintext wallet file exists while the wallet is open.** §4 says what
that does and does not protect. **Consequence for the UI:** close the wallet when
the pane is left and the app is idle, not only on quit, so the window in which
plaintext exists is the window in which the user is actually using the wallet.
`wallet.close()` is idempotent and cheap.

**3. The server's genesis is not verified.** `info_server` builds its JSON by hand
from zingolib's `ServerInfo` — `version`, `git_commit`, `server_uri`, `vendor`,
`taddr_support`, `chain_name`, `sapling_activation_height`,
`consensus_branch_id`, `latest_block_height` — and there is no genesis hash in it.
So the profile holds SWARM's genesis, the wallet threads it into the chain hint
(which is what makes the addon build the right `ChainType`), and nothing ever
compares it with what the indexer reports. `ServerInfo.genesisVerified` is
therefore always false. The chain label IS compared, and a mismatch refuses the
open.

**Consequence for the messenger:** the wallet pane must not claim the server is
verified. And the fix belongs upstream: a `genesis_hash` field in
`info_server`'s JSON (the indexer's `GetLightdInfo` is where it would come from)
would close it in one line here. Until then, treat "is this the real SWARM
indexer" as answered by TLS and the hostname, not by the chain.

---

## 9. What it would take to be done

In the order it should be built:

| # | Work | Depends on |
| --- | --- | --- |
| 1 | `app/SwarmWalletService.main.ts` + the `swarm-wallet:*` handlers + `asarUnpack` | this package (done) |
| 2 | `safeStorage` key, with the three failure paths of §4 | 1 |
| 3 | Exclude the wallet directory from Signal's backup export | 1 |
| 4 | `NavTab.Wallet`, the pane, four screens on Style Guide v2 | 1, 2 |
| 5 | Two clients on the staging stack, wallet open on both, addresses shared | 4, Opus M-B's server |
| 6 | The proto variant and the payment bubble | 5 |
| 7 | One small real payment between the owner's two clients on mainnet, txid on the explorer | 6 |

Milestone M3 in the plan is items 4 to 7.

---

## 10. Open questions for the owner

1. **Wallet per account or per device?** This design says per account
   (`<userData>/swarm-wallet/<ourAci>/`). If relinking should keep one wallet
   across accounts, say so — it is a directory decision and awkward to change
   later.
2. **Plaintext mode, or refuse to run?** When `safeStorage` is unavailable or on
   the Linux `basic_text` backend, this design runs the wallet unencrypted and
   says so on screen. The alternative is refusing to open a wallet at all on
   those machines. Which?
3. **Does the payment notice carry the sender's address by default?** Convenient,
   and it links the sender to that conversation for ever in the recipient's
   database. Default on, default off, or a per-conversation choice?
4. **Where does the wallet appear — a left-rail tab, or inside each conversation?**
   This design does the tab, with payments visible in the chat. A conversation-only
   wallet is a different product.
5. **Android and iOS.** The same `native/` builds for both (zingolib is what the
   SWARM mobile wallet uses), but the bridge is JNI / Swift and not neon, so the
   TypeScript API in this package does not carry across. Is one shared Rust core
   with three bridges the plan, or three wallets?
6. **A genesis in `info_server`?** §8.3. Adding `genesis_hash` to the addon's
   `info_server` JSON is a small change in `privacy-wallet`'s `native/src/lib.rs`
   and it would let every SWARM client refuse an indexer that is on another chain
   of the same name. Worth an upstream commit, or accepted as it is?
