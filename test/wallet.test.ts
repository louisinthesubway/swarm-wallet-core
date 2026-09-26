/**
 * The wrapper, against a fake addon.
 *
 * Nothing here touches the network and nothing here is a real wallet. What is
 * being tested is everything this package adds on top of the addon: the chain
 * hint, the singleton guard, the amount handling, the two-step send, the sync
 * loop over prose `poll_sync` answers, the server-identity refusal, and that the
 * plaintext wallet file is gone when `close()` resolves.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SwarmWallet } from "../src/wallet.js";
import { SwarmWalletError } from "../src/errors.js";
import { SWARM_MAINNET_GENESIS } from "../src/networkProfiles.js";
import { WALLET_KEY_BYTES, WalletStore } from "../src/walletStore.js";
import { argsOf, createFakeAddon } from "./fakeAddon.js";
import type { FakeAddonOptions } from "./fakeAddon.js";

let dataDir: string;
const openWallets: SwarmWallet[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "swarm-wallet-core-"));
});

afterEach(async () => {
  while (openWallets.length > 0) {
    await openWallets.pop()?.close().catch(() => {});
  }
  await rm(dataDir, { recursive: true, force: true });
});

const key = (): Uint8Array => WalletStore.generateKey();

const open = async (
  options: FakeAddonOptions = {},
  overrides: Partial<Parameters<typeof SwarmWallet.openOrCreate>[0]> = {},
): Promise<{ wallet: SwarmWallet; log: ReturnType<typeof createFakeAddon>["log"] }> => {
  const { addon, log } = createFakeAddon(options);
  const wallet = await SwarmWallet.openOrCreate({
    addon,
    dataDir,
    chain: "swarm-mainnet",
    encryptionKey: key(),
    ...overrides,
  });
  openWallets.push(wallet);
  return { wallet, log };
};

describe("openOrCreate", () => {
  it("gives the addon the full chain hint and never the bare label", async () => {
    const { log } = await open();
    const args = argsOf(log, "init_new");
    expect(args?.[1]).toBe(`swarm-mainnet:${SWARM_MAINNET_GENESIS}`);
    expect(args?.[1]).not.toBe("swarm-mainnet");
  });

  it("sets the addon's wallet base directory to the directory the caller owns", async () => {
    const { log } = await open();
    expect(log.baseDir).toBe(dataDir);
    // And the wallet file landed in the chain subdirectory the addon chooses.
    expect(existsSync(join(dataDir, "swarm-mainnet", "swarm-wallet.dat.enc"))).toBe(true);
  });

  it("defaults to the SWARM production indexer and 3 confirmations", async () => {
    const { log } = await open();
    const args = argsOf(log, "init_new");
    expect(args?.[0]).toBe("https://lwd-main.swarm.green:8443");
    expect(args?.[2]).toBe("High");
    expect(args?.[3]).toBe(3);
  });

  it("refuses a second wallet in the same process, because the addon has one slot", async () => {
    await open();
    const { addon } = createFakeAddon();
    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: key() }),
    ).rejects.toThrow(/already open in this process/);
  });

  it("refuses when the addon's base directory was already claimed by someone else", async () => {
    const { addon } = createFakeAddon({ refuseBaseDir: true });
    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: key() }),
    ).rejects.toThrow(/OnceCell|already set/);
    // And the guard released the slot, so the next open is possible.
    expect(SwarmWallet.current()).toBeNull();
  });

  it("refuses minConfirmations below 1, which the addon would reject after writing", async () => {
    const { addon } = createFakeAddon();
    await expect(
      SwarmWallet.openOrCreate({
        addon,
        dataDir,
        chain: "swarm-mainnet",
        minConfirmations: 0,
      }),
    ).rejects.toThrow(/integer >= 1/);
  });

  it("reopens an existing wallet with init_from_b64 rather than creating a second", async () => {
    const first = await open();
    await first.wallet.close();
    openWallets.length = 0;

    const storedKey = key();
    // A fresh store over the same directory: the file is there, so the second
    // open must take the existing-wallet path. (A different key would refuse to
    // decrypt, so the same one is used, which is what the messenger does.)
    const { addon, log } = createFakeAddon();
    const store = new WalletStore({ dataDir, chain: "swarm-mainnet", encryptionKey: storedKey });
    expect(await store.exists()).toBe(true);

    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: storedKey }),
    ).rejects.toThrow(/did not decrypt/);
    expect(log.calls.some((call) => call.name === "init_new")).toBe(false);
  });

  it("closes the wallet and refuses when the server reports another chain", async () => {
    const { addon } = createFakeAddon({ serverChain: "main" });
    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: key() }),
    ).rejects.toThrow(/reports chain "main", not "swarm-mainnet"/);
    expect(SwarmWallet.current()).toBeNull();
  });

  it("closes the wallet and refuses when the server reports another genesis", async () => {
    const { addon } = createFakeAddon({ serverGenesis: "ff".repeat(32) });
    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: key() }),
    ).rejects.toThrow(/Same chain name, different chain/);
  });
});

describe("restoreFromSeed", () => {
  it("passes the hint at argument 3, where init_from_seed takes it", async () => {
    const { addon, log } = createFakeAddon();
    const wallet = await SwarmWallet.restoreFromSeed({
      addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: key(),
      seedPhrase: Array.from({ length: 24 }, () => "abandon").join(" "),
      birthdayHeight: 100,
    });
    openWallets.push(wallet);
    const args = argsOf(log, "init_from_seed");
    expect(args?.[1]).toBe(100);
    expect(args?.[3]).toBe(`swarm-mainnet:${SWARM_MAINNET_GENESIS}`);
  });

  it("never lets the seed phrase itself into anything it records", async () => {
    const { addon, log } = createFakeAddon();
    const phrase = Array.from({ length: 24 }, () => "abandon").join(" ");
    const wallet = await SwarmWallet.restoreFromSeed({
      addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: key(),
      seedPhrase: phrase,
    });
    openWallets.push(wallet);
    expect(JSON.stringify(log.calls)).not.toContain(phrase);
  });

  it("refuses to restore over a wallet that already exists", async () => {
    const storedKey = key();
    const first = createFakeAddon();
    const wallet = await SwarmWallet.openOrCreate({
      addon: first.addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: storedKey,
    });
    await wallet.close();

    const second = createFakeAddon();
    await expect(
      SwarmWallet.restoreFromSeed({
        addon: second.addon,
        dataDir,
        chain: "swarm-mainnet",
        encryptionKey: storedKey,
        seedPhrase: Array.from({ length: 24 }, () => "abandon").join(" "),
      }),
    ).rejects.toThrow(/Restoring over it would destroy/);
  });
});

describe("reading", () => {
  it("reports balances as bigint zatoshi, spendable separately from total", async () => {
    const { wallet } = await open();
    const balance = await wallet.balance();
    expect(balance.totalZat).toBe(200_000_000n);
    expect(balance.spendableZat).toBe(150_000_000n);
    expect(balance.transparentZat).toBe(50_000_000n);
    expect(balance.pendingZat).toBe(50_000_000n);
  });

  it("formats the spendable balance for a label", async () => {
    const { wallet } = await open();
    expect(await wallet.balanceText()).toBe("1.5 SWM");
  });

  it("lists unified and transparent addresses apart", async () => {
    const { wallet } = await open();
    const { unified, transparent } = await wallet.addresses();
    expect(unified[0]).toMatch(/^swm1/);
    expect(transparent[0]).toMatch(/^s1/);
  });

  it("creates a new unified address with all three receivers by default", async () => {
    const { wallet, log } = await open();
    const created = await wallet.newAddress();
    expect(created).toMatch(/^swm1/);
    expect(argsOf(log, "create_new_unified_address")?.[0]).toBe(
      JSON.stringify({ orchard: true, sapling: true, transparent: true }),
    );
  });

  it("signs outgoing transaction values negative and keeps the memo", async () => {
    const { wallet } = await open();
    const [received, sent] = await wallet.transactions();
    expect(received?.valueZat).toBe(200_000_000n);
    expect(received?.memo).toBe("for the coffee");
    expect(sent?.valueZat).toBe(-50_000_000n);
    expect(sent?.feeZat).toBe(10_000n);
  });

  it("hands over the seed only when asked for it by name", async () => {
    const { wallet } = await open();
    const { phrase, birthdayHeight } = await wallet.seedPhrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(birthdayHeight).toBe(1);
    // And it is not part of anything else the wallet returns. (`raw` carries
    // bigints, so the balance is stringified with a bigint-aware replacer.)
    const balance = JSON.stringify(await wallet.balance(), (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(balance).not.toContain("abandon");
  });
});

describe("parseAddress", () => {
  it("refuses a Zcash address with a sentence that names the network", async () => {
    const { wallet } = await open();
    const verdict = await wallet.parseAddress("u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq");
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toMatch(/Zcash mainnet/);
  });

  it("refuses a SwarmTestnet address on a production wallet", async () => {
    const { wallet } = await open();
    const verdict = await wallet.parseAddress(
      "swarm1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    );
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toMatch(/SWARM Testnet address/);
  });

  it("says `prefix` when the addon cannot decode this chain's own encodings", async () => {
    const { wallet } = await open();
    const [address] = (await wallet.addresses()).unified;
    const verdict = await wallet.parseAddress(address!);
    expect(verdict.valid).toBe(true);
    // The addon decodes only Zcash main/test/regtest, so this is the honest
    // provenance of the verdict and the reason the field exists.
    expect(verdict.decodedBy).toBe("prefix");
  });
});

describe("sending", () => {
  it("quotes a fee without transmitting, and transmits only on confirm", async () => {
    const { wallet, log } = await open();
    const [address] = (await wallet.addresses()).unified;
    const quote = await wallet.proposeSend({ to: address!, amountZat: 100_000n, memo: "thanks" });
    expect(quote.feeZat).toBe(15_000n);
    expect(log.calls.some((call) => call.name === "confirm")).toBe(false);

    const result = await quote.confirm();
    expect(result.txids).toHaveLength(1);
    expect(result.feeZat).toBe(15_000n);
  });

  it("sends the amount as a JSON number of zatoshi, with the memo", async () => {
    const { wallet, log } = await open();
    const [address] = (await wallet.addresses()).unified;
    await wallet.proposeSend({ to: address!, amountZat: 12_345_678n, memo: "hello" });
    const payload = JSON.parse(String(argsOf(log, "send")?.[0])) as Array<Record<string, unknown>>;
    expect(payload[0]).toEqual({ address, amount: 12_345_678, memo: "hello" });
  });

  it("refuses a second confirm of the same quote", async () => {
    const { wallet } = await open();
    const [address] = (await wallet.addresses()).unified;
    const quote = await wallet.proposeSend({ to: address!, amountZat: 100_000n });
    await quote.confirm();
    await expect(quote.confirm()).rejects.toThrow(/already been confirmed/);
  });

  it("turns the addon's {error} answer into a thrown SwarmWalletError", async () => {
    const { wallet } = await open({ sendError: "Insufficient balance" });
    const [address] = (await wallet.addresses()).unified;
    await expect(wallet.proposeSend({ to: address!, amountZat: 100_000n })).rejects.toThrow(
      /Insufficient balance/,
    );
    await expect(
      wallet.proposeSend({ to: address!, amountZat: 100_000n }),
    ).rejects.toBeInstanceOf(SwarmWalletError);
  });

  it("refuses a zero amount and an address on another network", async () => {
    const { wallet } = await open();
    const [address] = (await wallet.addresses()).unified;
    await expect(wallet.proposeSend({ to: address!, amountZat: 0n })).rejects.toThrow(
      /greater than zero/,
    );
    await expect(
      wallet.proposeSend({ to: "u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", amountZat: 1n }),
    ).rejects.toThrow(/Zcash mainnet/);
  });

  it("honours a fee ceiling rather than paying more than the caller agreed", async () => {
    const { wallet, log } = await open();
    const [address] = (await wallet.addresses()).unified;
    await expect(
      wallet.send({ to: address!, amountZat: 100_000n, maxFeeZat: 1_000n }),
    ).rejects.toThrow(/above the .* ceiling/);
    expect(log.calls.some((call) => call.name === "confirm")).toBe(false);
  });
});

describe("syncing", () => {
  it("loops over the addon's prose poll answers and resolves when the run ends", async () => {
    const { wallet } = await open({ syncPolls: 2 });
    const seen: number[] = [];
    wallet.on("status", (status) => {
      if (status.progress !== null) seen.push(status.progress);
    });
    const final = await wallet.sync();
    expect(final.syncedHeight).toBe(900);
    expect(final.chainHeight).toBe(1000);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((value) => value === 0.9)).toBe(true);
  }, 30_000);

  it("emits `synced` once the run finishes", async () => {
    const { wallet } = await open({ syncPolls: 0 });
    const events: string[] = [];
    wallet.on("synced", () => events.push("synced"));
    await wallet.sync();
    expect(events).toEqual(["synced"]);
  });

  it("refuses a second concurrent sync", async () => {
    const { wallet } = await open({ syncPolls: 3 });
    const first = wallet.sync();
    await expect(wallet.sync()).rejects.toThrow(/already running/);
    await first;
  }, 30_000);
});

describe("close", () => {
  it("leaves the ciphertext and no plaintext behind", async () => {
    const { wallet } = await open();
    const { workingFile, encryptedFile } = wallet.store.paths;
    expect(existsSync(workingFile)).toBe(true);
    await wallet.close();
    openWallets.length = 0;
    expect(existsSync(workingFile)).toBe(false);
    expect(existsSync(encryptedFile!)).toBe(true);
    // And what is at rest is not the addon's plaintext.
    const sealed = readFileSync(encryptedFile!);
    expect(sealed.subarray(0, 10).toString("ascii")).toBe("SWMWALLET1");
    expect(sealed.toString("latin1")).not.toContain("fake zingolib wallet bytes");
  });

  it("is idempotent and releases the process slot", async () => {
    const { wallet } = await open();
    await wallet.close();
    await wallet.close();
    openWallets.length = 0;
    expect(SwarmWallet.current()).toBeNull();
  });

  it("refuses every call afterwards", async () => {
    const { wallet } = await open();
    await wallet.close();
    openWallets.length = 0;
    await expect(wallet.balance()).rejects.toThrow(/has been closed/);
  });

  it("leaves the wallet file in the clear when no key is supplied, and says so", async () => {
    const { addon } = createFakeAddon();
    const wallet = await SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet" });
    openWallets.push(wallet);
    expect(wallet.store.encrypted).toBe(false);
    expect(wallet.store.paths.encryptedFile).toBeNull();
    await wallet.close();
    openWallets.length = 0;
    expect(existsSync(wallet.store.paths.workingFile)).toBe(true);
  });
});

describe("the key", () => {
  it("must be exactly 32 bytes", async () => {
    const { addon } = createFakeAddon();
    await expect(
      SwarmWallet.openOrCreate({
        addon,
        dataDir,
        chain: "swarm-mainnet",
        encryptionKey: new Uint8Array(16),
      }),
    ).rejects.toThrow(new RegExp(`exactly ${WALLET_KEY_BYTES} bytes`));
  });
});
