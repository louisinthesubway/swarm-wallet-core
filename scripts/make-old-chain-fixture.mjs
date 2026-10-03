#!/usr/bin/env node
/**
 * Writes a throwaway wallet file the way swarm-wallet-core 0.2.0 wrote it on the
 * SWARM Mainnet chain abandoned on 2 October 2026, for the live move test.
 *
 *   node scripts/make-old-chain-fixture.mjs <0.2.0 native.node> <empty directory>
 *
 * It must be run with the 0.2.0 addon, in its own process (one addon per
 * process). The wallet is made from a brand-new random seed that never leaves
 * this process: `init_new` generates it, its answer is kept in memory only long
 * enough to restore the same seed with an old-chain birthday (block 6,000, far
 * above the restarted chain's tip), and nothing prints it. The wallet is never
 * funded and no transaction is made.
 *
 * `init_new` is the only call that dials the network: 0.2.0 fetches the tip to
 * derive a birthday, which any light-wallet server answers whatever its chain,
 * so it is pointed at the restarted chain's server (the abandoned one no longer
 * answers). The chain HINT is the abandoned chain's, exactly as 0.2.0 sent it.
 *
 * Writes `<dir>/swarm-mainnet/swarm-wallet.dat` (plaintext, as 0.2.0 wrote it
 * with no key) and `<dir>/fixture.json` with what the move must preserve:
 * birthday, every receive address, and the file's SHA-256. No key material.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [, , addonArg, dirArg] = process.argv;
if (!addonArg || !dirArg) {
  console.error("usage: make-old-chain-fixture.mjs <0.2.0 native.node> <empty directory>");
  process.exit(2);
}
const ABANDONED_GENESIS = "01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd";
const HINT = `swarm-mainnet:${ABANDONED_GENESIS}`;
const SERVER = process.env.SWARM_FIXTURE_SERVER ?? "https://lwd-main.swarm.green:443";
const OLD_BIRTHDAY = 6000;
const NAME = "swarm-wallet.dat";

const dir = resolve(dirArg);
mkdirSync(dir, { recursive: true });
const addon = createRequire(import.meta.url)(resolve(addonArg));
if (typeof addon.move_wallet_to_restarted_chain === "function") {
  console.error("this addon can already move wallets: it is not 0.2.0, so it cannot make the fixture");
  process.exit(2);
}
addon.set_crypto_default_provider_to_ring();
if (!addon.set_wallet_base_dir(dir)) throw new Error("set_wallet_base_dir refused");
const file = join(dir, "swarm-mainnet", NAME);
if (existsSync(file)) throw new Error(`${file} already exists; give an empty directory`);

// A brand-new seed, kept only in this variable.
let recovery = JSON.parse(addon.init_new(SERVER, HINT, "Low", 3, NAME));
addon.deinitialize();
rmSync(file, { force: true });
addon.init_from_seed(recovery.seed_phrase, OLD_BIRTHDAY, SERVER, HINT, "Low", 3, NAME);
recovery = null;

await addon.create_new_unified_address("oz");
await addon.create_new_transparent_address();
const saved = await addon.save_wallet_file();
if (!/saved successfully/i.test(saved)) throw new Error(`save_wallet_file answered: ${saved}`);
const seedInfo = JSON.parse(await addon.get_seed());
const birthday = seedInfo.birthday;
const unified = JSON.parse(await addon.get_unified_addresses()).map((a) => a.encoded_address);
const transparent = JSON.parse(await addon.get_transparent_addresses())
  .filter((a) => a.scope === "external")
  .map((a) => a.encoded_address);
addon.deinitialize();

const bytes = readFileSync(file);
const fixture = {
  madeWith: "swarm-wallet-core 0.2.0 addon",
  chainHint: HINT,
  birthday,
  unified,
  transparent,
  file: `swarm-mainnet/${NAME}`,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
writeFileSync(join(dir, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `old-chain fixture: birthday ${birthday}, ${unified.length} unified + ${transparent.length} ` +
    `transparent addresses, ${bytes.length} bytes, sha256 ${fixture.sha256}`,
);
process.exit(0);
