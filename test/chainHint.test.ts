/**
 * The addon takes a chain HINT, and for SWARM production the hint is not the
 * chain label.
 *
 * `ChainType::SwarmMainnet` carries the genesis hash and the SDK gives it no
 * default, so `swarm-mainnet` on its own is an error there, deliberately — the
 * hint has to be `swarm-mainnet:<64 hex>`. In the desktop wallet `chainHintFor`
 * had said so since the profile was written, in a documented and tested function
 * that **nothing called**: all fifteen call sites passed the chain label straight
 * through, and the type declaration said that was fine because for the other four
 * chains the hint and the label are the same string. The owner found out by
 * pressing Create on the mainnet build:
 *
 *   initializing wallet: 'swarm-mainnet' does not name a network. The SWARM
 *   production network is opened as 'swarm-mainnet:<genesis>'
 *
 * The first half of this file tests the builder. The second half reads the source
 * of this package, because a builder nobody calls is what failed there — and
 * because the branded `ChainHint` type is defeated by a cast, so the scan also
 * looks for casts.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SWARM_MAINNET_PROFILE,
  SWARM_TESTNET_PROFILE,
  chainHintFor,
  nativeChainHint,
  unselectableReason,
  withoutGenesis,
} from "../src/networkProfiles.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = join(here, "..", "src");

describe("the chain hint the addon is given", () => {
  it("carries the genesis for SWARM production, because the SDK has no default for it", () => {
    expect(nativeChainHint("swarm-mainnet")).toBe(
      `swarm-mainnet:${SWARM_MAINNET_PROFILE.genesis}`,
    );
    expect(nativeChainHint("swarm-mainnet")).toMatch(/^swarm-mainnet:[0-9a-f]{64}$/);
  });

  it("carries the genesis SWARM actually launched from", () => {
    expect(SWARM_MAINNET_PROFILE.genesis).toBe(
      "01c34428b9e67cdd8345e0b365aaa37dd8d2d65d3869e0e5d77d567f2c39afdd",
    );
  });

  it("is the bare label for SwarmTestnet, which is what the addon has always been sent", () => {
    expect(nativeChainHint("swarm-testnet")).toBe("swarm-testnet");
    expect(SWARM_TESTNET_PROFILE.chainLabel).toBe("swarm-testnet");
  });

  it("leaves upstream Zcash's chains exactly as they were", () => {
    expect(nativeChainHint("main")).toBe("main");
    expect(nativeChainHint("test")).toBe("test");
    expect(nativeChainHint("regtest")).toBe("regtest");
    expect(nativeChainHint(undefined)).toBe("");
  });

  it("refuses to build a hint for a network with no genesis", () => {
    const unlaunched = withoutGenesis(SWARM_MAINNET_PROFILE);
    expect(() => chainHintFor(unlaunched)).toThrow(/has not launched yet/);
    expect(unselectableReason(unlaunched)).toMatch(/genesis block is generated at the launch/);
  });
});

/** Every addon entry point that takes a chain hint, and where in its arguments. */
const NATIVES: Record<string, number> = {
  wallet_exists: 1,
  init_new: 1,
  init_from_seed: 3,
  init_from_ufvk: 3,
  init_from_b64: 1,
  delete_wallet: 1,
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    // nativeAddon.ts only DECLARES the entry points; it never calls them.
    if (entry.name === "nativeAddon.ts") return [];
    return [full];
  });

/**
 * The source with its comments taken out.
 *
 * Without this the sweep reads the documentation: `src/types.ts` explains the
 * branded hint with the words `native.init_new(server, "swarm-mainnet", …)`, and
 * a scanner that cannot tell a warning from a bug reports the warning.
 */
const withoutComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

/** The text between the parentheses of the call whose `(` is at `open`. */
const argumentsAt = (text: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced call");
};

/** Split an argument list on its top-level commas. */
const splitArguments = (text: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
};

type CallSite = { file: string; fn: string; chainArgument: string };

const callSites = (): CallSite[] => {
  const found: CallSite[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const [fn, position] of Object.entries(NATIVES)) {
      // `.init_new(` — however the addon object is spelled at the call site.
      const pattern = new RegExp(`\\.${fn}\\(`, "g");
      let match = pattern.exec(text);
      while (match !== null) {
        const args = splitArguments(argumentsAt(text, match.index + match[0].length - 1));
        if (args.length > position) {
          found.push({
            file: relative(join(here, ".."), file).replace(/\\/g, "/"),
            fn,
            chainArgument: (args[position] ?? "").trim(),
          });
        }
        match = pattern.exec(text);
      }
    }
  }
  return found;
};

describe("every addon call that takes a chain hint builds one", () => {
  it("finds the call sites at all, so an empty sweep cannot pass", () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(sites.map((site) => site.fn).sort()).toContain("init_new");
  });

  it("passes nativeChainHint(...) and never a bare chain label", () => {
    const offenders = callSites().filter(
      (site) => !site.chainArgument.startsWith("nativeChainHint("),
    );
    expect(offenders.map((o) => `${o.file}: .${o.fn}(… ${o.chainArgument} …)`)).toEqual([]);
  });

  it("casts nothing to ChainHint outside the one function that produces one", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).replace(/\\/g, "/");
      if (name === "networkProfiles.ts") continue;
      const text = withoutComments(readFileSync(file, "utf8"));
      text.split("\n").forEach((line, index) => {
        if (/as\s+ChainHint\b|<ChainHint>/.test(line)) {
          offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("names the branded type in the addon declarations, so a label cannot typecheck", () => {
    const declarations = readFileSync(join(sourceRoot, "nativeAddon.ts"), "utf8");
    for (const fn of Object.keys(NATIVES)) {
      if (!declarations.includes(`${fn}(`)) continue;
      const start = declarations.indexOf(`${fn}(`);
      const body = declarations.slice(start, declarations.indexOf("\n  )", start));
      expect(body, `${fn} must declare chain_hint as ChainHint`).toContain(
        "chain_hint: ChainHint",
      );
    }
  });
});
