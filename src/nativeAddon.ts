/**
 * The addon, as it really is, and how it is loaded.
 *
 * `native.node` is a neon cdylib built from `native/`. Three facts about it
 * decide the whole shape of this package, and they are all written down here
 * rather than discovered later:
 *
 *  1. **It is a process singleton.** There is no handle. `native/src/lib.rs`
 *     keeps one `static LIGHTCLIENT: RwLock<Option<LightClient>>`, every
 *     `init_*` resets it, and every other call operates on whatever is in it.
 *     So one process holds at most one open wallet, and `openOrCreate` refuses
 *     a second.
 *
 *  2. **Everything crosses as a string.** Results are JSON, mostly
 *     pretty-printed; failures arrive either as a thrown `Error` (the promise
 *     rejects) or as a resolved `{"error": "…"}` object, depending on the entry
 *     point. `send`, `confirm`, `parse_address` and `delete_wallet` use the
 *     second shape deliberately, "so no success can resemble a failure". The
 *     wrapper normalises both into thrown `SwarmWalletError`s.
 *
 *  3. **The first argument is a chain HINT, not a chain label.** See
 *     `networkProfiles.ts`. It is typed here as a branded string that only
 *     `nativeChainHint` can produce, so a bare label cannot reach the addon by
 *     accident — and `test/chainHint.test.ts` reads this package's own source
 *     in case someone casts around the brand.
 *
 * The declarations below are the subset of `src/native.node.d.ts` (wallet
 * `745c2092`) that this package uses, plus `set_wallet_base_dir`, which the
 * wallet's own `.d.ts` never declared although `public/electron.js` calls it.
 */

import { createRequire } from "node:module";

import type { ChainHint, PerformanceLevel } from "./types.js";

/** The raw addon surface this package uses. Every string is JSON unless noted. */
export type NativeAddon = {
  /**
   * Sets the directory the addon builds wallet paths under. Answers `false`
   * when one was already set — it is a `OnceCell`, so the FIRST caller in the
   * process wins and it cannot be changed afterwards.
   *
   * Not JSON: a boolean.
   */
  set_wallet_base_dir(path: string): boolean;

  /** Drops the open wallet from memory without touching the file. Returns "OK". */
  deinitialize(): string;

  /** Whether a wallet file for this name and chain is already on disk. */
  wallet_exists(
    server_uri: string,
    chain_hint: ChainHint,
    performance_level: PerformanceLevel,
    min_confirmations: number,
    wallet_name: string,
  ): boolean;

  /**
   * Creates a new wallet and returns its **seed phrase JSON**. The birthday is
   * derived from the server's chain tip, so this call needs the network.
   */
  init_new(
    server_uri: string,
    chain_hint: ChainHint,
    performance_level: PerformanceLevel,
    min_confirmations: number,
    wallet_name: string,
  ): string;

  /** Restores from a BIP-39 phrase. Returns the seed JSON. */
  init_from_seed(
    seed: string,
    birthday: number,
    server_uri: string,
    chain_hint: ChainHint,
    performance_level: PerformanceLevel,
    min_confirmations: number,
    wallet_name: string,
  ): string;

  /** Opens the wallet file already on disk. Returns the seed JSON. */
  init_from_b64(
    server_uri: string,
    chain_hint: ChainHint,
    performance_level: PerformanceLevel,
    min_confirmations: number,
    wallet_name: string,
  ): string;

  /** Writes the wallet file. `{"result":"success"}` or `{"error":…}`. */
  save_wallet_file(): Promise<string>;
  /** Whether the last background save failed. */
  check_save_error(): Promise<string>;
  /** Whether the wallet has unsaved changes. */
  get_wallet_save_required(): Promise<string>;

  /** `{"seed":"…24 words…","birthday":N}`. NEVER log this. */
  get_seed(): Promise<string>;

  /** The unified full viewing key. Not a spending key, still private. */
  get_ufvk(): Promise<string>;

  get_balance(): Promise<string>;
  get_spendable_balance_total(): Promise<string>;
  get_unified_addresses(): Promise<string>;
  get_transparent_addresses(): Promise<string>;
  create_new_unified_address(receivers: string): Promise<string>;
  create_new_transparent_address(): Promise<string>;
  get_value_transfers(): Promise<string>;
  get_messages(address: string): Promise<string>;

  /** Starts the background sync task. */
  run_sync(): Promise<string>;
  /** Asks whether the sync task has finished; does not block on it. */
  poll_sync(): Promise<string>;
  pause_sync(): Promise<string>;
  stop_sync(): Promise<string>;
  status_sync(): Promise<string>;
  run_rescan(): Promise<string>;

  /** `{"height":N}` from the wallet's own view. */
  get_latest_block_wallet(): Promise<string>;
  /** `{"height":N}` from the server, without an open wallet. */
  get_latest_block_server(server_uri: string): Promise<string>;
  /** The server's `GetLightdInfo`: chain name, genesis hash, block height. */
  info_server(): Promise<string>;
  change_server(server_uri: string): Promise<string>;

  /** Whether this wallet holds a spending key or only a viewing key. */
  wallet_kind(): Promise<string>;
  get_wallet_version(): Promise<string>;
  get_version(): Promise<string>;

  /**
   * Decodes an address. Answers `{"status":"success",…}` or
   * `{"status":"Invalid address",…}` — and see `addressCheck.ts`: it tries only
   * Zcash `main`, `test` and `regtest`, so a `swm1…` address is refused here.
   */
  parse_address(address: string): Promise<string>;

  /**
   * PROPOSES a send and answers `{"fee":N}` or `{"error":…}`. It does not
   * transmit. `confirm()` transmits the stored proposal.
   */
  send(send_json: string): Promise<string>;

  /** Transmits the stored proposal. `{"txids":[…]}` or `{"error":…}`. */
  confirm(): Promise<string>;

  /** Installs the rustls crypto provider. Called once, before anything else. */
  set_crypto_default_provider_to_ring(): string;

  delete_wallet(
    server_uri: string,
    chain_hint: ChainHint,
    performance_level: PerformanceLevel,
    min_confirmations: number,
    wallet_name: string,
  ): Promise<string>;
};

/**
 * Loads `native.node`.
 *
 * `addonPath` is resolved by the caller, because only the caller knows where the
 * binary ended up: beside `dist/` in a development checkout, inside
 * `app.asar.unpacked/` in a packaged Electron app. Nothing here guesses at an
 * Electron layout — the integration doc shows the two lines the messenger's main
 * process needs.
 *
 * `require` and not `import`, because a `.node` binary is a CommonJS addon;
 * `createRequire` is how an ES module loads one.
 */
export const loadNativeAddon = (addonPath: string): NativeAddon => {
  const requireFromHere = createRequire(import.meta.url);
  const addon = requireFromHere(addonPath) as NativeAddon;
  if (typeof addon.init_new !== "function") {
    throw new Error(
      `${addonPath} loaded but is not the SWARM wallet addon: it has no init_new. ` +
        `A wrong-architecture build loads and then fails on every call, which is ` +
        `indistinguishable from a broken wallet unless it is caught here.`,
    );
  }
  return addon;
};
