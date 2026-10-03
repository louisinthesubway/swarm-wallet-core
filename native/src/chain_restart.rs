//! Moving a SWARM Mainnet wallet file onto the restarted chain.
//!
//! The SWARM network was restarted on 2 October 2026 from a new genesis block
//! (`01b76d8a…eff2`). The network keeps its name, its label `swarm-mainnet`,
//! its address encodings and its consensus rules, so a wallet file written on
//! the abandoned chain (`01c34428…afdd`) still opens: the file stores only the
//! chain TAG for SWARM Mainnet, never the genesis it was synced against
//! (`zingolib::wallet::disk`, `SWARM_MAINNET_TAG`). What it also still holds is
//! that chain's state — blocks, transactions, notes, nullifiers, the commitment
//! trees, the sync state with heights the new chain will not reach for days,
//! scan targets at those heights, any Ironwood migration section — and a
//! birthday that may be above the new chain's tip.
//!
//! None of that is true on the new chain, and an in-place clean is not
//! available to this addon: `LightWallet::clear_all` keeps the birthday (there
//! is no setter), re-adds every old confirmed transaction as a scan target at
//! its old-chain height, and keeps the migration section. So this does what a
//! user would do by hand, without the seed ever leaving the process:
//!
//! 1. read the file and take its keys (the recovery phrase, or the viewing
//!    key for a watch-only wallet) and the list of addresses it has handed out;
//! 2. copy the file, byte for byte, to a backup beside it, and read the copy
//!    back to prove it is identical;
//! 3. build a fresh wallet from those same keys whose birthday is the new
//!    chain's first block, and hand out the same addresses again, in the same
//!    order, checking every one against the old list;
//! 4. replace the wallet file with the fresh one (temporary file and rename,
//!    so a crash leaves either the old file or the new one, never half of
//!    each) and read it back.
//!
//! Every check runs before step 4. A failure anywhere leaves the wallet file
//! exactly as it was, and the backup (if one was made) beside it.

use std::collections::BTreeMap;
use std::io::{BufReader, Read, Write};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use pepper_sync::keys::transparent::{TransparentAddressId, TransparentScope};
use pepper_sync::wallet::KeyIdInterface;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{NetworkUpgrade, Parameters};
use zingolib::config::{ChainType, WalletConfig};
use zingolib::wallet::keys::unified::{ReceiverSelection, UnifiedAddressId};
use zingolib::wallet::{LightWallet, WalletSettings};

/// What a successful move reports. No key material: the recovery phrase and
/// the viewing key stay inside this process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChainRestartReport {
    /// The byte-identical copy of the wallet file as it was before the move.
    pub backup_path: PathBuf,
    /// The birthday the wallet was carrying.
    pub previous_birthday: u32,
    /// The birthday it carries now: the restarted chain's first block.
    pub birthday: u32,
    /// "seed" or "ufvk": which keys the fresh wallet was built from.
    pub key_kind: &'static str,
    /// Unified addresses handed out again, each checked against the old list.
    pub unified_addresses: usize,
    /// Transparent receive addresses handed out again, each checked.
    pub transparent_addresses: usize,
    /// Transparent change or refund addresses the old file listed. They are
    /// derived from the same keys and the scan finds any the new chain has
    /// used; they are not re-listed by hand.
    pub transparent_other_scopes: usize,
}

impl ChainRestartReport {
    pub(crate) fn to_json(&self) -> String {
        json::object! {
            "backup_path" => self.backup_path.to_string_lossy().to_string(),
            "previous_birthday" => self.previous_birthday,
            "birthday" => self.birthday,
            "key_kind" => self.key_kind,
            "unified_addresses" => self.unified_addresses,
            "transparent_addresses" => self.transparent_addresses,
            "transparent_other_scopes" => self.transparent_other_scopes,
        }
        .pretty(2)
    }
}

/// The birthday a SWARM Mainnet wallet starts from after the restart: the new
/// chain's first block. The SDK says where that is; nothing here restates it.
pub(crate) fn first_block_of(chain: &ChainType) -> u32 {
    u32::from(
        chain
            .activation_height(NetworkUpgrade::Sapling)
            .expect("every chain this wallet opens has a Sapling activation height"),
    )
}

/// How far below the tip a new wallet's birthday sits: upstream zingolib's
/// own margin for a new seed (`WalletConfig::NewSeed`, `chain_height - 100`),
/// so a short reorg at the tip cannot leave the wallet's starting tree state
/// on a block that no longer exists.
pub(crate) const NEW_WALLET_REORG_MARGIN: u32 = 100;

/// The birthday a NEW wallet gets on SWARM Mainnet: the chain's current height
/// less the reorg margin, never below the first block.
///
/// `None` for every other chain, which keeps the SDK's own `NewSeed` rule. The
/// SDK gives SWARM Mainnet's `NewSeed` the activation height (block 1), which
/// is a hard-coded value, not the chain's height; this is the one network the
/// wallet derives a new wallet's birthday for itself.
pub(crate) fn new_wallet_birthday(chain: &ChainType, chain_height: u32) -> Option<u32> {
    match chain {
        ChainType::SwarmMainnet(_) => Some(
            chain_height
                .saturating_sub(NEW_WALLET_REORG_MARGIN)
                .max(first_block_of(chain)),
        ),
        _ => None,
    }
}

fn err(message: impl Into<String>) -> String {
    message.into()
}

fn read_wallet(path: &Path, chain: ChainType) -> Result<LightWallet, String> {
    let file = std::fs::File::open(path).map_err(|e| err(format!("opening {}: {e}", path.display())))?;
    LightWallet::read(BufReader::new(file), chain).map_err(|e| err(format!("reading {}: {e}", path.display())))
}

/// Every account's viewing key, encoded. Compared before and after, so the
/// fresh wallet is proven to hold the same keys without printing any of them.
fn viewing_keys(wallet: &LightWallet) -> Result<BTreeMap<u32, String>, String> {
    let chain = wallet.chain_type();
    wallet
        .unified_key_store
        .iter()
        .map(|(account, keys)| {
            let ufvk: UnifiedFullViewingKey = keys
                .try_into()
                .map_err(|e: zingolib::wallet::error::KeyError| err(format!("account {}: {e}", u32::from(*account))))?;
            Ok((u32::from(*account), ufvk.encode(&chain)))
        })
        .collect()
}

fn unified_address_list(wallet: &LightWallet) -> Vec<(UnifiedAddressId, ReceiverSelection, String)> {
    let chain = wallet.chain_type();
    wallet
        .unified_addresses()
        .iter()
        .map(|(id, address)| {
            (
                *id,
                ReceiverSelection {
                    orchard: address.orchard().is_some(),
                    sapling: address.sapling().is_some(),
                },
                address.encode(&chain),
            )
        })
        .collect()
}

/// A path beside `wallet_path` that does not exist yet:
/// `<file>.before-network-restart-<unix seconds>[-<n>].bak`.
fn backup_path_for(wallet_path: &Path, now_unix: u64) -> Result<PathBuf, String> {
    let name = wallet_path
        .file_name()
        .ok_or_else(|| err(format!("{} has no file name", wallet_path.display())))?
        .to_string_lossy()
        .to_string();
    for n in 0..1000u32 {
        let suffix = if n == 0 { String::new() } else { format!("-{n}") };
        let candidate = wallet_path.with_file_name(format!("{name}.before-network-restart-{now_unix}{suffix}.bak"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(err("no free backup file name beside the wallet file"))
}

/// Copies the wallet file to `backup` (refusing to overwrite anything), flushes
/// it to disk, and reads it back to prove the copy is byte-identical.
fn write_backup(wallet_path: &Path, backup: &Path) -> Result<Vec<u8>, String> {
    let original = std::fs::read(wallet_path).map_err(|e| err(format!("reading {}: {e}", wallet_path.display())))?;
    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(backup)
            .map_err(|e| err(format!("creating the backup {}: {e}", backup.display())))?;
        file.write_all(&original)
            .map_err(|e| err(format!("writing the backup {}: {e}", backup.display())))?;
        file.sync_all()
            .map_err(|e| err(format!("flushing the backup {}: {e}", backup.display())))?;
    }
    let mut copied = Vec::with_capacity(original.len());
    std::fs::File::open(backup)
        .and_then(|mut f| f.read_to_end(&mut copied))
        .map_err(|e| err(format!("reading the backup back {}: {e}", backup.display())))?;
    if copied != original {
        return Err(err(format!("the backup {} does not match the wallet file", backup.display())));
    }
    Ok(original)
}

/// Builds the fresh wallet from the old one's keys, with the same addresses,
/// and checks it. Pure: touches no file.
fn rebuild(old: &LightWallet, wallet_settings: WalletSettings) -> Result<(LightWallet, usize, usize, usize, &'static str), String> {
    let chain = old.chain_type();
    let birthday = first_block_of(&chain);

    let (config, key_kind) = match old.mnemonic_phrase() {
        Some(mnemonic_phrase) => {
            let accounts = u32::try_from(old.unified_key_store.len())
                .ok()
                .and_then(NonZeroU32::new)
                .ok_or_else(|| err("the wallet file holds no account"))?;
            (
                WalletConfig::MnemonicPhrase {
                    mnemonic_phrase,
                    no_of_accounts: accounts,
                    birthday,
                    wallet_settings,
                },
                "seed",
            )
        }
        None => {
            if old.unified_key_store.len() != 1 {
                return Err(err("a wallet without a recovery phrase must hold exactly one account"));
            }
            let ufvk = viewing_keys(old)?
                .remove(&0)
                .ok_or_else(|| err("the wallet file holds no account 0"))?;
            (WalletConfig::Ufvk { ufvk, birthday, wallet_settings }, "ufvk")
        }
    };

    let mut fresh = LightWallet::new(chain, config).map_err(|e| err(format!("building the fresh wallet: {e}")))?;

    if fresh.mnemonic_phrase() != old.mnemonic_phrase() {
        return Err(err("the fresh wallet's recovery phrase differs from the file's"));
    }
    if viewing_keys(&fresh)? != viewing_keys(old)? {
        return Err(err("the fresh wallet's keys differ from the file's"));
    }

    // Unified addresses, in index order, each one compared with the old list.
    let old_unified = unified_address_list(old);
    for (id, receivers, encoded) in &old_unified {
        let existing = fresh.unified_addresses().get(id).map(|a| a.encode(&chain));
        let produced = match existing {
            Some(address) => address,
            None => {
                let (new_id, address) = fresh
                    .generate_unified_address(*receivers, id.account_id)
                    .map_err(|e| err(format!("handing out unified address {}: {e}", id.address_index)))?;
                if new_id != *id {
                    return Err(err(format!(
                        "unified address {} came back as index {}",
                        id.address_index, new_id.address_index
                    )));
                }
                address.encode(&chain)
            }
        };
        if &produced != encoded {
            return Err(err(format!("unified address {} differs from the file's", id.address_index)));
        }
    }
    if unified_address_list(&fresh) != old_unified {
        return Err(err("the fresh wallet lists different unified addresses"));
    }

    // Transparent receive addresses, in index order. Change and refund scopes
    // are derived from the same keys and found by the scan if used.
    let old_transparent: BTreeMap<TransparentAddressId, String> = old.transparent_addresses().clone();
    let mut external = 0usize;
    let mut other = 0usize;
    for (id, encoded) in &old_transparent {
        if id.scope() != TransparentScope::External {
            other += 1;
            continue;
        }
        external += 1;
        if let Some(existing) = fresh.transparent_addresses().get(id) {
            if existing != encoded {
                return Err(err(format!("transparent address {} differs from the file's", id.address_index().index())));
            }
            continue;
        }
        let (new_id, _) = fresh
            .generate_transparent_address(id.account_id(), false)
            .map_err(|e| err(format!("handing out transparent address {}: {e}", id.address_index().index())))?;
        if new_id != *id {
            return Err(err(format!(
                "transparent address {} came back as index {}",
                id.address_index().index(),
                new_id.address_index().index()
            )));
        }
        if fresh.transparent_addresses().get(id) != Some(encoded) {
            return Err(err(format!("transparent address {} differs from the file's", id.address_index().index())));
        }
    }
    let fresh_external: BTreeMap<_, _> = fresh
        .transparent_addresses()
        .iter()
        .filter(|(id, _)| id.scope() == TransparentScope::External)
        .map(|(id, a)| (*id, a.clone()))
        .collect();
    let old_external: BTreeMap<_, _> = old_transparent
        .iter()
        .filter(|(id, _)| id.scope() == TransparentScope::External)
        .map(|(id, a)| (*id, a.clone()))
        .collect();
    // A wallet that never listed a transparent address (a viewing key without
    // a transparent component) has none to compare.
    if !old_external.is_empty() && fresh_external != old_external {
        return Err(err("the fresh wallet lists different transparent addresses"));
    }

    Ok((fresh, old_unified.len(), external, other, key_kind))
}

/// Moves the SWARM Mainnet wallet file at `wallet_path` onto the restarted
/// chain. See the module documentation for the steps and their order.
///
/// `chain` must be SWARM Mainnet: the restart is that network's, and no other
/// wallet is touched. `write_file` is the addon's own atomic writer
/// (temporary file, flush, rename).
pub(crate) fn move_to_restarted_chain(
    wallet_path: &Path,
    chain: ChainType,
    wallet_settings: WalletSettings,
    now_unix: u64,
    write_file: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<ChainRestartReport, String> {
    if !matches!(chain, ChainType::SwarmMainnet(_)) {
        return Err(err(format!(
            "only a SWARM Mainnet wallet is moved to the restarted network; this one is on {chain}"
        )));
    }
    if !wallet_path.exists() {
        return Err(err(format!("there is no wallet file at {}", wallet_path.display())));
    }

    let old = read_wallet(wallet_path, chain)?;
    let previous_birthday = u32::from(old.birthday());

    // Built and checked before anything is written.
    let (mut fresh, unified_addresses, transparent_addresses, transparent_other_scopes, key_kind) =
        rebuild(&old, wallet_settings)?;
    let birthday = u32::from(fresh.birthday());
    let fresh_bytes = fresh
        .save()
        .map_err(|e| err(format!("serialising the fresh wallet: {e}")))?
        .ok_or_else(|| err("the fresh wallet produced nothing to save"))?;

    let backup_path = backup_path_for(wallet_path, now_unix)?;
    let original = write_backup(wallet_path, &backup_path)?;
    if original == fresh_bytes {
        // Nothing to move: the file already is a fresh wallet with these keys.
        return Ok(ChainRestartReport {
            backup_path,
            previous_birthday,
            birthday,
            key_kind,
            unified_addresses,
            transparent_addresses,
            transparent_other_scopes,
        });
    }

    write_file(wallet_path, &fresh_bytes).map_err(|e| {
        err(format!(
            "writing the fresh wallet file: {e}. The wallet file is unchanged; a copy is at {}",
            backup_path.display()
        ))
    })?;

    // Read back what is now on disk: it must parse and hold the same keys and
    // addresses. If it does not, put the original back.
    let check = read_wallet(wallet_path, chain).and_then(|written| {
        if viewing_keys(&written)? != viewing_keys(&old)?
            || written.mnemonic_phrase() != old.mnemonic_phrase()
            || unified_address_list(&written) != unified_address_list(&old)
            || u32::from(written.birthday()) != birthday
        {
            Err(err("the written wallet file does not hold the expected keys and addresses"))
        } else {
            Ok(())
        }
    });
    if let Err(problem) = check {
        let restored = write_file(wallet_path, &original);
        return Err(err(match restored {
            Ok(()) => format!("{problem}. The original wallet file was put back; a copy is at {}", backup_path.display()),
            Err(e) => format!(
                "{problem}, and putting the original back failed ({e}). The original is at {}",
                backup_path.display()
            ),
        }));
    }

    Ok(ChainRestartReport {
        backup_path,
        previous_birthday,
        birthday,
        key_kind,
        unified_addresses,
        transparent_addresses,
        transparent_other_scopes,
    })
}

#[cfg(test)]
mod chain_restart_tests {
    use super::*;
    use pepper_sync::wallet::traits::{SyncTransactions, SyncWallet};
    use pepper_sync::wallet::ScanTarget;
    use zcash_protocol::consensus::BlockHeight;
    use zingolib::config::SwarmMainnetGenesis;

    /// The restarted chain's genesis, as the profile and the pin carry it.
    const NEW_GENESIS: &str = "01b76d8a0f18c502b23ab6605e26296d189aa5770fc4a34155e5c7b250a0eff2";

    /// The all-zero BIP-39 test vector: published, never funded.
    const FIXTURE_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    /// A birthday from the abandoned chain: far above the restarted chain's tip
    /// (about 135 when this was written), so it would stop any scan there.
    const OLD_CHAIN_BIRTHDAY: u32 = 6_000;

    fn mainnet() -> ChainType {
        ChainType::SwarmMainnet(SwarmMainnetGenesis::from_display_hex(NEW_GENESIS).unwrap())
    }

    fn settings() -> WalletSettings {
        WalletSettings::default()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("swarm-chain-restart-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plain(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let tmp = path.with_extension("dat.tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path)
    }

    fn save(wallet: &mut LightWallet, path: &Path) -> Vec<u8> {
        let bytes = wallet.save().unwrap().unwrap();
        std::fs::write(path, &bytes).unwrap();
        bytes
    }

    /// A wallet file as the abandoned chain left it: an old-chain birthday, a
    /// second unified address and a second transparent address handed out, and
    /// sync state pointing at heights the new chain has not reached.
    fn old_chain_seed_wallet(path: &Path) -> Vec<u8> {
        let mut wallet = LightWallet::new(
            mainnet(),
            WalletConfig::MnemonicPhrase {
                mnemonic_phrase: FIXTURE_MNEMONIC.to_string(),
                no_of_accounts: NonZeroU32::new(1).unwrap(),
                birthday: OLD_CHAIN_BIRTHDAY,
                wallet_settings: settings(),
            },
        )
        .unwrap();
        wallet
            .generate_unified_address(ReceiverSelection { orchard: true, sapling: false }, zip32::AccountId::ZERO)
            .unwrap();
        wallet
            .generate_unified_address(ReceiverSelection { orchard: true, sapling: true }, zip32::AccountId::ZERO)
            .unwrap();
        wallet.generate_transparent_address(zip32::AccountId::ZERO, false).unwrap();
        let txid = zingolib::utils::conversion::txid_from_hex_encoded_str(&"ab".repeat(32)).unwrap();
        pepper_sync::add_scan_targets(
            wallet.get_sync_state_mut().unwrap(),
            &[
                ScanTarget { block_height: BlockHeight::from_u32(6_500), txid, narrow_scan_area: true },
                ScanTarget { block_height: BlockHeight::from_u32(6_793), txid, narrow_scan_area: false },
            ],
        );
        save(&mut wallet, path)
    }

    /// What a wallet made today from the same seed, with the same addresses
    /// handed out, looks like on disk.
    fn reference_bytes() -> Vec<u8> {
        let mut wallet = LightWallet::new(
            mainnet(),
            WalletConfig::MnemonicPhrase {
                mnemonic_phrase: FIXTURE_MNEMONIC.to_string(),
                no_of_accounts: NonZeroU32::new(1).unwrap(),
                birthday: 1,
                wallet_settings: settings(),
            },
        )
        .unwrap();
        wallet
            .generate_unified_address(ReceiverSelection { orchard: true, sapling: false }, zip32::AccountId::ZERO)
            .unwrap();
        wallet
            .generate_unified_address(ReceiverSelection { orchard: true, sapling: true }, zip32::AccountId::ZERO)
            .unwrap();
        wallet.generate_transparent_address(zip32::AccountId::ZERO, false).unwrap();
        wallet.save().unwrap().unwrap()
    }

    #[test]
    fn an_old_chain_wallet_comes_up_fresh_with_the_same_keys_and_addresses() {
        let dir = temp_dir("seed");
        let path = dir.join("zingo-wallet-4.dat");
        let original = old_chain_seed_wallet(&path);
        let before = read_wallet(&path, mainnet()).unwrap();
        assert_eq!(u32::from(before.birthday()), OLD_CHAIN_BIRTHDAY);

        let report = move_to_restarted_chain(&path, mainnet(), settings(), 1_790_970_000, write_plain).unwrap();

        // The backup is the old file, byte for byte, beside it.
        assert_eq!(report.backup_path.parent(), path.parent());
        assert!(report
            .backup_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("zingo-wallet-4.dat.before-network-restart-1790970000"));
        assert_eq!(std::fs::read(&report.backup_path).unwrap(), original);

        // The wallet now starts from the restarted chain's first block.
        assert_eq!(report.previous_birthday, OLD_CHAIN_BIRTHDAY);
        assert_eq!(report.birthday, 1);
        let after = read_wallet(&path, mainnet()).unwrap();
        assert_eq!(u32::from(after.birthday()), 1);

        // Same keys, same addresses.
        assert_eq!(after.mnemonic_phrase().as_deref(), Some(FIXTURE_MNEMONIC));
        assert_eq!(viewing_keys(&after).unwrap(), viewing_keys(&before).unwrap());
        assert_eq!(unified_address_list(&after), unified_address_list(&before));
        assert_eq!(after.transparent_addresses(), before.transparent_addresses());
        assert_eq!(report.unified_addresses, 3);
        assert_eq!(report.transparent_addresses, 2);
        assert_eq!(report.key_kind, "seed");
        assert!(unified_address_list(&after).iter().all(|(_, _, a)| a.starts_with("swm1")));

        // Nothing of the old chain's state is left: no transactions, no scan
        // ranges, and the file is exactly a wallet made today from that seed
        // with those addresses — so no scan target at an old height either.
        assert!(after.get_wallet_transactions().unwrap().is_empty());
        assert!(after.get_sync_state().unwrap().scan_ranges().is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), reference_bytes());
        assert_ne!(std::fs::read(&path).unwrap(), original);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_move_keeps_a_second_backup_and_changes_nothing() {
        let dir = temp_dir("twice");
        let path = dir.join("zingo-wallet-5.dat");
        old_chain_seed_wallet(&path);
        let first = move_to_restarted_chain(&path, mainnet(), settings(), 1_790_970_000, write_plain).unwrap();
        let moved = std::fs::read(&path).unwrap();
        let second = move_to_restarted_chain(&path, mainnet(), settings(), 1_790_970_000, write_plain).unwrap();
        assert_ne!(first.backup_path, second.backup_path);
        assert_eq!(std::fs::read(&second.backup_path).unwrap(), moved);
        assert_eq!(std::fs::read(&path).unwrap(), moved);
        assert!(first.backup_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_watch_only_wallet_keeps_its_viewing_key() {
        let dir = temp_dir("ufvk");
        let path = dir.join("zingo-wallet-6.dat");
        let seed_wallet = LightWallet::new(
            mainnet(),
            WalletConfig::MnemonicPhrase {
                mnemonic_phrase: FIXTURE_MNEMONIC.to_string(),
                no_of_accounts: NonZeroU32::new(1).unwrap(),
                birthday: 1,
                wallet_settings: settings(),
            },
        )
        .unwrap();
        let ufvk = viewing_keys(&seed_wallet).unwrap().remove(&0).unwrap();
        let mut watch_only = LightWallet::new(
            mainnet(),
            WalletConfig::Ufvk { ufvk: ufvk.clone(), birthday: OLD_CHAIN_BIRTHDAY, wallet_settings: settings() },
        )
        .unwrap();
        let original = save(&mut watch_only, &path);

        let report = move_to_restarted_chain(&path, mainnet(), settings(), 7, write_plain).unwrap();
        assert_eq!(report.key_kind, "ufvk");
        assert_eq!(std::fs::read(&report.backup_path).unwrap(), original);
        let after = read_wallet(&path, mainnet()).unwrap();
        assert_eq!(after.mnemonic_phrase(), None);
        assert_eq!(viewing_keys(&after).unwrap().remove(&0).unwrap(), ufvk);
        assert_eq!(u32::from(after.birthday()), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_leaves_the_wallet_file_as_it_was() {
        let dir = temp_dir("fail");
        let path = dir.join("zingo-wallet-7.dat");
        let original = old_chain_seed_wallet(&path);
        let refused = move_to_restarted_chain(&path, mainnet(), settings(), 9, |_, _| {
            Err(std::io::Error::other("disk full"))
        })
        .unwrap_err();
        assert!(refused.contains("unchanged"), "{refused}");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".bak"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(backups[0].path()).unwrap(), original);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_swarm_mainnet_wallets_are_moved() {
        let dir = temp_dir("testnet");
        let path = dir.join("zingo-wallet-8.dat");
        let mut wallet = LightWallet::new(
            ChainType::CustomTestnet,
            WalletConfig::MnemonicPhrase {
                mnemonic_phrase: FIXTURE_MNEMONIC.to_string(),
                no_of_accounts: NonZeroU32::new(1).unwrap(),
                birthday: 1,
                wallet_settings: settings(),
            },
        )
        .unwrap();
        let original = save(&mut wallet, &path);
        assert!(move_to_restarted_chain(&path, ChainType::CustomTestnet, settings(), 1, write_plain).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no backup is made for a refused wallet");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_mainnet_wallet_is_born_at_the_chain_height() {
        let chain = mainnet();
        assert_eq!(first_block_of(&chain), 1);
        assert_eq!(new_wallet_birthday(&chain, 135), Some(35));
        assert_eq!(new_wallet_birthday(&chain, 20_000), Some(19_900));
        // A chain younger than the margin starts at its first block, never 0.
        assert_eq!(new_wallet_birthday(&chain, 60), Some(1));
        assert_eq!(new_wallet_birthday(&chain, 0), Some(1));
        // Other networks keep the SDK's own rule.
        assert_eq!(new_wallet_birthday(&ChainType::CustomTestnet, 135), None);
        assert_eq!(new_wallet_birthday(&ChainType::Mainnet, 3_000_000), None);
    }
}
