/**
 * Zatoshi arithmetic, and the rounding rule.
 *
 * The rule is: truncate towards zero, never round up. A balance that reads higher
 * than it is has cost someone a failed send, and an amount field that silently
 * drops a ninth decimal has changed what the user asked to pay.
 */

import { describe, expect, it } from "vitest";

import { SWM_DECIMALS, formatSwm, parseSwm, zatoshiFromJson } from "../src/amounts.js";
import { ZATOSHI_PER_SWM } from "../src/types.js";

describe("formatSwm", () => {
  it("writes whole amounts without decimals", () => {
    expect(formatSwm(0n)).toBe("0");
    expect(formatSwm(ZATOSHI_PER_SWM)).toBe("1");
    expect(formatSwm(21_000_000n * ZATOSHI_PER_SWM)).toBe("21000000");
  });

  it("writes one zatoshi as the eight decimals it is", () => {
    expect(formatSwm(1n)).toBe("0.00000001");
    expect(formatSwm(150_000_000n)).toBe("1.5");
  });

  it("truncates rather than rounding, in both directions", () => {
    expect(formatSwm(199_999_999n, { maxDecimals: 2 })).toBe("1.99");
    expect(formatSwm(-199_999_999n, { maxDecimals: 2 })).toBe("-1.99");
  });

  it("pads to minDecimals when a column has to line up", () => {
    expect(formatSwm(ZATOSHI_PER_SWM, { minDecimals: 2 })).toBe("1.00");
    expect(formatSwm(150_000_000n, { minDecimals: 4 })).toBe("1.5000");
  });

  it("adds the ticker and groups the integer part on request", () => {
    expect(formatSwm(1_234_567_800_000_000n, { withTicker: true, group: true })).toBe(
      "12 345 678 SWM",
    );
  });

  it("refuses a decimal range SWM does not have", () => {
    expect(() => formatSwm(1n, { maxDecimals: 9 })).toThrow(RangeError);
    expect(() => formatSwm(1n, { minDecimals: 3, maxDecimals: 2 })).toThrow(RangeError);
  });
});

describe("parseSwm", () => {
  it("reads what formatSwm writes", () => {
    for (const zatoshi of [0n, 1n, 99_999_999n, ZATOSHI_PER_SWM, 2_100_000_000_000_000n]) {
      expect(parseSwm(formatSwm(zatoshi))).toBe(zatoshi);
    }
  });

  it("accepts the shapes a user actually types", () => {
    expect(parseSwm("1")).toBe(ZATOSHI_PER_SWM);
    expect(parseSwm(" 1.5 ")).toBe(150_000_000n);
    expect(parseSwm(".5")).toBe(50_000_000n);
    expect(parseSwm("1.")).toBe(ZATOSHI_PER_SWM);
    expect(parseSwm("+2")).toBe(2n * ZATOSHI_PER_SWM);
    expect(parseSwm("-0.00000001")).toBe(-1n);
  });

  it("refuses a ninth decimal instead of dropping it", () => {
    expect(() => parseSwm("0.000000001")).toThrow(/has 9 decimal places/);
  });

  it("refuses everything that is not a plain decimal", () => {
    for (const bad of ["", " ", "abc", "1e8", "1,5", "0x10", "1.2.3", "--1", "1 000"]) {
      expect(() => parseSwm(bad), `"${bad}" must be refused`).toThrow(RangeError);
    }
  });

  it("agrees with SWM_DECIMALS", () => {
    expect(SWM_DECIMALS).toBe(8);
    expect(10n ** BigInt(SWM_DECIMALS)).toBe(ZATOSHI_PER_SWM);
  });
});

describe("zatoshiFromJson", () => {
  it("reads the JSON numbers the addon prints", () => {
    expect(zatoshiFromJson(150_000_000, "balance")).toBe(150_000_000n);
    expect(zatoshiFromJson(0, "balance")).toBe(0n);
  });

  it("reads a decimal string, in case a future SDK prints one", () => {
    expect(zatoshiFromJson("2100000000000000", "balance")).toBe(2_100_000_000_000_000n);
  });

  it("refuses a non-integer rather than rounding a balance", () => {
    expect(() => zatoshiFromJson(1.5, "balance")).toThrow(/not a count of zatoshi/);
    expect(() => zatoshiFromJson(null, "balance")).toThrow(/not a count of zatoshi/);
    expect(() => zatoshiFromJson("1.5", "balance")).toThrow(/not a count of zatoshi/);
  });
});
