# Changelog

The addon (`native/`, copied byte for byte from `Swarm-Official/privacy-wallet`
`745c2092`) has not changed between these versions. What changed is how the
TypeScript reads it.

## 0.1.1 — 2026-09-27

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
