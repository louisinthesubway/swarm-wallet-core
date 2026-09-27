/**
 * A stand-in for `native.node`.
 *
 * It answers what the real addon answers, read out of `native/src/lib.rs` at
 * wallet `745c2092` — including the two failure shapes (a thrown `Error`, and a
 * resolved `{"error": …}`) and, above all, **the prose**. `save_wallet_file`,
 * `run_sync`, `pause_sync`, `stop_sync`, `run_rescan` and two of `poll_sync`'s
 * three answers are English sentences, and `check_save_error` is the empty
 * string. `create_new_unified_address` answers ONE object with the address under
 * `encoded_address`, and takes a flag string (`"oz"`), not JSON.
 *
 * An earlier version of this file answered tidy JSON for all of those. Every test
 * passed, and the first live mainnet run failed on the first save:
 * `save_wallet_file answered something that is not JSON: Wallet saved
 * successfully. Size: 420 bytes.` A mock that is tidier than the addon is a mock
 * that certifies the bug.
 *
 * The same happened once more, with key names. The mock answered
 * `orchard_balance`, address strings, `scan_height` and `seed`; the addon
 * answers `total_orchard_balance` (and eleven more), objects with
 * `encoded_address`, `scan_ranges` with string block numbers, and
 * `seed_phrase`. Every shape below was read off the mainnet.2 binary
 * (`native.node` sha256 2dcd84bb…, wallet `745c2092`) on 2026-09-27 with a
 * throwaway wallet; `test/live.test.ts` checks the real thing.
 *
 * It also writes a wallet file, because `WalletStore` has one to encrypt and a
 * test that skips that step proves nothing about the sealing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChainHint, PerformanceLevel } from "../src/types.js";
import type { NativeAddon } from "../src/nativeAddon.js";
import { SWARM_MAINNET_GENESIS } from "../src/networkProfiles.js";

export type FakeAddonOptions = {
  /** Fail `init_new` with this message. */
  readonly initError?: string;
  /** What `info_server` reports as its chain label. Defaults to swarm-mainnet. */
  readonly serverChain?: string;
  /**
   * What `info_server` reports as `genesis_hash`. Defaults to the launch genesis,
   * which is what `lwd-main.swarm.green` states through the addon at `a963fd8c`.
   * `""` is what an indexer that predates the field answers.
   */
  readonly serverGenesis?: string;
  /** Make `save_wallet_file` reject, as a full disk would. */
  readonly saveError?: string;
  /** Make `poll_sync` always answer "Sync task has not been launched." */
  readonly neverLaunches?: boolean;
  /** Refuse to accept the wallet base directory, as a second caller would. */
  readonly refuseBaseDir?: boolean;
  /** Make `send` answer `{"error": …}` instead of a fee. */
  readonly sendError?: string;
  /** How many `poll_sync` calls report "not complete" before the run ends. */
  readonly syncPolls?: number;
  /** Answer `get_balance` with a shape this version does not know. */
  readonly unknownBalanceShape?: boolean;
  /** Rename ONLY the orchard field, the dangerous half-recognised case. */
  readonly renameOrchardBalance?: boolean;
  /**
   * Make `save_wallet_file` reject with this message once `confirm` has
   * transmitted — a full disk right after a payment.
   */
  readonly saveErrorAfterConfirm?: string;
  /**
   * Answer `status_sync` with an SDK revision's direct heights instead of a
   * plan, to keep the older shape readable.
   */
  readonly legacySyncStatus?: boolean;
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
  let transmitted = false;
  // A real bech32m string with a valid checksum, so the wrapper's own
  // pre-check accepts it exactly as it would accept a real address. A
  // checksum-invalid placeholder here would make every send test fail for the
  // wrong reason.
  const unified = [
    "swm1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khced2letk",
  ];
  const transparent = ["s1FakeTransparentAddressAaaaaaaaaaa"];
  /** A change address. It must never be offered as somewhere to be paid. */
  const transparentInternal = "s1FakeInternalChangeAddressBbbbbbb";
  // The recovery info every init_* returns and get_seed repeats. Not a real
  // seed: twenty-four repetitions of one word, which no BIP-39 checksum accepts.
  const recoveryInfo = (): string =>
    JSON.stringify({
      seed_phrase: Array.from({ length: 24 }, () => "abandon").join(" "),
      birthday: 1,
      no_of_accounts: 1,
    });
  /** `unified_addresses_json`: objects, the string under `encoded_address`. */
  const unifiedJson = (): string =>
    JSON.stringify(
      unified.map((encoded_address, address_index) => ({
        account: 0,
        address_index,
        has_orchard: true,
        has_sapling: address_index > 0,
        has_transparent: false,
        encoded_address,
      })),
    );
  /**
   * `transparent_addresses_json`: objects again, with a `scope` — and an
   * `internal` change address among them, which the wrapper must leave out.
   */
  const transparentJson = (): string =>
    JSON.stringify([
      ...transparent.map((encoded_address, address_index) => ({
        account: 0,
        address_index,
        scope: "external",
        encoded_address,
      })),
      { account: 0, address_index: 0, scope: "internal", encoded_address: transparentInternal },
    ]);

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
    return recoveryInfo();
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
      if (options.saveError) throw new Error(`Save error. ${options.saveError}`);
      if (options.saveErrorAfterConfirm && transmitted) {
        throw new Error(`Save error. ${options.saveErrorAfterConfirm}`);
      }
      mkdirSync(dirname(walletFile), { recursive: true });
      const bytes = `fake zingolib wallet bytes ${log.calls.length}`;
      writeFileSync(walletFile, bytes);
      // Prose. Verbatim from lib.rs.
      return `Wallet saved successfully. Size: ${bytes.length} bytes.`;
    },

    async check_save_error(): Promise<string> {
      requireOpen("check_save_error");
      // The empty string is success. Not JSON.
      return "";
    },

    async get_wallet_save_required(): Promise<string> {
      requireOpen("get_wallet_save_required");
      return JSON.stringify({ save_required: false });
    },

    async get_seed(): Promise<string> {
      requireOpen("get_seed");
      // `seed_phrase`, not `seed`: zingolib's recovery info as serde writes it.
      return recoveryInfo();
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
      // zingolib's AccountBalance: three figures per pool, four pools, twelve
      // keys. Verbatim key names from the mainnet.2 binary.
      const balance: Record<string, number> = {
        confirmed_ironwood_balance: 0,
        unconfirmed_ironwood_balance: 0,
        total_ironwood_balance: 0,
        confirmed_orchard_balance: 150_000_000,
        unconfirmed_orchard_balance: 0,
        total_orchard_balance: 150_000_000,
        confirmed_sapling_balance: 0,
        unconfirmed_sapling_balance: 0,
        total_sapling_balance: 0,
        confirmed_transparent_balance: 50_000_000,
        unconfirmed_transparent_balance: 0,
        total_transparent_balance: 50_000_000,
      };
      if (options.renameOrchardBalance) {
        // One field renamed and the rest intact: the case a per-pool fallback to
        // zero would report as a funded wallet missing its whole shielded balance.
        const { total_orchard_balance, ...rest } = balance;
        return JSON.stringify({ ...rest, orchard_note_value: total_orchard_balance });
      }
      return JSON.stringify(balance);
    },

    async get_spendable_balance_total(): Promise<string> {
      requireOpen("get_spendable_balance_total");
      return JSON.stringify({ spendable_balance: 150_000_000 });
    },

    async get_unified_addresses(): Promise<string> {
      requireOpen("get_unified_addresses");
      // Objects with `encoded_address`, which is what the addon really answers.
      // A fake that answered bare strings is why the live run opened a wallet and
      // then reported it had no receive address.
      return unifiedJson();
    },

    async get_transparent_addresses(): Promise<string> {
      requireOpen("get_transparent_addresses");
      return transparentJson();
    },

    async create_new_unified_address(receivers: string): Promise<string> {
      requireOpen("create_new_unified_address");
      log.calls.at(-1)!.args = [receivers] as unknown[];
      addressCounter += 1;
      const created =
        addressCounter === 1
          ? "swm1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6skyprw"
          : `swm1newaddress${addressCounter}`;
      unified.push(created);
      // One object, the address under `encoded_address`, and the receivers read
      // from the FLAG STRING exactly as the addon reads them.
      return JSON.stringify({
        account: 0,
        address_index: addressCounter,
        has_orchard: receivers.includes("o"),
        has_sapling: receivers.includes("z"),
        has_transparent: false,
        encoded_address: created,
      });
    },

    async create_new_transparent_address(): Promise<string> {
      requireOpen("create_new_transparent_address");
      transparent.push(`s1NewTransparent${transparent.length}`);
      return transparentJson();
    },

    async get_value_transfers(): Promise<string> {
      requireOpen("get_value_transfers");
      // The addon wraps the list: `{"value_transfers": [...]}`.
      return JSON.stringify({ value_transfers: [
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
        // An enum serialised as an object, and a kind nothing recognises. Both
        // shapes the SDK could produce, and neither may be read as income.
        { txid: "cc".repeat(32), kind: { Sent: { pool: "orchard" } }, value: 1_000 },
        { txid: "dd".repeat(32), kind: "Rearrangement", value: 2_000 },
      ] });
    },

    async get_messages(): Promise<string> {
      requireOpen("get_messages");
      return JSON.stringify([]);
    },

    async run_sync(): Promise<string> {
      requireOpen("run_sync");
      pollsLeft = options.syncPolls ?? 1;
      return "Launching sync task...";
    },

    async poll_sync(): Promise<string> {
      requireOpen("poll_sync");
      if (options.neverLaunches) return "Sync task has not been launched.";
      if (pollsLeft > 0) {
        pollsLeft -= 1;
        // Prose, not JSON. This is verbatim what the addon answers.
        return "Sync task is not complete.";
      }
      return JSON.stringify({ sync_complete: { scanned: 100 } });
    },

    async pause_sync(): Promise<string> {
      requireOpen("pause_sync");
      return "Pausing sync task...";
    },

    async stop_sync(): Promise<string> {
      requireOpen("stop_sync");
      return "Sync already stopped.";
    },

    async status_sync(): Promise<string> {
      requireOpen("status_sync");
      if (options.legacySyncStatus) {
        return JSON.stringify({ scan_height: 900, chain_height: 1000 });
      }
      // pepper_sync::sync_status: a plan of ranges with STRING block numbers,
      // and counters. No height field anywhere. While polls are left the top
      // range is still pending; when none are, everything is Scanned.
      const done = pollsLeft <= 0;
      return JSON.stringify({
        scan_ranges: [
          { priority: "Scanned", start_block: "1", end_block: "900" },
          { priority: done ? "Scanned" : "ChainTip", start_block: "901", end_block: "1000" },
        ],
        sync_start_height: 1,
        session_blocks_scanned: done ? 1000 : 900,
        total_blocks_scanned: done ? 1000 : 900,
        percentage_session_blocks_scanned: done ? 100 : 90,
        percentage_total_blocks_scanned: done ? 100 : 90,
        session_sapling_outputs_scanned: 0,
        total_sapling_outputs_scanned: 0,
        session_orchard_outputs_scanned: 0,
        total_orchard_outputs_scanned: 0,
        session_ironwood_outputs_scanned: 0,
        total_ironwood_outputs_scanned: 0,
        percentage_session_outputs_scanned: 0,
        percentage_total_outputs_scanned: 0,
        total_outputs_scanned: 0,
        total_outputs: 0,
      });
    },

    async run_rescan(): Promise<string> {
      requireOpen("run_rescan");
      return "Launching rescan...";
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
      // Exactly the ten fields lib.rs builds by hand at a963fd8c. There is NO
      // block_height; the height is `latest_block_height`. `genesis_hash` is the
      // tenth, added upstream on 2026-09-27; an indexer that predates the proto
      // field comes through as "".
      return JSON.stringify({
        version: "fake",
        git_commit: "0000000",
        server_uri: "https://lwd-main.swarm.green:8443/",
        vendor: "SWARM lightwalletd",
        taddr_support: true,
        chain_name: options.serverChain ?? "swarm-mainnet",
        sapling_activation_height: 1,
        consensus_branch_id: "c8e71055",
        latest_block_height: 1000,
        genesis_hash: options.serverGenesis ?? SWARM_MAINNET_GENESIS,
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
      // refused here exactly as it is refused there — and, just as there, it will
      // happily decode an address from a DIFFERENT one of those three and say
      // which. That is the case a wallet on `main` has to refuse for itself.
      if (address.startsWith("u1") || address.startsWith("t1")) {
        return JSON.stringify({
          status: "success",
          chain_name: "main",
          address_kind: "unified",
          receivers_available: ["orchard", "sapling"],
        });
      }
      if (
        address.startsWith("utest1") ||
        address.startsWith("ztestsapling1") ||
        address.startsWith("tm")
      ) {
        return JSON.stringify({
          status: "success",
          chain_name: "test",
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
      transmitted = true;
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
