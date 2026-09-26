/**
 * `WalletStore`: what encryption at rest does and does not do.
 *
 * The limitation this file pins down is the honest one. While a wallet is open,
 * the plaintext is on disk — the addon can read nothing else. These tests hold
 * the store to the three things it can actually promise: at rest the file is
 * ciphertext, the wrong key will not open it, and a crash does not lose whatever
 * the wallet learned.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WALLET_KEY_BYTES, WalletStore } from "../src/walletStore.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "swarm-wallet-store-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const PLAINTEXT = "zingolib wallet bytes, including a spending key that must never be at rest";

const store = (key?: Uint8Array, chain = "swarm-mainnet"): WalletStore =>
  new WalletStore({
    dataDir,
    chain,
    ...(key === undefined ? {} : { encryptionKey: key }),
  });

describe("paths", () => {
  it("puts the wallet in the subdirectory the addon will choose for the chain", () => {
    expect(store(WalletStore.generateKey()).paths.chainDir).toBe(join(dataDir, "swarm-mainnet"));
    expect(store(WalletStore.generateKey(), "swarm-testnet").paths.chainDir).toBe(
      join(dataDir, "swarm-testnet"),
    );
    expect(store(WalletStore.generateKey(), "test").paths.chainDir).toBe(join(dataDir, "testnet3"));
    // Zcash mainnet is the one chain with no subdirectory, in the addon and here.
    expect(store(WalletStore.generateKey(), "main").paths.chainDir).toBe(dataDir);
  });

  it("hands the addon the base directory, not the chain directory", () => {
    // The addon appends the chain subdirectory itself. Handing it the chain
    // directory would produce <dataDir>/swarm-mainnet/swarm-mainnet/…
    expect(store(WalletStore.generateKey()).paths.baseDir).toBe(dataDir);
  });

  it("refuses a wallet name that is a path", () => {
    expect(() => new WalletStore({ dataDir, chain: "swarm-mainnet", walletName: "../escape" })).toThrow(
      /must be a file name, not a path/,
    );
    expect(() => new WalletStore({ dataDir, chain: "swarm-mainnet", walletName: "a/b" })).toThrow();
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => store(new Uint8Array(31))).toThrow(new RegExp(`exactly ${WALLET_KEY_BYTES} bytes`));
  });
});

describe("encrypted mode", () => {
  it("seals the plaintext and wipes it on close", async () => {
    const key = WalletStore.generateKey();
    const first = store(key);
    const { workingFile, encryptedFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    expect(existsSync(workingFile)).toBe(false);
    expect(existsSync(encryptedFile!)).toBe(true);
    const sealed = readFileSync(encryptedFile!);
    expect(sealed.subarray(0, 10).toString("ascii")).toBe("SWMWALLET1");
    expect(sealed.toString("latin1")).not.toContain("spending key");
  });

  it("gives the same plaintext back to the same key", async () => {
    const key = WalletStore.generateKey();
    const first = store(key);
    const { workingFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    const second = store(key);
    const paths = await second.open();
    expect(readFileSync(paths.workingFile, "utf8")).toBe(PLAINTEXT);
    await second.close();
  });

  it("refuses a different key rather than handing back rubbish", async () => {
    const first = store(WalletStore.generateKey());
    const { workingFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    const wrong = store(WalletStore.generateKey());
    await expect(wrong.open()).rejects.toThrow(/did not decrypt/);
  });

  it("refuses a file that has been altered, because the tag covers it", async () => {
    const key = WalletStore.generateKey();
    const first = store(key);
    const { workingFile, encryptedFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    const sealed = readFileSync(encryptedFile!);
    sealed[sealed.length - 1] ^= 0x01;
    writeFileSync(encryptedFile!, sealed);

    await expect(store(key).open()).rejects.toThrow(/did not decrypt|has been altered/);
  });

  it("uses a fresh nonce per save, so two saves of the same bytes differ", async () => {
    const key = WalletStore.generateKey();
    const one = store(key);
    const { workingFile, encryptedFile } = await one.open();
    writeFileSync(workingFile, PLAINTEXT);
    await one.save();
    const firstSealed = readFileSync(encryptedFile!);
    await one.save();
    const secondSealed = readFileSync(encryptedFile!);
    await one.close();
    expect(firstSealed.equals(secondSealed)).toBe(false);
  });

  it("says plainly that a plaintext wallet file is not a container", async () => {
    const key = WalletStore.generateKey();
    const target = store(key);
    await target.open();
    writeFileSync(target.paths.encryptedFile!, "a plaintext zingolib wallet, copied here by hand");
    await target.close({ seal: false });
    await expect(store(key).open()).rejects.toThrow(/container magic/);
  });

  it("refuses to seal an EMPTY working file over a good ciphertext", async () => {
    // #wipeWorkingFile truncates before it unlinks, so a failed unlink or a crash
    // in that window leaves a 0-byte file with a fresh mtime — which open() would
    // read as "newer, therefore the only copy" and seal over the real wallet.
    const key = WalletStore.generateKey();
    const one = store(key);
    const { workingFile } = await one.open();
    writeFileSync(workingFile, PLAINTEXT);
    await one.save();
    writeFileSync(workingFile, "");
    await expect(one.save()).rejects.toThrow(/it is empty/);
    await one.close({ seal: false });

    // And the wallet at rest survived.
    const two = store(key);
    const paths = await two.open();
    expect(readFileSync(paths.workingFile, "utf8")).toBe(PLAINTEXT);
    await two.close();
  });

  it("zeroes the key when open() fails, instead of leaving it live", async () => {
    const first = store(WalletStore.generateKey());
    const { workingFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    const wrong = store(WalletStore.generateKey());
    await expect(wrong.open()).rejects.toThrow(/did not decrypt/);
    // The key is gone, so nothing can be sealed with it any more. (Put a working
    // file back first, or save() would refuse for the other reason.)
    writeFileSync(wrong.paths.workingFile, PLAINTEXT);
    await expect(wrong.save()).rejects.toThrow(/has no key/);
  });

  it("refuses to be opened twice", async () => {
    const one = store(WalletStore.generateKey());
    await one.open();
    await expect(one.open()).rejects.toThrow(/already open/);
    await one.close({ seal: false });
  });
});

describe("a plaintext wallet already on disk", () => {
  it("is seen by exists(), so nothing reports an empty directory", async () => {
    // It used to be invisible: exists() looked only at the ciphertext, so
    // openOrCreate reported existed:false, ran init_new, and the addon wrote a
    // NEW SEED over a funded wallet's file and sealed it.
    const key = WalletStore.generateKey();
    const target = store(key);
    await mkdir(target.paths.chainDir, { recursive: true });
    writeFileSync(target.paths.workingFile, PLAINTEXT);
    expect(await target.exists()).toBe(true);
  });

  it("is adopted and sealed in place, not replaced", async () => {
    const key = WalletStore.generateKey();
    const first = store(key);
    await mkdir(first.paths.chainDir, { recursive: true });
    writeFileSync(first.paths.workingFile, PLAINTEXT);

    const paths = await first.open();
    // Still there, unchanged, where the addon expects it.
    expect(readFileSync(paths.workingFile, "utf8")).toBe(PLAINTEXT);
    // And already sealed, before anything else can touch it.
    expect(existsSync(paths.encryptedFile!)).toBe(true);
    await first.close();

    const second = store(key);
    const again = await second.open();
    expect(readFileSync(again.workingFile, "utf8")).toBe(PLAINTEXT);
    await second.close();
  });
});

describe("recovery after a crash", () => {
  it("keeps a working file whose mtime only EQUALS the ciphertext's", async () => {
    // Coarse filesystem timestamps make this the common case after a fast crash,
    // and `>` threw away the only copy of what the wallet had learned.
    const key = WalletStore.generateKey();
    const first = store(key);
    const { workingFile, encryptedFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    writeFileSync(workingFile, `${PLAINTEXT} — and one more block scanned`);
    // BOTH files, to the same explicit instant. Copying the ciphertext's own
    // mtime is not enough: Linux keeps nanoseconds while `stat().mtime` is a
    // millisecond Date, so the copy lands a fraction of a millisecond EARLIER and
    // the case under test never happens. That is how this passed on Windows and
    // failed on the CI runner.
    const when = new Date(Math.floor((await stat(encryptedFile!)).mtimeMs));
    await utimes(workingFile, when, when);
    await utimes(encryptedFile!, when, when);

    const second = store(key);
    const paths = await second.open();
    expect(readFileSync(paths.workingFile, "utf8")).toContain("one more block scanned");
    await second.close();
  });

  it("keeps the working file when it is newer than the ciphertext", async () => {
    const key = WalletStore.generateKey();
    const first = store(key);
    const { workingFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    // The crash: a plaintext file left behind, newer than what was sealed.
    writeFileSync(workingFile, `${PLAINTEXT} — and one more block scanned`);
    const now = new Date();
    await utimes(workingFile, now, new Date(now.getTime() + 5_000));

    const second = store(key);
    const paths = await second.open();
    expect(readFileSync(paths.workingFile, "utf8")).toContain("one more block scanned");
    await second.close();

    // And it survived: the sealed copy now carries it too.
    const third = store(key);
    const again = await third.open();
    expect(readFileSync(again.workingFile, "utf8")).toContain("one more block scanned");
    await third.close();
  });

  it("discards a stale working file when the ciphertext is at least as new", async () => {
    const key = WalletStore.generateKey();
    const first = store(key);
    const { workingFile } = await first.open();
    writeFileSync(workingFile, PLAINTEXT);
    await first.close();

    writeFileSync(workingFile, "stale leftovers from an older run");
    const old = new Date(Date.now() - 60_000);
    await utimes(workingFile, old, old);

    const second = store(key);
    const paths = await second.open();
    expect(readFileSync(paths.workingFile, "utf8")).toBe(PLAINTEXT);
    await second.close();
  });
});

describe("plaintext mode", () => {
  it("does nothing but make the directory, and says it is not encrypted", async () => {
    const plain = store(undefined);
    expect(plain.encrypted).toBe(false);
    const { workingFile, encryptedFile } = await plain.open();
    expect(encryptedFile).toBeNull();
    writeFileSync(workingFile, PLAINTEXT);
    await plain.close();
    // The addon's own file, exactly where the addon put it, untouched.
    expect(readFileSync(workingFile, "utf8")).toBe(PLAINTEXT);
  });

  it("reports whether a wallet exists in either mode", async () => {
    const key = WalletStore.generateKey();
    const sealed = store(key);
    expect(await sealed.exists()).toBe(false);
    const { workingFile } = await sealed.open();
    writeFileSync(workingFile, PLAINTEXT);
    await sealed.close();
    expect(await sealed.exists()).toBe(true);
  });
});
