/**
 * Whether an address may be paid from a wallet on a given SWARM network.
 *
 * Ported unchanged in behaviour from the SWARM desktop wallet's
 * `src/utils/swarmAddress.ts` at commit `745c2092`, with the import path and the
 * enum spelling adapted to this package. The wallet's own reasons, which are
 * this file's reason for existing:
 *
 * The addon has the authority here — it decodes the address properly, against
 * the consensus parameters of the chain — but it cannot be the only check, for
 * two reasons. It is loaded by the main process and answers over IPC, so the
 * first thing a user sees after typing an address is a round trip; and the
 * build's vendored `zcash_protocol` gives the *testnet* constants SWARM's HRPs,
 * so a chain the addon calls `test` and a chain the user calls SwarmTestnet are
 * the same decode. That aliasing is exactly what must not extend to production.
 *
 * So this is a pre-check, in front of the addon, that answers from the address
 * string alone: HRP for bech32/bech32m forms, version prefix for Base58Check. It
 * never widens what the addon accepts — an address this file admits still has to
 * decode — it only refuses, early and with a sentence that says which network the
 * address belongs to and which one the wallet is on.
 *
 * ONE THING TO KNOW, and it is why `ParsedAddress` carries `decodedBy`: the
 * addon's `parse_address` tries `ChainType::Mainnet`, `Testnet` and `Regtest`
 * and nothing else (`native/src/lib.rs`, `make_decoded_chain_pair`), because an
 * address string cannot supply the genesis a `SwarmMainnet` chain type needs.
 * A `swm1…` address therefore comes back from the addon as
 * `{"status":"Invalid address"}`. On SWARM production this file's verdict is the
 * strongest answer available, and `parseAddress` says so rather than pretending
 * the addon agreed.
 */

import {
  SWARM_MAINNET_PROFILE,
  SWARM_TESTNET_PROFILE,
  SwarmProfileId,
  swarmProfileFor,
} from "./networkProfiles.js";
import type { SwarmNetworkProfile } from "./networkProfiles.js";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

export type Bech32Shape = {
  /** The human-readable part: everything before the final separator. */
  hrp: string;
  /** Which checksum the string carries, or `null` when it carries neither. */
  encoding: "bech32" | "bech32m" | null;
};

/**
 * The HRP of a bech32/bech32m string and which checksum it satisfies.
 *
 * `undefined` when the string is not of that shape at all. The separator is the
 * *last* `1`, as BIP 173 specifies, because `1` is not in the data charset but
 * may appear in an HRP.
 */
export function bech32Shape(address: string): Bech32Shape | undefined {
  const value = address.trim();
  if (!value || value.length < 8 || value.length > 2000) return undefined;
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) return undefined;
  const lower = value.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return undefined;
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const index = BECH32_CHARSET.indexOf(ch);
    if (index < 0) return undefined;
    data.push(index);
  }
  if (!/^[\x21-\x7e]+$/.test(hrp)) return undefined;
  const check = polymod(hrpExpand(hrp).concat(data));
  const encoding = check === BECH32_CONST ? "bech32" : check === BECH32M_CONST ? "bech32m" : null;
  return { hrp, encoding };
}

/** Whether `address` looks like a Base58Check string at all. */
function isBase58Shaped(address: string): boolean {
  const value = address.trim();
  if (value.length < 26 || value.length > 40) return false;
  return [...value].every((ch) => BASE58_ALPHABET.includes(ch));
}

type ForeignNetwork = {
  /** What to call the network the address belongs to, in a sentence. */
  name: string;
  /** Its unified/shielded HRPs. */
  hrps: readonly string[];
  /** Its transparent Base58Check prefixes. */
  prefixes: readonly string[];
};

/**
 * The upstream Zcash networks. Refused on every SWARM profile, always: this
 * application is not a wallet for the public Zcash network, and a payment to a
 * Zcash address from a SWARM wallet would be a payment into nothing.
 */
const UPSTREAM: readonly ForeignNetwork[] = [
  { name: "Zcash mainnet", hrps: ["u", "zs", "tex", "uview", "uivk"], prefixes: ["t1", "t3"] },
  { name: "Zcash regtest", hrps: ["uregtest", "zregtestsapling", "texregtest"], prefixes: [] },
];

/** The SWARM network an address belongs to, by its own encodings. */
function swarmHomeOf(profile: SwarmNetworkProfile): ForeignNetwork {
  return {
    name: profile.displayName,
    hrps: [profile.unifiedHrp, profile.texHrp, ...profile.legacyUnifiedHrps],
    prefixes: profile.transparentPrefixes,
  };
}

/**
 * SwarmTestnet's sapling HRP is upstream testnet's, because the vendored
 * protocol crate only renamed the unified ones. It is listed with the profile's
 * own encodings rather than under "upstream", which is what it is in this
 * build: a SwarmTestnet address.
 */
const TESTNET_EXTRA_HRPS = ["ztestsapling"];
/** The SWARM production sapling HRP, `concat!("z", HRP_ROOT, "sapling")`. */
const MAINNET_EXTRA_HRPS = ["zswmsapling"];

/** `"s1…" or "s3…"`, for a sentence that tells the user what to look for. */
function transparentShapes(profile: SwarmNetworkProfile): string {
  return profile.transparentPrefixes.map((p) => `"${p}…"`).join(" or ");
}

function acceptedHrps(profile: SwarmNetworkProfile): readonly string[] {
  const extra = profile.id === SwarmProfileId.testnet ? TESTNET_EXTRA_HRPS : MAINNET_EXTRA_HRPS;
  return [profile.unifiedHrp, profile.texHrp, ...profile.legacyUnifiedHrps, ...extra];
}

export enum AddressRefusal {
  /** Belongs to the other SWARM network. */
  otherSwarmNetwork = "other-swarm-network",
  /** Belongs to upstream Zcash. */
  upstream = "upstream",
  /** Not an address this wallet can read at all. */
  unrecognised = "unrecognised",
  /** The right shape and HRP, but the checksum does not hold. */
  corrupt = "corrupt",
}

export type AddressVerdict =
  | { accepted: true }
  | { accepted: false; reason: AddressRefusal; message: string };

const ACCEPTED: AddressVerdict = { accepted: true };

function refuse(reason: AddressRefusal, message: string): AddressVerdict {
  return { accepted: false, reason, message };
}

/**
 * Whether `address` may be paid from a wallet on `profile`.
 *
 * Accepting is not a claim that the address decodes — the addon decides that.
 * Refusing is final: no caller may pay an address this refuses.
 */
export function checkAddressForProfile(address: string, profile: SwarmNetworkProfile): AddressVerdict {
  const value = (address ?? "").trim();
  if (!value) {
    return refuse(AddressRefusal.unrecognised, "Enter an address.");
  }

  const other =
    profile.id === SwarmProfileId.mainnet ? SWARM_TESTNET_PROFILE : SWARM_MAINNET_PROFILE;
  const otherHome = swarmHomeOf(other);
  const otherExtra = other.id === SwarmProfileId.testnet ? TESTNET_EXTRA_HRPS : MAINNET_EXTRA_HRPS;

  const bech32 = bech32Shape(value);
  if (bech32) {
    const { hrp, encoding } = bech32;

    if (acceptedHrps(profile).includes(hrp)) {
      if (encoding === null) {
        return refuse(
          AddressRefusal.corrupt,
          `That ${profile.displayName} address is damaged — its checksum does not match. ` +
            `Copy it again from the sender.`,
        );
      }
      return ACCEPTED;
    }

    if ([...otherHome.hrps, ...otherExtra].includes(hrp)) {
      return refuse(
        AddressRefusal.otherSwarmNetwork,
        `That is a ${other.displayName} address (it starts "${hrp}1…"), and this wallet is on ` +
          `${profile.displayName}. The two networks are separate: coins sent across them are lost. ` +
          `Use a ${profile.displayName} address, which starts "${profile.unifiedHrp}1…".`,
      );
    }

    for (const network of UPSTREAM) {
      if (network.hrps.includes(hrp)) {
        return refuse(
          AddressRefusal.upstream,
          `That is a ${network.name} address (it starts "${hrp}1…"). This wallet is on ` +
            `${profile.displayName} and cannot pay the public Zcash network.`,
        );
      }
    }

    return refuse(
      AddressRefusal.unrecognised,
      `"${hrp}1…" is not an address ${profile.displayName} recognises. A ${profile.displayName} ` +
        `address starts "${profile.unifiedHrp}1…", or ${transparentShapes(profile)}.`,
    );
  }

  if (isBase58Shaped(value)) {
    const startsWith = (prefixes: readonly string[]) => prefixes.some((p) => value.startsWith(p));

    if (startsWith(profile.transparentPrefixes)) return ACCEPTED;

    if (startsWith(otherHome.prefixes)) {
      return refuse(
        AddressRefusal.otherSwarmNetwork,
        `That is a ${other.displayName} transparent address (it starts "${value.slice(0, 2)}…"), and ` +
          `this wallet is on ${profile.displayName}. The two networks are separate: coins sent across ` +
          `them are lost. A ${profile.displayName} transparent address starts ${transparentShapes(profile)}.`,
      );
    }

    for (const network of UPSTREAM) {
      if (startsWith(network.prefixes)) {
        return refuse(
          AddressRefusal.upstream,
          `That is a ${network.name} transparent address (it starts "${value.slice(0, 2)}…"). This ` +
            `wallet is on ${profile.displayName} and cannot pay the public Zcash network.`,
        );
      }
    }
  }

  return refuse(
    AddressRefusal.unrecognised,
    `That is not a ${profile.displayName} address. They start "${profile.unifiedHrp}1…", ` +
      `or ${transparentShapes(profile)}.`,
  );
}

/**
 * The same check, from the chain label the rest of the app carries.
 *
 * Answers `undefined` — "no opinion" — for `main`, `test` and `regtest`, which
 * are upstream Zcash chains with no SWARM profile and whose address rules are
 * the addon's business, unchanged. Only a SWARM chain gets a verdict here.
 */
export function checkAddressForChain(address: string, chain: string | undefined): AddressVerdict | undefined {
  const profile = swarmProfileFor(chain);
  if (!profile) return undefined;
  return checkAddressForProfile(address, profile);
}

/** The refusal sentence for an address on `chain`, or "" when there is none. */
export function addressRefusalMessage(address: string, chain: string | undefined): string {
  const verdict = checkAddressForChain(address, chain);
  if (!verdict || verdict.accepted) return "";
  return verdict.message;
}
