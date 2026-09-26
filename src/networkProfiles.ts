/**
 * The SWARM networks this package can open a wallet on, as data, and the one
 * function that turns a chain label into the string the addon is given.
 *
 * Ported from the SWARM desktop wallet's `src/utils/networkProfiles.ts` at
 * commit `745c2092`. The semantics are the wallet's; the wallet's own reasons
 * are kept, because they are the reasons and not commentary:
 *
 *  1. The generic word "mainnet" never reaches a SWARM profile. Upstream's
 *     `main` chain is Zcash and stays Zcash — in the SDK, in the vendored
 *     address crates, and in the addon, where `"main" => ChainType::Mainnet`
 *     still decodes `u1…`/`zs1…`/`t1…`/`t3…`. SWARM production is a separate
 *     profile with its own label, `swarm-mainnet`, reachable only by that
 *     label.
 *
 *  2. A profile with no genesis hash is not selectable. A wallet that synced
 *     against the wrong chain would write its state back over the right one.
 *
 * SWARM mainnet launched on 2026-09-26 at 12:19:57 UTC, so its genesis is a
 * fact here and not a plan.
 */

import type { ChainHint } from "./types.js";

/** Which SWARM network a profile describes. */
export const SwarmProfileId = {
  testnet: "swarm-testnet",
  mainnet: "swarm-mainnet",
} as const;

export type SwarmProfileId = (typeof SwarmProfileId)[keyof typeof SwarmProfileId];

/**
 * Chain labels this package understands. The three upstream Zcash labels are
 * here because a legacy wallet file on one of them still has to be findable on
 * disk, not because this package is a Zcash wallet.
 */
export type ChainLabel = "swarm-mainnet" | "swarm-testnet" | "main" | "test" | "regtest";

/** The genesis block hash of the SWARM production network, in display order. */
export const SWARM_MAINNET_GENESIS =
  "01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd";

/** The lightwalletd the SWARM production network runs on. TLS, port 8443. */
export const SWARM_MAINNET_SERVER = "https://lwd-main.swarm.green:8443";

/** The lightwalletd SwarmTestnet runs on. */
export const SWARM_TESTNET_SERVER = "https://lwd.swarm.green:443";

/** Everything one SWARM network is, in the terms this package needs. */
export type SwarmNetworkProfile = {
  /** Which network this is. */
  readonly id: SwarmProfileId;
  /**
   * The light-wallet chain label: what the indexer reports in `GetLightdInfo`
   * and what the addon's chain hint is built from. The single string that
   * decides the chain.
   */
  readonly chainLabel: ChainLabel;
  /** What the network is called on screen. */
  readonly displayName: string;
  /** The coin balances are counted in. */
  readonly ticker: string;
  /**
   * The bech32m human-readable part of a unified address on this network:
   * `swarm1…` on testnet, `swm1…` on production. Disjoint by construction — a
   * bech32m string cannot satisfy two HRPs at once.
   */
  readonly unifiedHrp: string;
  /** Older unified HRPs this network still accepts as payment destinations. */
  readonly legacyUnifiedHrps: readonly string[];
  /** The bech32m HRP of a ZIP 320 TEX address on this network. */
  readonly texHrp: string;
  /** The leading characters of a Base58Check transparent address. */
  readonly transparentPrefixes: readonly string[];
  /** The indexer this network's wallets start on. */
  readonly defaultServer: string;
  /** The light-wallet gRPC port this network's indexer serves. */
  readonly grpcPort: number;
  /** The genesis this profile holds its indexer to, or `null` when unlaunched. */
  readonly genesis: string | null;
  /**
   * The `zingolib::config::ChainType` variant this profile means. Never
   * `Mainnet`: that variant is upstream Zcash.
   */
  readonly sdkChainType: "CustomTestnet" | "SwarmMainnet";
  /** The first block, and so the earliest birthday a wallet here can have. */
  readonly activationHeight: number;
  /**
   * The directory name the addon appends to the wallet base directory for this
   * chain. Mirrors `construct_uri_load_config` in `native/src/lib.rs`: the
   * genesis distinguishes chains, not directories, and a wallet file records
   * its own chain and refuses to open against another.
   */
  readonly walletSubdirectory: string;
};

const TESTNET: SwarmNetworkProfile = {
  id: SwarmProfileId.testnet,
  chainLabel: "swarm-testnet",
  displayName: "SWARM Testnet",
  ticker: "SWM",
  unifiedHrp: "swarm",
  legacyUnifiedHrps: ["utest"],
  texHrp: "textest",
  transparentPrefixes: ["tm", "t2"],
  defaultServer: SWARM_TESTNET_SERVER,
  grpcPort: 9067,
  genesis: "045993f5c91ea160c7ebda573dd97b0016816bca68d395bfff202779b88e2a28",
  sdkChainType: "CustomTestnet",
  activationHeight: 1,
  walletSubdirectory: "swarm-testnet",
};

const MAINNET: SwarmNetworkProfile = {
  id: SwarmProfileId.mainnet,
  chainLabel: "swarm-mainnet",
  displayName: "SWARM",
  ticker: "SWM",
  unifiedHrp: "swm",
  legacyUnifiedHrps: [],
  texHrp: "texswm",
  transparentPrefixes: ["s1", "s3"],
  defaultServer: SWARM_MAINNET_SERVER,
  grpcPort: 9068,
  genesis: SWARM_MAINNET_GENESIS,
  sdkChainType: "SwarmMainnet",
  activationHeight: 1,
  walletSubdirectory: "swarm-mainnet",
};

/** Every SWARM profile, in the order a selector would list them. */
export const SWARM_NETWORK_PROFILES: readonly SwarmNetworkProfile[] = [MAINNET, TESTNET];

export const SWARM_MAINNET_PROFILE = MAINNET;
export const SWARM_TESTNET_PROFILE = TESTNET;

/**
 * The profile a chain label names, or `undefined`.
 *
 * `undefined` for `main`, `test` and `regtest` — upstream Zcash chains with no
 * SWARM profile — and for anything unrecognised. It never falls back: a caller
 * that cannot identify the chain must not be handed one.
 */
export const swarmProfileFor = (
  chain: string | undefined | null,
): SwarmNetworkProfile | undefined =>
  SWARM_NETWORK_PROFILES.find((profile) => profile.chainLabel === chain);

/**
 * Whether this profile can be put in front of a user. A profile with no genesis
 * cannot: the wallet would have nothing to hold the server to.
 */
export const isProfileSelectable = (profile: SwarmNetworkProfile | undefined): boolean =>
  !!profile && typeof profile.genesis === "string" && profile.genesis.length > 0;

/** Why a profile is not on offer, in one sentence, or "" when it is. */
export const unselectableReason = (profile: SwarmNetworkProfile): string => {
  if (isProfileSelectable(profile)) return "";
  return (
    `${profile.displayName} has not launched yet: its genesis block is generated at the launch ` +
    `ceremony, and until this package ships that hash it cannot tell a real ${profile.displayName} ` +
    `server from any other.`
  );
};

/**
 * What a SWARM profile is called in the addon's chain HINT — the first argument
 * of `init_*`, `wallet_exists` and `delete_wallet`.
 *
 * SwarmTestnet's hint is the bare label. Production's carries the genesis after
 * a colon, because `ChainType::SwarmMainnet` holds the hash and the SDK gives it
 * no default: `ChainType::try_from("swarm-mainnet")` is an error there,
 * deliberately, so a hint without a hash cannot build one.
 */
export const chainHintFor = (profile: SwarmNetworkProfile): ChainHint => {
  if (profile.id === SwarmProfileId.testnet) return profile.chainLabel as ChainHint;
  if (!isProfileSelectable(profile)) throw new Error(unselectableReason(profile));
  return `${profile.chainLabel}:${profile.genesis}` as ChainHint;
};

/**
 * THE ONE PLACE a chain label becomes a chain hint. Every addon call that takes
 * one goes through this, and `test/chainHint.test.ts` reads the source of this
 * package and fails the build if a call site stops doing so.
 *
 * It exists because on 2026-09-26 the owner pressed Create on the first mainnet
 * wallet build and got
 *
 *   initializing wallet: 'swarm-mainnet' does not name a network. The SWARM
 *   production network is opened as 'swarm-mainnet:<genesis>'
 *
 * `chainHintFor` had been written, documented and tested, and nothing called it:
 * all fifteen call sites passed the chain label straight through, which is right
 * for every chain the addon knew when they were written and wrong for the only
 * one added since. A correct function nobody calls is not a fix.
 *
 * Upstream Zcash's `main`, `test` and `regtest` pass through unchanged: their
 * hint IS the bare label. Anything unrecognised passes through too — the
 * addon's own error is a better answer than a guess made here.
 */
export const nativeChainHint = (chain: string | undefined | null): ChainHint => {
  const profile = swarmProfileFor(chain);
  if (profile) return chainHintFor(profile);
  // The two casts in this file are the only ones in the package, and they are
  // what makes the brand mean something: a `ChainHint` exists only because it
  // came out of here.
  return (chain ?? "") as ChainHint;
};

/**
 * The directory the addon will actually put the wallet file in, given the base
 * directory it was handed.
 *
 * Mirrors `construct_uri_load_config`: every chain but Zcash mainnet gets a
 * subdirectory. Exported because `WalletStore` has to know the exact path in
 * order to encrypt the file at rest, and guessing it is how a wallet ends up
 * written in the clear next to its ciphertext.
 */
export const walletSubdirectoryFor = (chain: string | undefined | null): string => {
  const profile = swarmProfileFor(chain);
  if (profile) return profile.walletSubdirectory;
  switch (chain) {
    case "test":
      return "testnet3";
    case "regtest":
      return "regtest";
    case "main":
      return "";
    default:
      return "";
  }
};

/**
 * A copy of `profile` carrying `genesis`, for tests that have to exercise a
 * launched network other than the one this package ships.
 */
export const withGenesis = (
  profile: SwarmNetworkProfile,
  genesis: string,
): SwarmNetworkProfile => {
  if (!/^[0-9a-f]{64}$/.test(genesis)) {
    throw new Error(
      `'${genesis}' is not a block hash: a genesis is 64 lowercase hexadecimal characters in display order.`,
    );
  }
  return { ...profile, genesis };
};

/** A copy of `profile` with no genesis, for tests of the unlaunched state. */
export const withoutGenesis = (profile: SwarmNetworkProfile): SwarmNetworkProfile => ({
  ...profile,
  genesis: null,
});
