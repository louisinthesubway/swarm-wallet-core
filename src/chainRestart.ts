/**
 * The SWARM network restart of 2 October 2026, as this package sees it.
 *
 * SWARM Mainnet launched on 2026-09-26 from genesis `01c34428…afdd` and was
 * restarted on 2026-10-02 from genesis `01b76d8a…eff2`. Everything else about
 * the network stayed the same — its name, its label `swarm-mainnet`, its
 * address prefixes, its rules — so a wallet file written before the restart
 * still opens. What it must not do is carry the abandoned chain's balances,
 * history and scan state onto the new one, or keep a birthday the new chain
 * has not reached.
 *
 * The design is the desktop wallet's (privacy-wallet 8b73dbc3,
 * `src/utils/chainRestart.ts` and `native/src/chain_restart.rs`), reused, not
 * re-invented:
 *
 *  * The wallet FILE cannot say which chain it was synced against: zingolib
 *    stores the SWARM Mainnet tag, not the genesis. So the package keeps a
 *    small RECORD beside the file, `<wallet name>.network.json`, that names the
 *    chain and the genesis the file belongs to. It holds no key material.
 *  * A SWARM Mainnet wallet whose record does not name this build's genesis is
 *    moved once, before it is opened. Wallets written by 0.2.0 have no record
 *    at all, and every one of them was made on the abandoned chain: 0.2.0
 *    could not reach any other.
 *  * The move is the addon's `move_wallet_to_restarted_chain`: the file is
 *    copied byte for byte to `<file>.before-network-restart-<unix>.bak` and
 *    read back, a fresh wallet is built from the same recovery phrase (or
 *    viewing key) with its birthday at the new chain's first block, every
 *    unified and transparent receive address is handed out again and compared,
 *    then the file is replaced atomically and read back. Any failure leaves the
 *    file as it was, and the wallet is not opened.
 *  * In encrypted mode the plaintext backup the addon writes is sealed with the
 *    wallet's own key and the plaintext copy wiped (`WalletStore.sealBackup`),
 *    so the move leaves no seed in the clear on disk.
 *
 * Moving is safe to repeat: a second move of an already-moved file makes a
 * second backup and changes nothing else. That is what makes a crash between
 * the move and the record write harmless.
 */

import { open as openFile, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { SwarmWalletError } from "./errors.js";
import {
  SWARM_MAINNET_ABANDONED_GENESIS,
  SwarmProfileId,
  swarmProfileFor,
} from "./networkProfiles.js";
import type { SwarmNetworkProfile } from "./networkProfiles.js";

/** The one sentence a moved wallet's owner is shown. Verbatim the desktop wallet's. */
export const CHAIN_RESTART_NOTICE =
  "The SWARM network was restarted on 2 October 2026. Your addresses and recovery phrase are unchanged; balances start again from the new chain.";

/** The title the sentence is shown under. */
export const CHAIN_RESTART_NOTICE_TITLE = "SWARM network restarted";

/** The schema name of the record, so a later version can tell its own from ours. */
export const NETWORK_RECORD_SCHEMA = "swarm-wallet-core/network-record/1";

/** What the record beside a wallet file says. No key material, ever. */
export type NetworkRecord = {
  readonly schema: typeof NETWORK_RECORD_SCHEMA;
  /** The chain label the wallet was opened on, e.g. `swarm-mainnet`. */
  readonly chain: string;
  /** The genesis of the chain the wallet file's state belongs to. */
  readonly genesis: string;
  /** When the record was written, ISO 8601 UTC. */
  readonly writtenUtc: string;
  /** Present when the file was moved onto the restarted chain. */
  readonly restart?: {
    readonly movedUtc: string;
    /** The backup's file name, beside the wallet file. Not a path. */
    readonly backupFile: string;
    readonly backupEncrypted: boolean;
    readonly previousBirthday: number;
    readonly birthday: number;
  };
};

/** What a successful move reports. No key material. */
export type ChainRestartReport = {
  /** The copy of the wallet file as it was before the move. */
  readonly backupPath: string;
  /**
   * Whether that copy is sealed with the wallet's key (encrypted mode), or a
   * plaintext copy of a plaintext wallet (plaintext mode).
   */
  readonly backupEncrypted: boolean;
  /** The birthday the wallet was carrying. */
  readonly previousBirthday: number;
  /** The birthday it carries now: the restarted chain's first block. */
  readonly birthday: number;
  /** Which keys the fresh wallet was built from. */
  readonly keyKind: "seed" | "ufvk";
  /** Unified addresses handed out again, each checked against the old list. */
  readonly unifiedAddresses: number;
  /** Transparent receive addresses handed out again, each checked. */
  readonly transparentAddresses: number;
  /** Change/refund transparent addresses the old file listed (found again by the scan). */
  readonly transparentOtherScopes: number;
  /** The genesis the wallet now belongs to. */
  readonly genesis: string;
  /** The sentence to show its owner. */
  readonly notice: string;
};

/** The record's path, beside the wallet file the addon reads. */
export const networkRecordPath = (chainDir: string, walletName: string): string =>
  join(chainDir, `${walletName}.network.json`);

/**
 * Reads the record, or `null` when there is none. A record that is not JSON,
 * or not ours, is read as "no record" — which on SWARM Mainnet means "move",
 * the safe direction: a move keeps the keys and addresses and only resets the
 * chain view.
 */
export const readNetworkRecord = async (path: string): Promise<NetworkRecord | null> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SwarmWalletError(
      "wallet-file",
      `could not read the wallet's network record ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  try {
    const parsed = JSON.parse(text) as Partial<NetworkRecord>;
    if (
      parsed &&
      parsed.schema === NETWORK_RECORD_SCHEMA &&
      typeof parsed.chain === "string" &&
      typeof parsed.genesis === "string"
    ) {
      return parsed as NetworkRecord;
    }
  } catch {
    // Not JSON: treated as absent, see above.
  }
  return null;
};

/** Writes the record atomically: temp file, fsync, rename. */
export const writeNetworkRecord = async (path: string, record: NetworkRecord): Promise<void> => {
  const temp = `${path}.tmp`;
  try {
    const handle = await openFile(temp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw new SwarmWalletError(
      "wallet-file",
      `could not write the wallet's network record ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }
};

/** A record for a wallet whose state belongs to `profile`'s current chain. */
export const currentRecord = (
  profile: SwarmNetworkProfile,
  restart?: NetworkRecord["restart"],
): NetworkRecord | null =>
  profile.genesis === null
    ? null
    : {
        schema: NETWORK_RECORD_SCHEMA,
        chain: profile.chainLabel,
        genesis: profile.genesis,
        writtenUtc: new Date().toISOString(),
        ...(restart === undefined ? {} : { restart }),
      };

/**
 * Whether a wallet on `chain` with this record must be moved before it is
 * opened: a SWARM Mainnet wallet whose record does not name this build's
 * genesis. Only SWARM Mainnet was restarted; no other wallet is ever moved.
 */
export const recordNeedsMove = (chain: string, record: NetworkRecord | null): boolean => {
  const profile = swarmProfileFor(chain);
  if (!profile || profile.id !== SwarmProfileId.mainnet || profile.genesis === null) return false;
  return record?.genesis !== profile.genesis;
};

/** Whether a record names the abandoned chain (or none, which means the same). */
export const recordIsFromAbandonedChain = (record: NetworkRecord | null): boolean =>
  record === null || record.genesis === SWARM_MAINNET_ABANDONED_GENESIS;

/**
 * Reads the addon's JSON report. The addon answers snake_case and this package
 * answers camelCase; a report missing a field is a malformed answer, never a
 * guessed one, because it is the proof the move happened.
 */
export const parseNativeRestartReport = (
  raw: unknown,
): Omit<ChainRestartReport, "backupEncrypted" | "genesis" | "notice"> => {
  const call = "move_wallet_to_restarted_chain";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SwarmWalletError("malformed-response", `${call} answered ${JSON.stringify(raw)}.`, {
      call,
    });
  }
  const r = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const value = r[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    throw new SwarmWalletError(
      "malformed-response",
      `${call} answered no usable ${key}: keys present [${Object.keys(r).join(", ")}].`,
      { call },
    );
  };
  const backupPath = r["backup_path"];
  const keyKind = r["key_kind"];
  if (typeof backupPath !== "string" || backupPath.length === 0) {
    throw new SwarmWalletError("malformed-response", `${call} answered no backup_path.`, { call });
  }
  if (keyKind !== "seed" && keyKind !== "ufvk") {
    throw new SwarmWalletError(
      "malformed-response",
      `${call} answered key_kind ${JSON.stringify(keyKind)}.`,
      { call },
    );
  }
  return {
    backupPath,
    previousBirthday: num("previous_birthday"),
    birthday: num("birthday"),
    keyKind,
    unifiedAddresses: num("unified_addresses"),
    transparentAddresses: num("transparent_addresses"),
    transparentOtherScopes: num("transparent_other_scopes"),
  };
};
