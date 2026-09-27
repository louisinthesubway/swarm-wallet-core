# Changelog

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
