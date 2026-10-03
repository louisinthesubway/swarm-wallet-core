#!/usr/bin/env node
/**
 * The built addon loads and holds the chain-hint contract, with no network and
 * — deliberately — NO SEED PHRASE anywhere.
 *
 *   node scripts/check-addon-contract.cjs [path/to/native.node]
 *
 * The bare label must be refused and the full hint accepted. That is the bug
 * that cost the owner the first mainnet wallet creation, and it is checkable
 * here because `wallet_exists` goes through the same `construct_uri_load_config`
 * and so the same `chain_type_from_hint`, and takes no key material at all. The
 * project rule is that no recovery words appear in a commit or a log, and a
 * published BIP-39 test vector is still recovery words.
 *
 * Since 0.3.0 it also holds the restart contract: the genesis is the restarted
 * chain's (2026-10-02), and `move_wallet_to_restarted_chain` exists, refuses a
 * network other than SWARM Mainnet and refuses a wallet file that is not there,
 * creating nothing either way.
 *
 * Kept as a file rather than inline in the workflow so the macOS Intel build,
 * which is cross-compiled on an Apple-silicon runner, can run the very same
 * check under an x64 Node through Rosetta.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GENESIS = "01b76d8a0f18c502b23ab6605e26296d189aa5770fc4a34155e5c7b250a0eff2";
const ABANDONED = "01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd";

const addonPath = path.resolve(process.argv[2] || "native.node");
const addon = require(addonPath);
console.log(`loaded ${addonPath} in ${process.platform}-${process.arch}`);

for (const name of [
  "set_wallet_base_dir",
  "wallet_exists",
  "init_new",
  "init_from_seed",
  "init_from_b64",
  "move_wallet_to_restarted_chain",
  "get_balance",
  "send",
  "confirm",
  "parse_address",
  "save_wallet_file",
  "deinitialize",
]) {
  if (typeof addon[name] !== "function") throw new Error("addon has no " + name);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swc-hint-"));
if (!addon.set_wallet_base_dir(dir)) throw new Error("set_wallet_base_dir refused");

let bare = null;
try {
  addon.wallet_exists("", "swarm-mainnet", "Low", 3, "probe.dat");
} catch (e) {
  bare = String((e && e.message) || e);
}
if (bare === null) throw new Error("the addon accepted the BARE label swarm-mainnet");
if (!/does not name a network/.test(bare)) throw new Error("unexpected refusal: " + bare);
console.log("bare label refused, as it must be");

for (const genesis of [GENESIS, ABANDONED]) {
  const exists = addon.wallet_exists("", "swarm-mainnet:" + genesis, "Low", 3, "probe.dat");
  if (exists !== false) throw new Error("wallet_exists answered " + exists + " for an empty directory");
}
console.log("full chain hint accepted: swarm-mainnet:" + GENESIS);
// And the genesis is load-bearing: a different one is a different chain.
const other = addon.wallet_exists("", "swarm-mainnet:" + "ab".repeat(32), "Low", 3, "probe.dat");
if (other !== false) throw new Error("wallet_exists answered " + other + " for another genesis");
for (const refused of ["mainnet", "swarm", "swarm-mainnet:", "swarm-mainnet:0", "swarm-mainnet:" + GENESIS.toUpperCase(), ""]) {
  let threw = false;
  try {
    addon.wallet_exists("", refused, "Low", 3, "probe.dat");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("the addon accepted the hint " + JSON.stringify(refused));
}
console.log("every malformed hint refused");

// The move: offline, and it refuses rather than creating anything.
for (const [hint, why] of [
  ["swarm-testnet", "a SwarmTestnet wallet"],
  ["swarm-mainnet:" + GENESIS, "a wallet file that does not exist"],
  ["swarm-mainnet", "the bare label"],
]) {
  let refusal = null;
  try {
    addon.move_wallet_to_restarted_chain(hint, "Low", 3, "probe.dat");
  } catch (e) {
    refusal = String((e && e.message) || e);
  }
  if (refusal === null) throw new Error("move_wallet_to_restarted_chain accepted " + why);
  console.log("move refused " + why + ": " + refusal.split("\n")[0]);
}
const left = [];
const walk = (d) => {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) walk(full);
    else left.push(path.relative(dir, full));
  }
};
walk(dir);
if (left.length > 0) throw new Error("the refused moves left files behind: " + left.join(", "));
console.log("refused moves created nothing");

fs.rmSync(dir, { recursive: true, force: true });
console.log("addon contract holds");
