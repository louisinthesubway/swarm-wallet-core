/**
 * The one test that talks to SWARM mainnet.
 *
 * Skipped unless `SWARM_WALLET_CORE_LIVE=1`, so the ordinary run needs no network
 * and no compiled addon. In CI it runs on Linux, after `native.node` is built.
 *
 * What it proves, and it is the only thing that can prove it: that the addon this
 * package builds opens a wallet on the chain SWARM actually launched — the right
 * genesis, the right address prefix, a real sync against
 * `lwd-main.swarm.green:8443`.
 *
 * What it must never do:
 *
 * * **Print a seed.** The wallet is created, so a seed exists in the addon. It is
 *   never asked for, never logged, and the assertion below reads the whole
 *   captured output back to make sure no BIP-39 word sequence escaped.
 * * **Move funds.** A fresh wallet has none, the test asserts the balance is
 *   exactly zero, and nothing here calls `send`.
 * * **Leave a wallet behind.** The directory is a fresh temp directory and is
 *   removed afterwards, ciphertext and all.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SwarmWallet } from "../src/wallet.js";
import { WalletStore } from "../src/walletStore.js";
import { loadNativeAddon } from "../src/nativeAddon.js";
import {
  SWARM_MAINNET_GENESIS,
  SWARM_MAINNET_PROFILE,
  SWARM_MAINNET_SERVER,
} from "../src/networkProfiles.js";
import type { NativeAddon } from "../src/nativeAddon.js";

const live = process.env["SWARM_WALLET_CORE_LIVE"] === "1";

/** Where `native.node` is. `yarn neon` / the CI build puts it at the repo root. */
const addonPath = (): string => {
  const fromEnv = process.env["SWARM_WALLET_CORE_ADDON"];
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
  const root = fileURLToPath(new URL("..", import.meta.url));
  return join(root, "native.node");
};

/** Anything that looks like a run of BIP-39-ish words, for the leak assertion. */
const LOOKS_LIKE_A_SEED = /(?:\b[a-z]{3,8}\b[ ]){11,}\b[a-z]{3,8}\b/;

describe.skipIf(!live)("against SWARM mainnet", () => {
  let dataDir: string;
  let addon: NativeAddon;
  let wallet: SwarmWallet | null = null;
  const output: string[] = [];

  /** Everything this test prints, captured so it can be searched for a seed. */
  const say = (line: string): void => {
    output.push(line);
    // oxlint-disable-next-line no-console
    console.log(`[live] ${line}`);
  };

  beforeAll(async () => {
    const path = addonPath();
    expect(
      existsSync(path),
      `native.node not found at ${path}. Build it with \`npm run neon\`, or point ` +
        `SWARM_WALLET_CORE_ADDON at it.`,
    ).toBe(true);
    addon = loadNativeAddon(path);
    dataDir = await mkdtemp(join(tmpdir(), "swarm-wallet-core-live-"));
  });

  afterAll(async () => {
    await wallet?.close().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("creates a throwaway wallet, syncs, and reports an empty swm1 wallet", async () => {
    wallet = await SwarmWallet.openOrCreate({
      addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: WalletStore.generateKey(),
      // Low, because a runner has better things to do than saturate itself.
      performanceLevel: "Low",
    });
    say(`opened a new wallet on ${wallet.chain} against ${wallet.server}`);

    // The server is the chain it claims. `openOrCreate` already refused if not;
    // this records what it saw.
    const info = await wallet.serverInfo();
    say(
      `server reports chain=${info.chainName} height=${info.blockHeight} ` +
        `branch=${info.consensusBranchId} genesis=${info.genesisHash}`,
    );
    expect(info.chainName).toBe("swarm-mainnet");
    expect(info.blockHeight).not.toBeNull();
    expect(wallet.server).toBe(SWARM_MAINNET_SERVER);

    // And the limitation, asserted rather than hoped about: `info_server` carries
    // no genesis hash, so the profile's genesis — which IS threaded into the chain
    // hint, and is what makes the addon build the right ChainType — is never
    // compared with what the indexer reports. The first version of this test
    // expected the hash and failed here, which is the right way to find out.
    expect(SWARM_MAINNET_GENESIS).toMatch(/^[0-9a-f]{64}$/);
    expect(info.genesisHash).toBeNull();
    expect(info.genesisVerified).toBe(false);

    // Before the first sync the plan is empty and nothing has been scanned. Both
    // heights are null — not zero, not a guess.
    const before = await wallet.syncStatus();
    expect(before.ranges).toEqual([]);
    expect(before.syncedHeight).toBeNull();
    expect(before.syncing).toBe(false);

    // The addon answers objects with `encoded_address`; 0.1.0 read strings and
    // `address` and answered two empty lists here. This is the line that failed.
    const addresses = await wallet.addresses();
    const [receive] = addresses.unified;
    say(`receive address: ${receive}`);
    expect(receive).toBeDefined();
    expect(receive!.startsWith(`${SWARM_MAINNET_PROFILE.unifiedHrp}1`)).toBe(true);
    // Not a Zcash address, not a SwarmTestnet address, by construction.
    expect(receive!.startsWith("u1")).toBe(false);
    expect(receive!.startsWith("swarm1")).toBe(false);
    // And the transparent list, which has the same shape with a `scope`.
    expect(addresses.transparent).toHaveLength(1);
    expect(addresses.transparent[0]).toMatch(/^s[13]/);

    const verdict = await wallet.parseAddress(receive!);
    expect(verdict.valid).toBe(true);

    // The recovery phrase is readable through the package — 0.1.0 threw here,
    // reading `seed` where the addon writes `seed_phrase`. Only its word count
    // is looked at, and nothing about it goes into `output`.
    const recovery = await wallet.seedPhrase();
    expect(recovery.phrase.trim().split(/\s+/)).toHaveLength(24);
    expect(recovery.birthdayHeight).toBeGreaterThan(0);

    let lastProgress = -1;
    wallet.on("status", (status) => {
      if (status.progress !== null && status.progress > lastProgress + 0.19) {
        lastProgress = status.progress;
        say(`sync ${(status.progress * 100).toFixed(0)}% (${status.syncedHeight}/${status.chainHeight})`);
      }
    });
    const synced = await wallet.sync();
    say(`synced to ${synced.syncedHeight} of ${synced.chainHeight} (${synced.ranges.length} ranges)`);
    // Heights come out of `scan_ranges`; 0.1.0 answered null for both. A finished
    // run has every range Scanned, so the synced height IS the chain height, and
    // the chain the sync saw is at least as high as the server said before it.
    expect(synced.chainHeight).toBeGreaterThan(0);
    expect(synced.syncedHeight).toBe(synced.chainHeight);
    expect(synced.chainHeight!).toBeGreaterThanOrEqual(info.blockHeight!);
    expect(synced.progress).toBe(1);
    expect(synced.ranges.length).toBeGreaterThan(0);
    expect(synced.ranges.every((range) => range.priority === "Scanned")).toBe(true);
    expect(synced.blocksScanned).toBeGreaterThan(0);

    // The balance reads through the addon's twelve confirmed_/unconfirmed_/total_
    // pool keys; 0.1.0 refused this object as unreadable.
    const balance = await wallet.balance();
    say(`balance: ${balance.totalZat} zatoshi total, ${balance.spendableZat} spendable`);
    // A wallet created seconds ago on a chain nobody has paid it on.
    expect(balance.totalZat).toBe(0n);
    expect(balance.spendableZat).toBe(0n);
    expect(balance.confirmedZat).toBe(0n);
    expect(balance.orchardZat).toBe(0n);
    expect(balance.saplingZat).toBe(0n);
    expect(balance.transparentZat).toBe(0n);
    expect(balance.ironwoodZat).toBe(0n);

    expect(await wallet.transactions()).toEqual([]);

    await wallet.close();
    const closed = wallet;
    wallet = null;
    // The plaintext is gone and the sealed copy is there.
    expect(existsSync(closed.store.paths.workingFile)).toBe(false);
    expect(existsSync(closed.store.paths.encryptedFile!)).toBe(true);
  }, 900_000);

  it("printed no seed phrase", () => {
    const everything = output.join("\n");
    expect(LOOKS_LIKE_A_SEED.test(everything), `output looked like a seed: ${everything}`).toBe(
      false,
    );
    for (const word of ["abandon", "seed", "mnemonic", "recovery", "phrase"]) {
      expect(everything.toLowerCase()).not.toContain(word);
    }
  });
});
