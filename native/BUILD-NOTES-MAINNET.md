# Building the addon against the SWARM production SDK

**Status: built and green everywhere** (2026-09-26). The Linux addon was built
and tested on the build host ("Linux build, verified" at the end of this file),
and CI then compiled the addon against this pin on all four platforms at wallet
commit `d08e17e2`:

* Windows — https://github.com/Swarm-Official/privacy-wallet/actions/runs/36204252054
* Linux, macOS arm64, macOS x64 — https://github.com/Swarm-Official/privacy-wallet/actions/runs/36204253710

Nothing below is untried any more. The paragraph that follows records how the
notes were first written, and is kept because it explains why they read as they
do.

**Status at the time of writing: none of this had been run.** The commit that added these notes was
authored with no compiler available — the build host's memory was fully taken by
another agent's release builds and every local disk was near full — so the four
vendored crates, the `[patch.crates-io]` table, the lockfile edits and the new
`swarm-mainnet:<genesis>` chain hint have been written and read against their
sources, and nothing more. Treat every command below as untried.

## The SDK branch: pushed

`native/Cargo.toml` and `sdk/swarm-sdk-pin.json` name SDK revision
`d9f1a5b888067724b61b2fae46307ed56b4b1e0a`. **It is pushed**: confirmed
2026-09-26 as the head of branch `codex/mainnet-sdk-identity-20260925` in
`Swarm-Official/privacy-zingolib`. `cargo fetch` resolves it and
`actions/checkout` checks it out; the four CI builds above did both.

This section used to say the opposite, and everything downstream of it was
written on that assumption. Where a later paragraph still says "once it is
pushed" or predicts a fetch failure for want of the revision, read it as history
— the "Linux build, verified" section at the end records what actually
happened, including that `native/Cargo.lock` turned out to need no change.

## Expect the lockfile to move

`native/Cargo.lock` was edited by hand, and only where a path patch strictly
requires it:

- `zcash_primitives` 0.30.1 and `zcash_transparent` 0.10.0 lost their `source`
  and `checksum` lines, because `[patch.crates-io]` now resolves both from
  `vendor/`.
- the seven `source = "git+…privacy-zingolib?rev=…"` lines moved from
  `ef08aa25` to `d9f1a5b8`.

Nothing else was regenerated, and the SDK revision changed under the lock, so:

- `cargo fetch --locked --manifest-path native/Cargo.toml` — the CI step named
  *Check the lockfile resolves without changes* — **is expected to fail** on the
  first run, because `d9f1a5b8`'s own dependency set is not the one `ef08aa25`
  resolved to. The SDK worktree already differs from this repository at, among
  others, `zcash_client_backend` (SDK `0.24.0-rc.7`, here `0.24.0`), `orchard`
  (SDK `0.15.5`, here `0.15.4`) and `zcash_pool_migration` (SDK `0.1.0-rc.7`,
  here `0.1.0`).
- so run `cargo update --manifest-path native/Cargo.toml --workspace` once (or
  simply drop `--locked` from the first build), then **re-pin** the floating git
  dependency the manifest warns about:

  ```sh
  cargo update --manifest-path native/Cargo.toml \
    -p zcash_pool_migration --precise e12f1d0ff7be5e5bfd2e4bcbb8d9a863a405f031
  ```

  A bare `cargo update` floats `zcash_pool_migration` (and, transitively, several
  zcash crates) to `librustzcash`'s default-branch tip, where the migration
  denomination constants were renamed and `zingolib` no longer compiles. The
  `[patch.crates-io]` note in `native/Cargo.toml` says the same thing at more
  length.
- after that, commit the regenerated `native/Cargo.lock`. The CI step *Check Rust
  dependency pins* (`git diff --exit-code -- native/Cargo.lock`) fails on any
  build that leaves the lock dirty.

If `cargo update` pulls a crate version that matches `NetworkType` or `BranchId`
exhaustively and is not one of the four vendored here, it will fail to compile
against the patched `zcash_protocol`. That is the intended failure mode — it is
how a crate that could quietly fold SWARM production into Zcash Mainnet announces
itself. Vendor it the same way (see `native/vendor/README.md`) rather than
reaching for a wildcard arm.

## Linux addon, in a container

The build host has no spare memory for this while release builds are running.
Run it when the host is free, from the repository root, mounting the wallet
worktree **and** the SDK checkout is not needed — cargo fetches the SDK over the
network once it is pushed.

```sh
docker run --rm -it \
  -v "$PWD":/w -w /w \
  -e CARGO_HOME=/w/.cargo-container \
  -e CARGO_NET_GIT_FETCH_WITH_CLI=true \
  -e CARGO_INCREMENTAL=0 \
  -e RUSTFLAGS='--cfg zcash_unstable="nu6.3"' \
  node:20 bash -lc '
    set -euo pipefail
    apt-get update
    apt-get install -y --no-install-recommends \
      build-essential pkg-config protobuf-compiler git curl ca-certificates
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain 1.96.0
    . "$CARGO_HOME/env"
    rustc --version && protoc --version
    npm install --global yarn@1.22.22
    yarn install --frozen-lockfile
    yarn neon
  '
```

Notes on that block:

- `RUSTFLAGS='--cfg zcash_unstable="nu6.3"'` is not optional. Every workflow sets
  it, and the vendored crates are Ironwood-era; a build without it resolves a
  different cfg surface. It must be identical for the vendored crates and for the
  addon, which is automatic here because it is an environment variable.
- `protoc` is required: `lightwallet-protocol`'s `rebuild-proto` feature runs it.
- `CARGO_HOME` is put inside the mount so the fetched registry survives between
  container runs. It is large; put it on the volume with room.
- `yarn neon` is `cargo build --release --manifest-path native/Cargo.toml` with
  `cargo-cp-artifact` copying the `cdylib` to `src/native.node`. To see compiler
  errors without the JS wrapper, run
  `cargo build --release --manifest-path native/Cargo.toml` directly first.
- `node:20` satisfies the addon build. The workflows use Node 24 for the
  **frontend**; if you go on to `yarn build-linux` or `electron-builder`, use a
  Node 24 image instead.

### The vendored crates, on their own

Each vendored crate can be built and tested by itself, which is much faster than
finding out from the addon link step. Each of the four needs the patch
resolution that `native/Cargo.toml` applies; `zcash_address`, `zcash_primitives`
and `zcash_transparent` carry a `.cargo/config.toml` that reproduces it, and
`zcash_protocol` needs none because it patches nothing.

From `native/`:

```sh
cargo test --manifest-path vendor/zcash_protocol/Cargo.toml
cargo test --manifest-path vendor/zcash_address/Cargo.toml \
  --config vendor/zcash_address/.cargo/config.toml
cargo test --manifest-path vendor/zcash_transparent/Cargo.toml \
  --config vendor/zcash_transparent/.cargo/config.toml
cargo test --manifest-path vendor/zcash_primitives/Cargo.toml \
  --config vendor/zcash_primitives/.cargo/config.toml
```

`--locked` is deliberately absent: each crate's own `Cargo.lock` was hand-edited
for the path patches and has not been resolved by cargo. Add `--locked` back once
a successful run has rewritten them.

For reference, the same crates on the SDK worktree (against its 0.30.0 copy of
`zcash_primitives`, not this repository's 0.30.1) reported: protocol 43 passed,
address 39 unit + 9 doc, transparent 9, primitives 54.

### The addon's own tests

```sh
cargo test --manifest-path native/Cargo.toml
```

`native/src/lib.rs` gains `mod chain_hint_tests`, which is the part of this
change with a testable contract: `main`/`test`/`regtest`/`swarm-testnet` keep
their meanings, `swarm-mainnet:<64 lowercase hex>` builds
`ChainType::SwarmMainnet` carrying that genesis, and the bare label, a truncated
or over-long or upper-case or non-hex genesis, `swarm-mainnet-<hex>`,
`swarm-mainnetx:<hex>`, `mainnet`, `swarm` and the empty string are each refused.
`cargo test` builds the crate as a test target even though `[lib] crate-type` is
`cdylib` only; if that turns out not to hold for this crate, run the module's
assertions from a `tests/` integration target instead of deleting them.

## The JS suite against the built addon

`yarn neon` writes `src/native.node`, which is what the JS suite loads.

```sh
node scripts/generate-swapkit-secrets.js
node scripts/test.js --watchAll=false --runInBand \
  src/utils/networkProfiles.test.ts \
  src/utils/serverIdentity.test.ts \
  src/utils/swarmAddress.test.ts \
  src/rpc/serverIdentityGate.test.ts
```

Those four are the suites that already encode the production contract:
`networkProfiles.test.ts` asserts `chainHintFor(launched)` is
`swarm-mainnet:<genesis>` and that `selectableChainOrFallback("swarm-mainnet")`
still falls back to `swarm-testnet`; `serverIdentity.test.ts` and
`serverIdentityGate.test.ts` assert the chain-label and `genesis_hash` comparison
against the server's `GetLightdInfo`.

The two suites that exercise the compiled addon directly:

```sh
node scripts/check-swarm-prefix-native.js
node scripts/test.js --watchAll=false --runInBand src/utils/uris.test.js
```

Whole suite, when the above pass:

```sh
yarn test:run
```

## Windows and macOS addons, via CI

**Both have run and both passed** — the two runs linked at the top of this
file, at wallet commit `d08e17e2`, with the addon compiled against `d9f1a5b8`
on Windows, Linux, macOS arm64 and macOS x64. The rest of this section is the
instructions for running them again.

Both workflows already name
`d9f1a5b8` as the SDK checkout ref (this commit bumped
`.github/workflows/swarm-wallet-unix.yml` — both the `SWARM_SDK_REV` env and the
`actions/checkout` `ref` — and `.github/workflows/swarm-wallet-windows.yml`).

- **SWARM wallet Windows test build** — `.github/workflows/swarm-wallet-windows.yml`,
  `workflow_dispatch` on `windows-2025`, builds `yarn neon-win-x64`.
- **SWARM wallet Linux and macOS test build** — `.github/workflows/swarm-wallet-unix.yml`,
  `workflow_dispatch`, matrix of `linux`, `mac-arm64` and `mac-x64`.

```sh
gh workflow run "SWARM wallet Windows test build" --ref codex/mainnet-wallet-mainnet-20260925
gh workflow run "SWARM wallet Linux and macOS test build" --ref codex/mainnet-wallet-mainnet-20260925
```

Two steps in both workflows will fail before the compiler is reached unless the
lockfile has been regenerated and committed first, so do the Linux container
build above before dispatching CI:

1. *Verify the pinned SDK revision and its network* —
   `node scripts/check-swarm-sdk-pin.js sdk-source --require-real-genesis`. This
   reads `SWARM_TESTNET_NAME` and `SWARM_TESTNET_GENESIS` out of the checked-out
   SDK and compares them with `sdk/swarm-sdk-pin.json`. `d9f1a5b8` leaves both
   constants untouched, so the pin's `chainName` and `genesis` deliberately still
   read `swarm-testnet`; SWARM production has no genesis constant to pin, by
   design.
2. *Check the lockfile resolves without changes* — `cargo fetch --locked`, which
   is the failure described above.

One loose end left alone on purpose: `docs/MAC-DISTRIBUTION.md` still names
`ef08aa25`, because it records a build that was actually verified at that
revision. Update it when a Mac build is verified at `d9f1a5b8`, not before.

## Linux build, verified

2026-09-26, on the mainnet build host, in a container built from
`node:24-bookworm` (the Node the workflows use) with rustup `1.96.0`,
`protobuf-compiler` and `yarn@1.22.22`; `RUSTFLAGS='--cfg zcash_unstable="nu6.3"'`.

- `cargo fetch --locked --manifest-path native/Cargo.toml` fails exactly as
  predicted, and for the predicted reason: `upload-pack: not our ref
  d9f1a5b888067724b61b2fae46307ed56b4b1e0a`. The SDK branch is still unpushed,
  so this is the one thing that blocks both CI workflows.
- With the SDK checkout supplied locally through a container-only
  `[patch."https://github.com/Swarm-Official/privacy-zingolib"]` path table
  (never committed), `cargo fetch` resolves with **no change to
  `native/Cargo.lock`**: the hand-edited lock was already correct. The only
  difference cargo writes is that the seven SDK crates lose their `source =
  "git+...?rev=d9f1a5b8..."` line while patched to paths. `zcash_pool_migration`
  stays at the crates.io `0.1.0` the lock already pinned, so the re-pin above is
  not needed on this path — it remains the right guard against a bare
  `cargo update`.
- `yarn install --frozen-lockfile` needs Node >= 22.12 (`@electron/notarize`),
  so `node:20` needs `--ignore-engines`; `node:24` does not.
- `zingolib`'s `build.rs` writes the downloaded sapling params back into the SDK
  checkout, so that mount cannot be read-only.
- `yarn neon` then succeeds and writes `src/native.node`.
- `node scripts/check-swarm-prefix-native.js`: passed (legacy decode, canonical
  SWARM encoding, mixed-case/checksum rejection).
- `node scripts/test.js --watchAll=false`: **117 suites, 1588 tests, all
  passing**, including `src/utils/uris.test.js` (10) against the built addon and
  the four contract suites (77).
