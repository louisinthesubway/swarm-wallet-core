/**
 * The wallet file, and how it is protected at rest.
 *
 * ## What the addon does, honestly
 *
 * The addon writes a **plaintext** wallet file. `native/src/lib.rs`'s
 * `write_to_path` opens a temp file beside the target, writes the bytes zingolib
 * serialised, `fsync`s, renames over the target and `fsync`s the directory. There
 * is no passphrase and no key: the seed and the spending keys are in that file in
 * the clear. The path is
 *
 *     <base directory>/<chain subdirectory>/<wallet name>
 *
 * where the base directory is whatever `set_wallet_base_dir` was given (a
 * `OnceCell` — the FIRST caller in the process wins, for the whole process
 * lifetime) and the chain subdirectory is `swarm-mainnet`, `swarm-testnet`,
 * `testnet3`, `regtest` or nothing, exactly as `construct_uri_load_config`
 * decides it.
 *
 * ## What this wrapper adds, and what it cannot
 *
 * `WalletStore` keeps the wallet file **encrypted at rest** with a 32-byte key
 * the caller supplies — in the messenger, a key generated once and kept in
 * Electron's `safeStorage`, which is the OS keychain (Keychain on macOS, DPAPI on
 * Windows, libsecret/kwallet on Linux). The cipher is AES-256-GCM from Node's
 * own `crypto`, with a fresh 12-byte nonce per save and the file version and
 * nonce as additional authenticated data. Nothing cryptographic is invented
 * here: no new primitive, no new key derivation, no change to anything the addon
 * or zingolib does.
 *
 * The honest limitation, stated plainly because it is the whole risk:
 *
 * > **While a wallet is open, its plaintext exists on disk.** The addon can only
 * > read and write a plaintext file, so `open()` decrypts the ciphertext to a
 * > working file inside a private directory, and `close()` overwrites and unlinks
 * > it. Between those two moments the working file is readable by anything
 * > running as the same user with the same privileges. Encryption at rest means
 * > at rest: it protects a stolen laptop, a synced backup folder, a disk image,
 * > and another user account on the same machine. It does not protect against
 * > malware already running as the user, which could equally read the addon's
 * > memory.
 *
 * What is done to narrow that window:
 *
 * * The working directory is created with mode `0o700` and the working file with
 *   `0o600`. On Windows those modes are advisory, so the directory is also placed
 *   under the caller's per-account data directory, which the OS already ACLs to
 *   the user; there is a note in the integration doc about tightening it with
 *   `icacls` if the owner wants belt and braces.
 * * `close()` overwrites the working file with random bytes of the same length,
 *   `fsync`s, truncates and unlinks it. On a copy-on-write or log-structured
 *   filesystem (APFS, btrfs, any SSD doing wear levelling) that does not
 *   guarantee the old blocks are gone. Said here rather than implied.
 * * A crash leaves the working file behind. `open()` finds it, refuses to trust
 *   it silently, and takes the documented recovery path: a working file at least
 *   as new as the ciphertext is re-encrypted first, because it is the only copy
 *   of whatever the wallet learned before the crash; only a strictly older one is
 *   wiped. Ties go to the working file deliberately — on a filesystem with
 *   coarse timestamps the two can share an mtime, and throwing away the only copy
 *   is the worse of the two mistakes.
 * * A plaintext wallet with no ciphertext beside it — the desktop wallet's file,
 *   or this package run once without a key — is **adopted**: sealed in place and
 *   left where the addon expects it. `exists()` sees it too, so nothing reports
 *   "no wallet here" and writes a new seed over it.
 * * `close()` wipes the plaintext only when there is a sealed copy of it. A
 *   failed seal leaves the plaintext alone and throws, because after a failed
 *   save the plaintext is the only copy there is.
 *
 * ## Plaintext mode
 *
 * With no key, `WalletStore` does nothing but resolve paths and create the
 * directory: the addon's own file, in the caller's directory, unencrypted. That
 * is the wallet's current behaviour and it stays available, so a caller that has
 * nowhere to keep a key is not forced into a false sense of one. `encrypted` on
 * the instance says which mode it is in, and the messenger is expected to log
 * that at startup.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open as openFile,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SwarmWalletError } from "./errors.js";
import { walletSubdirectoryFor } from "./networkProfiles.js";

/** How long the key must be. AES-256. */
export const WALLET_KEY_BYTES = 32;

/** The magic and version of the encrypted container. */
const MAGIC = Buffer.from("SWMWALLET1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type WalletStoreOptions = {
  /**
   * The directory the caller owns. In the messenger: the per-account wallet
   * directory under Electron's `userData`. Created if it does not exist.
   */
  readonly dataDir: string;
  /** The chain label, which decides the subdirectory the addon will use. */
  readonly chain: string;
  /** The wallet file name. Defaults to `swarm-wallet.dat`. */
  readonly walletName?: string;
  /**
   * 32 bytes. When absent the wallet file is left in plaintext and
   * `encrypted` is false.
   */
  readonly encryptionKey?: Uint8Array;
};

/** Where everything is, once the store has resolved it. */
export type WalletPaths = {
  /** What `set_wallet_base_dir` must be given. */
  readonly baseDir: string;
  /** The directory the addon will actually write in. */
  readonly chainDir: string;
  /** The plaintext file the addon reads and writes. */
  readonly workingFile: string;
  /** The ciphertext at rest, or `null` in plaintext mode. */
  readonly encryptedFile: string | null;
  /** The name to pass as the addon's `wallet_name` argument. */
  readonly walletName: string;
};

export class WalletStore {
  readonly paths: WalletPaths;

  readonly encrypted: boolean;

  /** Kept in memory only while the wallet is open; never logged, never written. */
  #key: Buffer | null;

  #open = false;

  constructor(options: WalletStoreOptions) {
    const walletName = options.walletName ?? "swarm-wallet.dat";
    if (walletName.includes("/") || walletName.includes("\\") || walletName.includes("..")) {
      throw new SwarmWalletError(
        "bad-argument",
        `walletName "${walletName}" must be a file name, not a path: the addon joins it onto the ` +
          `chain directory, so a separator here escapes the directory the caller owns.`,
      );
    }
    if (options.encryptionKey && options.encryptionKey.byteLength !== WALLET_KEY_BYTES) {
      throw new SwarmWalletError(
        "bad-argument",
        `encryptionKey must be exactly ${WALLET_KEY_BYTES} bytes (AES-256), got ${options.encryptionKey.byteLength}.`,
      );
    }

    const baseDir = resolve(options.dataDir);
    const subdirectory = walletSubdirectoryFor(options.chain);
    const chainDir = subdirectory ? join(baseDir, subdirectory) : baseDir;
    this.#key = options.encryptionKey ? Buffer.from(options.encryptionKey) : null;
    this.encrypted = this.#key !== null;
    this.paths = {
      baseDir,
      chainDir,
      walletName,
      workingFile: join(chainDir, walletName),
      encryptedFile: this.encrypted ? join(chainDir, `${walletName}.enc`) : null,
    };
  }

  /**
   * Whether a wallet exists here at all.
   *
   * In encrypted mode this looks at the plaintext working file **as well as** the
   * ciphertext, and that is not a nicety. It used to look only at the ciphertext,
   * so a plaintext wallet left by the desktop wallet — or by an earlier run of
   * this package with no key — was invisible: `openOrCreate` reported
   * `existed: false`, ran `init_new`, and the addon wrote a brand new seed over a
   * funded wallet's file and then sealed it. `#decrypt`'s own error text
   * advertises that migration path, and `exists()` guaranteed it was never
   * reached.
   */
  async exists(): Promise<boolean> {
    const { encryptedFile, workingFile } = this.paths;
    if (await fileExists(workingFile)) return true;
    return encryptedFile === null ? false : fileExists(encryptedFile);
  }

  /**
   * Makes the directory, then puts the plaintext where the addon expects it.
   *
   * In plaintext mode: creates the directory and returns. In encrypted mode:
   * decrypts the ciphertext onto the working path, resolving a leftover working
   * file from a crash as documented at the top of this file.
   */
  async open(): Promise<WalletPaths> {
    if (this.#open) {
      throw new SwarmWalletError("already-open", "This WalletStore is already open.");
    }
    try {
      return await this.#openInner();
    } catch (error) {
      // A wrong key or an altered file is the ordinary failure here, and the key
      // used to stay live in a Buffer for the life of the process afterwards
      // because only close() cleared it — and there is no wallet object to close.
      this.#key?.fill(0);
      this.#key = null;
      throw error;
    }
  }

  async #openInner(): Promise<WalletPaths> {
    await mkdir(this.paths.chainDir, { recursive: true, mode: 0o700 });
    await chmodQuietly(this.paths.chainDir, 0o700);

    const { encryptedFile, workingFile } = this.paths;
    if (encryptedFile === null) {
      this.#open = true;
      return this.paths;
    }

    const [hasCipher, hasWorking] = await Promise.all([
      fileExists(encryptedFile),
      fileExists(workingFile),
    ]);

    if (hasWorking && !hasCipher) {
      // A plaintext wallet and no ciphertext: either the desktop wallet's file,
      // or this package run once without a key. Seal it in place and leave the
      // plaintext where the addon expects it. Adopting it is the only safe
      // answer — the alternative is what used to happen, which was not seeing it
      // and writing a new seed over it.
      await this.save();
      this.#open = true;
      return this.paths;
    }

    if (hasWorking && hasCipher) {
      const [workingStat, cipherStat] = await Promise.all([stat(workingFile), stat(encryptedFile)]);
      // `>=`, not `>`: on a filesystem with coarse timestamps a genuinely newer
      // post-crash working file can share the ciphertext's mtime, and throwing
      // away the only copy of what the wallet learned is the worse mistake.
      if (workingStat.mtimeMs >= cipherStat.mtimeMs) {
        await this.save();
      } else {
        await this.#wipeWorkingFile();
      }
    }

    if (hasCipher) {
      const sealed = await readFile(encryptedFile);
      const plaintext = this.#decrypt(sealed, encryptedFile);
      await writeFile(workingFile, plaintext, { mode: 0o600 });
      await chmodQuietly(workingFile, 0o600);
      plaintext.fill(0);
    }

    this.#open = true;
    return this.paths;
  }

  /**
   * Encrypts the working file to the ciphertext at rest.
   *
   * Call it after `save_wallet_file()`, and before `close()`. In plaintext mode
   * it is a no-op, because the addon has already written the only file there is.
   */
  async save(): Promise<void> {
    const { encryptedFile, workingFile } = this.paths;
    if (encryptedFile === null) return;
    const info = await stat(workingFile).catch(() => null);
    if (info === null) {
      throw new SwarmWalletError(
        "wallet-file",
        `nothing to seal: the addon has not written ${workingFile}. Call save_wallet_file() first.`,
      );
    }
    // A zero-length working file must never replace a good ciphertext.
    // `#wipeWorkingFile` truncates before it unlinks, so a failed unlink (a
    // Windows file lock) or a crash in that window leaves an empty file with a
    // fresh mtime — which `open()` would then read as "newer, therefore the only
    // copy" and seal over the real wallet.
    if (info.size === 0) {
      throw new SwarmWalletError(
        "wallet-file",
        `refusing to seal ${workingFile}: it is empty. An empty wallet file is what a wiped or ` +
          `half-written one looks like, and sealing it would replace the wallet at rest with ` +
          `nothing.`,
      );
    }
    const plaintext = await readFile(workingFile);
    const sealed = this.#encrypt(plaintext);
    plaintext.fill(0);
    // Same discipline as the addon's own write_to_path: temp file, fsync,
    // rename, fsync the directory. A wallet half-written is a wallet lost.
    const temp = `${encryptedFile}.tmp`;
    const handle = await openFile(temp, "w", 0o600);
    try {
      await handle.writeFile(sealed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, encryptedFile);
    await syncDirectory(dirname(encryptedFile));
  }

  /**
   * Seals, then removes the plaintext.
   *
   * `seal` defaults to true. Pass false only when the addon failed to write and
   * the working file is known to be stale or absent.
   */
  async close(options: { seal?: boolean } = {}): Promise<void> {
    const { seal = true } = options;
    const encrypted = this.paths.encryptedFile !== null;
    const hadPlaintext = encrypted && (await fileExists(this.paths.workingFile));
    let sealed = false;
    let sealError: unknown = null;
    if (seal && hadPlaintext) {
      try {
        await this.save();
        sealed = true;
      } catch (error) {
        sealError = error;
      }
    }
    try {
      // The plaintext is wiped ONLY when there is a sealed copy of it, or when the
      // caller said not to seal. Wiping after a failed save — a full disk, an
      // EPERM on the temp file, an antivirus holding it, a rename that did not
      // land — destroyed the only copy of the wallet and left either a stale
      // ciphertext or, on a first save, none at all. The error propagated, by
      // which time the seed was gone.
      if (encrypted && (!hadPlaintext || sealed || !seal)) {
        await this.#wipeWorkingFile();
      }
    } finally {
      this.#key?.fill(0);
      this.#key = null;
      this.#open = false;
    }
    if (sealError !== null) {
      throw new SwarmWalletError(
        "wallet-file",
        `the wallet could not be sealed: ${(sealError as Error).message}. The plaintext wallet ` +
          `file has been LEFT IN PLACE at ${this.paths.workingFile}, because it is the only ` +
          `copy — do not delete it, and do not report this wallet as closed.`,
        { cause: sealError },
      );
    }
  }

  /** Generates a key for a caller that has nowhere to get one. */
  static generateKey(): Buffer {
    return randomBytes(WALLET_KEY_BYTES);
  }

  #encrypt(plaintext: Buffer): Buffer {
    const key = this.#requireKey();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.concat([MAGIC, nonce]));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), body]);
  }

  #decrypt(sealed: Buffer, path: string): Buffer {
    const key = this.#requireKey();
    const headerLength = MAGIC.length + NONCE_BYTES + TAG_BYTES;
    if (sealed.length < headerLength) {
      throw new SwarmWalletError(
        "wallet-file",
        `${path} is ${sealed.length} bytes, too short to be an encrypted SWARM wallet.`,
      );
    }
    const magic = sealed.subarray(0, MAGIC.length);
    if (magic.length !== MAGIC.length || !timingSafeEqual(magic, MAGIC)) {
      throw new SwarmWalletError(
        "wallet-file",
        `${path} does not start with the SWARM wallet container magic. If this is a plaintext ` +
          `wallet file from the desktop wallet, open it once with no encryptionKey and then ` +
          `supply one: the first save seals it.`,
      );
    }
    const nonce = sealed.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
    const tag = sealed.subarray(MAGIC.length + NONCE_BYTES, headerLength);
    const body = sealed.subarray(headerLength);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.concat([MAGIC, nonce]));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch (cause) {
      throw new SwarmWalletError(
        "wallet-file",
        `${path} did not decrypt: either the key is not the one it was sealed with, or the file ` +
          `has been altered. AES-GCM refuses both the same way, on purpose — a wallet file that ` +
          `decrypts to something an attacker chose is worse than one that will not open.`,
        { cause },
      );
    }
  }

  #requireKey(): Buffer {
    if (this.#key === null) {
      throw new SwarmWalletError(
        "wallet-file",
        "this WalletStore has no key: either it was built without one, or it has been closed.",
      );
    }
    return this.#key;
  }

  async #wipeWorkingFile(): Promise<void> {
    const { workingFile } = this.paths;
    try {
      const info = await stat(workingFile);
      if (info.size > 0) {
        const handle = await openFile(workingFile, "r+");
        try {
          await handle.write(randomBytes(info.size), 0, info.size, 0);
          await handle.sync();
          await handle.truncate(0);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await unlink(workingFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new SwarmWalletError(
          "wallet-file",
          `could not remove the plaintext wallet at ${workingFile}: ${(error as Error).message}. ` +
            `The plaintext is still on disk; do not report the wallet as closed.`,
          { cause: error },
        );
      }
    }
  }
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

/** `chmod` is meaningless on Windows and must not fail the open there. */
const chmodQuietly = async (path: string, mode: number): Promise<void> => {
  try {
    await chmod(path, mode);
  } catch {
    // Windows, or a filesystem without POSIX modes. The directory is still under
    // the user's own profile, which is where the OS ACL does this job.
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  try {
    const handle = await openFile(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows cannot open a directory for fsync. The rename is still atomic
    // there, which is the property that matters.
  }
};
