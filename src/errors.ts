/**
 * One error type, and the two ways the addon reports failure.
 *
 * The addon is inconsistent about it, deliberately. Some entry points reject the
 * promise with an `Error` whose message is a cause chain; others resolve with a
 * JSON object carrying `error`, "so no success can resemble a failure" — `send`,
 * `confirm`, `parse_address` and `delete_wallet` are the second kind. A caller
 * should not have to know which. Everything in this package throws.
 */

/** What the wrapper was doing when it failed. */
export type SwarmWalletErrorCode =
  /** The addon was asked for something before a wallet was open. */
  | "not-open"
  /** A second wallet was opened in a process that already has one. */
  | "already-open"
  /** The chain hint, server or directory the caller supplied cannot be used. */
  | "bad-argument"
  /** The addon refused: a cause chain from zingolib. */
  | "addon"
  /** The server is not the chain this wallet is on. */
  | "wrong-chain"
  /** Reading, writing, encrypting or decrypting the wallet file failed. */
  | "wallet-file"
  /** The addon answered something this wrapper cannot read. */
  | "malformed-response";

export class SwarmWalletError extends Error {
  readonly code: SwarmWalletErrorCode;

  /** The addon call that produced it, when there was one. */
  readonly call: string | undefined;

  constructor(
    code: SwarmWalletErrorCode,
    message: string,
    options?: { call?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SwarmWalletError";
    this.code = code;
    this.call = options?.call;
  }
}

/**
 * Parses an addon answer, turning both failure shapes into a throw.
 *
 * `raw` is what the addon resolved with. An `{"error": …}` object becomes a
 * `SwarmWalletError`; anything else is returned as parsed JSON.
 */
export const parseAddonJson = <T = unknown>(raw: string, call: string): T => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new SwarmWalletError(
      "malformed-response",
      `${call} answered something that is not JSON: ${truncate(raw)}`,
      { call, cause },
    );
  }
  if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
    const { error } = parsed as { error: unknown };
    throw new SwarmWalletError("addon", `${call}: ${String(error)}`, { call });
  }
  return parsed as T;
};

/**
 * Runs an addon call and rewrites whichever way it fails.
 *
 * The addon's thrown errors carry zingolib cause chains, which are the useful
 * part; they are kept verbatim as the message and as `cause`.
 */
export const callAddon = async <T>(call: string, work: () => Promise<string>): Promise<T> => {
  let raw: string;
  try {
    raw = await work();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SwarmWalletError(
      message.includes("Lightclient is not initialized") ? "not-open" : "addon",
      `${call}: ${message}`,
      { call, cause },
    );
  }
  return parseAddonJson<T>(raw, call);
};

const truncate = (text: string, limit = 200): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} characters)`;
