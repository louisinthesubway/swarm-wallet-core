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
 * If either transform no longer round-trips, the file has other changes in it
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
      "\nnative/ is copied, byte for byte, from Swarm-Official/privacy-wallet at 745c2092.\n" +
        "Changes belong upstream in the wallet, where its own test suite can see them,\n" +
        "and come here as a new copy with a new commit id in native/PROVENANCE.md.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`native/ matches its provenance: ${seen.size} files, wallet 745c2092.`);
};

await main();
