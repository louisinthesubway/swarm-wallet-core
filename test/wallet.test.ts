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

/**
 * Opens a wallet on a fresh fake addon and hands back the addon too.
 *
 * The addon matters to a caller: one process has one addon and one OnceCell'd
 * base directory, so a test about reopening has to reuse this one rather than
 * make a second.
 */
const open = async (
  options: FakeAddonOptions = {},
  overrides: Partial<Parameters<typeof SwarmWallet.openOrCreate>[0]> = {},
): Promise<{
  wallet: SwarmWallet;
  log: ReturnType<typeof createFakeAddon>["log"];
  addon: ReturnType<typeof createFakeAddon>["addon"];
}> => {
  const { addon, log } = createFakeAddon(options);
  const wallet = await SwarmWallet.openOrCreate({
    addon,
    dataDir,
    chain: "swarm-mainnet",
    encryptionKey: key(),
    ...overrides,
  });
  openWallets.push(wallet);
  return { wallet, log, addon };
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
    const storedKey = key();
    const first = await open({}, { encryptionKey: storedKey });
    await first.wallet.close();
    openWallets.length = 0;

    // The SAME addon object, because one process has one addon and one
    // OnceCell'd base directory. Handing the reopen a second fake would give it a
    // fresh cell and dodge the very thing this test is named for.
    const log = first.log;
    const before = log.calls.length;
    const wallet = await SwarmWallet.openOrCreate({
      addon: first.addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: storedKey,
    });
    openWallets.push(wallet);
    const after = log.calls.slice(before);
    expect(after.some((call) => call.name === "init_from_b64")).toBe(true);
    expect(after.some((call) => call.name === "init_new")).toBe(false);
    // And the reopen was given the full hint too, not just the creation.
    expect(after.find((call) => call.name === "init_from_b64")?.args[1]).toBe(
      `swarm-mainnet:${SWARM_MAINNET_GENESIS}`,
    );
  });

  it("reopens in the same process although set_wallet_base_dir answers false", async () => {
    // The addon's base dir is a OnceCell with no getter and no reset: the second
    // call returns false even for the identical path. Treating that as fatal made
    // close-then-reopen impossible, which is the ordinary flow after an error, an
    // account switch, or the wrong-chain refusal.
    const storedKey = key();
    const first = await open({}, { encryptionKey: storedKey });
    await first.wallet.close();
    openWallets.length = 0;

    const second = await SwarmWallet.openOrCreate({
      addon: first.addon,
      dataDir,
      chain: "swarm-mainnet",
      encryptionKey: storedKey,
    });
    openWallets.push(second);
    expect(second.store.paths.baseDir).toBe(dataDir);
    const setCalls = first.log.calls.filter((call) => call.name === "set_wallet_base_dir");
    // Once, not twice: the second open knows this process already did it.
    expect(setCalls).toHaveLength(1);
  });

  it("refuses a wallet sealed with a different key instead of overwriting it", async () => {
    const first = await open({}, { encryptionKey: key() });
    await first.wallet.close();
    openWallets.length = 0;

    const store = new WalletStore({ dataDir, chain: "swarm-mainnet", encryptionKey: key() });
    expect(await store.exists()).toBe(true);

    const { addon, log } = createFakeAddon();
    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: key() }),
    ).rejects.toThrow(/did not decrypt/);
    // Nothing was created over it. A lost key loses the file, and the answer is
    // restore-from-seed, never a new wallet written where the old one was.
    expect(log.calls.some((call) => call.name === "init_new")).toBe(false);
    expect(SwarmWallet.current()).toBeNull();
  });

  it("closes the wallet and refuses when the server reports another chain", async () => {
    const { addon } = createFakeAddon({ serverChain: "main" });
    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: key() }),
    ).rejects.toThrow(/reports chain "main", not "swarm-mainnet"/);
    expect(SwarmWallet.current()).toBeNull();
  });

  it("refuses another genesis IF the addon ever reports one", async () => {
    const { addon } = createFakeAddon({ serverGenesis: "ff".repeat(32) });
    await expect(
      SwarmWallet.openOrCreate({ addon, dataDir, chain: "swarm-mainnet", encryptionKey: key() }),
    ).rejects.toThrow(/Same chain name, different chain/);
  });

  it("says plainly that the genesis is NOT verified, because the addon reports none", async () => {
    // The honest state of the world. info_server builds its JSON by hand and
    // carries no genesis_hash, so the guard above cannot fire in production. A
    // caller that needs to know reads genesisVerified; the previous version had
    // a guard that looked tested only because the fake invented a field.
    const { wallet } = await open();
    const info = await wallet.serverInfo();
    expect(info.chainName).toBe("swarm-mainnet");
    expect(info.genesisHash).toBeNull();
    expect(info.genesisVerified).toBe(false);
    // And the height comes from latest_block_height, which is what the addon calls it.
    expect(info.blockHeight).toBe(1000);
    expect(info.consensusBranchId).toBe("c8e71055");
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

  it("reads the twelve keys the addon really answers, per pool and per state", async () => {
    // confirmed_/unconfirmed_/total_ × ironwood/orchard/sapling/transparent. 0.1.0
    // read `orchard_balance`, which is not among them, and refused every balance
    // this addon produced — correctly, rather than reporting zero, but a wallet
    // that refuses to state its balance is not a wallet.
    const { wallet, addon } = await open();
    const raw = JSON.parse(await addon.get_balance()) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(12);
    expect(raw).toHaveProperty("total_orchard_balance");
    expect(raw).not.toHaveProperty("orchard_balance");
    const balance = await wallet.balance();
    expect(balance.orchardZat).toBe(150_000_000n);
    expect(balance.saplingZat).toBe(0n);
    expect(balance.ironwoodZat).toBe(0n);
    expect(balance.confirmedZat).toBe(200_000_000n);
  });

  it("refuses a balance shape it cannot read, rather than reporting a wrong number", async () => {
    // A wallet screen showing 0 SWM for a funded wallet is the worst failure this
    // package can have, and a renamed SDK field is how it would happen.
    const { wallet } = await open({ unknownBalanceShape: true });
    await expect(wallet.balance()).rejects.toThrow(/cannot read/);
    await expect(wallet.balance()).rejects.toThrow(/wrong rather than one that is unknown/);
  });

  it("refuses when ONE pool field is renamed, not only when all of them are", async () => {
    // The dangerous case. With a per-pool fallback to 0n, renaming just the
    // orchard field reported a funded wallet as short by its entire shielded
    // balance — successfully, with no complaint.
    const { wallet } = await open({ renameOrchardBalance: true });
    await expect(wallet.balance()).rejects.toThrow(/no readable orchard balance/);
  });

  it("formats the spendable balance for a label", async () => {
    const { wallet } = await open();
    expect(await wallet.balanceText()).toBe("1.5 SWM");
  });

  it("reads the addresses out of encoded_address, which is where they are", async () => {
    const { wallet } = await open();
    const { unified, transparent } = await wallet.addresses();
    expect(unified[0]).toMatch(/^swm1/);
    expect(transparent[0]).toMatch(/^s1/);
  });

  it("leaves internal change addresses out of the transparent list", async () => {
    // `scope` is external / internal / refund. Offering a change address as
    // somewhere to be paid publishes the wallet's own bookkeeping.
    const { wallet } = await open();
    const { transparent } = await wallet.addresses();
    expect(transparent).toHaveLength(1);
    expect(transparent.join(" ")).not.toContain("Internal");
  });

  it("refuses an address list it cannot read, rather than saying there are none", async () => {
    // Every wallet has a unified address, so an empty list is a shape this version
    // does not understand. It used to come back as `unified: []`, which on a
    // Receive screen reads as "this wallet cannot be paid".
    const { wallet, addon } = await open();
    const original = addon.get_unified_addresses;
    addon.get_unified_addresses = async () =>
      JSON.stringify([{ account: 0, ua: "swm1somethingElseEntirely" }]);
    await expect(wallet.addresses()).rejects.toThrow(/no address could be read/);
    addon.get_unified_addresses = original;
  });

  it("reads the address out of `encoded_address`, where the addon puts it", async () => {
    // The addon answers objects — {account, address_index, has_orchard, …,
    // encoded_address} — not strings and not {address}. 0.1.0 read the latter two
    // and answered two empty lists for a wallet that had addresses, which a
    // caller cannot tell from "no addresses yet".
    const { wallet, addon } = await open();
    const raw = JSON.parse(await addon.get_unified_addresses()) as Array<Record<string, unknown>>;
    expect(raw[0]).toHaveProperty("encoded_address");
    expect(raw[0]).not.toHaveProperty("address");
    const { unified, transparent } = await wallet.addresses();
    expect(unified).toEqual([raw[0]!["encoded_address"]]);
    expect(transparent).toHaveLength(1);
  });

  it("asks for both shielded receivers with the FLAG STRING the addon reads", async () => {
    const { wallet, log } = await open();
    const created = await wallet.newAddress();
    expect(created).toMatch(/^swm1/);
    // "oz", not JSON. The addon reads receivers.contains('o') and
    // receivers.contains('z'); JSON.stringify({orchard:false,sapling:true})
    // contains an "o" (inside "orchard") and no "z", so it would have asked for
    // orchard only whatever the flags said.
    expect(argsOf(log, "create_new_unified_address")?.[0]).toBe("oz");
  });

  it("asks for sapling alone as \"z\", which JSON could never express", async () => {
    const { wallet, log } = await open();
    await wallet.newAddress({ orchard: false, sapling: true });
    expect(argsOf(log, "create_new_unified_address")?.[0]).toBe("z");
  });

  it("refuses a selection with no shielded receiver at all", async () => {
    const { wallet } = await open();
    await expect(wallet.newAddress({ orchard: false, sapling: false })).rejects.toThrow(
      /at least one shielded receiver/,
    );
  });

  it("reports a direction rather than guessing a sign, and keeps the memo", async () => {
    const { wallet } = await open();
    const [received, sent, enumShaped, unrecognised] = await wallet.transactions();

    expect(received?.direction).toBe("in");
    expect(received?.amountZat).toBe(200_000_000n);
    expect(received?.memo).toBe("for the coffee");

    expect(sent?.direction).toBe("out");
    expect(sent?.amountZat).toBe(50_000_000n);
    expect(sent?.feeZat).toBe(10_000n);

    // `{"Sent": {...}}` is a spend however the SDK chose to serialise it.
    expect(enumShaped?.kind).toBe("Sent");
    expect(enumShaped?.direction).toBe("out");

    // And a kind nothing recognises must read as unknown, not as income. The
    // previous version matched /sent|spend|outgoing/i over this string, so
    // anything it had not been shown became a positive amount: a spend displayed
    // as money arriving.
    expect(unrecognised?.kind).toBe("Rearrangement");
    expect(unrecognised?.direction).toBe("unknown");
    expect(unrecognised?.amountZat).toBe(2_000n);
  });

  it("hands over the seed only when asked for it by name", async () => {
    const { wallet, log, addon } = await open();
    // The addon's key is `seed_phrase` (zingolib's recovery info), not `seed`;
    // reading `seed` is why 0.1.0 threw "get_seed answered no seed".
    expect(Object.keys(JSON.parse(await addon.get_seed()) as object)).toEqual([
      "seed_phrase",
      "birthday",
      "no_of_accounts",
    ]);
    const { phrase, birthdayHeight } = await wallet.seedPhrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(birthdayHeight).toBe(1);
    // And nothing else asked the addon for it. (The previous version searched the
    // balance object for a seed word, which three fixed integers could never
    // contain — an assertion that cannot fail. What is worth checking is that
    // get_seed is called once, and only from here.)
    // Two: the check above, and seedPhrase(). Nothing else.
    expect(log.calls.filter((call) => call.name === "get_seed")).toHaveLength(2);
  });
});

describe("parseAddress", () => {
  it("refuses an address from another chain even on a chain with no SWARM profile", async () => {
    // `main`, `test` and `regtest` have no profile, so there is no prefix
    // pre-check in front of the addon — and the addon happily decodes a testnet
    // address and reports chain_name "test". Without comparing that, the verdict
    // came back valid and proposeSend went ahead with it.
    const { addon } = createFakeAddon();
    const wallet = await SwarmWallet.openOrCreate({
      addon,
      dataDir,
      chain: "main",
      server: "https://example.invalid:443",
      encryptionKey: key(),
      verifyServerIdentity: false,
    });
    openWallets.push(wallet);
    // The fake decodes u1…/t1… as chain_name "main", so that one is accepted…
    await expect(wallet.parseAddress("u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).resolves.toMatchObject({
      valid: true,
    });
    // …and one the addon decodes as a DIFFERENT chain is refused, with a sentence
    // naming both. Before this it came back valid and proposeSend went ahead.
    const verdict = await wallet.parseAddress("utest1anAddressOnZcashTestnet");
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) {
      expect(verdict.reason).toMatch(/belongs to "test" and this wallet is on "main"/);
    }
    await expect(
      wallet.proposeSend({ to: "utest1anAddressOnZcashTestnet", amountZat: 1n }),
    ).rejects.toThrow(/belongs to "test"/);
  });

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

  it("refuses a STALE quote, because the addon holds only the newest proposal", async () => {
    // The bug this prevents, in three lines: quote A for 1 000 to Alice, quote B
    // for 999 000 to Bob, then a.confirm() — which transmitted B, paying Bob,
    // and reported A's fee. The addon stores exactly one proposal and `confirm`
    // transmits whatever is in it.
    const { wallet, log } = await open();
    const [alice] = (await wallet.addresses()).unified;
    const bob = await wallet.newAddress();

    const a = await wallet.proposeSend({ to: alice!, amountZat: 1_000n });
    const b = await wallet.proposeSend({ to: bob, amountZat: 999_000n });

    await expect(a.confirm()).rejects.toThrow(/stale/);
    expect(log.calls.some((call) => call.name === "confirm")).toBe(false);
    // The newest quote still works, and it is the one the addon is holding.
    await expect(b.confirm()).resolves.toMatchObject({ feeZat: 15_000n });
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

  it("keeps the txids when the save after the transmit fails", async () => {
    // 0.1.0 persisted AFTER transmitting and let the persist throw — so a full
    // disk, or a save answer it could not read, turned a payment already on the
    // network into an exception with the txids inside it. Here the money has
    // moved: the txids come back, the save failure comes back beside them, and
    // the same error is emitted for a UI that only listens.
    const { wallet } = await open({ saveErrorAfterConfirm: "No space left on device" });
    const heard: SwarmWalletError[] = [];
    wallet.on("save-error", (error) => heard.push(error));
    const [address] = (await wallet.addresses()).unified;
    const quote = await wallet.proposeSend({ to: address!, amountZat: 100_000n });

    const result = await quote.confirm();
    expect(result.txids).toEqual(["cc".repeat(32)]);
    expect(result.feeZat).toBe(15_000n);
    expect(result.saved).toBe(false);
    expect(result.saveError).toBeInstanceOf(SwarmWalletError);
    expect(result.saveError?.message).toMatch(/No space left on device/);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBe(result.saveError);
    // The wallet is still open and usable; the disk is the problem, not the wallet.
    expect((await wallet.balance()).spendableZat).toBe(150_000_000n);
    // And close() still reports the save failure, as it always did.
    await expect(wallet.close()).rejects.toThrow(/No space left on device/);
    openWallets.length = 0;
  });

  it("reports a successful save as such", async () => {
    const { wallet } = await open();
    const [address] = (await wallet.addresses()).unified;
    const result = await (await wallet.proposeSend({ to: address!, amountZat: 100_000n })).confirm();
    expect(result.saved).toBe(true);
    expect(result.saveError).toBeNull();
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
  it("does not call an unlaunched sync a finished sync", async () => {
    // "Sync task has not been launched." used to be read as finished: sync()
    // persisted, emitted `synced` and resolved, telling the caller the wallet was
    // at the tip when nothing had scanned at all.
    const { wallet } = await open({ neverLaunches: true });
    const events: string[] = [];
    wallet.on("synced", () => events.push("synced"));
    await expect(wallet.sync()).rejects.toThrow(/has not been launched/);
    expect(events).toEqual([]);
  }, 60_000);

  it("loops over the addon's prose poll answers and resolves when the run ends", async () => {
    const { wallet } = await open({ syncPolls: 2 });
    const seen: number[] = [];
    wallet.on("status", (status) => {
      if (status.progress !== null) seen.push(status.progress);
    });
    const final = await wallet.sync();
    expect(final.syncedHeight).toBe(1000);
    expect(final.chainHeight).toBe(1000);
    expect(final.progress).toBe(1);
    // Two polls in flight at 90%, then the plan is all Scanned.
    expect(seen.slice(0, 2)).toEqual([0.9, 0.9]);
    expect(seen.at(-1)).toBe(1);
  }, 30_000);

  it("derives the heights from scan_ranges, which is all status_sync carries", async () => {
    // pepper_sync's status has no height field. It has a plan — ranges with
    // STRING block numbers and a priority — and counters. 0.1.0 read
    // `scan_height` / `chain_height`, which do not exist, and answered null for
    // both, so a caller could never tell a synced wallet from an unsynced one.
    const { wallet, addon } = await open({ syncPolls: 1 });
    const raw = JSON.parse(await addon.status_sync()) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("scan_height");
    expect(raw).not.toHaveProperty("chain_height");
    expect((raw["scan_ranges"] as Array<Record<string, unknown>>)[0]!["start_block"]).toBe("1");

    const status = await wallet.syncStatus();
    // The synced height stops at the top of the Scanned run from the bottom; the
    // chain height is the top of the highest range, whatever its state.
    expect(status.syncedHeight).toBe(900);
    expect(status.chainHeight).toBe(1000);
    expect(status.progress).toBe(0.9);
    expect(status.blocksScanned).toBe(900);
    expect(status.ranges).toEqual([
      { start: 1, end: 900, priority: "Scanned" },
      { start: 901, end: 1000, priority: "ChainTip" },
    ]);
    expect(status.syncing).toBe(false);
  });

  it("still reads an SDK revision that states the heights directly", async () => {
    const { wallet } = await open({ legacySyncStatus: true });
    const status = await wallet.syncStatus();
    expect(status.syncedHeight).toBe(900);
    expect(status.chainHeight).toBe(1000);
    expect(status.progress).toBe(0.9);
    expect(status.ranges).toEqual([]);
    expect(status.blocksScanned).toBeNull();
  });

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
  it("leaves the plaintext in place when the seal fails, and says so", async () => {
    // The plaintext used to be wiped in a `finally`, so a failed seal — a full
    // disk, an EPERM on the temp file, an antivirus holding it — destroyed the
    // only copy of the wallet and left a stale ciphertext or none at all.
    const { wallet, addon } = await open();
    const workingFile = wallet.store.paths.workingFile;
    expect(existsSync(workingFile)).toBe(true);

    // Break the seal by making the working file unreadable to the store: the
    // addon will "save" to a path the store no longer sees as a file.
    const { rm: remove, mkdir: makeDir } = await import("node:fs/promises");
    await remove(workingFile);
    await makeDir(workingFile);

    await expect(wallet.close()).rejects.toThrow(/could not be sealed|LEFT IN PLACE/);
    openWallets.length = 0;
    // Whatever is at that path, close() did not delete it behind an error.
    expect(existsSync(workingFile)).toBe(true);
    expect(addon).toBeDefined();
  });

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
