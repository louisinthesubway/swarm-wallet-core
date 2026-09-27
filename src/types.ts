/**
 * The types the wrapper hands its callers, and the two types the addon needs.
 *
 * Amounts are `bigint` zatoshi everywhere. Never `number`: 21 million SWM is
 * 2.1e15 zatoshi, which fits in a double today, and the first thing anyone does
 * with a balance is add a fee to it and multiply it by a price. `bigint` costs
 * one `n` at the call site and removes the whole class of rounding bug.
 */

/**
 * A chain hint. Produced only by `nativeChainHint`, never written as a literal.
 *
 * The wallet types this `string` on purpose, "so nothing can pass a label here
 * believing the compiler checked it". This package brands it instead, which is
 * the stronger version of the same intent: the brand cannot be satisfied by any
 * chain label, so `native.init_new(server, "swarm-mainnet", …)` does not
 * compile. The source-scanning test in `test/chainHint.test.ts` stays, because
 * a brand is defeated by a cast and a cast is what the scan looks for.
 */
export type ChainHint = string & { readonly __swarmChainHint: unique symbol };

import type { SwarmWalletError } from "./errors.js";

/** How hard the addon is allowed to work while syncing. */
export type PerformanceLevel = "Maximum" | "High" | "Medium" | "Low";

/** One zatoshi. 100,000,000 zatoshi = 1 SWM. */
export const ZATOSHI_PER_SWM = 100_000_000n;

/**
 * What the wallet holds, in zatoshi.
 *
 * `totalZat` and `spendableZat` are never guessed: if the addon's answer does not
 * carry them, `balance()` throws rather than returning a number. The per-pool
 * fields are `null` when the addon did not say, because a zero there would read
 * as "this pool is empty" when what is true is "this version cannot see it".
 *
 * The addon's `get_balance` (wallet `745c2092`, read from the mainnet.2 binary
 * on 2026-09-27) reports each pool three ways — `confirmed_<pool>_balance`,
 * `unconfirmed_<pool>_balance`, `total_<pool>_balance` — for `orchard`,
 * `sapling`, `transparent` and `ironwood`. The per-pool fields here are the
 * totals; `confirmedZat` sums the confirmed thirds.
 */
export type Balance = {
  /** Everything the wallet can see, confirmed or not. */
  readonly totalZat: bigint;
  /** What can be spent right now, at the configured confirmation depth. */
  readonly spendableZat: bigint;
  /**
   * The confirmed part of `totalZat`, summed over the pools that reported one,
   * or `null` when the addon reported no confirmed figure at all.
   */
  readonly confirmedZat: bigint | null;
  /** Shielded value in Orchard notes, or `null` when the addon did not report it. */
  readonly orchardZat: bigint | null;
  /** Shielded value in Sapling notes, or `null`. */
  readonly saplingZat: bigint | null;
  /** Unshielded value on transparent addresses, or `null`. */
  readonly transparentZat: bigint | null;
  /** Shielded value in Ironwood (NU6.3) notes, or `null`. */
  readonly ironwoodZat: bigint | null;
  /** Value received but not yet confirmed to the wallet's confirmation depth. */
  readonly pendingZat: bigint;
  /** The addon's own JSON, for anything this shape does not carry. */
  readonly raw: unknown;
};

/** Every address this wallet can be paid at. */
export type AddressSet = {
  /** Unified addresses, `swm1…` on SWARM production. Prefer these. */
  readonly unified: readonly string[];
  /** Transparent addresses, `s1…`/`s3…`. Visible on the chain to everyone. */
  readonly transparent: readonly string[];
};

/**
 * Which receivers a new unified address should carry. Both default to true.
 *
 * There is no `transparent`: the addon's `generate_unified_address` takes a
 * `ReceiverSelection { orchard, sapling }` and reads nothing else, so a
 * transparent flag here would be a promise this package cannot keep.
 */
export type ReceiverSelection = {
  readonly orchard?: boolean;
  readonly sapling?: boolean;
};

/**
 * One block range in the sync's plan, as `status_sync` reports it.
 *
 * `pepper_sync::sync_status` answers `scan_ranges: [{priority, start_block,
 * end_block}]` — the block numbers cross as **strings** — plus scanned-block and
 * scanned-output counters. `"Scanned"` is the only priority that means done.
 */
export type ScanRange = {
  readonly start: number;
  readonly end: number;
  /** `"Scanned"` when done; otherwise the sync's own word for what is pending. */
  readonly priority: string;
};

/** Where the sync has got to. */
export type SyncStatus = {
  /** Whether a sync task is running right now. */
  readonly syncing: boolean;
  /**
   * The height up to which every range is `Scanned`, or `null` when nothing
   * has been scanned yet. Read out of `scan_ranges`, walking from the lowest
   * range upwards and stopping at the first one that is not done.
   */
  readonly syncedHeight: number | null;
  /** The highest block in the sync's plan — the tip it knows about — or `null`. */
  readonly chainHeight: number | null;
  /**
   * 0 to 1, or `null` when the heights do not permit an honest fraction. The
   * addon's own `percentage_total_blocks_scanned` when it reports one.
   */
  readonly progress: number | null;
  /** Blocks scanned so far in the wallet's life, or `null` when unreported. */
  readonly blocksScanned: number | null;
  /** Every range in the plan, lowest first. Empty before the first sync. */
  readonly ranges: readonly ScanRange[];
  /** The addon's own JSON. */
  readonly raw: unknown;
};

/** One movement of value in or out of this wallet. */
export type WalletTransaction = {
  readonly txid: string;
  /** `"sent"`, `"received"`, `"shield"`, … exactly as the SDK named it. */
  readonly kind: string;
  /**
   * Which way the value went, from a list of kinds this package knows.
   *
   * `"unknown"` when `kind` is not one of them — and a caller must render that as
   * unknown rather than assuming income. A spend shown as income is the bug this
   * field exists to make impossible; the previous version inferred the direction
   * from a regex over `kind` and got it wrong for every spelling it had not been
   * shown.
   */
  readonly direction: "in" | "out" | "unknown";
  /** The magnitude, always >= 0. Apply the sign from `direction`. */
  readonly amountZat: bigint;
  /** The fee this wallet paid, when it paid one. */
  readonly feeZat: bigint | null;
  /** The block it was mined in, or `null` while it is in the mempool. */
  readonly blockHeight: number | null;
  /** Unix seconds, as the wallet recorded it. */
  readonly timestamp: number | null;
  /** The counterparty address, when the SDK knows one. */
  readonly address: string | null;
  /** The memo as UTF-8, when it is UTF-8. */
  readonly memo: string | null;
  readonly raw: unknown;
};

/** What an address turned out to be. */
export type ParsedAddress =
  | {
      readonly valid: true;
      /** The chain this address belongs to, as a label. */
      readonly chain: string;
      readonly kind: "unified" | "transparent" | "sapling" | "tex";
      /** Which receivers a unified address carries. */
      readonly receivers?: readonly string[];
      /**
       * Whether the addon itself decoded it, or only this package's HRP and
       * version-byte check did. See `addressCheck.ts`: the addon decodes only
       * Zcash `main`/`test`/`regtest`, so on SWARM production `"prefix"` is the
       * strongest answer available today and is recorded as such.
       */
      readonly decodedBy: "addon" | "prefix";
    }
  | {
      readonly valid: false;
      /** One sentence for the user, naming which network the address belongs to. */
      readonly reason: string;
      readonly decodedBy: "addon" | "prefix";
    };

/** A payment to make. */
export type SendRequest = {
  /** The destination address, on this wallet's own chain. */
  readonly to: string;
  /** How much, in zatoshi. */
  readonly amountZat: bigint;
  /**
   * Up to 512 bytes of memo, delivered encrypted to the recipient and readable
   * by nobody else. Shielded receivers only — a transparent destination cannot
   * carry one and the addon will refuse.
   */
  readonly memo?: string;
};

/** A proposed payment, with the fee the wallet would pay for it. */
export type SendQuote = {
  readonly feeZat: bigint;
  /** Transmit it. Nothing has touched the network until this resolves. */
  confirm(): Promise<SendResult>;
};

/**
 * A payment that has been transmitted.
 *
 * Once `confirm()` has resolved, the money has moved: the txids are the fact
 * that matters and nothing that happens afterwards may lose them. The wallet
 * file save that follows the transmit is therefore reported here rather than
 * thrown — a throw after the transmit was how 0.1.0 lost the txids of a payment
 * already on the network.
 */
export type SendResult = {
  /** Every transaction the send produced, in the order the SDK returned them. */
  readonly txids: readonly string[];
  /** The fee quoted for it. */
  readonly feeZat: bigint;
  /**
   * Whether the wallet file was saved and sealed after the transmit. When
   * false, `saveError` says why; the spend is recorded in the addon's memory
   * and in the chain, and the next successful save (`close()`, a later sync)
   * writes it to disk. A caller that shows a payment as sent should still do so.
   */
  readonly saved: boolean;
  /** The save failure, when `saved` is false. */
  readonly saveError: SwarmWalletError | null;
};

/**
 * What the server says it is.
 *
 * Read `genesisVerified` before trusting a balance. Since 0.2.0 the addon's
 * `info_server` carries `genesis_hash` — the height-zero block hash the indexer
 * states (SDK `swarm-sdk-mainnet-1`, `LightdInfo.genesisHash` field 19) — and
 * `openOrCreate` has already refused the server if it named another genesis. So
 * `true` here means the indexer confirmed the chain the profile holds; `false`
 * means it did not say (an older indexer answers the empty string), never that
 * it disagreed. Through the 0.1.x addon the field did not exist and this was
 * always false.
 */
export type ServerInfo = {
  /** The chain label the indexer reports. Checked against the wallet's own. */
  readonly chainName: string;
  /** The genesis the indexer states, or `null` when it did not state one. */
  readonly genesisHash: string | null;
  /** Whether the stated genesis matched the profile's. False when unstated. */
  readonly genesisVerified: boolean;
  readonly blockHeight: number | null;
  /** The consensus branch id the indexer reports, as it reports it. */
  readonly consensusBranchId: string | null;
  readonly saplingActivationHeight: number | null;
  readonly vendor: string | null;
  readonly raw: unknown;
};
