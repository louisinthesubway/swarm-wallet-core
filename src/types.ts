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

/** How hard the addon is allowed to work while syncing. */
export type PerformanceLevel = "Maximum" | "High" | "Medium" | "Low";

/** One zatoshi. 100,000,000 zatoshi = 1 SWM. */
export const ZATOSHI_PER_SWM = 100_000_000n;

/** What the wallet holds, in zatoshi. */
export type Balance = {
  /** Everything the wallet can see, confirmed or not. */
  readonly totalZat: bigint;
  /** What can be spent right now, at the configured confirmation depth. */
  readonly spendableZat: bigint;
  /** Shielded value in Orchard notes. */
  readonly orchardZat: bigint;
  /** Shielded value in Sapling notes. */
  readonly saplingZat: bigint;
  /** Unshielded value on transparent addresses. */
  readonly transparentZat: bigint;
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

/** Which receivers a new unified address should carry. */
export type ReceiverSelection = {
  readonly orchard?: boolean;
  readonly sapling?: boolean;
  readonly transparent?: boolean;
};

/** Where the sync has got to. */
export type SyncStatus = {
  /** Whether a sync task is running right now. */
  readonly syncing: boolean;
  /** The height the wallet has scanned to, or `null` when it has not started. */
  readonly syncedHeight: number | null;
  /** The chain tip the wallet knows about, or `null`. */
  readonly chainHeight: number | null;
  /** 0 to 1, or `null` when the heights do not permit an honest fraction. */
  readonly progress: number | null;
  /** The addon's own JSON. */
  readonly raw: unknown;
};

/** One movement of value in or out of this wallet. */
export type WalletTransaction = {
  readonly txid: string;
  /** `"sent"`, `"received"`, `"shield"`, `"memo-to-self"`, … as the SDK names it. */
  readonly kind: string;
  /** Signed: negative when value left the wallet. */
  readonly valueZat: bigint;
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

/** A payment that has been transmitted. */
export type SendResult = {
  /** Every transaction the send produced, in the order the SDK returned them. */
  readonly txids: readonly string[];
  /** The fee quoted for it. */
  readonly feeZat: bigint;
};

/** What the server says it is. */
export type ServerInfo = {
  /** The chain label the indexer reports. Must match the wallet's own. */
  readonly chainName: string;
  /** The genesis hash the indexer reports. Must match the profile's. */
  readonly genesisHash: string | null;
  readonly blockHeight: number | null;
  readonly vendor: string | null;
  readonly raw: unknown;
};
