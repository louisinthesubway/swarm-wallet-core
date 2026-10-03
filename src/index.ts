/**
 * `swarm-wallet-core` — the SWARM wallet as one embeddable package.
 *
 * The keys live on the device and nowhere else. There is no server-side wallet
 * in this package and no code path that sends a seed, a spending key or a
 * viewing key anywhere.
 *
 * The shortest complete use, in an Electron main process:
 *
 * ```ts
 * import { SwarmWallet, loadNativeAddon, SWARM_MAINNET_PROFILE } from "swarm-wallet-core";
 *
 * const addon = loadNativeAddon(addonPathForThisBuild());
 * const wallet = await SwarmWallet.openOrCreate({
 *   addon,
 *   dataDir: join(app.getPath("userData"), "swarm-wallet", accountId),
 *   chain: "swarm-mainnet",
 *   encryptionKey: keyFromSafeStorage(),   // 32 bytes
 * });
 *
 * wallet.on("status", ({ progress }) => sendToRenderer(progress));
 * await wallet.sync();
 * const { spendableZat } = await wallet.balance();
 * const [receive] = (await wallet.addresses()).unified;   // swm1…
 * await wallet.close();
 * ```
 *
 * `docs/MESSENGER-INTEGRATION.md` is the design for Signal-Desktop, including
 * where the addon is loaded, which IPC channels carry what, and the proposed
 * in-chat payment message.
 */

export { SwarmWallet } from "./wallet.js";
export type { OpenOptions, RestoreOptions, SwarmWalletEvents, WalletLocation } from "./wallet.js";

export {
  CHAIN_RESTART_NOTICE,
  CHAIN_RESTART_NOTICE_TITLE,
  NETWORK_RECORD_SCHEMA,
  networkRecordPath,
  readNetworkRecord,
  recordNeedsMove,
} from "./chainRestart.js";
export type { ChainRestartReport, NetworkRecord } from "./chainRestart.js";

export { loadNativeAddon } from "./nativeAddon.js";
export type { NativeAddon } from "./nativeAddon.js";

export { WalletStore, WALLET_KEY_BYTES } from "./walletStore.js";
export type { WalletPaths, WalletStoreOptions } from "./walletStore.js";

export { SwarmWalletError } from "./errors.js";
export type { SwarmWalletErrorCode } from "./errors.js";

export { formatSwm, parseSwm, SWM_DECIMALS } from "./amounts.js";
export type { FormatOptions } from "./amounts.js";

export {
  SWARM_MAINNET_ABANDONED_GENESIS,
  SWARM_MAINNET_ABANDONED_SERVER,
  SWARM_MAINNET_GENESIS,
  SWARM_MAINNET_PROFILE,
  SWARM_MAINNET_RESTARTED_UTC,
  SWARM_MAINNET_SERVER,
  SWARM_NETWORK_PROFILES,
  SWARM_TESTNET_PROFILE,
  SWARM_TESTNET_SERVER,
  SwarmProfileId,
  chainHintFor,
  isProfileSelectable,
  nativeChainHint,
  swarmProfileFor,
  unselectableReason,
  walletSubdirectoryFor,
  withGenesis,
  withoutGenesis,
} from "./networkProfiles.js";
export type { ChainLabel, SwarmNetworkProfile } from "./networkProfiles.js";

export {
  AddressRefusal,
  addressRefusalMessage,
  bech32Shape,
  checkAddressForChain,
  checkAddressForProfile,
} from "./addressCheck.js";
export type { AddressVerdict, Bech32Shape } from "./addressCheck.js";

export { ZATOSHI_PER_SWM } from "./types.js";
export type {
  AddressSet,
  Balance,
  ChainHint,
  ParsedAddress,
  PerformanceLevel,
  ReceiverSelection,
  SendQuote,
  SendRequest,
  SendResult,
  ServerInfo,
  SyncStatus,
  WalletTransaction,
} from "./types.js";
