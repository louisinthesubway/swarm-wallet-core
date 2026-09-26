/**
 * A stand-in for `native.node`.
 *
 * It answers the JSON shapes the real addon answers, taken from the entry points
 * in `native/src/lib.rs` at wallet `745c2092` — including the two failure shapes
 * (a thrown `Error`, and a resolved `{"error": …}`), and including the prose
 * `poll_sync` answers, which are not JSON at all. A mock that answers tidier JSON
 * than the addon does is a mock that hides the bugs this wrapper exists to absorb.
 *
 * It also writes a wallet file, because `WalletStore` has one to encrypt and a
 * test that skips that step proves nothing about the sealing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChainHint, PerformanceLevel } from "../src/types.js";
import type { NativeAddon } from "../src/nativeAddon.js";

export type FakeAddonOptions = {
  /** Fail `init_new` with this message. */
  readonly initError?: string;
  /** What `info_server` reports. Defaults to matching SWARM production. */
  readonly serverChain?: string;
  readonly serverGenesis?: string;
  /** Refuse to accept the wallet base directory, as a second caller would. */
  readonly refuseBaseDir?: boolean;
  /** Make `send` answer `{"error": …}` instead of a fee. */
  readonly sendError?: string;
  /** How many `poll_sync` calls report "not complete" before the run ends. */
  readonly syncPolls?: number;
  /** Answer `get_balance` with a shape this version does not know. */
  readonly unknownBalanceShape?: boolean;
};

/** What the fake recorded, so a test can assert on the arguments it was given. */
export type FakeAddonLog = {
  readonly calls: Array<{ name: string; args: readonly unknown[] }>;
  baseDir: string | null;
};

export const createFakeAddon = (
  options: FakeAddonOptions = {},
): { addon: NativeAddon; log: FakeAddonLog } => {
  const log: FakeAddonLog = { calls: [], baseDir: null };
  let initialized = false;
  let walletFile: string | null = null;
  let addressCounter = 0;
  let pollsLeft = options.syncPolls ?? 1;
  let proposalStored = false;
  // A real bech32m string with a valid checksum, so the wrapper's own
  // pre-check accepts it exactly as it would accept a real address. A
  // checksum-invalid placeholder here would make every send test fail for the
  // wrong reason.
  const unified = [
    "swm1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khced2letk",
  ];
  const transparent = ["s1FakeTransparentAddressAaaaaaaaaaa"];

  const record = (name: string, ...args: unknown[]): void => {
    log.calls.push({ name, args });
  };

  const requireOpen = (name: string): void => {
    if (!initialized) throw new Error("Error: Lightclient is not initialized");
    record(name);
  };

  /** What every `init_*` does: claim the slot and write a wallet file. */
  const doInit = (name: string, walletName: string, args: readonly unknown[]): string => {
    record(name, ...args);
    if (options.initError) throw new Error(`initializing wallet: ${options.initError}`);
    if (log.baseDir === null) throw new Error("wallet base directory was never set");
    const chainHint = String(args[name === "init_from_seed" ? 3 : 1]);
    const subdirectory = chainHint.startsWith("swarm-mainnet")
      ? "swarm-mainnet"
      : chainHint === "swarm-testnet"
        ? "swarm-testnet"
        : "";
    walletFile = subdirectory
      ? join(log.baseDir, subdirectory, walletName)
      : join(log.baseDir, walletName);
    initialized = true;
    // A seed phrase shaped like the real one. Not a real seed: twenty-four
    // repetitions of one word, which no BIP-39 checksum accepts.
    return JSON.stringify({ seed: Array.from({ length: 24 }, () => "abandon").join(" "), birthday: 1 });
  };

  const addon: NativeAddon = {
    set_wallet_base_dir(path: string): boolean {
      record("set_wallet_base_dir", path);
      if (options.refuseBaseDir) return false;
      log.baseDir = path;
      return true;
    },

    deinitialize(): string {
      record("deinitialize");
      initialized = false;
      return "OK";
    },

    set_crypto_default_provider_to_ring(): string {
      record("set_crypto_default_provider_to_ring");
      return "OK";
    },

    wallet_exists(
      server: string,
      chainHint: ChainHint,
      performance: PerformanceLevel,
      minConfirmations: number,
      walletName: string,
    ): boolean {
      record("wallet_exists", server, chainHint, performance, minConfirmations, walletName);
      return walletFile !== null;
    },

    init_new(
      server: string,
      chainHint: ChainHint,
      performance: PerformanceLevel,
      minConfirmations: number,
      walletName: string,
    ): string {
      return doInit("init_new", walletName, [
        server,
        chainHint,
        performance,
        minConfirmations,
        walletName,
      ]);
    },

    init_from_seed(
      seed: string,
      birthday: number,
      server: string,
      chainHint: ChainHint,
      performance: PerformanceLevel,
      minConfirmations: number,
      walletName: string,
    ): string {
      // The seed is recorded as its length only. A fake that logs a seed phrase
      // teaches the habit this package exists to prevent.
      return doInit("init_from_seed", walletName, [
        `<${seed.split(/\s+/).length} words>`,
        birthday,
        server,
        chainHint,
        performance,
        minConfirmations,
        walletName,
      ]);
    },

    init_from_b64(
      server: string,
      chainHint: ChainHint,
      performance: PerformanceLevel,
      minConfirmations: number,
      walletName: string,
    ): string {
      return doInit("init_from_b64", walletName, [
        server,
        chainHint,
        performance,
        minConfirmations,
        walletName,
      ]);
    },

    async save_wallet_file(): Promise<string> {
      requireOpen("save_wallet_file");
      if (walletFile === null) throw new Error("no wallet path");
      mkdirSync(dirname(walletFile), { recursive: true });
      writeFileSync(walletFile, `fake zingolib wallet bytes ${log.calls.length}`);
      return JSON.stringify({ result: "success" });
    },

    async check_save_error(): Promise<string> {
      requireOpen("check_save_error");
      return JSON.stringify({ result: "success" });
    },

    async get_wallet_save_required(): Promise<string> {
      requireOpen("get_wallet_save_required");
      return JSON.stringify({ save_required: false });
    },

    async get_seed(): Promise<string> {
      requireOpen("get_seed");
      return JSON.stringify({
        seed: Array.from({ length: 24 }, () => "abandon").join(" "),
        birthday: 1,
      });
    },

    async get_ufvk(): Promise<string> {
      requireOpen("get_ufvk");
      return JSON.stringify({ ufvk: "uview1fake", birthday: 1 });
    },

    async get_balance(): Promise<string> {
      requireOpen("get_balance");
      if (options.unknownBalanceShape) {
        // What a renamed SDK field set would look like from here.
        return JSON.stringify({ pools: { orchard: 150_000_000 }, unit: "zatoshi" });
      }
      return JSON.stringify({
        orchard_balance: 150_000_000,
        sapling_balance: 0,
        transparent_balance: 50_000_000,
      });
    },

    async get_spendable_balance_total(): Promise<string> {
      requireOpen("get_spendable_balance_total");
      return JSON.stringify({ spendable_balance: 150_000_000 });
    },

    async get_unified_addresses(): Promise<string> {
      requireOpen("get_unified_addresses");
      return JSON.stringify(unified);
    },

    async get_transparent_addresses(): Promise<string> {
      requireOpen("get_transparent_addresses");
      return JSON.stringify(transparent);
    },

    async create_new_unified_address(receivers: string): Promise<string> {
      requireOpen("create_new_unified_address");
      log.calls.at(-1)!.args = [receivers] as unknown[];
      addressCounter += 1;
      unified.push(
        addressCounter === 1
          ? "swm1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6skyprw"
          : `swm1newaddress${addressCounter}`,
      );
      return JSON.stringify(unified);
    },

    async create_new_transparent_address(): Promise<string> {
      requireOpen("create_new_transparent_address");
      transparent.push(`s1NewTransparent${transparent.length}`);
      return JSON.stringify(transparent);
    },

    async get_value_transfers(): Promise<string> {
      requireOpen("get_value_transfers");
      return JSON.stringify([
        {
          txid: "aa".repeat(32),
          kind: "received",
          value: 200_000_000,
          block_height: 42,
          datetime: 1_790_000_000,
          address: unified[0],
          memo: "for the coffee",
        },
        {
          txid: "bb".repeat(32),
          kind: "sent",
          value: 50_000_000,
          fee: 10_000,
          block_height: 43,
          datetime: 1_790_000_100,
          address: "swm1recipient",
          memo: null,
        },
      ]);
    },

    async get_messages(): Promise<string> {
      requireOpen("get_messages");
      return JSON.stringify([]);
    },

    async run_sync(): Promise<string> {
      requireOpen("run_sync");
      pollsLeft = options.syncPolls ?? 1;
      return JSON.stringify({ result: "success" });
    },

    async poll_sync(): Promise<string> {
      requireOpen("poll_sync");
      if (pollsLeft > 0) {
        pollsLeft -= 1;
        // Prose, not JSON. This is verbatim what the addon answers.
        return "Sync task is not complete.";
      }
      return JSON.stringify({ result: "success" });
    },

    async pause_sync(): Promise<string> {
      requireOpen("pause_sync");
      return JSON.stringify({ result: "success" });
    },

    async stop_sync(): Promise<string> {
      requireOpen("stop_sync");
      return JSON.stringify({ result: "success" });
    },

    async status_sync(): Promise<string> {
      requireOpen("status_sync");
      return JSON.stringify({ scan_height: 900, chain_height: 1000 });
    },

    async run_rescan(): Promise<string> {
      requireOpen("run_rescan");
      return JSON.stringify({ result: "success" });
    },

    async get_latest_block_wallet(): Promise<string> {
      requireOpen("get_latest_block_wallet");
      return JSON.stringify({ height: 1000 });
    },

    async get_latest_block_server(server: string): Promise<string> {
      record("get_latest_block_server", server);
      return JSON.stringify({ height: 1000 });
    },

    async info_server(): Promise<string> {
      requireOpen("info_server");
      return JSON.stringify({
        chain_name: options.serverChain ?? "swarm-mainnet",
        genesis_hash:
          options.serverGenesis ??
          "01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd",
        block_height: 1000,
        vendor: "SWARM lightwalletd",
      });
    },

    async change_server(server: string): Promise<string> {
      record("change_server", server);
      return JSON.stringify({ result: "success" });
    },

    async wallet_kind(): Promise<string> {
      requireOpen("wallet_kind");
      return JSON.stringify({ kind: "Spend capable" });
    },

    async get_wallet_version(): Promise<string> {
      requireOpen("get_wallet_version");
      return JSON.stringify({ version: 30 });
    },

    async get_version(): Promise<string> {
      record("get_version");
      return JSON.stringify({ version: "fake-addon" });
    },

    async parse_address(address: string): Promise<string> {
      record("parse_address", address);
      // The real addon tries Zcash main/test/regtest only, so a swm1 address is
      // refused here exactly as it is refused there.
      if (address.startsWith("u1") || address.startsWith("t1")) {
        return JSON.stringify({
          status: "success",
          chain_name: "main",
          address_kind: "unified",
          receivers_available: ["orchard", "sapling"],
        });
      }
      return JSON.stringify({
        status: "Invalid address",
        chain_name: null,
        address_kind: null,
      });
    },

    async send(sendJson: string): Promise<string> {
      requireOpen("send");
      log.calls.at(-1)!.args = [sendJson] as unknown[];
      if (options.sendError) return JSON.stringify({ error: options.sendError });
      proposalStored = true;
      return JSON.stringify({ fee: 15_000 });
    },

    async confirm(): Promise<string> {
      requireOpen("confirm");
      if (!proposalStored) return JSON.stringify({ error: "no proposal stored" });
      proposalStored = false;
      return JSON.stringify({ txids: ["cc".repeat(32)] });
    },

    async delete_wallet(
      server: string,
      chainHint: ChainHint,
      performance: PerformanceLevel,
      minConfirmations: number,
      walletName: string,
    ): Promise<string> {
      record("delete_wallet", server, chainHint, performance, minConfirmations, walletName);
      return JSON.stringify({ status: "File deleted successfully" });
    },
  };

  return { addon, log };
};

/** The arguments a named call was given, or `undefined` when it was never made. */
export const argsOf = (log: FakeAddonLog, name: string): readonly unknown[] | undefined =>
  log.calls.find((call) => call.name === name)?.args;
