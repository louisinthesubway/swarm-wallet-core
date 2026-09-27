# swarm-wallet-core

The SWARM wallet as one embeddable package: the Rust/neon addon from the SWARM
desktop wallet, plus a typed, promise-based TypeScript API over it, for the SWARM
Messenger apps.

**The keys live on the device.** There is no server-side wallet here and no code
path that sends a seed, a spending key or a viewing key anywhere. The messenger
holds the wallet file; the messenger's server never sees it.

| | |
| --- | --- |
| Network | SWARM mainnet — chain label `swarm-mainnet`, ticker `SWM` |
| Genesis | `01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd` |
| Indexer | `lwd-main.swarm.green:8443` (TLS) |
| Addresses | unified `swm1…`, transparent `s1…` / `s3…`, TEX `texswm1…` |
| Addon source | `Swarm-Official/privacy-wallet` @ `a963fd8c`, copied byte for byte — see [`native/PROVENANCE.md`](native/PROVENANCE.md) |
| SDK | `Swarm-Official/privacy-zingolib` @ `c7464d2e…` (tag `swarm-sdk-mainnet-1`), by revision — see [`sdk/swarm-sdk-pin.json`](sdk/swarm-sdk-pin.json) |

## Using it

```ts
import { SwarmWallet, WalletStore, loadNativeAddon } from "swarm-wallet-core";

const addon = loadNativeAddon("/path/to/native.node");

const wallet = await SwarmWallet.openOrCreate({
  addon,
  dataDir: "/…/userData/swarm-wallet/<accountId>",
  chain: "swarm-mainnet",
  encryptionKey: keyFromSafeStorage(),   // 32 bytes, or omit for plaintext
});

wallet.on("status", ({ progress }) => showProgress(progress));
await wallet.sync();

const { spendableZat } = await wallet.balance();      // bigint zatoshi
const [receive] = (await wallet.addresses()).unified; // swm1…

const quote = await wallet.proposeSend({ to: recipient, amountZat: 100_000n, memo: "coffee" });
showFee(quote.feeZat);          // nothing has been transmitted yet
const { txids, saved } = await quote.confirm();   // txids first; `saved` says whether the file followed

await wallet.close();           // saves, seals, wipes the plaintext
```

### The API

| | |
| --- | --- |
| `SwarmWallet.openOrCreate(options)` | Opens the wallet in `dataDir`, creating one if there is none. Creation needs the network: the addon derives the birthday from the chain tip. |
| `SwarmWallet.restoreFromSeed(options)` | Restores a BIP-39 phrase. Refuses if a wallet already exists in `dataDir`. |
| `wallet.balance()` / `balanceText()` | `bigint` zatoshi, total and spendable apart, plus the per-pool totals (orchard, sapling, transparent, ironwood) and the confirmed sum; or one formatted string. |
| `wallet.addresses()` / `newAddress(receivers?)` | Unified and transparent lists; a new unified address (orchard **and** sapling by default — the addon's `generate_unified_address` takes no transparent flag). |
| `wallet.proposeSend(request)` → `SendQuote` | Builds the proposal and returns its fee. **Transmits nothing.** `quote.confirm()` transmits, and refuses if a later proposal has replaced it. It resolves `{txids, feeZat, saved, saveError}`: once the addon has answered txids nothing thrown afterwards may lose them, so a wallet-file save that fails after the transmit is reported in the result and as a `save-error` event, never as an exception. |
| `wallet.send({…, maxFeeZat})` | Propose and confirm in one call, refusing above a fee ceiling. |
| `wallet.sync({signal?})` + `status` / `synced` / `sync-error` events | One run to the chain tip, polling the addon as it goes. `SyncStatus` heights are derived from the addon's `scan_ranges` plan. |
| `wallet.transactions()` | Value transfers: a magnitude plus `direction: "in" \| "out" \| "unknown"`. Never a guessed sign. |
| `wallet.parseAddress(address)` | Verdict plus `decodedBy: "addon" \| "prefix"` — read the note below. |
| `wallet.seedPhrase()` | The seed, only when asked for by name. Nothing else in this package reads it. |
| `wallet.close()` | Saves, drops the addon's wallet, seals the file, wipes the plaintext. Idempotent. |
| `formatSwm` / `parseSwm` | zatoshi ⇄ decimal SWM. Truncates towards zero; refuses a ninth decimal. |

Amounts are `bigint` zatoshi throughout. 100,000,000 zatoshi = 1 SWM.

## Four things to know before building on it

**One wallet per process.** The addon keeps a single global `LightClient`
(`native/src/lib.rs`, `static LIGHTCLIENT: RwLock<Option<LightClient>>`). There is
no handle, so a second `openOrCreate` in the same process would replace the first
wallet under its owner's feet. It is refused. Two accounts, two processes.

**The chain hint is not the chain label.** `ChainType::SwarmMainnet` carries the
genesis hash and the SDK gives it no default, so the addon must be given
`swarm-mainnet:<64 hex>` and refuses the bare label. Every call goes through
`nativeChainHint()`; the branded `ChainHint` type stops a label typechecking and
`test/chainHint.test.ts` reads this package's own source in case someone casts
around the brand. On 2026-09-26 the same bug in the desktop wallet stopped the
owner creating a mainnet wallet at all.

**`parseAddress` tells you who decided.** The addon's `parse_address` decodes
against Zcash `main`, `test` and `regtest` only, because an address string cannot
supply the genesis a `SwarmMainnet` chain type needs — so it answers
`Invalid address` for a perfectly good `swm1…`. This package therefore runs its
own HRP and version-byte check (`src/addressCheck.ts`, ported from the wallet) and
reports `decodedBy: "prefix"` when that is the strongest answer available. It is
a real limitation, stated rather than papered over.

**The server's genesis is checked, since 0.2.0.** `info_server` now carries
`genesis_hash` — the height-zero block hash the indexer serves, through
`LightdInfo.genesisHash` (proto field 19) in the SDK at `swarm-sdk-mainnet-1` —
and `openOrCreate` refuses a server whose genesis is not the profile's, so "same
chain name, different chain" is closed. `ServerInfo.genesisVerified` is true
against `lwd-main.swarm.green`. An indexer that does not state a genesis answers
the empty string; that reads as `genesisHash: null` and `genesisVerified: false`,
never as a mismatch. Through the 0.1.x addon the field did not exist and the flag
was always false.

## Wallet file protection

The addon writes a **plaintext** wallet file — seed and spending keys in the
clear. `WalletStore` keeps that file encrypted at rest with AES-256-GCM under a
32-byte key the caller supplies (in the messenger, from Electron `safeStorage`,
i.e. the OS keychain). The honest limit: **while the wallet is open its plaintext
is on disk**, because the addon can read nothing else. `close()` overwrites,
truncates and unlinks it. See the long comment at the top of
[`src/walletStore.ts`](src/walletStore.ts) for exactly what that protects against
and what it does not, including the copy-on-write caveat.

With no key, the file is left in plaintext and `store.encrypted` is `false`. That
is the desktop wallet's current behaviour, kept available so a caller with nowhere
to put a key is not given a false sense of one.

## Getting the addon

CI publishes `native-linux-x64.node`, `native-win32-x64.node` and
`native-darwin-arm64.node` to a **GitHub Release** in this repository, with a
`.sha256` beside each one and a `SHA256SUMS.txt` computed by reading the three
binaries back out of the release. Verify before you load one:

```sh
gh release download swarm-wallet-core-0.1.1 -R Swarm-Official/swarm-wallet-core
sha256sum -c SHA256SUMS.txt
```

Releases are cut by pushing a `build-<version>` tag; the workflow publishes to
the release `swarm-wallet-core-<version>`. `CHANGELOG.md` says what each one
changed. The addon binary is the same across 0.1.x — the TypeScript is what moved.

A release and not the artifact store, because on 2026-09-26 the organisation's
Actions artifact quota was exhausted and no artifact could be uploaded at all.
The artifact upload is still there, non-fatal, and reappears when the quota does.

## Building the addon

There is no Rust toolchain on the development workstation, so the addon is built
in CI on three platforms: `.github/workflows/build.yml`. Locally:

```sh
npm ci
npm run typecheck && npm test     # no addon needed; it is mocked
npm run neon                      # needs Rust 1.96.0 and protoc; writes ./native.node
SWARM_WALLET_CORE_LIVE=1 npx vitest run test/live.test.ts
```

The live test runs against **any** build of the addon — point
`SWARM_WALLET_CORE_ADDON` at one, for example the `native.node` inside an
installed SWARM Wallet (`resources/app.asar.unpacked/build/native.node`). It is the
test that found every shape mismatch in 0.1.0, and the mocked suite cannot replace
it: `test/fakeAddon.ts` answers what the addon was *observed* to answer, and an
observation is what keeps it honest.

The pieces that are not optional — Rust exactly `1.96.0`,
`RUSTFLAGS='--cfg zcash_unstable="nu6.3"'`, `protoc` on PATH — and why, are in
[`native/PROVENANCE.md`](native/PROVENANCE.md) and, at length, in
`native/BUILD-NOTES-MAINNET.md` (the wallet's own note, copied unchanged).

`npm run check:provenance` checks every file under `native/` against the SHA-256
of the wallet file it was copied from. CI runs it before anything compiles.

## Documents

* [`docs/MESSENGER-INTEGRATION.md`](docs/MESSENGER-INTEGRATION.md) — the design
  for Signal-Desktop: loading the addon in the main process, the `swarm-wallet:*`
  IPC surface, where the wallet directory lives, `safeStorage` key handling, the
  wallet pane, and the proposed in-chat payment message and address exchange.
  It says, per section, what is proposed and what is implemented.
* [`docs/ADDON-BEHAVIOUR.md`](docs/ADDON-BEHAVIOUR.md) — what each addon entry
  point really answers, read out of `native/src/lib.rs`, including the seven that
  answer prose rather than JSON. Read it before adding a call.
* [`docs/CI-PROOF-2026-09-26.md`](docs/CI-PROOF-2026-09-26.md) — the CI runs, the
  `native.node` hashes, and what each run proved.

## Licence

MIT, as the wallet it is copied from. `native/vendor/` carries its own
`LICENSE-APACHE` / `LICENSE-MIT` pairs, unchanged.
