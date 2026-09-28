# Where this addon came from, and what was changed

Every file under `native/` was copied from the SWARM desktop wallet. Nothing
here was written for this package except this file and the file list beside it.

| | |
| --- | --- |
| Source repository | `Swarm-Official/privacy-wallet` (also pushed as `brs-holding/privacy-wallet`) |
| Branch | `codex/mainnet-wallet-mainnet-20260925` |
| Commit | `a963fd8c` — *"Wallet: record the swarm-sdk-mainnet-1 Linux build and the 1606-test run"* |
| Local checkout copied from | `D:\swarm-work\wallet-sdk-bump` (a worktree of that branch, clean at `a963fd8c`) |
| Copied on | 2026-09-27 |
| Files copied | 115 (`native/` minus `native/target/`) |
| Per-file SHA-256 | [`PROVENANCE-FILES.tsv`](PROVENANCE-FILES.tsv) |

| Copy | Wallet commit | What the wallet changed under `native/` since the previous copy |
| --- | --- | --- |
| 2026-09-26 (0.1.0, 0.1.1) | `745c2092` | first copy |
| 2026-09-27 (0.2.0) | `a963fd8c` | SDK pin `d9f1a5b8` → `c7464d2e` (tag `swarm-sdk-mainnet-1`) with the `lightwallet-protocol` fork `c9c13e46` in `Cargo.toml` / `Cargo.lock`; `src/lib.rs` `info_server` adds `"genesis_hash"`; `vendor/README.md` and `BUILD-NOTES-MAINNET.md` record it |

`PROVENANCE-FILES.tsv` records the SHA-256 of each file **as it was copied**,
before the two edits listed below. To check a file against the wallet:

```sh
sha256sum native/src/lib.rs
# compare with the row in native/PROVENANCE-FILES.tsv
```

`scripts/check-provenance.mjs` does the whole set, and CI runs it. Because the
two renamed files are listed with their *pre-rename* hashes, the check applies
the same rename before hashing them, so the hashes in the table stay comparable
with the wallet checkout itself.

## What was changed

Two files, one edit each, and nothing else:

1. `native/Cargo.toml` — `name = "zingolib-native"` → `name = "swarm-wallet-core-native"`.
2. `native/Cargo.lock` — the same string in the root package entry, **and** the
   root package's `[[package]]` block moved to where the new name sorts. Cargo
   keeps that file sorted by name, so the rename moves the block from between
   `zingolib` and `zip32` to between `subtle` and `syn`; the first `cargo build`
   would re-sort it and then fail CI's `git diff --exit-code -- native/Cargo.lock`.
   Moving it in the committed file means the lock still resolves without changes
   (`cargo fetch --locked`) and stays clean after a build.
   `scripts/check-provenance.mjs` sorts the blocks back before hashing; the
   table's row for `native/Cargo.lock` is the wallet's own lock hash, and the
   check passing is the proof that the transform round-trips.

`native/src/lib.rs`, `native/src/lock_discipline_tests.rs`,
`native/src/macos_auth.m`, `native/build.rs`, `native/BUILD-NOTES-MAINNET.md`
and all 109 files under `native/vendor/` are **byte-identical** to the wallet at
`a963fd8c`. The copy is made by a script that hashes the wallet's bytes first
and applies the two edits after, so a copy can never carry a third edit
unnoticed.

## What was NOT removed, and why

The brief allowed desktop-only pieces to be dropped. They were kept. The
candidates, and the decision on each:

| Piece | Kept | Why |
| --- | --- | --- |
| `src/macos_auth.m`, `check_mac_auth`, `verify_mac_user` (LocalAuthentication / Touch ID) | yes | The messenger will want a local re-authentication in front of *send*, and this is the code the wallet already ships and Apple already accepts. Dropping it would mean writing it again later, from nothing, for a macOS build we cannot test on this workstation. |
| `check_windows_hello`, `verify_windows_user` (the `windows` crate, `Security_Credentials_UI`) | yes | The same argument, and it is the only Windows-specific dependency in the manifest. Removing it changes the Windows dependency graph away from the one that is proven green in the wallet's CI. |
| `start_security_scoped_access` (macOS app-scoped bookmarks) | yes | Needed the day the wallet directory sits outside the app container — for example a Mac App Store build of the messenger. It is a no-op returning `{ok: true}` on every other platform. |
| The Ironwood migration surface (`plan_ironwood_migration` … `execute_due_parts`), swap deposits, the Nym mixnet calls, the ZEC price fetch | yes | These are entry points in the same `lib.rs`; removing them means editing a 3,209-line Rust file that **cannot be compiled on this workstation** (no Rust toolchain, no Visual Studio, C: has ~4 GB free). Every removal would be a change first verified an hour later in CI, on a build whose only proof of correctness today is that it is byte-identical to a build that is already green on four platforms. The TypeScript wrapper simply does not expose them; the dead code costs binary size and nothing else. |

So the rule for this directory is: **byte-identical, or it is a bug.** If the
messenger needs the addon's surface trimmed, that trimming belongs upstream in
`privacy-wallet`, where the wallet's own 117-suite test run can see it, and
comes here as a new copy with a new commit id in this file.

## Cryptography

Untouched, in both directions. `zingolib`, `pepper-sync` and `zingo-netutils`
are fetched by revision from `Swarm-Official/privacy-zingolib`
(`c7464d2ec40a5d619500a9ebee76ac4c39775baa`, the tag `swarm-sdk-mainnet-1`, the
revision recorded in `sdk/swarm-sdk-pin.json`), and `lightwallet-protocol` from
the SWARM fork `Swarm-Official/privacy-lightwallet-protocol-rust` at `c9c13e46`,
the same revision the SDK's own workspace pins (it adds `LightdInfo.genesisHash`,
proto field 19); the four vendored crates under `native/vendor/` are
the wallet's own copies, whose provenance and archive SHA-256s are in
[`vendor/README.md`](vendor/README.md). No primitive, no consensus parameter and
no key derivation in this package differs from the wallet by one byte.

## The build recipe

`native/BUILD-NOTES-MAINNET.md` is the wallet's own build note, copied
unchanged, and it is the authority on how this compiles. The short version, as
`.github/workflows/build.yml` runs it:

* Rust `1.96.0` exactly (`RUSTUP_TOOLCHAIN`), and `rust-toolchain` at the repo
  root says `stable` only because the wallet's does; the workflow's pin wins.
* `RUSTFLAGS='--cfg zcash_unstable="nu6.3"'` — **not optional**. The vendored
  crates are Ironwood-era and a build without it resolves a different cfg
  surface.
* `protoc` on PATH (the workflows pin Protocol Buffers `36.2`), because
  `lightwallet-protocol`'s `rebuild-proto` feature runs it.
* `cargo-cp-artifact -a cdylib swarm-wallet-core-native native.node -- cargo build --release --manifest-path native/Cargo.toml`
  (the crate name is the one thing that differs from the wallet's `yarn neon`).
* `CARGO_NET_GIT_FETCH_WITH_CLI=true`, so the SDK revision fetch uses git.

## Mirror change, 2026-09-28

GitHub suspended the Swarm-Official account on 2026-09-28. To build again, the two
git dependencies of `native/Cargo.toml` and `native/Cargo.lock` now point at the
mirrors `louisinthesubway/privacy-zingolib` (same commit `c7464d2e`, tag
`swarm-sdk-mainnet-1`) and `louisinthesubway/privacy-lightwallet-protocol-rust`
(same commit `c9c13e46`). Nothing else under `native/` changed; the two rows in
`PROVENANCE-FILES.tsv` were re-hashed for exactly these URL edits. The wallet's
own copy of these files still names the Swarm-Official URLs.
