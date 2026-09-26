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

import { formatSwm, zatoshiFromJson } from "./amounts.js";
import { checkAddressForProfile } from "./addressCheck.js";
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
};

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
      await wallet.#afterInit(options);
    } catch (error) {
      await wallet.#abandon();
      throw error;
    }
    return wallet;
  }

  /** The wallet currently open in this process, or `null`. */
  static current(): SwarmWallet | null {
    return SwarmWallet.#openInstance;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /**
   * What the wallet holds, in zatoshi.
   *
   * The pool field names have moved across SDK revisions, so several spellings
   * are read. What this must never do is answer zero because it recognised
   * nothing: a balance that reads 0 when the wallet is funded is the worst
   * possible failure of a wallet screen. So a response carrying none of the known
   * fields is a `malformed-response` throw that names what it did see.
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

    const orchard = find(raw, ["orchard_balance", "orchard", "orchard_value"]);
    const sapling = find(raw, ["sapling_balance", "sapling", "sapling_value"]);
    const transparent = find(raw, ["transparent_balance", "transparent", "transparent_value"]);
    const statedTotal = find(raw, ["total", "total_balance"]);

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
      statedTotal ?? (orchard as bigint) + (sapling as bigint) + (transparent as bigint);
    return {
      totalZat,
      spendableZat,
      // `null` where the addon did not say, rather than a zero that reads as a
      // fact. A pane that shows a pool split has to handle null.
      orchardZat: orchard ?? null,
      saplingZat: sapling ?? null,
      transparentZat: transparent ?? null,
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
    return {
      unified: addressStrings(unified),
      transparent: addressStrings(transparent),
    };
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
   * `genesisHash` is **always null through this addon**, and `genesisVerified` is
   * therefore always false. `info_server` builds its JSON by hand from
   * zingolib's `ServerInfo` and the fields it carries are `version`,
   * `git_commit`, `server_uri`, `vendor`, `taddr_support`, `chain_name`,
   * `sapling_activation_height`, `consensus_branch_id`, `latest_block_height` —
   * no genesis. So "is this really SWARM mainnet and not another chain calling
   * itself that" is answered by the chain label, the consensus branch id and the
   * sapling activation height, and not by the hash the profile holds. Closing
   * that gap needs a new addon entry point; it is an open question in
   * docs/MESSENGER-INTEGRATION.md rather than a silent hole.
   */
  async serverInfo(): Promise<ServerInfo> {
    this.#assertOpen();
    const raw = await callAddon<Record<string, unknown>>("info_server", () =>
      this.#addon.info_server(),
    );
    const genesisHash = stringOrNull(raw["genesis_hash"] ?? raw["genesisHash"]);
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
    const phrase = stringOr(raw["seed"], "");
    if (!phrase) {
      throw new SwarmWalletError("malformed-response", "get_seed answered no seed.", {
        call: "get_seed",
      });
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
        await this.#persist();
        return { txids, feeZat };
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

  /** Where the sync has got to, without starting one. */
  async syncStatus(): Promise<SyncStatus> {
    this.#assertOpen();
    const raw = await callAddon<Record<string, unknown>>("status_sync", () =>
      this.#addon.status_sync(),
    );
    const syncedHeight = numberOrNull(
      raw["scan_height"] ?? raw["synced_height"] ?? raw["last_scanned_height"],
    );
    const chainHeight = numberOrNull(
      raw["chain_height"] ?? raw["target_height"] ?? raw["last_known_chain_height"],
    );
    const progress =
      syncedHeight !== null && chainHeight !== null && chainHeight > 0
        ? Math.min(1, Math.max(0, syncedHeight / chainHeight))
        : null;
    return { syncing: this.#syncing, syncedHeight, chainHeight, progress, raw };
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
    // The genesis half cannot be done through this addon. `info_server` builds
    // its JSON by hand and carries no genesis_hash (see NativeAddon.info_server),
    // so `info.genesisHash` is always null and this comparison never fires
    // today. It is kept, and its emptiness is written down, because the
    // alternative — deleting it — would leave nothing to say that "same chain
    // name, different chain" is an unchecked risk. `genesisVerified` on
    // ServerInfo is what a caller should read before it trusts a balance.
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
 * Pulls address strings out of whatever the addon answered.
 *
 * `unified_addresses_json` and `transparent_addresses_json` have both been an
 * array of strings and an array of `{address: …}` objects across SDK revisions,
 * so both are read rather than one being assumed.
 */
const addressStrings = (value: unknown): readonly string[] => {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value["addresses"])
      ? value["addresses"]
      : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") out.push(entry);
    else if (isRecord(entry) && typeof entry["address"] === "string") out.push(entry["address"]);
  }
  return out;
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
