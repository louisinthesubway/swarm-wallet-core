/**
 * Zatoshi in, SWM on screen.
 *
 * Every amount this package carries is a `bigint` count of zatoshi. These are
 * the only two functions that turn one into a decimal string and back, so a
 * rounding rule lives in one place and a test can hold it there.
 */

import { ZATOSHI_PER_SWM } from "./types.js";

/** How many decimal places one SWM has. */
export const SWM_DECIMALS = 8;

export type FormatOptions = {
  /**
   * Show at least this many decimals. Default 0: a whole number of SWM reads as
   * "1 SWM", not "1.00000000 SWM".
   */
  readonly minDecimals?: number;
  /** Show at most this many. Default 8, which is all of them. */
  readonly maxDecimals?: number;
  /** Append " SWM". Default false — a layout usually puts the ticker itself. */
  readonly withTicker?: boolean;
  /** Group the integer part with thin spaces, as the style guide does. */
  readonly group?: boolean;
};

/**
 * Formats zatoshi as SWM. Truncates towards zero; it never rounds a balance up,
 * because a balance that reads higher than it is has cost someone a failed send.
 */
export const formatSwm = (zatoshi: bigint, options: FormatOptions = {}): string => {
  const { minDecimals = 0, maxDecimals = SWM_DECIMALS, withTicker = false, group = false } = options;
  if (minDecimals < 0 || maxDecimals > SWM_DECIMALS || minDecimals > maxDecimals) {
    throw new RangeError(
      `decimals must satisfy 0 <= minDecimals <= maxDecimals <= ${SWM_DECIMALS}, got ${minDecimals} and ${maxDecimals}`,
    );
  }

  const negative = zatoshi < 0n;
  const absolute = negative ? -zatoshi : zatoshi;
  const whole = absolute / ZATOSHI_PER_SWM;
  const fraction = absolute % ZATOSHI_PER_SWM;

  let digits = fraction.toString().padStart(SWM_DECIMALS, "0").slice(0, maxDecimals);
  while (digits.length > minDecimals && digits.endsWith("0")) digits = digits.slice(0, -1);

  const wholeText = group ? groupDigits(whole.toString()) : whole.toString();
  const sign = negative ? "-" : "";
  const body = digits.length > 0 ? `${wholeText}.${digits}` : wholeText;
  return withTicker ? `${sign}${body} SWM` : `${sign}${body}`;
};

/**
 * Reads a decimal SWM amount as zatoshi.
 *
 * Strict: it refuses anything it cannot convert exactly, including more than
 * eight decimal places, exponent notation, and thousands separators. A wallet
 * amount is not a place to be forgiving — an amount field that silently drops a
 * ninth decimal has changed what the user asked to send.
 */
export const parseSwm = (text: string): bigint => {
  const value = text.trim().replace(/^\+/, "");
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new RangeError(`"${text}" is not an amount of SWM.`);
  }
  const [, sign, wholeText = "", fractionText = ""] = match;
  if (fractionText.length > SWM_DECIMALS) {
    throw new RangeError(
      `"${text}" has ${fractionText.length} decimal places; SWM has ${SWM_DECIMALS}. ` +
        `The smallest amount that can be sent is 0.00000001 SWM (one zatoshi).`,
    );
  }
  const whole = BigInt(wholeText === "" ? "0" : wholeText);
  const fraction = BigInt(fractionText.padEnd(SWM_DECIMALS, "0") || "0");
  const magnitude = whole * ZATOSHI_PER_SWM + fraction;
  return sign === "-" ? -magnitude : magnitude;
};

/** Thin-space grouping, per the SWARM style guide's numeric treatment. */
const groupDigits = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * Reads a number the addon produced as zatoshi.
 *
 * The addon prints balances as JSON numbers, which `JSON.parse` gives us as
 * doubles. Up to 2^53 that is lossless and SWARM's whole supply is far below it,
 * but a non-integer or an unsafe integer means the shape changed, and that is a
 * bug to find rather than a value to round.
 */
export const zatoshiFromJson = (value: unknown, field: string): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new RangeError(`${field} is ${JSON.stringify(value)}, which is not a count of zatoshi.`);
  }
  return BigInt(value);
};
