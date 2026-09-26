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
 * Runs an addon call and rewrites whichever way it fails, returning the raw
 * string it answered.
 *
 * For the entry points that answer **prose**, which is most of the ones that do
 * something rather than report something:
 *
 *   save_wallet_file  "Wallet saved successfully. Size: 420 bytes."
 *                     "Wallet is empty. Nothing to save."
 *   run_sync          "Launching sync task." / "Sync task already running."
 *                     / "Resuming sync task."
 *   pause_sync        "Pausing sync task."
 *   stop_sync         "Stopping sync task." / "Sync already stopped."
 *   run_rescan        "Launching rescan."
 *   poll_sync         "Sync task has not been launched."
 *                     / "Sync task is not complete."  (or JSON when ready)
 *   check_save_error  ""  (the empty string, on success)
 *
 * None of these can report a failure on the data channel — the addon says so in
 * `save_wallet_file`: "only benign status strings (which never begin with
 * "error") cross on the data channel, so no success can resemble a failure".
 * Failures reject the promise instead. So there is nothing to parse and nothing
 * to check: the string is the answer.
 *
 * The addon's thrown errors carry zingolib cause chains, which are the useful
 * part; they are kept verbatim as the message and as `cause`.
 */
export const callAddonText = async (call: string, work: () => Promise<string>): Promise<string> => {
  try {
    return await work();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SwarmWalletError(
      message.includes("Lightclient is not initialized") ? "not-open" : "addon",
      `${call}: ${message}`,
      { call, cause },
    );
  }
};

/**
 * The same, for the entry points that answer JSON, parsing it and turning an
 * `{"error": …}` object into a throw.
 *
 * Use `callAddonText` for anything in the list above. Putting one of those
 * through here is the bug that made the first live mainnet run fail:
 * `save_wallet_file answered something that is not JSON: Wallet saved
 * successfully. Size: 420 bytes.`
 */
export const callAddon = async <T>(call: string, work: () => Promise<string>): Promise<T> => {
  const raw = await callAddonText(call, work);
  return parseAddonJson<T>(raw, call);
};

const truncate = (text: string, limit = 200): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} characters)`;
