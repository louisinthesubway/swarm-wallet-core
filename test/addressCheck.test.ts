/**
 * The pre-check in front of the addon.
 *
 * Its whole job is to refuse, early, an address belonging to another chain, and
 * to say which one in a sentence a user can act on. The one thing it must never
 * do is accept a SWARM production address on a SwarmTestnet wallet or the other
 * way round: the two networks are separate and coins sent across them are lost.
 */

import { describe, expect, it } from "vitest";

import {
  AddressRefusal,
  addressRefusalMessage,
  bech32Shape,
  checkAddressForChain,
  checkAddressForProfile,
} from "../src/addressCheck.js";
import { SWARM_MAINNET_PROFILE, SWARM_TESTNET_PROFILE } from "../src/networkProfiles.js";

/** A bech32m string with a valid checksum for `hrp`, built rather than pasted. */
const bech32m = (hrp: string, dataLength = 40): string => {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const polymod = (values: number[]): number => {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const value of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ value;
      for (let i = 0; i < 5; i += 1) if ((top >> i) & 1) chk ^= GEN[i]!;
    }
    return chk >>> 0;
  };
  const expand = (text: string): number[] => [
    ...[...text].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...text].map((c) => c.charCodeAt(0) & 31),
  ];
  const data = Array.from({ length: dataLength }, (_, i) => i % 32);
  const checksum = polymod([...expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const check = Array.from({ length: 6 }, (_, i) => (checksum >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...check].map((d) => CHARSET[d]!).join("")}`;
};

describe("bech32Shape", () => {
  it("finds the HRP and the checksum kind", () => {
    const address = bech32m("swm");
    expect(bech32Shape(address)).toEqual({ hrp: "swm", encoding: "bech32m" });
  });

  it("reports a broken checksum rather than guessing", () => {
    const address = bech32m("swm");
    const broken = `${address.slice(0, -1)}${address.endsWith("q") ? "p" : "q"}`;
    expect(bech32Shape(broken)?.encoding).toBeNull();
  });

  it("is not fooled by mixed case, which BIP 173 forbids", () => {
    const address = bech32m("swm");
    expect(bech32Shape(`${address.slice(0, 5).toUpperCase()}${address.slice(5)}`)).toBeUndefined();
  });
});

describe("on a SWARM production wallet", () => {
  const verdict = (address: string) => checkAddressForProfile(address, SWARM_MAINNET_PROFILE);

  it("accepts its own unified address", () => {
    expect(verdict(bech32m("swm")).accepted).toBe(true);
  });

  it("accepts its own TEX and sapling HRPs", () => {
    expect(verdict(bech32m("texswm")).accepted).toBe(true);
    expect(verdict(bech32m("zswmsapling")).accepted).toBe(true);
  });

  it("accepts its own transparent prefixes", () => {
    expect(verdict("s1FakeTransparentAddressAaaaaaaaaaa").accepted).toBe(true);
    expect(verdict("s3FakeTransparentAddressAaaaaaaaaaa").accepted).toBe(true);
  });

  it("refuses a SwarmTestnet address, naming both networks", () => {
    const answer = verdict(bech32m("swarm"));
    expect(answer.accepted).toBe(false);
    if (!answer.accepted) {
      expect(answer.reason).toBe(AddressRefusal.otherSwarmNetwork);
      expect(answer.message).toMatch(/SWARM Testnet address/);
      expect(answer.message).toMatch(/coins sent across them are lost/);
    }
  });

  it("refuses a Zcash address, because this is not a Zcash wallet", () => {
    const unified = verdict(bech32m("u"));
    expect(unified.accepted).toBe(false);
    if (!unified.accepted) {
      expect(unified.reason).toBe(AddressRefusal.upstream);
      expect(unified.message).toMatch(/Zcash mainnet/);
    }
    const transparent = verdict("t1FakeZcashTransparentAaaaaaaaaaaa");
    expect(transparent.accepted).toBe(false);
  });

  it("refuses a damaged address of its own, so a typo is not read as another chain", () => {
    const address = bech32m("swm");
    const broken = `${address.slice(0, -1)}${address.endsWith("q") ? "p" : "q"}`;
    const answer = verdict(broken);
    expect(answer.accepted).toBe(false);
    if (!answer.accepted) expect(answer.reason).toBe(AddressRefusal.corrupt);
  });

  it("refuses an empty string and a word", () => {
    expect(verdict("").accepted).toBe(false);
    expect(verdict("hello").accepted).toBe(false);
  });
});

describe("on a SwarmTestnet wallet", () => {
  const verdict = (address: string) => checkAddressForProfile(address, SWARM_TESTNET_PROFILE);

  it("accepts its own and its legacy HRP", () => {
    expect(verdict(bech32m("swarm")).accepted).toBe(true);
    expect(verdict(bech32m("utest")).accepted).toBe(true);
  });

  it("refuses a SWARM production address", () => {
    const answer = verdict(bech32m("swm"));
    expect(answer.accepted).toBe(false);
    if (!answer.accepted) expect(answer.message).toMatch(/SWARM address/);
  });
});

describe("from a chain label", () => {
  it("has no opinion about upstream Zcash chains", () => {
    expect(checkAddressForChain(bech32m("u"), "main")).toBeUndefined();
    expect(addressRefusalMessage(bech32m("u"), "main")).toBe("");
  });

  it("answers for a SWARM chain", () => {
    expect(addressRefusalMessage(bech32m("swarm"), "swarm-mainnet")).toMatch(/SWARM Testnet/);
    expect(addressRefusalMessage(bech32m("swm"), "swarm-mainnet")).toBe("");
  });
});

describe("the two networks are disjoint", () => {
  it("no address is accepted by both profiles", () => {
    const every = [
      "swm",
      "texswm",
      "zswmsapling",
      "swarm",
      "utest",
      "textest",
      "ztestsapling",
      "u",
      "zs",
    ].map((hrp) => bech32m(hrp));
    for (const address of every) {
      const onMainnet = checkAddressForProfile(address, SWARM_MAINNET_PROFILE).accepted;
      const onTestnet = checkAddressForProfile(address, SWARM_TESTNET_PROFILE).accepted;
      expect(onMainnet && onTestnet, `${address.slice(0, 12)}… must not suit both`).toBe(false);
    }
  });
});
