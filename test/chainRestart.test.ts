/**
 * The move onto the SWARM Mainnet chain restarted on 2 October 2026, at the
 * package level, against the fake addon.
 *
 * The native half — that the fresh wallet holds the same keys and addresses,
 * that its birthday is block 1, that the backup is the old file byte for byte,
 * that a failed write leaves the file unchanged — is proven by the Rust tests
 * in `native/src/chain_restart.rs` (copied from the desktop wallet) and by the
 * live run. What is proven HERE is everything this package adds around it:
 * which wallets are moved and which are not, that the move happens before the
 * file is opened, that in encrypted mode no plaintext copy of the wallet is
 * left on disk, that the record is written only after a move succeeded, and
 * that a failed move opens nothing and changes nothing.
 */

import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHAIN_RESTART_NOTICE,
  NETWORK_RECORD_SCHEMA,
  readNetworkRecord,
  recordNeedsMove,
} from "../src/chainRestart.js";
import type { NetworkRecord } from "../src/chainRestart.js";
import { loadNativeAddon } from "../src/nativeAddon.js";
import {
  SWARM_MAINNET_ABANDONED_GENESIS,
  SWARM_MAINNET_GENESIS,
  SWARM_TESTNET_PROFILE,
} from "../src/networkProfiles.js";
import { SwarmWallet } from "../src/wallet.js";
import { WalletStore } from "../src/walletStore.js";
import { createFakeAddon } from "./fakeAddon.js";
import type { FakeAddonOptions } from "./fakeAddon.js";

let dataDir: string;
const openWallets: SwarmWallet[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "swarm-wallet-core-restart-"));
});

afterEach(async () => {
  while (openWallets.length > 0) {
    await openWallets.pop()?.close().catch(() => {});
  }
  await rm(dataDir, { recursive: true, force: true });
});

const chainDir = (): string => join(dataDir, "swarm-mainnet");
const recordFile = (): string => join(chainDir(), "swarm-wallet.dat.network.json");
const cipherFile = (): string => join(chainDir(), "swarm-wallet.dat.enc");
const workingFile = (): string => join(chainDir(), "swarm-wallet.dat");

/** Opens and closes the container the way WalletStore seals it. */
const unseal = (sealed: Buffer, key: Uint8Array): Buffer => {
  const magic = Buffer.from("SWMWALLET1", "ascii");
  expect(sealed.subarray(0, magic.length).equals(magic)).toBe(true);
  const nonce = sealed.subarray(magic.length, magic.length + 12);
  const tag = sealed.subarray(magic.length + 12, magic.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.concat([magic, nonce]));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(magic.length + 28)), decipher.final()]);
};

/**
 * A wallet as 0.2.0 left it: a sealed file and NO network record. 0.2.0 only
 * ever knew the abandoned chain, so that is what such a file holds.
 */
const legacyWallet = async (
  walletKey: Uint8Array | undefined,
  options: FakeAddonOptions = {},
): Promise<ReturnType<typeof createFakeAddon>> => {
  const fake = createFakeAddon(options);
  const wallet = await SwarmWallet.openOrCreate({
    addon: fake.addon,
    dataDir,
    chain: "swarm-mainnet",
    ...(walletKey === undefined ? {} : { encryptionKey: walletKey }),
  });
  await wallet.close();
  await rm(recordFile(), { force: true });
  return fake;
};

const reopen = async (
  fake: ReturnType<typeof createFakeAddon>,
  walletKey: Uint8Array | undefined,
  extra: Partial<Parameters<typeof SwarmWallet.openOrCreate>[0]> = {},
): Promise<SwarmWallet> => {
  const wallet = await SwarmWallet.openOrCreate({
    addon: fake.addon,
    dataDir,
    chain: "swarm-mainnet",
    ...(walletKey === undefined ? {} : { encryptionKey: walletKey }),
    ...extra,
  });
  openWallets.push(wallet);
  return wallet;
};

describe("which wallets are moved", () => {
  it("moves a SWARM Mainnet wallet with no record, or a record naming another genesis", () => {
    expect(recordNeedsMove("swarm-mainnet", null)).toBe(true);
    const at = (genesis: string): NetworkRecord => ({
      schema: NETWORK_RECORD_SCHEMA,
      chain: "swarm-mainnet",
      genesis,
      writtenUtc: "2026-10-03T00:00:00Z",
    });
    expect(recordNeedsMove("swarm-mainnet", at(SWARM_MAINNET_ABANDONED_GENESIS))).toBe(true);
    expect(recordNeedsMove("swarm-mainnet", at("ab".repeat(32)))).toBe(true);
    expect(recordNeedsMove("swarm-mainnet", at(SWARM_MAINNET_GENESIS))).toBe(false);
  });

  it("never moves a wallet on any other network", () => {
    expect(recordNeedsMove("swarm-testnet", null)).toBe(false);
    expect(recordNeedsMove("main", null)).toBe(false);
    expect(recordNeedsMove("test", null)).toBe(false);
    expect(recordNeedsMove("regtest", null)).toBe(false);
    expect(recordNeedsMove("nonsense", null)).toBe(false);
  });

  it("answers needsMoveToRestartedChain from the files alone, without the addon or the key", async () => {
    const walletKey = WalletStore.generateKey();
    const location = { dataDir, chain: "swarm-mainnet", encryptionKey: walletKey };
    expect(await SwarmWallet.needsMoveToRestartedChain(location)).toBe(false); // nothing there
    const fake = await legacyWallet(walletKey);
    expect(await SwarmWallet.needsMoveToRestartedChain(location)).toBe(true);
    // Without a key the location means plaintext mode, which looks for the
    // plaintext file only: the caller must describe the wallet it really has.
    expect(
      await SwarmWallet.needsMoveToRestartedChain({ dataDir, chain: "swarm-mainnet" }),
    ).toBe(false);
    await (await reopen(fake, walletKey)).close();
    openWallets.length = 0;
    expect(await SwarmWallet.needsMoveToRestartedChain(location)).toBe(false);
  });
});

describe("openOrCreate on a wallet from the abandoned chain", () => {
  it("moves it once, before it is opened, and leaves no plaintext copy behind", async () => {
    const walletKey = WalletStore.generateKey();
    const fake = await legacyWallet(walletKey);
    const sealedBefore = readFileSync(cipherFile());
    const plaintextBefore = unseal(sealedBefore, walletKey);
    const callsBefore = fake.log.calls.length;

    const wallet = await reopen(fake, walletKey);
    const calls = fake.log.calls.slice(callsBefore).map((call) => call.name);

    // The move comes before the file is opened, and with the full chain hint.
    const moved = calls.indexOf("move_wallet_to_restarted_chain");
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(moved).toBeLessThan(calls.indexOf("init_from_b64"));
    const moveCall = fake.log.calls.find((call) => call.name === "move_wallet_to_restarted_chain");
    expect(moveCall?.args[0]).toBe(`swarm-mainnet:${SWARM_MAINNET_GENESIS}`);

    // The report, with the sentence for the owner.
    const report = wallet.restartMove;
    expect(report).not.toBeNull();
    expect(report?.notice).toBe(CHAIN_RESTART_NOTICE);
    expect(report?.notice).toBe(
      "The SWARM network was restarted on 2 October 2026. Your addresses and recovery phrase are unchanged; balances start again from the new chain.",
    );
    expect(report?.genesis).toBe(SWARM_MAINNET_GENESIS);
    expect(report?.birthday).toBe(1);
    expect(report?.keyKind).toBe("seed");
    expect(report?.backupEncrypted).toBe(true);
    expect(report?.backupPath.endsWith(".bak.enc")).toBe(true);

    // The backup is sealed with the wallet's key and opens to the old file's
    // bytes exactly; its plaintext is gone.
    expect(unseal(readFileSync(report!.backupPath), walletKey).equals(plaintextBefore)).toBe(true);
    expect(existsSync(report!.backupPath.replace(/\.enc$/, ""))).toBe(false);
    const plaintextBackups = readdirSync(chainDir()).filter((name) => name.endsWith(".bak"));
    expect(plaintextBackups).toEqual([]);

    // The record names the restarted chain and what was done.
    const record = await readNetworkRecord(recordFile());
    expect(record?.genesis).toBe(SWARM_MAINNET_GENESIS);
    expect(record?.chain).toBe("swarm-mainnet");
    expect(record?.restart?.backupEncrypted).toBe(true);
    expect(record?.restart?.previousBirthday).toBe(6000);
    expect(record?.restart?.birthday).toBe(1);
    expect(JSON.stringify(record)).not.toMatch(/abandon|seed_phrase|uview|secret/);

    // The sealed wallet at rest is now the moved one.
    await wallet.close();
    openWallets.length = 0;
    const movedPlain = unseal(readFileSync(cipherFile()), walletKey).toString("utf8");
    expect(movedPlain).toMatch(/^fake (moved wallet|zingolib wallet bytes)/);
    expect(existsSync(workingFile())).toBe(false);
  });

  it("does not move it a second time", async () => {
    const walletKey = WalletStore.generateKey();
    const fake = await legacyWallet(walletKey);
    await (await reopen(fake, walletKey)).close();
    openWallets.length = 0;
    const before = fake.log.calls.length;
    const again = await reopen(fake, walletKey);
    expect(again.restartMove).toBeNull();
    expect(
      fake.log.calls.slice(before).some((call) => call.name === "move_wallet_to_restarted_chain"),
    ).toBe(false);
    expect(readdirSync(chainDir()).filter((name) => name.includes("before-network-restart"))).toHaveLength(1);
  });

  it("moves a wallet whose record names the abandoned genesis", async () => {
    const walletKey = WalletStore.generateKey();
    const fake = await legacyWallet(walletKey);
    writeFileSync(
      recordFile(),
      JSON.stringify({
        schema: NETWORK_RECORD_SCHEMA,
        chain: "swarm-mainnet",
        genesis: SWARM_MAINNET_ABANDONED_GENESIS,
        writtenUtc: "2026-09-30T00:00:00Z",
      }),
    );
    const wallet = await reopen(fake, walletKey);
    expect(wallet.restartMove).not.toBeNull();
    expect((await readNetworkRecord(recordFile()))?.genesis).toBe(SWARM_MAINNET_GENESIS);
  });

  it("in plaintext mode keeps the addon's plaintext backup, byte for byte", async () => {
    const fake = await legacyWallet(undefined);
    const before = readFileSync(workingFile());
    const wallet = await reopen(fake, undefined);
    const report = wallet.restartMove!;
    expect(report.backupEncrypted).toBe(false);
    expect(report.backupPath.endsWith(".bak")).toBe(true);
    expect(readFileSync(report.backupPath).equals(before)).toBe(true);
    expect((await readNetworkRecord(recordFile()))?.restart?.backupEncrypted).toBe(false);
  });

  it("refuses instead of moving when asked to, and changes nothing", async () => {
    const walletKey = WalletStore.generateKey();
    const fake = await legacyWallet(walletKey);
    const sealedBefore = readFileSync(cipherFile());
    const before = fake.log.calls.length;
    await expect(reopen(fake, walletKey, { restartedChain: "refuse" })).rejects.toMatchObject({
      code: "wrong-chain",
    });
    const calls = fake.log.calls.slice(before).map((call) => call.name);
    expect(calls).not.toContain("move_wallet_to_restarted_chain");
    expect(calls).not.toContain("init_from_b64");
    expect(readFileSync(cipherFile()).equals(sealedBefore)).toBe(true);
    expect(existsSync(recordFile())).toBe(false);
    expect(existsSync(workingFile())).toBe(false);
    expect(SwarmWallet.current()).toBeNull();
  });

  it("opens nothing and changes nothing when the move fails", async () => {
    const walletKey = WalletStore.generateKey();
    await legacyWallet(walletKey);
    const sealedBefore = readFileSync(cipherFile());
    const failing = createFakeAddon({ moveError: "the fresh wallet's keys differ from the file's" });
    // A separate fake for the failing open: the store and the record are on
    // disk, which is all that carries over between processes.
    await expect(
      SwarmWallet.openOrCreate({
        addon: failing.addon,
        dataDir,
        chain: "swarm-mainnet",
        encryptionKey: walletKey,
      }),
    ).rejects.toThrow(/keys differ/);
    expect(failing.log.calls.some((call) => call.name === "init_from_b64")).toBe(false);
    expect(readFileSync(cipherFile()).equals(sealedBefore)).toBe(true);
    expect(existsSync(recordFile())).toBe(false);
    expect(existsSync(workingFile())).toBe(false);
    expect(SwarmWallet.current()).toBeNull();
  });

  it("seals a plaintext backup that an interrupted earlier move left behind", async () => {
    const walletKey = WalletStore.generateKey();
    const fake = await legacyWallet(walletKey);
    const leftover = join(chainDir(), "swarm-wallet.dat.before-network-restart-1790000000.bak");
    writeFileSync(leftover, "plaintext wallet bytes from a crash");
    await reopen(fake, walletKey);
    expect(existsSync(leftover)).toBe(false);
    expect(unseal(readFileSync(`${leftover}.enc`), walletKey).toString("utf8")).toBe(
      "plaintext wallet bytes from a crash",
    );
    expect(readdirSync(chainDir()).filter((name) => name.endsWith(".bak"))).toEqual([]);
  });
});

describe("moveWalletToRestartedChain", () => {
  it("moves without opening, then openOrCreate opens without moving", async () => {
    const walletKey = WalletStore.generateKey();
    const fake = await legacyWallet(walletKey);
    const report = await SwarmWallet.moveWalletToRestartedChain({
      addon: fake.addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: walletKey,
    });
    expect(report?.backupEncrypted).toBe(true);
    expect(fake.log.calls.some((call) => call.name === "init_from_b64")).toBe(false);
    expect(existsSync(workingFile())).toBe(false);
    expect(SwarmWallet.current()).toBeNull();

    const wallet = await reopen(fake, walletKey);
    expect(wallet.restartMove).toBeNull();
    // Nothing to do the second time.
    await wallet.close();
    openWallets.length = 0;
    expect(
      await SwarmWallet.moveWalletToRestartedChain({
        addon: fake.addon,
        dataDir,
        chain: "swarm-mainnet",
        encryptionKey: walletKey,
      }),
    ).toBeNull();
  });
});

describe("the record a new wallet gets", () => {
  it("names the restarted chain's genesis on create, so it is never moved", async () => {
    const fake = createFakeAddon();
    const wallet = await SwarmWallet.openOrCreate({
      addon: fake.addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: WalletStore.generateKey(),
    });
    openWallets.push(wallet);
    const record = await readNetworkRecord(recordFile());
    expect(record?.schema).toBe(NETWORK_RECORD_SCHEMA);
    expect(record?.genesis).toBe(SWARM_MAINNET_GENESIS);
    expect(record?.restart).toBeUndefined();
    expect(wallet.restartMove).toBeNull();
  });

  it("names it on restore too", async () => {
    const fake = createFakeAddon();
    const wallet = await SwarmWallet.restoreFromSeed({
      addon: fake.addon,
      dataDir,
      chain: "swarm-mainnet",
      seedPhrase: Array.from({ length: 24 }, () => "word").join(" "),
    });
    openWallets.push(wallet);
    expect((await readNetworkRecord(recordFile()))?.genesis).toBe(SWARM_MAINNET_GENESIS);
  });

  it("never moves a testnet wallet, record or not", async () => {
    const fake = createFakeAddon({ serverChain: "swarm-testnet", serverGenesis: SWARM_TESTNET_PROFILE.genesis! });
    const first = await SwarmWallet.openOrCreate({ addon: fake.addon, dataDir, chain: "swarm-testnet" });
    await first.close();
    await rm(join(dataDir, "swarm-testnet", "swarm-wallet.dat.network.json"), { force: true });
    const again = await SwarmWallet.openOrCreate({ addon: fake.addon, dataDir, chain: "swarm-testnet" });
    openWallets.push(again);
    expect(again.restartMove).toBeNull();
    expect(fake.log.calls.some((call) => call.name === "move_wallet_to_restarted_chain")).toBe(false);
  });
});

describe("loadNativeAddon", () => {
  it("refuses a 0.2.0 addon, which cannot move a wallet off the abandoned chain", async () => {
    const path = join(dataDir, "old-addon.cjs");
    writeFileSync(path, "module.exports = { init_new() {}, init_from_b64() {} };\n");
    expect(() => loadNativeAddon(path)).toThrow(/before the network restart of 2 October 2026/);
  });
});
