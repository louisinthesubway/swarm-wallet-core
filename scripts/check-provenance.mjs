#!/usr/bin/env node
/**
 * Checks every file under `native/` against `native/PROVENANCE-FILES.tsv`.
 *
 * The table holds each file's SHA-256 **as it was copied from the wallet at
 * `745c2092`**, so the table stays comparable with the wallet checkout itself.
 * Two files were then edited — the crate rename — so for those two the check
 * applies the same rename before hashing:
 *
 *   name = "swarm-wallet-core-native"  →  name = "zingolib-native"
 *
 * `native/Cargo.lock` needs one more step, because cargo keeps `[[package]]`
 * blocks sorted by name: renaming the root crate moves it from between
 * `zingolib` and `zip32` to between `subtle` and `syn`, and the first
 * `cargo build` re-sorts the file — which then fails the workflow's
 * `git diff --exit-code -- native/Cargo.lock`. So the block is moved in the
 * committed file, and this check sorts the blocks back before hashing. The
 * inverse was verified to reproduce the wallet's lock byte for byte.
 *
 * Since 0.3.0 (2026-10-03) one more documented edit: the chain-restart move of
 * the desktop wallet at privacy-wallet `8b73dbc3`. `native/src/chain_restart.rs`
 * is copied from that commit byte for byte (its own row in the table), and
 * `native/src/lib.rs` carries exactly that commit's four lib.rs hunks — the
 * module line, the export line, the new-wallet birthday in `init_new`, and the
 * `move_wallet_to_restarted_chain` entry point — and nothing else. The table
 * keeps lib.rs's hash AS COPIED at a963fd8c; this check takes the four hunks
 * back out (each must be found exactly once) and hashes what is left, and it
 * hashes the entry point it took out against the wallet's own bytes at
 * 8b73dbc3. So the port is proven identical to the wallet's in both directions.
 *
 * If any transform no longer round-trips, the file has other changes in it
 * and this refuses, which is the point: `native/` is copied code, and a silent
 * edit to copied code is how a wallet stops being the wallet that was audited.
 *
 * Exit 0 when everything matches. Exit 1, with a list, when it does not.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nativeDir = join(root, "native");
const tablePath = join(nativeDir, "PROVENANCE-FILES.tsv");

/** The two files the rename touched, and how to undo it for hashing. */
const RENAMED = new Set(["native/Cargo.toml", "native/Cargo.lock"]);
const RENAMED_FROM = 'name = "swarm-wallet-core-native"';
const RENAMED_TO = 'name = "zingolib-native"';

/**
 * The chain-restart port into lib.rs (privacy-wallet 8b73dbc3), as pairs of
 * [text as ported, text at a963fd8c]. Undone before hashing.
 */
const RESTART_PORT_PAIRS = [
  [
    "#[cfg(test)]\nmod lock_discipline_tests;\n\nmod chain_restart;\n\n",
    "#[cfg(test)]\nmod lock_discipline_tests;\n\n",
  ],
  [
    '    cx.export_function("init_from_b64", init_from_b64)?;\n    cx.export_function("move_wallet_to_restarted_chain", move_wallet_to_restarted_chain)?;\n',
    '    cx.export_function("init_from_b64", init_from_b64)?;\n',
  ],
  [
    "        reset_lightclient();\n" +
      "        let chain_type = chain_type_from_hint(&chain_hint)?;\n" +
      "        let (builder, wallet_settings, lightwalletd_uri) =\n" +
      "            construct_uri_load_config(server_uri, chain_hint, performance_level, min_confirmations, wallet_name)?;\n" +
      "        // Fetch the current chain tip from the server; the new wallet derives\n" +
      "        // its birthday from this height (chain_height - 100).\n",
    "        reset_lightclient();\n" +
      "        let (builder, wallet_settings, lightwalletd_uri) =\n" +
      "            construct_uri_load_config(server_uri, chain_hint, performance_level, min_confirmations, wallet_name)?;\n" +
      "        // Fetch the current chain tip from the server; the NewSeed wallet\n" +
      "        // derives its birthday from this height (chain_height - 100).\n",
  ],
  [
    "        let no_of_accounts = NonZeroU32::try_from(1).expect(\"hard-coded integer\");\n" +
      "        // SWARM Mainnet: the SDK's `NewSeed` would give the wallet the\n" +
      "        // network's first block as its birthday whatever the chain's height.\n" +
      "        // A new wallet is born at the height the server just reported, less\n" +
      "        // upstream's reorg margin (chain_restart::new_wallet_birthday), with\n" +
      "        // a phrase generated exactly as `NewSeed` generates it. Every other\n" +
      "        // network keeps `NewSeed`.\n" +
      "        let wallet_config = match chain_restart::new_wallet_birthday(&chain_type, chain_height) {\n" +
      "            Some(birthday) => WalletConfig::MnemonicPhrase {\n" +
      "                mnemonic_phrase: Mnemonic::<bip0039::English>::generate(bip0039::Count::Words24).into_phrase(),\n" +
      "                no_of_accounts,\n" +
      "                birthday,\n" +
      "                wallet_settings,\n" +
      "            },\n" +
      "            None => WalletConfig::NewSeed {\n" +
      "                no_of_accounts,\n" +
      "                chain_height,\n" +
      "                wallet_settings,\n" +
      "            },\n" +
      "        };\n" +
      "        let config = builder\n" +
      "            .set_wallet_config(wallet_config)\n",
    "        let config = builder\n" +
      "            .set_wallet_config(WalletConfig::NewSeed {\n" +
      "                no_of_accounts: NonZeroU32::try_from(1).expect(\"hard-coded integer\"),\n" +
      "                chain_height,\n" +
      "                wallet_settings,\n" +
      "            })\n",
  ],
];

/** The `move_wallet_to_restarted_chain` entry point, as privacy-wallet 8b73dbc3 has it. */
const RESTART_ENTRY_START = "/// Moves a SWARM Mainnet wallet file written on the abandoned chain onto the\n";
const RESTART_ENTRY_END = "fn write_to_path(wallet_path: &std::path::Path, bytes: &[u8])";
const RESTART_ENTRY_SHA256 = "ae674134ce0c6df02743fb74f0750d9918109f6e8dc4de440e2e534da40d6f3e";

/** lib.rs with the chain-restart port taken back out, or an error string. */
const undoRestartPort = (text) => {
  const start = text.indexOf(RESTART_ENTRY_START);
  const end = text.indexOf(RESTART_ENTRY_END);
  if (start < 0 || end < start) return { error: "the ported move_wallet_to_restarted_chain entry point is missing" };
  const entry = text.slice(start, end);
  const entryHash = createHash("sha256").update(entry, "utf8").digest("hex");
  if (entryHash !== RESTART_ENTRY_SHA256) {
    return { error: `the ported entry point differs from privacy-wallet 8b73dbc3 (sha256 ${entryHash})` };
  }
  let restored = text.slice(0, start) + text.slice(end);
  for (const [ported, original] of RESTART_PORT_PAIRS) {
    if (restored.split(ported).length !== 2) {
      return { error: `a ported hunk is missing or repeated: ${JSON.stringify(ported.slice(0, 60))}` };
    }
    restored = restored.replace(ported, original);
  }
  return { restored };
};

/** Files this package added under native/ and which the wallet never had. */
const OURS = new Set(["native/PROVENANCE.md", "native/PROVENANCE-FILES.tsv"]);

/**
 * A `Cargo.lock` with its `[[package]]` blocks back in cargo's own order, which
 * is by name. Reproduces the wallet's file exactly once the rename is undone.
 */
const sortLockPackages = (text) => {
  const start = text.indexOf("[[package]]");
  if (start < 0) return text;
  const header = text.slice(0, start);
  const blocks = text.slice(start).split("\n\n");
  const nameOf = (block) => {
    const match = /^name = "(.*?)"$/m.exec(block);
    if (!match) throw new Error("a [[package]] block in Cargo.lock has no name");
    return match[1];
  };
  return (
    header +
    blocks
      .slice()
      .sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0))
      .join("\n\n")
  );
};

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // The build output is not copied code.
      if (entry.name === "target") continue;
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
};

const posix = (path) => relative(root, path).split("\\").join("/");

const main = async () => {
  const table = new Map();
  const tableText = await readFile(tablePath, "utf8");
  for (const line of tableText.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const [path, bytes, sha256] = line.split("\t");
    table.set(path, { bytes: Number(bytes), sha256 });
  }

  const problems = [];
  const seen = new Set();

  for (const file of await walk(nativeDir)) {
    const key = posix(file);
    if (OURS.has(key)) continue;
    seen.add(key);
    const expected = table.get(key);
    if (!expected) {
      problems.push(`${key}: not in PROVENANCE-FILES.tsv. Added here? Say so in PROVENANCE.md.`);
      continue;
    }
    let bytes = await readFile(file);
    if (key === "native/src/lib.rs") {
      const undone = undoRestartPort(bytes.toString("utf8"));
      if (undone.error) {
        problems.push(`${key}: ${undone.error}`);
        continue;
      }
      bytes = Buffer.from(undone.restored, "utf8");
    }
    if (RENAMED.has(key)) {
      const text = bytes.toString("utf8");
      if (!text.includes(RENAMED_FROM)) {
        problems.push(`${key}: does not carry the renamed crate name; the rename was undone?`);
        continue;
      }
      let restored = text.replaceAll(RENAMED_FROM, RENAMED_TO);
      if (key === "native/Cargo.lock") restored = sortLockPackages(restored);
      bytes = Buffer.from(restored, "utf8");
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected.sha256) {
      problems.push(
        `${key}: sha256 ${actual}\n    expected ${expected.sha256} (${expected.bytes} bytes as copied)`,
      );
    }
  }

  for (const key of table.keys()) {
    if (!seen.has(key)) problems.push(`${key}: in PROVENANCE-FILES.tsv but missing from the tree.`);
  }

  if (problems.length > 0) {
    console.error(
      `native/ does not match its provenance (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      "\nnative/ is copied, byte for byte, from Swarm-Official/privacy-wallet at a963fd8c,\n" +
        "plus the chain-restart move of privacy-wallet 8b73dbc3 (see native/PROVENANCE.md).\n" +
        "Changes belong upstream in the wallet, where its own test suite can see them,\n" +
        "and come here as a new copy with a new commit id in native/PROVENANCE.md.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `native/ matches its provenance: ${seen.size} files, wallet a963fd8c + chain-restart move of 8b73dbc3.`,
  );
};

await main();
