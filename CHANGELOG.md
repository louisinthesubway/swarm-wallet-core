# Changelog

## 0.3.0 — 2026-10-03

For the SWARM Mainnet **restarted on 2026-10-02** from genesis
`01b76d8a0f18c502b23ab6605e26296d189aa5770fc4a34155e5c7b250a0eff2`, served by
`lwd-main.swarm.green:443` (`:8443` and genesis `01c34428…afdd` are the abandoned
chain and are no longer served). Name, label, prefixes and rules are unchanged.

* **Pins**: `SWARM_MAINNET_GENESIS`, `SWARM_MAINNET_SERVER` (`:443`), new
  `SWARM_MAINNET_ABANDONED_GENESIS`, `SWARM_MAINNET_ABANDONED_SERVER`,
  `SWARM_MAINNET_RESTARTED_UTC`; `sdk/swarm-sdk-pin.json`'s `mainnet` block as the
  desktop wallet writes it (manifest `swarm-mainnet-r2`, sha256 `40794956…7325`).
  The SDK revision (`c7464d2e`, `swarm-sdk-mainnet-1`) is unchanged.
* **The move** (native): `native/src/chain_restart.rs` copied byte for byte from
  privacy-wallet `8b73dbc3`, and that commit's four `lib.rs` hunks — the
  `move_wallet_to_restarted_chain` entry point and the new-wallet birthday —
  ported exactly; `scripts/check-provenance.mjs` proves both. No change to
  cryptography, key derivation or the SDK.
* **The move** (package): `src/chainRestart.ts`, the network record
  `<wallet>.network.json`, `openOrCreate` moving a SWARM Mainnet wallet whose
  record does not name this genesis before it opens it (`restartMove`, the
  notice sentence), `SwarmWallet.needsMoveToRestartedChain` and
  `SwarmWallet.moveWalletToRestartedChain`, `restartedChain: "refuse"`,
  `WalletStore.sealBackup` / `sealLeftoverBackups` so no plaintext backup stays
  on disk in encrypted mode, `WalletPaths.networkRecordFile`.
* **New wallets** on SWARM Mainnet are born at the tip less 100 blocks.
* `loadNativeAddon` refuses an addon without `move_wallet_to_restarted_chain`.
* **CI**: genesis/server checks for the restarted chain; a fourth platform,
  **macOS x64** (cross-compiled on the arm64 runner, `lipo` checked, loaded under
  Rosetta when available); the native `chain_restart_tests` and
  `chain_hint_tests` on Linux; the live test also moves a wallet made with the
  published 0.2.0 Linux addon and syncs it from block 1; the release is a
  PRE-release that also carries the packed tgz.

## 0.2.0 — 2026-09-27

The addon moves: `native/` is now the wallet at `a963fd8c` (branch
`codex/mainnet-wallet-mainnet-20260925`), copied byte for byte with fresh
provenance. What the wallet changed there, and therefore what changes here:

* **SDK pin `d9f1a5b8` → `c7464d2e`**, the tag `swarm-sdk-mainnet-1` in
  `Swarm-Official/privacy-zingolib`, with `lightwallet-protocol` from the SWARM
  fork `c9c13e46` (adds `LightdInfo.genesisHash`, proto field 19). Same
  cryptography, same vendored crates.
* **`info_server` carries `genesis_hash`**, so `ServerInfo.genesisHash` is the
  hash the indexer states and `genesisVerified` is true against
  `lwd-main.swarm.green`. `openOrCreate` now refuses a server on another chain
  with the same label. An indexer that states no genesis (the empty string)
  reads as `null` and unverified, never as a mismatch.
* The live test asserts the verified genesis; an addon built from an older
  `native/` fails it, on purpose.
* `scripts/check-provenance.mjs`, `native/PROVENANCE.md`, `build.yml`
  (`SWARM_SDK_REV`, checkout ref) and `sdk/swarm-sdk-pin.json` follow the copy.

The wrapper's other readers are unchanged from 0.1.1.

## 0.1.1 — 2026-09-27

The addon (`native/`, copied byte for byte from `Swarm-Official/privacy-wallet`
`745c2092`) did not change between 0.1.0 and 0.1.1. What changed is how the
TypeScript reads it.

Fixes for the shape mismatches the FUEL staking session found running 0.1.0
against the addon shipped in SWARM Wallet 0.1.0-mainnet.2 (`D:/privacy/privacy/
swarm-wallet-core defect report 2026-09-26.md`). Every shape below was read off
that binary with a throwaway wallet, then written into `test/fakeAddon.ts`, and
`test/live.test.ts` now asserts each one against the real addon.

* **`SendQuote.confirm()` no longer throws after a transmit.** It transmitted,
  then saved the wallet file, and a save failure took the txids of a payment
  already on the network down with it. The save is still made; its failure is
  now reported beside the txids as `SendResult.saved` / `saveError` and as a
  `save-error` event. The txids always reach the caller.
* **`balance()`** reads the addon's real keys — `total_<pool>_balance`,
  `confirmed_<pool>_balance` for orchard, sapling, transparent and ironwood —
  instead of refusing them. `Balance` gains `ironwoodZat` and `confirmedZat`.
* **`addresses()`** reads `encoded_address`, which is where both address lists
  put the string. 0.1.0 answered two empty lists. Fixed on `main` in `9fed943`
  (which also drops `internal` and `refund` transparent addresses from the list
  and refuses an unreadable unified list rather than answering `[]`); this
  release carries that fix and asserts the shape against the real addon.
* **`syncStatus()`** derives `syncedHeight` and `chainHeight` from the
  `scan_ranges` plan, which is all `status_sync` carries; 0.1.0 answered null for
  both. `SyncStatus` gains `ranges` and `blocksScanned`.
* **`seedPhrase()`** reads `seed_phrase`, not `seed`. 0.1.0 threw.
* `serverInfo().blockHeight` (`latest_block_height`) and the prose answers of
  `save_wallet_file`, `run_sync`, `pause_sync`, `stop_sync`, `run_rescan` and
  `poll_sync` were already fixed on `main` before this release (`82c9afc`).
* The build workflow publishes a `build-<version>` tag to the release
  `swarm-wallet-core-<version>` instead of always to `…-0.1.0-m1`.

## 0.1.0 — 2026-09-26

First version. Addon from wallet `745c2092`, SDK `d9f1a5b8`.
