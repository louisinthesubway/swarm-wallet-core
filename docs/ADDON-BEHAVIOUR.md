# What the addon really answers

Read out of `native/src/lib.rs` at `745c2092`, which is the copy in this
repository. **Read this before adding a call to `src/wallet.ts`.**

It exists because of one afternoon. The wrapper was written against
`src/native.node.d.ts`, whose every method is `Promise<string>`, and the
reasonable assumption — those strings are JSON — is wrong for seven of them. The
mocked tests passed, 90 of them, and the first live run on mainnet failed on the
first save:

```
SwarmWalletError: save_wallet_file answered something that is not JSON:
Wallet saved successfully. Size: 420 bytes.
```

## The seven that do not answer JSON

| Entry point | What it answers |
| --- | --- |
| `save_wallet_file` | `"Wallet saved successfully. Size: N bytes."` or `"Wallet is empty. Nothing to save."` |
| `check_save_error` | `""` — the empty string, on success |
| `run_sync` | `"Launching sync task..."`, `"Resuming sync task..."` or `"Sync task already running."` |
| `pause_sync` | `"Pausing sync task..."` |
| `stop_sync` | `"Stopping sync task..."` or `"Sync already stopped."` |
| `run_rescan` | `"Launching rescan..."` |
| `poll_sync` | `"Sync task has not been launched."` or `"Sync task is not complete."` — **and** `{"sync_complete": …}` JSON when it is done |

Every one of these reports failure by **rejecting the promise**, never on the data
channel. `save_wallet_file` says so in its own comment: "only benign status
strings (which never begin with "error") cross on the data channel, so no success
can resemble a failure."

Use `callAddonText` from `src/errors.ts` for these. `callAddon` is for JSON.

## Two failure shapes, and which entry points use which

* **A rejected promise**, with a zingolib cause chain as the message: every
  `init_*` (they are synchronous and `cx.throw_error`), and every prose entry
  point above.
* **A resolved `{"error": "…"}` object**: `send`, `confirm`, `parse_address`,
  `delete_wallet`. Deliberate, so a failure cannot be mistaken for a success.

`callAddon` turns both into a thrown `SwarmWalletError`.

## Shapes that are not what the name suggests

**`send` does not send.** It calls `propose_send` and answers `{"fee": N}`.
`confirm` calls `send_stored_proposal` and answers `{"txids": [...]}`. The addon
holds **exactly one** stored proposal, so a second `send` replaces the first and
an older quote's `confirm` would transmit the newer payment. `SendQuote` carries a
serial number for precisely this.

**`create_new_unified_address` answers one object, not a list**, and the address
is under `encoded_address`:

```json
{ "account": 0, "address_index": 3, "has_orchard": true,
  "has_sapling": true, "has_transparent": false,
  "encoded_address": "swm1…" }
```

Its argument is a **flag string**, not JSON: the addon reads
`receivers.contains('o')` and `receivers.contains('z')` and nothing else. So `"oz"`
means both. `JSON.stringify({orchard: false, sapling: true})` asks for **orchard
only**, because that text contains an `o` (inside `"orchard"`) and no `z`.

**`info_server` has no genesis hash.** It builds its JSON by hand, because
zingolib's `ServerInfo` does not derive `Serialize`, and the nine fields are:
`version`, `git_commit`, `server_uri`, `vendor`, `taddr_support`, `chain_name`,
`sapling_activation_height`, `consensus_branch_id`, `latest_block_height`. Not
`genesis_hash`, and not `block_height`. So `ServerInfo.genesisVerified` is always
false — see the third limitation in `docs/MESSENGER-INTEGRATION.md`.

**`parse_address` cannot decode SWARM addresses.** It tries `ChainType::Mainnet`,
`Testnet` and `Regtest` only (`make_decoded_chain_pair`), because an address
string cannot supply the genesis a `SwarmMainnet` chain type needs. A valid
`swm1…` therefore comes back `{"status": "Invalid address"}`. It *will* decode an
address from another of those three and report `chain_name` for it, so a wallet on
`main` must compare that itself — `parseAddress` does.

## `set_wallet_base_dir` is a `OnceCell`

`WALLET_BASE_DIR.set(..).is_ok()`. The first caller in the process wins, for the
whole process lifetime; every later call answers `false`, **including one passing
the identical path**, and there is no getter and no reset. So `false` alone cannot
distinguish "you already set this, to the same place" from "somebody else set it
somewhere else". `src/wallet.ts` keeps a `WeakMap` from addon object to the
directory it was given, so close-then-reopen works and a genuinely different
directory is refused.

The wallet path the addon then builds is
`<base>/<chain subdirectory>/<wallet name>`, where the subdirectory is
`swarm-mainnet`, `swarm-testnet`, `testnet3`, `regtest`, or nothing for Zcash
mainnet. `walletSubdirectoryFor` in `src/networkProfiles.ts` mirrors that table,
because `WalletStore` has to know the exact path in order to encrypt the file.

**One exception, on SwarmTestnet only:** for `ChainType::CustomTestnet` the addon
lets `SWARM_WALLET_DIR` **replace** the whole computed directory. With that
variable set, the addon reads and writes `$SWARM_WALLET_DIR/<walletName>` while
`WalletStore` seals and wipes `<dataDir>/swarm-testnet/<walletName>` — so the real
wallet file stays permanently in the clear at a path the store never touches. Do
not set it in a process that uses this package.

## One wallet per process

`static LIGHTCLIENT: RwLock<Option<LightClient>>`, and every `init_*` resets it.
There is no handle, so two wallets in one process is one wallet with two owners.
`SwarmWallet.openOrCreate` refuses the second.

## The chain hint

`chain_type_from_hint`: `"main"`, `"test"`, `"regtest"`, `"swarm-testnet"`, and
`"swarm-mainnet:<64 lowercase hex>"`. The bare `swarm-mainnet` is refused, as are
a truncated, over-long, upper-case or non-hex genesis, `swarm-mainnet-<hex>`,
`swarm-mainnetx:<hex>`, `mainnet`, `swarm` and the empty string. The addon has its
own tests for all of that; CI re-checks it against the compiled binary through
`wallet_exists`, which takes a hint and no key material.
