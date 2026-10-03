/**
 * `SwarmWallet` — the typed, promise-based API over the addon's string/JSON calls.
 *
 * One rule runs through the whole file: **every addon call that takes a chain
 * argument is given `nativeChainHint(chain)` and never a chain label.** That is
 * enforced three ways — the branded `ChainHint` type, this being the only module
 * that touches those five entry points, and `test/chainHint.test.ts` reading the
 * source. The bug it prevents cost the owner the first mainnet wallet creation on
 * 2026-09-26.
 *
 * The second rule: **one wallet per process.** The addon keeps a single global
 * `LIGHTCLIENT`, so a second `openOrCreate` in the same process would silently
 * replace the first wallet under the first caller's feet. It is refused instead.
 */

import { EventEmitter } from "node:events";
import { basename } from "node:path";

import { formatSwm, zatoshiFromJson } from "./amounts.js";
import { checkAddressForProfile } from "./addressCheck.js";
import {
  CHAIN_RESTART_NOTICE,
  currentRecord,
  parseNativeRestartReport,
  readNetworkRecord,
  recordNeedsMove,
  writeNetworkRecord,
} from "./chainRestart.js";
import type { ChainRestartReport } from "./chainRestart.js";
import { SwarmWalletError, callAddon, callAddonText, parseAddonJson } from "./errors.js";
import { nativeChainHint, swarmProfileFor } from "./networkProfiles.js";
import type { SwarmNetworkProfile } from "./networkProfiles.js";
import type { NativeAddon } from "./nativeAddon.js";
import { WalletStore } from "./walletStore.js";
import type { WalletStoreOptions } from "./walletStore.js";
import type {
  AddressSet,
  Balance,
  ParsedAddress,
  PerformanceLevel,
  ReceiverSelection,
  ScanRange,
  SendQuote,
  SendRequest,
  SendResult,
  ServerInfo,
  SyncStatus,
  WalletTransaction,
} from "./types.js";

/** What `openOrCreate` needs. */
export type OpenOptions = {
  /** The addon, already loaded. `loadNativeAddon(path)` returns one. */
  readonly addon: NativeAddon;
  /**
   * The directory this wallet owns. The addon appends a chain subdirectory to it.
   * In the messenger: `<userData>/swarm-wallet/<accountId>`.
   */
  readonly dataDir: string;
  /** Which network. `"swarm-mainnet"` for SWARM. */
  readonly chain: string;
  /** The lightwalletd URI. Defaults to the profile's own server. */
  readonly server?: string;
  /** The wallet file name. Defaults to `swarm-wallet.dat`. */
  readonly walletName?: string;
  /** 32 bytes; when given, the wallet file is encrypted at rest. */
  readonly encryptionKey?: Uint8Array;
  /** How hard to sync. Defaults to `"High"`. */
  readonly performanceLevel?: PerformanceLevel;
  /** Confirmations before a note is spendable. Defaults to 3; must be >= 1. */
  readonly minConfirmations?: number;
  /**
   * Refuse to open if the server reports a different chain or genesis than the
   * profile. Default true. There is no honest reason to turn it off outside a
   * test against a throwaway indexer.
   */
  readonly verifyServerIdentity?: boolean;
  /**
   * What to do with a SWARM Mainnet wallet file written on the chain abandoned
   * on 2 October 2026 (`chainRestart.ts`). `"move"` (the default) moves it once,
   * safely, before it is opened, and reports the move as `restartMove`.
   * `"refuse"` throws a `wrong-chain` error instead and changes nothing, for a
   * caller that wants to ask its user first and then call
   * `SwarmWallet.moveWalletToRestartedChain`.
   */
  readonly restartedChain?: "move" | "refuse";
};

/** Which wallet file a restart check or move is about. No addon needed to ask. */
export type WalletLocation = Pick<OpenOptions, "dataDir" | "chain" | "walletName" | "encryptionKey">;

/** Restoring an existing seed rather than opening or creating a wallet. */
export type RestoreOptions = OpenOptions & {
  /** The BIP-39 phrase. Never logged, never stored by this package. */
  readonly seedPhrase: string;
  /**
   * The block to start scanning from. Lower is slower; below the network's
   * activation height is pointless. Defaults to the profile's activation height,
   * which is correct and slow.
   */
  readonly birthdayHeight?: number;
};

/** Events `SwarmWallet` emits. */
export type SwarmWalletEvents = {
  /** Emitted while `sync()` runs, at the poll interval. */
  status: [SyncStatus];
  /** Emitted once when a sync run finishes. */
  synced: [SyncStatus];
  /** Emitted when a sync run fails. The wallet stays open. */
  "sync-error": [SwarmWalletError];
  /**
   * Emitted when the wallet file could not be saved after a payment was
   * transmitted. The payment happened; `SendResult.saveError` carries the same
   * error. Listen here to warn the user that the file on disk is behind.
   */
  "save-error": [SwarmWalletError];
};

/** How long between `status_sync` polls while a sync runs. */
const SYNC_POLL_MS = 1_500;

/** How many "sync task has not been launched" answers to tolerate before giving up. */
const MAX_UNLAUNCHED_POLLS = 10;

/**
 * The directory each loaded addon was given, if this package gave it one.
 *
 * `set_wallet_base_dir` is a `OnceCell`: the first caller wins for the life of
 * the process, and it answers `false` for **every** later call, including one
 * passing the identical path. There is no getter and no reset. So a `false` on
 * its own cannot tell "you already set this, to the same place" from "somebody
 * else set it somewhere else", and treating `false` as fatal made
 * close-then-reopen impossible — the ordinary messenger flow after an error, an
 * account switch, or the wrong-chain refusal below.
 *
 * Keyed by the addon object rather than held in a module variable, because the
 * cell belongs to the addon: one loaded `native.node` is one cell. A test with
 * two fake addons has two, which is exactly right, and nothing here leaks when an
 * addon is dropped.
 */
const baseDirGivenToAddon = new WeakMap<NativeAddon, string>();

export class SwarmWallet extends EventEmitter<SwarmWalletEvents> {
  /**
   * The addon is a process singleton, so this is too. Module-level and not
   * static-private so the guard is visible in a stack trace.
   */
  static #openInstance: SwarmWallet | null = null;

  readonly chain: string;

  readonly server: string;

  readonly profile: SwarmNetworkProfile | undefined;

  readonly store: WalletStore;

  /**
   * The chain-restart move `openOrCreate` made before opening this wallet, or
   * `null` when none was needed. When it is not null, show its owner
   * `restartMove.notice` once.
   */
  restartMove: ChainRestartReport | null = null;

  readonly #addon: NativeAddon;

  readonly #performanceLevel: PerformanceLevel;

  readonly #minConfirmations: number;

  #closed = false;

  #syncing = false;

  /**
   * Which proposal the addon is holding.
   *
   * The addon stores exactly ONE proposal: `send` builds it, `confirm` transmits
   * whatever is stored at that moment. So two quotes in flight is not two
   * payments — it is one payment, the newest, and an older quote's `confirm()`
   * would transmit it while reporting the older quote's fee. Quote A for 1 000
   * zatoshi to Alice, then quote B for 999 000 to Bob, then `a.confirm()`: Bob
   * gets 999 000. Each quote captures this number and refuses if it has moved.
   */
  #proposalSerial = 0;

  private constructor(options: {
    addon: NativeAddon;
    chain: string;
    server: string;
    store: WalletStore;
    performanceLevel: PerformanceLevel;
    minConfirmations: number;
  }) {
    super();
    this.#addon = options.addon;
    this.chain = options.chain;
    this.server = options.server;
    this.store = options.store;
    this.profile = swarmProfileFor(options.chain);
    this.#performanceLevel = options.performanceLevel;
    this.#minConfirmations = options.minConfirmations;
  }

  /**
   * Opens the wallet at `dataDir`, creating one if there is none.
   *
   * On creation the addon needs the network: it derives the birthday from the
   * server's chain tip. The seed phrase it returns is **discarded here**. A
   * caller that must show it to the user asks `seedPhrase()` explicitly, so
   * nothing gets a seed by accident.
   */
  static async openOrCreate(options: OpenOptions): Promise<SwarmWallet> {
    const { wallet, existed } = await SwarmWallet.#prepare(options);
    try {
      if (existed) {
        // Before the file is opened: once it is open, the addon's save task
        // would write the abandoned chain's state back over a moved file.
        if (await wallet.#needsMove()) {
          if (options.restartedChain === "refuse") {
            throw new SwarmWalletError(
              "wrong-chain",
              `the wallet at ${wallet.store.paths.encryptedFile ?? wallet.store.paths.workingFile} ` +
                `was written on the SWARM Mainnet chain abandoned on 2 October 2026 and has to be ` +
                `moved onto the restarted chain before it is opened. Nothing was changed. Call ` +
                `SwarmWallet.moveWalletToRestartedChain, or open with restartedChain: "move".`,
            );
          }
          wallet.restartMove = await wallet.#moveToRestartedChain();
        }
        wallet.#init("init_from_b64", () =>
          wallet.#addon.init_from_b64(
            wallet.server,
            nativeChainHint(wallet.chain),
            wallet.#performanceLevel,
            wallet.#minConfirmations,
            wallet.store.paths.walletName,
          ),
        );
      } else {
        wallet.#init("init_new", () =>
          wallet.#addon.init_new(
            wallet.server,
            nativeChainHint(wallet.chain),
            wallet.#performanceLevel,
            wallet.#minConfirmations,
            wallet.store.paths.walletName,
          ),
        );
        await wallet.#persist();
        await wallet.#writeCurrentRecord();
      }
      // Inside the try: #afterInit makes a network call, so an unreachable or
      // slow indexer is the ordinary case, and its failure used to leave the
      // decrypted wallet file on disk and the process singleton wedged with no
      // object for the caller to close.
      await wallet.#afterInit(options);
    } catch (error) {
      await wallet.#abandon();
      throw error;
    }
    return wallet;
  }

  /**
   * Restores a wallet from a seed phrase, overwriting nothing: it refuses if a
   * wallet already exists in `dataDir`, because a restore onto an existing file
   * is how a funded wallet disappears.
   */
  static async restoreFromSeed(options: RestoreOptions): Promise<SwarmWallet> {
    const { wallet, existed } = await SwarmWallet.#prepare(options);
    if (existed) {
      await wallet.#abandon();
      throw new SwarmWalletError(
        "bad-argument",
        `a wallet already exists at ${wallet.store.paths.encryptedFile ?? wallet.store.paths.workingFile}. ` +
          `Restoring over it would destroy whatever key it holds. Move it aside first, or restore ` +
          `into a different dataDir.`,
      );
    }
    const birthday =
      options.birthdayHeight ?? wallet.profile?.activationHeight ?? 1;
    try {
      wallet.#init("init_from_seed", () =>
        wallet.#addon.init_from_seed(
          options.seedPhrase,
          birthday,
          wallet.server,
          nativeChainHint(wallet.chain),
          wallet.#performanceLevel,
          wallet.#minConfirmations,
          wallet.store.paths.walletName,
        ),
      );
      await wallet.#persist();
      await wallet.#writeCurrentRecord();
      await wallet.#afterInit(options);
    } catch (error) {
      await wallet.#abandon();
      throw error;
    }
    return wallet;
  }

  /**
   * Whether the wallet at this location has to be moved onto the SWARM Mainnet
   * chain restarted on 2 October 2026 before it is opened: it exists, it is a
   * SWARM Mainnet wallet, and its network record does not name this build's
   * genesis (0.2.0 wrote no record; every wallet it made is on the abandoned
   * chain). Reads two file names and one small JSON file; no addon, no key, no
   * network.
   */
  static async needsMoveToRestartedChain(location: WalletLocation): Promise<boolean> {
    // Only the paths are needed, and they depend on WHETHER there is a key, not
    // on the key: a zero placeholder keeps the real key from being copied into
    // a store that is never opened and so never wipes it.
    const store = new WalletStore({
      dataDir: location.dataDir,
      chain: location.chain,
      ...(location.walletName === undefined ? {} : { walletName: location.walletName }),
      ...(location.encryptionKey === undefined ? {} : { encryptionKey: new Uint8Array(32) }),
    });
    if (!(await store.exists())) return false;
    return recordNeedsMove(location.chain, await readNetworkRecord(store.paths.networkRecordFile));
  }

  /**
   * Moves the wallet at this location onto the restarted SWARM Mainnet chain,
   * without opening it, and answers the report, or `null` when no move was
   * needed. `openOrCreate` does the same by itself; this is for a caller that
   * asked its user first. Needs the addon (the move is native) and, in
   * encrypted mode, the key; makes no network call. Claims the process's one
   * wallet slot for its duration, so it refuses while a wallet is open.
   */
  static async moveWalletToRestartedChain(options: OpenOptions): Promise<ChainRestartReport | null> {
    const { wallet, existed } = await SwarmWallet.#prepare(options);
    let report: ChainRestartReport | null = null;
    try {
      if (existed && (await wallet.#needsMove())) {
        report = await wallet.#moveToRestartedChain();
      }
    } finally {
      // The move sealed what it wrote; closing without a seal only wipes the
      // plaintext working copy and frees the slot.
      await wallet.#abandon();
    }
    return report;
  }

  /** The wallet currently open in this process, or `null`. */
  static current(): SwarmWallet | null {
    return SwarmWallet.#openInstance;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /**
   * What the wallet holds, in zatoshi.
   *
   * The addon's `get_balance` is zingolib's `AccountBalance` as JSON, and at
   * wallet `745c2092` its keys are `confirmed_<pool>_balance`,
   * `unconfirmed_<pool>_balance` and `total_<pool>_balance` for the pools
   * `orchard`, `sapling`, `transparent` and `ironwood` — twelve keys, read off
   * the mainnet.2 binary on 2026-09-27. 0.1.0 read `orchard_balance` and
   * friends, which that addon never answers, and so refused every balance.
   * The older spellings are still accepted after the real ones, for an SDK
   * revision that goes back to them.
   *
   * What this must never do is answer zero because it recognised nothing: a
   * balance that reads 0 when the wallet is funded is the worst possible failure
   * of a wallet screen. So a response carrying none of the known fields is a
   * `malformed-response` throw that names what it did see.
   */
  async balance(): Promise<Balance> {
    this.#assertOpen();
    const raw = await callAddon<Record<string, unknown>>("get_balance", () =>
      this.#addon.get_balance(),
    );
    const spendable = await callAddon<Record<string, unknown>>(
      "get_spendable_balance_total",
      () => this.#addon.get_spendable_balance_total(),
    );
    // A field this version does not know must be an error, never a zero. The
    // earlier version checked that SOME field was recognised and then let each
    // individual pool fall back to 0n — so renaming one pool would have reported a
    // funded wallet as short by exactly that pool, successfully, with no
    // complaint. `find` returns undefined and the callers decide.
    const find = (source: Record<string, unknown>, names: string[]): bigint | undefined => {
      for (const name of names) {
        const value = source[name];
        if (value !== undefined && value !== null) return zatoshiFromJson(value, name);
      }
      return undefined;
    };
    const refuse = (call: string, source: Record<string, unknown>, missing: string): never => {
      throw new SwarmWalletError(
        "malformed-response",
        `${call} answered an object this version cannot read: no ${missing}. Keys present: ` +
          `[${Object.keys(source).join(", ")}]. Refusing, because the alternative is reporting a ` +
          `balance that is wrong rather than one that is unknown.`,
        { call },
      );
    };

    // `total_<pool>_balance` first: that is the key the addon answers. The rest
    // are older spellings, kept so a future SDK revision that reverts to one of
    // them is read rather than refused.
    const pool = (name: string): bigint | undefined =>
      find(raw, [`total_${name}_balance`, `${name}_balance`, name, `${name}_value`]);
    const orchard = pool("orchard");
    const sapling = pool("sapling");
    const transparent = pool("transparent");
    // Ironwood is the fourth pool this SDK reports. Optional: an SDK without
    // NU6.3 has no such pool, and its absence is not a malformed answer.
    const ironwood = find(raw, ["total_ironwood_balance", "ironwood_balance"]);
    const statedTotal = find(raw, ["total", "total_balance"]);
    // The confirmed thirds, summed over whichever pools report one.
    let confirmed: bigint | null = null;
    for (const name of ["orchard", "sapling", "transparent", "ironwood"]) {
      const value = find(raw, [`confirmed_${name}_balance`]);
      if (value !== undefined) confirmed = (confirmed ?? 0n) + value;
    }

    // Either the addon states a total, or all three pools are readable so one can
    // be computed. Two of three is not enough for either.
    if (
      statedTotal === undefined &&
      (orchard === undefined || sapling === undefined || transparent === undefined)
    ) {
      const absent = [
        orchard === undefined ? "orchard" : null,
        sapling === undefined ? "sapling" : null,
        transparent === undefined ? "transparent" : null,
      ]
        .filter((name): name is string => name !== null)
        .join(", ");
      refuse("get_balance", raw, `total, and no readable ${absent} balance`);
    }
    const spendable_ = find(spendable, ["spendable_balance", "spendable", "total"]);
    if (spendable_ === undefined) {
      refuse("get_spendable_balance_total", spendable, "spendable balance");
    }
    const spendableZat = spendable_ as bigint;

    const totalZat =
      statedTotal ??
      (orchard as bigint) + (sapling as bigint) + (transparent as bigint) + (ironwood ?? 0n);
    return {
      totalZat,
      spendableZat,
      confirmedZat: confirmed,
      // `null` where the addon did not say, rather than a zero that reads as a
      // fact. A pane that shows a pool split has to handle null.
      orchardZat: orchard ?? null,
      saplingZat: sapling ?? null,
      transparentZat: transparent ?? null,
      ironwoodZat: ironwood ?? null,
      pendingZat: totalZat > spendableZat ? totalZat - spendableZat : 0n,
      raw,
    };
  }

  /** The same balance as a decimal SWM string, for a label. */
  async balanceText(): Promise<string> {
    const { spendableZat } = await this.balance();
    return formatSwm(spendableZat, { withTicker: true, group: true });
  }

  /** Every address this wallet can be paid at. */
  async addresses(): Promise<AddressSet> {
    this.#assertOpen();
    const unified = await callAddon<unknown>("get_unified_addresses", () =>
      this.#addon.get_unified_addresses(),
    );
    const transparent = await callAddon<unknown>("get_transparent_addresses", () =>
      this.#addon.get_transparent_addresses(),
    );
    const set: AddressSet = {
      unified: addressStrings(unified),
      // External only: `internal` is change and `refund` is a reserved swap
      // address, and neither is something to show as "pay me here".
      transparent: addressStrings(transparent, true),
    };
    if (set.unified.length === 0) {
      throw new SwarmWalletError(
        "malformed-response",
        `get_unified_addresses answered ${JSON.stringify(unified)}, from which no address could ` +
          `be read. Every wallet has at least one unified address, so this is a shape this ` +
          `version does not understand rather than an empty wallet.`,
        { call: "get_unified_addresses" },
      );
    }
    return set;
  }

  /**
   * Adds a unified address to the account and returns it.
   *
   * Defaults to orchard **and** sapling, so a sender picks whichever pool it
   * supports. There is no `transparent` flag: the addon's
   * `generate_unified_address` takes a `ReceiverSelection { orchard, sapling }`
   * and nothing else.
   *
   * The selection crosses as a **flag string**, not JSON, because the addon reads
   * `receivers.contains('o')` and `receivers.contains('z')`. Sending
   * `JSON.stringify({orchard: false, sapling: true})` would ask for orchard only,
   * since that text contains an `o` and no `z` — which is exactly what this
   * package did until the addon source was read properly.
   */
  async newAddress(receivers: ReceiverSelection = {}): Promise<string> {
    this.#assertOpen();
    const { orchard = true, sapling = true } = receivers;
    if (!orchard && !sapling) {
      throw new SwarmWalletError(
        "bad-argument",
        "a unified address needs at least one shielded receiver: orchard, sapling, or both.",
      );
    }
    const selection = `${orchard ? "o" : ""}${sapling ? "z" : ""}`;
    const answer = await callAddon<Record<string, unknown>>("create_new_unified_address", () =>
      this.#addon.create_new_unified_address(selection),
    );
    const created = stringOrNull(answer["encoded_address"]);
    if (created === null) {
      throw new SwarmWalletError(
        "malformed-response",
        `create_new_unified_address answered ${JSON.stringify(answer)}, which carries no ` +
          `encoded_address.`,
        { call: "create_new_unified_address" },
      );
    }
    // What was actually produced, not what was asked for: the flag string is a
    // request and the addon's answer is the fact.
    if (orchard && answer["has_orchard"] === false) {
      throw new SwarmWalletError(
        "malformed-response",
        `an orchard receiver was asked for and ${created} has none.`,
        { call: "create_new_unified_address" },
      );
    }
    if (sapling && answer["has_sapling"] === false) {
      throw new SwarmWalletError(
        "malformed-response",
        `a sapling receiver was asked for and ${created} has none.`,
        { call: "create_new_unified_address" },
      );
    }
    await this.#persist();
    return created;
  }

  /** Every movement of value this wallet knows about, newest last. */
  async transactions(): Promise<readonly WalletTransaction[]> {
    this.#assertOpen();
    const answer = await callAddon<unknown>("get_value_transfers", () =>
      this.#addon.get_value_transfers(),
    );
    const list = Array.isArray(answer)
      ? answer
      : isRecord(answer) && Array.isArray(answer["value_transfers"])
        ? answer["value_transfers"]
        : [];
    return list.filter(isRecord).map(toTransaction);
  }

  /**
   * What the server says it is.
   *
   * `info_server` builds its JSON by hand from zingolib's `ServerInfo`. Since
   * wallet `a963fd8c` (SDK `swarm-sdk-mainnet-1`) that includes `genesis_hash`,
   * the height-zero block hash the indexer states through
   * `LightdInfo.genesisHash` (proto field 19), so "is this really SWARM mainnet
   * and not another chain calling itself that" is answered by the hash and not
   * only by the label. An indexer built before the field answers the empty
   * string; that is "did not say", read as `null`, and `genesisVerified` stays
   * false without anything being refused. Through the 0.1.x addon the field did
   * not exist at all.
   */
  async serverInfo(): Promise<ServerInfo> {
    this.#assertOpen();
    const raw = await callAddon<Record<string, unknown>>("info_server", () =>
      this.#addon.info_server(),
    );
    const stated = stringOrNull(raw["genesis_hash"] ?? raw["genesisHash"]);
    // "" is the SDK's "the server did not state one" — never a genesis, never a
    // mismatch. Lower-cased because the profile's hash is, and hex has no case.
    const genesisHash = stated === null || stated.trim() === "" ? null : stated.trim().toLowerCase();
    return {
      chainName: stringOr(raw["chain_name"] ?? raw["chainName"], ""),
      genesisHash,
      genesisVerified: genesisHash !== null && genesisHash === this.profile?.genesis,
      blockHeight: numberOrNull(
        raw["latest_block_height"] ?? raw["block_height"] ?? raw["blockHeight"],
      ),
      consensusBranchId: stringOrNull(raw["consensus_branch_id"]),
      saplingActivationHeight: numberOrNull(raw["sapling_activation_height"]),
      vendor: stringOrNull(raw["vendor"]),
      raw,
    };
  }

  /**
   * The seed phrase, for the one screen that shows it to its owner.
   *
   * A separate call, awkward on purpose. Nothing else in this package reads it,
   * nothing logs it, and it is not part of any object this package returns.
   */
  async seedPhrase(): Promise<{ phrase: string; birthdayHeight: number }> {
    this.#assertOpen();
    const raw = await callAddon<Record<string, unknown>>("get_seed", () => this.#addon.get_seed());
    // `get_seed` serialises zingolib's recovery info, whose keys are
    // `seed_phrase`, `birthday` and `no_of_accounts` — the same object every
    // `init_*` returns. 0.1.0 read `seed`, which is not there, and threw.
    const phrase = stringOr(raw["seed_phrase"] ?? raw["seed"], "");
    if (!phrase) {
      throw new SwarmWalletError(
        "malformed-response",
        `get_seed answered an object with keys [${Object.keys(raw).join(", ")}] and no seed_phrase.`,
        { call: "get_seed" },
      );
    }
    return { phrase, birthdayHeight: numberOrNull(raw["birthday"]) ?? 0 };
  }

  // ── addresses ────────────────────────────────────────────────────────────

  /**
   * Whether `address` can be paid from this wallet, and what it is.
   *
   * Two checks, in this order, and the result says which one answered:
   *
   *  1. This package's own HRP / version-byte check (`addressCheck.ts`). It
   *     refuses an address belonging to the other SWARM network or to upstream
   *     Zcash, with a sentence naming which. Its refusal is final.
   *  2. The addon's `parse_address`, which decodes properly — but only against
   *     Zcash `main`, `test` and `regtest`. On SWARM production it cannot decode
   *     a `swm1…` address at all, because an address string cannot supply the
   *     genesis that `ChainType::SwarmMainnet` requires. So on a SWARM
   *     production wallet the verdict comes back `decodedBy: "prefix"`, and that
   *     is the strongest honest answer this package can give today.
   */
  async parseAddress(address: string): Promise<ParsedAddress> {
    if (this.profile) {
      const verdict = checkAddressForProfile(address, this.profile);
      if (!verdict.accepted) {
        return { valid: false, reason: verdict.message, decodedBy: "prefix" };
      }
    }

    const raw = await callAddon<Record<string, unknown>>("parse_address", () =>
      this.#addon.parse_address(address),
    );
    const status = stringOr(raw["status"], "");
    if (status === "success") {
      // The addon says which chain it decoded against, and for the three upstream
      // Zcash labels there is no prefix pre-check in front of it — so without
      // this a testnet address is `valid: true` on a `main` wallet and
      // proposeSend goes ahead with it.
      const decodedChain = stringOr(raw["chain_name"], "");
      if (decodedChain && decodedChain !== this.chain) {
        return {
          valid: false,
          reason:
            `That address belongs to "${decodedChain}" and this wallet is on "${this.chain}". ` +
            `The two are separate chains: coins sent across them are lost.`,
          decodedBy: "addon",
        };
      }
      const kind = stringOr(raw["address_kind"], "unified");
      const receivers = Array.isArray(raw["receivers_available"])
        ? raw["receivers_available"].filter((value): value is string => typeof value === "string")
        : undefined;
      return {
        valid: true,
        chain: stringOr(raw["chain_name"], this.chain),
        kind: kind === "transparent" || kind === "sapling" || kind === "tex" ? kind : "unified",
        ...(receivers ? { receivers } : {}),
        decodedBy: "addon",
      };
    }

    if (this.profile) {
      // The pre-check accepted it and the addon cannot decode this chain's
      // encodings. Say what is true: the string is a well-formed address for
      // this network, checked as far as anything here can check it.
      return {
        valid: true,
        chain: this.chain,
        kind: guessKind(address, this.profile),
        decodedBy: "prefix",
      };
    }

    return {
      valid: false,
      reason: `"${address}" is not an address this wallet can pay.`,
      decodedBy: "addon",
    };
  }

  // ── sending ──────────────────────────────────────────────────────────────

  /**
   * Proposes a payment and returns its fee, without transmitting anything.
   *
   * The addon's `send` builds a proposal and stores it; `confirm` transmits the
   * stored proposal. That two-step is preserved here, because a messenger has to
   * show a fee before it spends someone's money. `SendQuote.confirm()` is the
   * only thing in this package that touches the network with intent to spend.
   */
  async proposeSend(request: SendRequest): Promise<SendQuote> {
    this.#assertOpen();
    if (request.amountZat <= 0n) {
      throw new SwarmWalletError("bad-argument", "amountZat must be greater than zero.");
    }
    const parsed = await this.parseAddress(request.to);
    if (!parsed.valid) {
      throw new SwarmWalletError("bad-argument", parsed.reason);
    }
    const payload = JSON.stringify([
      {
        address: request.to,
        // The addon reads `amount` with `as_u64`, so it must cross as a JSON
        // number. Range-checked here rather than truncated there.
        amount: asSafeNumber(request.amountZat, "amountZat"),
        ...(request.memo === undefined ? {} : { memo: request.memo }),
      },
    ]);
    const quoted = await callAddon<Record<string, unknown>>("send", () =>
      this.#addon.send(payload),
    );
    const feeZat = zatoshiFromJson(quoted["fee"], "fee");
    this.#proposalSerial += 1;
    const serial = this.#proposalSerial;
    let confirmed = false;
    return {
      feeZat,
      confirm: async (): Promise<SendResult> => {
        if (confirmed) {
          throw new SwarmWalletError(
            "bad-argument",
            "this quote has already been confirmed. Propose the payment again rather than " +
              "retrying a confirm: the addon holds one stored proposal, and a second confirm " +
              "would transmit whatever is in it now.",
          );
        }
        if (serial !== this.#proposalSerial) {
          throw new SwarmWalletError(
            "bad-argument",
            "this quote is stale: a later payment was proposed and replaced the one the addon " +
              "is holding, so confirming this quote would transmit that other payment — a " +
              "different recipient and a different amount, reported with this quote's fee. " +
              "Propose again.",
          );
        }
        confirmed = true;
        this.#assertOpen();
        const answer = await callAddon<Record<string, unknown>>("confirm", () =>
          this.#addon.confirm(),
        );
        const txids = Array.isArray(answer["txids"])
          ? answer["txids"].filter((value): value is string => typeof value === "string")
          : [];
        if (txids.length === 0) {
          throw new SwarmWalletError(
            "malformed-response",
            `confirm answered ${JSON.stringify(answer)}, with no txid. The payment may or may not ` +
              `have been transmitted; sync and check the transaction list before retrying.`,
            { call: "confirm" },
          );
        }
        // From here the money has moved and the txids are the one fact that must
        // reach the caller. The save is wanted — it writes the spend to disk —
        // but a save that fails is a file problem, not a payment problem, and
        // throwing it with the txids inside is how 0.1.0 lost the ids of a
        // payment already on the network. So the save is attempted, its failure
        // is reported beside the txids and as a `save-error` event, and the next
        // save (a sync, `close()`) writes the same state.
        const saveError = await this.#persistReporting();
        return { txids, feeZat, saved: saveError === null, saveError };
      },
    };
  }

  /**
   * Proposes and immediately transmits. The convenience form.
   *
   * A UI that shows a fee should use `proposeSend` and confirm on the user's
   * word. This exists for a caller that has already agreed a fee ceiling, and it
   * takes one: `maxFeeZat`, which refuses rather than paying more.
   */
  async send(request: SendRequest & { maxFeeZat?: bigint }): Promise<SendResult> {
    const quote = await this.proposeSend(request);
    if (request.maxFeeZat !== undefined && quote.feeZat > request.maxFeeZat) {
      throw new SwarmWalletError(
        "bad-argument",
        `the fee for this payment is ${formatSwm(quote.feeZat, { withTicker: true })}, above the ` +
          `${formatSwm(request.maxFeeZat, { withTicker: true })} ceiling given. Nothing was sent.`,
      );
    }
    return quote.confirm();
  }

  // ── syncing ──────────────────────────────────────────────────────────────

  /**
   * Runs one sync to the chain tip, emitting `status` as it goes.
   *
   * `run_sync` starts a background task in the addon and returns; `poll_sync`
   * says whether it has finished and `status_sync` says where it is. This loops
   * over both and resolves when the run ends, so a caller can `await` a sync or
   * ignore the promise and listen for events.
   */
  async sync(options: { signal?: AbortSignal } = {}): Promise<SyncStatus> {
    this.#assertOpen();
    if (this.#syncing) {
      throw new SwarmWalletError(
        "bad-argument",
        "a sync is already running. Listen for the `synced` event instead of starting a second.",
      );
    }
    this.#syncing = true;
    const unlaunched = { count: 0 };
    try {
      await callAddonText("run_sync", () => this.#addon.run_sync());
      for (;;) {
        if (options.signal?.aborted) {
          await callAddonText("stop_sync", () => this.#addon.stop_sync()).catch(() => {});
          throw new SwarmWalletError("bad-argument", "the sync was cancelled by its caller.");
        }
        const status = await this.syncStatus();
        this.emit("status", status);
        const finished = await this.#pollSyncFinished(unlaunched);
        if (finished) {
          const final = await this.syncStatus();
          await this.#persist();
          this.emit("synced", final);
          return final;
        }
        await delay(SYNC_POLL_MS);
      }
    } catch (error) {
      const wrapped =
        error instanceof SwarmWalletError
          ? error
          : new SwarmWalletError("addon", `sync: ${(error as Error).message}`, { cause: error });
      this.emit("sync-error", wrapped);
      throw wrapped;
    } finally {
      this.#syncing = false;
    }
  }

  /**
   * Where the sync has got to, without starting one.
   *
   * `status_sync` is `pepper_sync::sync_status` as JSON. It carries no height
   * field: what it carries is the plan, `scan_ranges: [{priority, start_block,
   * end_block}]` with the block numbers as strings, and counters —
   * `total_blocks_scanned`, `percentage_total_blocks_scanned` and so on. The
   * heights here are derived from the plan: the synced height is the top of the
   * run of `Scanned` ranges from the bottom, the chain height is the top of the
   * highest range. 0.1.0 read `scan_height` and `chain_height`, which are not
   * there, and answered null for both.
   */
  async syncStatus(): Promise<SyncStatus> {
    this.#assertOpen();
    const raw = await callAddon<Record<string, unknown>>("status_sync", () =>
      this.#addon.status_sync(),
    );
    const ranges = scanRanges(raw["scan_ranges"]);
    let syncedHeight: number | null = null;
    let chainHeight: number | null = null;
    if (ranges.length > 0) {
      for (const range of ranges) {
        if (range.priority !== "Scanned") break;
        syncedHeight = range.end;
      }
      chainHeight = ranges[ranges.length - 1]!.end;
    } else {
      // No plan yet — or an SDK that reports heights directly. Read those, so a
      // revision that goes back to them is read rather than answered null.
      syncedHeight = numberOrNull(
        raw["scan_height"] ?? raw["synced_height"] ?? raw["last_scanned_height"],
      );
      chainHeight = numberOrNull(
        raw["chain_height"] ?? raw["target_height"] ?? raw["last_known_chain_height"],
      );
    }
    // The addon's own percentage when it states one over a plan; the height
    // ratio otherwise.
    const percentage = numberOrNull(raw["percentage_total_blocks_scanned"]);
    const progress =
      percentage !== null && ranges.length > 0
        ? Math.min(1, Math.max(0, percentage / 100))
        : syncedHeight !== null && chainHeight !== null && chainHeight > 0
          ? Math.min(1, Math.max(0, syncedHeight / chainHeight))
          : null;
    return {
      syncing: this.#syncing,
      syncedHeight,
      chainHeight,
      progress,
      blocksScanned: numberOrNull(raw["total_blocks_scanned"]),
      ranges,
      raw,
    };
  }

  /** Stops a running sync. Does not close the wallet. Answers the addon's prose. */
  async stopSync(): Promise<string> {
    this.#assertOpen();
    return callAddonText("stop_sync", () => this.#addon.stop_sync());
  }

  /** Rescans from the wallet's birthday. Slow, and sometimes the only cure. */
  async rescan(): Promise<string> {
    this.#assertOpen();
    return callAddonText("run_rescan", () => this.#addon.run_rescan());
  }

  // ── closing ──────────────────────────────────────────────────────────────

  /**
   * Saves, drops the wallet from the addon's memory, seals the file and wipes the
   * plaintext.
   *
   * Idempotent. After this the instance is dead; open a new one.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let persistError: unknown = null;
    try {
      await callAddonText("stop_sync", () => this.#addon.stop_sync()).catch(() => {});
      await this.#persist();
    } catch (error) {
      persistError = error;
    }
    try {
      this.#addon.deinitialize();
    } catch {
      // The addon is in whatever state it is in; the slot must still be freed.
    }
    let storeError: unknown = null;
    try {
      await this.store.close();
    } catch (error) {
      // A failed seal leaves the plaintext in place on purpose (it is the only
      // copy) and throws. The wallet is finished either way, so the process slot
      // is released here rather than in a `finally` after the throw — otherwise
      // one failed seal wedged the singleton and no wallet could be opened again.
      storeError = error;
    }
    if (SwarmWallet.#openInstance === this) SwarmWallet.#openInstance = null;
    this.removeAllListeners();
    if (storeError !== null) throw storeError;
    if (persistError !== null) throw persistError;
  }

  // ── internals ────────────────────────────────────────────────────────────

  static async #prepare(
    options: OpenOptions,
  ): Promise<{ wallet: SwarmWallet; existed: boolean }> {
    if (SwarmWallet.#openInstance !== null) {
      throw new SwarmWalletError(
        "already-open",
        "a SWARM wallet is already open in this process. The addon keeps one global wallet, so a " +
          "second open would replace the first under its owner's feet. Close the first, or run the " +
          "second wallet in its own process.",
      );
    }
    const minConfirmations = options.minConfirmations ?? 3;
    if (!Number.isInteger(minConfirmations) || minConfirmations < 1) {
      throw new SwarmWalletError(
        "bad-argument",
        `minConfirmations must be an integer >= 1, got ${String(options.minConfirmations)}. ` +
          `The addon rejects 0 rather than unwrapping, which would abort the process.`,
      );
    }
    const profile = swarmProfileFor(options.chain);
    const server = options.server ?? profile?.defaultServer;
    if (!server) {
      throw new SwarmWalletError(
        "bad-argument",
        `no server for chain "${options.chain}" and none supplied. Only SWARM chains have a default.`,
      );
    }
    // Throws for an unlaunched profile, which is the point: it happens here,
    // before any file is touched, not after an init has written a directory.
    nativeChainHint(options.chain);

    const storeOptions: WalletStoreOptions = {
      dataDir: options.dataDir,
      chain: options.chain,
      ...(options.walletName === undefined ? {} : { walletName: options.walletName }),
      ...(options.encryptionKey === undefined ? {} : { encryptionKey: options.encryptionKey }),
    };
    const store = new WalletStore(storeOptions);
    const existed = await store.exists();
    // `store.open()` zeroes its own key if it throws, so a wrong-key open leaves
    // nothing behind. Nothing else here holds the key.
    await store.open();

    const wallet = new SwarmWallet({
      addon: options.addon,
      chain: options.chain,
      server,
      store,
      performanceLevel: options.performanceLevel ?? "High",
      minConfirmations,
    });

    // The addon's base dir is a OnceCell, so this is only ever set ONCE per
    // process — and a second call answers false even for the identical path.
    // What matters is not the boolean but whether the directory the addon is
    // actually using is the one this store encrypts in.
    const alreadyGiven = baseDirGivenToAddon.get(options.addon);
    if (alreadyGiven === undefined) {
      const accepted = options.addon.set_wallet_base_dir(store.paths.baseDir);
      if (!accepted) {
        // Somebody else in this process got there first, and there is no getter
        // to ask where they pointed it. The wallet file could be written outside
        // the directory this store seals, so refuse.
        await store.close({ seal: false });
        throw new SwarmWalletError(
          "bad-argument",
          `the addon's wallet base directory was already set by something else in this process ` +
            `(it is a OnceCell, with no getter and no reset), so this wallet might be written ` +
            `outside ${store.paths.baseDir}, where its encryption at rest does not reach. Open ` +
            `this wallet in its own process.`,
        );
      }
      baseDirGivenToAddon.set(options.addon, store.paths.baseDir);
    } else if (alreadyGiven !== store.paths.baseDir) {
      await store.close({ seal: false });
      throw new SwarmWalletError(
        "bad-argument",
        `this process already pointed the addon at ${alreadyGiven}, and the addon's wallet ` +
          `base directory is a OnceCell that cannot be changed. A wallet under ` +
          `${store.paths.baseDir} cannot be opened here — use a separate process for it. (One ` +
          `messenger account per process; see docs/MESSENGER-INTEGRATION.md.)`,
      );
    }
    options.addon.set_crypto_default_provider_to_ring();
    SwarmWallet.#openInstance = wallet;
    return { wallet, existed };
  }

  /**
   * Runs one of the five synchronous `init_*` entry points.
   *
   * They return the seed phrase JSON on success and **throw** on failure, so
   * there is no `{"error":…}` shape here. The seed is dropped on the floor:
   * nothing in this package reads an init's return value.
   */
  #init(call: string, work: () => string): void {
    try {
      work();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SwarmWalletError("addon", `${call}: ${message}`, { call, cause });
    }
  }

  /** Whether this (existing, not yet opened) wallet must be moved first. */
  async #needsMove(): Promise<boolean> {
    return recordNeedsMove(this.chain, await readNetworkRecord(this.store.paths.networkRecordFile));
  }

  /**
   * The move itself. The store is open (in encrypted mode the working file is
   * the decrypted wallet), the addon's base directory is this store's, and no
   * wallet is loaded in the addon.
   *
   * Order, each step only after the one before it succeeded:
   *  1. seal any plaintext backup an interrupted earlier move left behind;
   *  2. the addon's move: backup, fresh wallet, every key and address checked,
   *     atomic replace, read-back, or a throw with the file unchanged;
   *  3. seal the moved working file (encrypted mode);
   *  4. seal the backup and wipe its plaintext (encrypted mode);
   *  5. write the record naming the restarted chain's genesis.
   * A crash anywhere before 5 leaves no record, so the next open moves again,
   * which is harmless: same keys, a second backup, nothing else.
   */
  async #moveToRestartedChain(): Promise<ChainRestartReport> {
    const profile = this.profile;
    if (!profile || profile.genesis === null) {
      throw new SwarmWalletError("bad-argument", `${this.chain} is not a network that was restarted.`);
    }
    await this.store.sealLeftoverBackups();
    let raw: string;
    try {
      raw = this.#addon.move_wallet_to_restarted_chain(
        nativeChainHint(this.chain),
        this.#performanceLevel,
        this.#minConfirmations,
        this.store.paths.walletName,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SwarmWalletError("wallet-file", `move_wallet_to_restarted_chain: ${message}`, {
        call: "move_wallet_to_restarted_chain",
        cause,
      });
    }
    const native = parseNativeRestartReport(parseAddonJson(raw, "move_wallet_to_restarted_chain"));
    await this.store.save();
    const backupPath = await this.store.sealBackup(native.backupPath);
    const backupEncrypted = backupPath !== native.backupPath;
    const record = currentRecord(profile, {
      movedUtc: new Date().toISOString(),
      backupFile: basename(backupPath),
      backupEncrypted,
      previousBirthday: native.previousBirthday,
      birthday: native.birthday,
    });
    if (record !== null) await writeNetworkRecord(this.store.paths.networkRecordFile, record);
    return {
      ...native,
      backupPath,
      backupEncrypted,
      genesis: profile.genesis,
      notice: CHAIN_RESTART_NOTICE,
    };
  }

  /**
   * Records that this wallet file belongs to the current chain: after a create
   * or a restore, which build the wallet from keys against this build's genesis.
   */
  async #writeCurrentRecord(): Promise<void> {
    const record = this.profile ? currentRecord(this.profile) : null;
    if (record !== null) await writeNetworkRecord(this.store.paths.networkRecordFile, record);
  }

  /** Checks the server is the chain it claims, then wires the profile's rules. */
  async #afterInit(options: OpenOptions): Promise<void> {
    if (options.verifyServerIdentity === false) return;
    const info = await this.serverInfo();
    const expectedChain = this.profile?.chainLabel ?? this.chain;
    if (info.chainName && info.chainName !== expectedChain) {
      throw new SwarmWalletError(
        "wrong-chain",
        `${this.server} reports chain "${info.chainName}", not "${expectedChain}". Nothing was ` +
          `synced: scanning the wrong chain writes its state over the right one.`,
      );
    }
    // The genesis half. Since the addon at `a963fd8c` `info_server` carries the
    // hash the indexer states, so this fires for real: a server on another chain
    // with the same label is refused before anything syncs. A server that states
    // no genesis (`info.genesisHash` null) is not refused — the label check above
    // is then all there is, and `ServerInfo.genesisVerified` says so to the caller.
    const expectedGenesis = this.profile?.genesis;
    if (expectedGenesis && info.genesisHash && info.genesisHash !== expectedGenesis) {
      throw new SwarmWalletError(
        "wrong-chain",
        `${this.server} reports genesis ${info.genesisHash}, not ${expectedGenesis}. Same chain ` +
          `name, different chain. Nothing was synced.`,
      );
    }
  }

  /**
   * Saves the wallet file and then seals it.
   *
   * `save_wallet_file` answers PROSE — "Wallet saved successfully. Size: 420
   * bytes." — and putting it through the JSON reader is what made the first live
   * mainnet run fail after the wallet had already been written. A failure
   * rejects the promise; there is nothing to parse.
   */
  async #persist(): Promise<void> {
    const answer = await callAddonText("save_wallet_file", () => this.#addon.save_wallet_file());
    // "Wallet is empty. Nothing to save." is the other benign answer, and it
    // means there is no file to seal yet.
    if (/nothing to save/i.test(answer)) return;
    await this.store.save();
  }

  /**
   * `#persist`, for the one place a failure must not propagate: after a
   * transmit. Answers the error instead of throwing it, and emits it as
   * `save-error` so a UI with no hand on the `SendResult` still hears.
   */
  async #persistReporting(): Promise<SwarmWalletError | null> {
    try {
      await this.#persist();
      return null;
    } catch (cause) {
      const error =
        cause instanceof SwarmWalletError
          ? cause
          : new SwarmWalletError(
              "wallet-file",
              `saving the wallet after the transmit failed: ${(cause as Error).message}`,
              { cause },
            );
      this.emit("save-error", error);
      return error;
    }
  }

  async #abandon(): Promise<void> {
    try {
      this.#addon.deinitialize();
    } catch {
      // The addon is already in whatever state it is in; the store still has to
      // be closed so no plaintext is left behind.
    }
    await this.store.close({ seal: false });
    if (SwarmWallet.#openInstance === this) SwarmWallet.#openInstance = null;
  }

  /**
   * Whether the sync run has finished.
   *
   * `poll_sync` answers prose for both unfinished states and `{"sync_complete":…}`
   * JSON when it is done. "Sync task has not been launched." must NOT be read as
   * finished, which is what this did: `sync()` then persisted, emitted `synced`
   * and resolved, telling the caller the wallet was at the tip when nothing had
   * scanned. It can appear briefly if the handle is not installed yet, so it is
   * tolerated a bounded number of times and then reported.
   */
  async #pollSyncFinished(unlaunched: { count: number }): Promise<boolean> {
    const raw = await callAddonText("poll_sync", () => this.#addon.poll_sync());
    if (/not complete/i.test(raw)) return false;
    if (/has not been launched/i.test(raw)) {
      unlaunched.count += 1;
      if (unlaunched.count > MAX_UNLAUNCHED_POLLS) {
        throw new SwarmWalletError(
          "addon",
          `the addon still reports "Sync task has not been launched." after ` +
            `${MAX_UNLAUNCHED_POLLS} polls. Nothing has scanned, so this is not a finished sync.`,
          { call: "poll_sync" },
        );
      }
      return false;
    }
    // JSON from here: `{"sync_complete": …}` on success, and a rejected promise
    // (already turned into a throw above) on failure.
    parseAddonJson(raw, "poll_sync");
    return true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SwarmWalletError("not-open", "this wallet has been closed.");
    }
  }
}

// ── small readers, kept out of the class ────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
};

/**
 * Pulls address strings out of what the addon answered.
 *
 * Both `unified_addresses_json` and `transparent_addresses_json` answer an array
 * of OBJECTS, and the address is under **`encoded_address`**:
 *
 *   unified:      {account, address_index, encoded_address, has_orchard,
 *                  has_sapling, has_transparent}
 *   transparent:  {account, address_index, scope, encoded_address}
 *
 * Confirmed against the desktop wallet's own readers
 * (`UnifiedAddressClass` / `TransparentAddressClass` in `src/components/appstate/classes/`)
 * and read off the mainnet.2 binary itself on 2026-09-27. This looked for
 * `address`, found nothing, and returned an empty list — so the live mainnet run
 * opened a wallet and then reported it had no receive address.
 *
 * Transparent addresses carry a `scope`, and only `external` ones are addresses to
 * be paid at: `internal` is change and `refund` is reserved for a swap refund.
 * Handing either to a user as "your address" would publish a change address.
 * Plain strings and `address` are still accepted, in case a future SDK
 * simplifies the shape.
 */
const addressStrings = (value: unknown, externalOnly = false): readonly string[] => {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value["addresses"])
      ? value["addresses"]
      : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (!isRecord(entry)) continue;
    if (externalOnly && entry["scope"] !== undefined && entry["scope"] !== "external") continue;
    const encoded = entry["encoded_address"] ?? entry["address"];
    if (typeof encoded === "string" && encoded.length > 0) out.push(encoded);
  }
  return out;
};

/**
 * The sync plan out of `status_sync`, lowest range first.
 *
 * `start_block` and `end_block` are strings in the addon's JSON (`"1"`,
 * `"614"`), which `numberOrNull` reads. A range missing either bound is
 * dropped rather than guessed at.
 */
const scanRanges = (value: unknown): readonly ScanRange[] => {
  if (!Array.isArray(value)) return [];
  const out: ScanRange[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const start = numberOrNull(entry["start_block"] ?? entry["start"]);
    const end = numberOrNull(entry["end_block"] ?? entry["end"]);
    if (start === null || end === null) continue;
    out.push({ start, end, priority: stringOr(entry["priority"], "unknown") });
  }
  return out.sort((a, b) => a.start - b.start);
};

/**
 * Which value-transfer kinds mean money left the wallet, and which mean it
 * arrived.
 *
 * Spelled out rather than matched with a regex. The earlier version tested
 * `/sent|spend|outgoing/i` against whatever string zingolib happened to
 * serialise, so `"Sent"` was outgoing and `"Send"`, `"SendToSelf"` or an enum
 * serialised as an object were not — and a spend then appeared as income. On
 * money, an unknown kind must read as unknown.
 */
const OUTGOING_KINDS = new Set([
  "sent",
  "send",
  "outgoing",
  "sendtoself",
  "memotoself",
  "shield",
  "shielding",
]);
const INCOMING_KINDS = new Set(["received", "receive", "incoming"]);

const toTransaction = (raw: Record<string, unknown>): WalletTransaction => {
  const value = raw["value"] ?? raw["amount"] ?? raw["value_zat"];
  // An enum serialised as `{"Sent": {...}}` carries no string anywhere; its
  // single key is the kind, so it is read from there rather than becoming
  // "unknown".
  const kindField = raw["kind"] ?? raw["transfer_kind"] ?? raw["type"];
  const kind =
    typeof kindField === "string"
      ? kindField
      : isRecord(kindField) && Object.keys(kindField).length === 1
        ? String(Object.keys(kindField)[0])
        : "unknown";
  const normalised = kind.toLowerCase().replace(/[^a-z]/g, "");
  const direction: WalletTransaction["direction"] = OUTGOING_KINDS.has(normalised)
    ? "out"
    : INCOMING_KINDS.has(normalised)
      ? "in"
      : "unknown";
  return {
    txid: stringOr(raw["txid"] ?? raw["transaction_id"], ""),
    kind,
    direction,
    // Always the magnitude. A caller that wants a signed number reads
    // `direction` and applies the sign itself, so an unrecognised kind cannot be
    // rendered as income by default.
    amountZat: value === undefined || value === null ? 0n : zatoshiFromJson(value, "value"),
    feeZat:
      raw["fee"] === undefined || raw["fee"] === null ? null : zatoshiFromJson(raw["fee"], "fee"),
    blockHeight: numberOrNull(raw["block_height"] ?? raw["blockheight"] ?? raw["height"]),
    timestamp: numberOrNull(raw["datetime"] ?? raw["timestamp"] ?? raw["block_time"]),
    address: stringOrNull(raw["address"] ?? raw["recipient_address"]),
    memo: stringOrNull(raw["memo"]),
    raw,
  };
};

/** Which kind of address a string is, by its own prefix. */
const guessKind = (
  address: string,
  profile: SwarmNetworkProfile,
): "unified" | "transparent" | "sapling" | "tex" => {
  const value = address.trim().toLowerCase();
  if (value.startsWith(`${profile.texHrp}1`)) return "tex";
  if (value.startsWith(`${profile.unifiedHrp}1`)) return "unified";
  for (const hrp of profile.legacyUnifiedHrps) {
    if (value.startsWith(`${hrp}1`)) return "unified";
  }
  if (profile.transparentPrefixes.some((prefix) => address.startsWith(prefix))) return "transparent";
  return "sapling";
};

const asSafeNumber = (zatoshi: bigint, field: string): number => {
  if (zatoshi < 0n || zatoshi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SwarmWalletError(
      "bad-argument",
      `${field} is ${zatoshi} zatoshi, outside the range the addon can read as a JSON number ` +
        `(0 … ${Number.MAX_SAFE_INTEGER}). SWARM's whole supply is far below that ceiling, so this ` +
        `is a bug in the caller and not a limit anyone should meet.`,
    );
  }
  return Number(zatoshi);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
