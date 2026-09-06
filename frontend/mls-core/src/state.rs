use ciborium::{de::from_reader, ser::into_writer};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use openmls_traits::storage::StorageProvider;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crate::MlsError;

// --- 1. Persistence model (on disk) ---

/// The on-disk snapshot.
///
/// Every byte-buffer field goes through [`crate::byte_compat`], which writes a CBOR byte string
/// and reads EITHER a byte string or the legacy array of integers. Without that, serde's generic
/// `Vec<u8>` path parses one CBOR header per byte - 58.6 s of CPU on a 2.67 MB file, enough to ANR
/// the app from the boot receiver (WP-ANR-1). The read side of the pair is what lets an existing
/// install survive the change and MUST NOT be removed; see the module docs for the rollback
/// consequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedState {
    #[serde(with = "crate::byte_compat::bytes")]
    pub identity_bundle: Vec<u8>,
    #[serde(with = "crate::byte_compat::bytes_map")]
    pub storage_values: HashMap<Vec<u8>, Vec<u8>>,
    #[serde(with = "crate::byte_compat::bytes_vec")]
    pub group_ids: Vec<Vec<u8>>,
    /// Minimum epoch to accept per group after a forget_group() call.
    /// #[serde(default)] ensures compatibility with states saved before this field was added.
    #[serde(default)]
    pub forgotten_group_min_epochs: HashMap<String, u64>,
}

/// Borrowed view of [`PersistedState`] for CBOR encoding without cloning OpenMLS storage.
///
/// The field encodings must match [`PersistedState`] exactly - this is the WRITER of the same
/// bytes that struct reads, and nothing in the type system ties the two together.
#[derive(Serialize)]
pub(crate) struct PersistedStateSer<'a> {
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) identity_bundle: &'a [u8],
    #[serde(with = "crate::byte_compat::bytes_map")]
    pub(crate) storage_values: &'a HashMap<Vec<u8>, Vec<u8>>,
    #[serde(with = "crate::byte_compat::bytes_vec")]
    pub(crate) group_ids: &'a [Vec<u8>],
    pub(crate) forgotten_group_min_epochs: &'a HashMap<String, u64>,
}

// Struct request wrapper for serialization
#[derive(Serialize)]
pub(crate) struct IdentityBundleRef<'a> {
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) keypair: &'a [u8], // Serialized bytes
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) credential: &'a [u8], // Serialized bytes
}

#[derive(Serialize, Deserialize)]
pub(crate) struct IdentityBundle {
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) keypair: Vec<u8>,
    #[serde(with = "crate::byte_compat::bytes")]
    pub(crate) credential: Vec<u8>,
}

// --- 2. Manager (in memory) ---

/// In-memory CBOR snapshot cache for `save_state` / `save_encrypted`.
/// Uses interior mutability so `generate_key_package` (`&self`) can invalidate it.
pub(crate) struct StateSnapshotCache {
    pub(crate) dirty: bool,
    pub(crate) cached_cbor: Option<Vec<u8>>,
}

impl StateSnapshotCache {
    pub(crate) fn new_dirty() -> Self {
        Self {
            dirty: true,
            cached_cbor: None,
        }
    }

    pub(crate) fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub(crate) fn get_or_build<F>(&mut self, build: F) -> Result<Vec<u8>, MlsError>
    where
        F: FnOnce() -> Result<Vec<u8>, MlsError>,
    {
        if !self.dirty
            && let Some(ref cached) = self.cached_cbor
        {
            log::debug!(
                "save_state: returning cached CBOR snapshot ({} bytes)",
                cached.len()
            );
            return Ok(cached.clone());
        }

        let bytes = build()?;
        log::debug!("save_state: rebuilt CBOR snapshot ({} bytes)", bytes.len());
        self.cached_cbor = Some(bytes.clone());
        self.dirty = false;
        Ok(bytes)
    }
}

pub struct MlsManager {
    // OpenMlsRustCrypto owns the MemoryStorage internally and implements OpenMlsProvider
    pub(crate) provider: OpenMlsRustCrypto,

    pub(crate) keypair: SignatureKeyPair,
    pub(crate) credential: BasicCredential,

    pub(crate) groups: HashMap<String, MlsGroup>,

    /// Minimum epoch required to accept a Welcome (per groupId).
    /// Set by forget_group to prevent a stale Welcome (from a device itself behind on epoch)
    /// from putting this device back on the wrong branch.
    pub(crate) forgotten_group_min_epochs: HashMap<String, u64>,

    pub(crate) state_snapshot: RefCell<StateSnapshotCache>,
}

/// Every label `openmls_memory_storage` prefixes its storage keys with.
///
/// A key is `label || serde_json(id) || u16 version`, built by that crate's `build_key_from_vec`,
/// so the label is a plain byte PREFIX and a scan can attribute every entry to exactly one owner.
/// Longest match wins when one label is a prefix of another - `Tree` must not swallow
/// `ApplicationExportTree`, and `Psk` must not swallow `ResumptionPsk`.
pub(crate) const STORAGE_LABELS: &[&str] = &[
    "KeyPackage",
    "EncryptionKeyPair",
    "SignatureKeyPair",
    "EpochKeyPairs",
    "Psk",
    "Tree",
    "GroupContext",
    "ApplicationExportTree",
    "InterimTranscriptHash",
    "ConfirmationTag",
    "MlsGroupJoinConfig",
    "OwnLeafNodes",
    "GroupState",
    "QueuedProposal",
    "ProposalQueueRefs",
    "OwnLeafNodeIndex",
    "EpochSecrets",
    "ResumptionPsk",
    "MessageSecrets",
];

/// One storage label's share of the state: how many entries, and how many bytes they occupy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoragePortion {
    pub label: String,
    pub entries: usize,
    pub bytes: usize,
}

impl MlsManager {
    /// What this device's persisted state is MADE OF, heaviest first.
    ///
    /// ## Why this exists, and why it is product code rather than a test helper
    ///
    /// `mls.bin` has been a P1 twice - a phone reached 20 812 360 bytes with a checkpoint costing
    /// 48 s and a PIN unlock 22 s - and BOTH investigations were slowed by the same gap: nothing
    /// could ask a device what its state was made of. The composition had to be inferred from
    /// synthetic states and arithmetic, and on 2026-09-06 that inference was wrong twice in one
    /// evening. A 12.8 MB drop was then attributed to abandoned groups on the strength of a
    /// division, while a bounded per-epoch cost measured minutes later refuted the mechanism that
    /// division implied.
    ///
    /// A number nobody can read off the running system is a number that gets guessed. This makes it
    /// readable: it is the same scan `prune_expired_key_packages` uses, over the same map, exposed
    /// rather than reimplemented - `tests/state_weight.rs` calls THIS instead of carrying its own
    /// copy of the label list, so the measurement and the product can never disagree.
    ///
    /// Bytes are `key.len() + value.len()`, which is the entry's weight in the map rather than in
    /// the CBOR that wraps it - close enough to attribute a megabyte, and it needs no serialisation.
    pub fn state_composition(&self) -> Result<Vec<StoragePortion>, MlsError> {
        let storage = self.provider.storage();
        let values = storage
            .values
            .read()
            .map_err(|e| MlsError::OpenMls(format!("Storage lock poisoned: {e}")))?;

        let mut by_label: HashMap<String, StoragePortion> = HashMap::new();
        for (k, v) in values.iter() {
            let label = STORAGE_LABELS
                .iter()
                .filter(|l| k.starts_with(l.as_bytes()))
                .max_by_key(|l| l.len())
                .map(|l| (*l).to_string())
                .unwrap_or_else(|| "UNKNOWN".to_string());
            let e = by_label.entry(label.clone()).or_insert(StoragePortion {
                label,
                entries: 0,
                bytes: 0,
            });
            e.entries += 1;
            e.bytes += k.len() + v.len();
        }

        let mut rows: Vec<StoragePortion> = by_label.into_values().collect();
        // Heaviest first, then by label so the order is stable for a reader comparing two runs.
        rows.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.label.cmp(&b.label)));
        Ok(rows)
    }

    /// One compact line naming the three heaviest parts of the state, for the load-time log.
    ///
    /// THREE, not all nineteen: a line nobody reads to the end is a line that hides the next defect,
    /// and every composition measured so far has had one part carrying most of the weight. The total
    /// is always printed, so a reader can see at once whether the three explain it.
    pub fn state_composition_summary(&self) -> String {
        match self.state_composition() {
            Ok(rows) => {
                let total: usize = rows.iter().map(|r| r.bytes).sum();
                let head = rows
                    .iter()
                    .take(3)
                    .map(|r| format!("{} {}x{}B", r.label, r.entries, r.bytes))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{total}B total; {head}")
            }
            // NOT SWALLOWED INTO AN EMPTY STRING: a caller logging this would print a line that
            // reads as "the state is made of nothing", which is a worse answer than none.
            Err(e) => format!("unavailable ({e})"),
        }
    }

    /// Marks the CBOR snapshot stale after any MLS state mutation.
    ///
    /// INVARIANT: every method that mutates `self.provider` storage, `self.groups`,
    /// `self.keypair`, or `forgotten_group_min_epochs` MUST call this (or invalidate the
    /// snapshot directly, as `process_incoming_on_group` does). Forgetting it makes
    /// `save_state` persist a stale snapshot - silent state loss / ratchet desync.
    /// Over-invalidating only costs a rebuild and is always safe.
    pub(crate) fn mark_state_dirty(&self) {
        self.state_snapshot.borrow_mut().invalidate();
    }

    /// Invalidates the in-memory CBOR snapshot so the next [`Self::save_state`] rebuilds it.
    /// Exposed for benchmarks and integration tests measuring cold serialization cost.
    pub fn invalidate_persisted_snapshot(&self) {
        self.mark_state_dirty();
    }
    // --- A. INITIALIZATION (Load or Create) ---

    pub fn load_or_create(
        user_id: &str,
        device_id: &str,
        decrypted_state: Option<Vec<u8>>,
    ) -> Result<Self, MlsError> {
        let provider = OpenMlsRustCrypto::default();

        if let Some(state_bytes) = decrypted_state {
            // CAS 1 : Restauration
            let state: PersistedState = from_reader(state_bytes.as_slice())
                .map_err(|e| MlsError::Serialization(e.to_string()))?;

            let bundle: IdentityBundle = from_reader(state.identity_bundle.as_slice())
                .map_err(|e| MlsError::Serialization(e.to_string()))?;

            // Deserialize keypair & credential from bytes
            let keypair = SignatureKeyPair::tls_deserialize(&mut bundle.keypair.as_slice())
                .map_err(|_| MlsError::Serialization("Failed to deserialize keypair".into()))?;

            let credential_enum = Credential::tls_deserialize(&mut bundle.credential.as_slice())
                .map_err(|_| MlsError::Serialization("Failed to deserialize credential".into()))?;

            let credential =
                BasicCredential::try_from(credential_enum).map_err(|_| MlsError::InvalidData)?;

            // Verify that the credential identity matches the expected identity.
            // A corrupted or tampered state could contain a credential for a different user/device.
            let expected_identity = format!("{}:{}", user_id, device_id);
            let loaded_identity = String::from_utf8_lossy(credential.identity()).to_string();
            if loaded_identity != expected_identity {
                log::warn!(
                    "load_or_create: identity mismatch - expected={} loaded={}",
                    expected_identity,
                    loaded_identity
                );
                return Err(MlsError::OpenMls(format!(
                    "Credential identity mismatch: expected {} but state contains {}",
                    expected_identity, loaded_identity
                )));
            }

            // 2. Restore in-memory storage
            {
                let storage = provider.storage();
                let mut lock = storage.values.write().unwrap();
                *lock = state.storage_values;
            }

            // 3. Restore the groups
            let mut groups = HashMap::new();
            for gid_bytes in state.group_ids {
                let group_id = GroupId::from_slice(&gid_bytes);

                // Load using the provider
                if let Some(group) = MlsGroup::load(provider.storage(), &group_id)
                    .map_err(|e| MlsError::OpenMls(format!("{:?}", e)))?
                {
                    let group_id_str = String::from_utf8_lossy(&gid_bytes).to_string();
                    groups.insert(group_id_str, group);
                }
            }

            let manager = Self {
                provider,
                keypair,
                credential,
                groups,
                forgotten_group_min_epochs: state.forgotten_group_min_epochs,
                // Deliberately NOT `from_loaded(state_bytes)`, which would hand the bytes we just
                // read straight back to the first `save_state`. That is a sound optimisation while
                // the encoding is fixed, and exactly wrong across a format change: a device
                // carrying a legacy `mls.bin` would re-persist it verbatim and keep paying the
                // per-byte decode for ever, migrating only if some mutation happened to dirty the
                // cache first. Rebuilding once per session makes the migration deterministic
                // instead of dependent on what the user does next, and the cost is one
                // serialization - never the decode this change exists to remove.
                state_snapshot: RefCell::new(StateSnapshotCache::new_dirty()),
            };

            // SHED WHAT THIS DEVICE CAN NO LONGER USE, ONCE PER LOAD.
            //
            // Nothing else ever deletes a key package bundle, and two callers mint them without
            // bound - a fresh last-resort package on every connection, and up to 50 more per
            // `republishKeyMaterial`. See `prune_expired_key_packages` for the measurement and for
            // why an elapsed lifetime is the only signal that cannot race a join.
            //
            // HERE rather than on a timer: a load is the one moment that happens exactly once per
            // session, needs no scheduling, and already has the whole state in hand. A clock would
            // add a second path to the same state for no gain, and the rule this repository keeps
            // is that termination comes from a proof and never from a timer.
            //
            // A FAILURE HERE MUST NOT FAIL THE LOAD. Pruning is maintenance: a device that cannot
            // shed old bundles still works, where a device that refuses to load has lost
            // everything. It is logged at a level that accuses, because a prune that never succeeds
            // is the leak coming back and nothing else would say so.
            match manager.prune_expired_key_packages() {
                Ok(0) => {}
                Ok(n) => log::info!("load_or_create: pruned {} expired key package(s)", n),
                Err(e) => log::warn!(
                    "load_or_create: could not prune expired key packages: {}",
                    e
                ),
            }

            // WHAT THE STATE IS MADE OF, ONCE PER LOAD.
            //
            // One line per session, on the one seam every platform loads through, and it is here
            // because the alternative has been paid for twice: `mls.bin` has been a P1 on SIZE
            // alone, and both investigations had to INFER the composition from synthetic states
            // because nothing could ask the running device. That inference was wrong twice in one
            // evening on 2026-09-06 - once blaming key packages for a drop that deleting groups
            // caused, once blaming epochs for a per-group cost a later measurement showed to be
            // bounded.
            //
            // Nobody watches this line. It is the one a reader needs the moment a checkpoint starts
            // costing seconds, and it costs one pass over a map already in memory.
            log::info!(
                "load_or_create: state composition - {}",
                manager.state_composition_summary()
            );

            Ok(manager)
        } else {
            // Case 2: First creation
            let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
            let keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
                .map_err(|e| MlsError::OpenMls(format!("{:?}", e)))?;

            let credential =
                BasicCredential::new(format!("{}:{}", user_id, device_id).into_bytes());

            Ok(Self {
                provider,
                keypair,
                credential,
                groups: HashMap::new(),
                forgotten_group_min_epochs: HashMap::new(),
                state_snapshot: RefCell::new(StateSnapshotCache::new_dirty()),
            })
        }
    }

    // --- E. SAVE (CBOR serialization) ---

    pub fn save_state(&self) -> Result<Vec<u8>, MlsError> {
        let mut cache = self.state_snapshot.borrow_mut();
        cache.get_or_build(|| self.serialize_state())
    }

    fn serialize_state(&self) -> Result<Vec<u8>, MlsError> {
        // 1. Serialize the identity (using Ref wrapper to avoid cloning keypair)
        let keypair_bytes = self
            .keypair
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Keypair serialization: {:?}", e)))?;

        // Credential is an enum, we convert BasicCredential to Credential for serialization
        let cred_enum: Credential = self.credential.clone().into();
        let credential_bytes = cred_enum
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Credential serialization: {:?}", e)))?;

        let bundle = IdentityBundleRef {
            keypair: &keypair_bytes,
            credential: &credential_bytes,
        };

        let mut bundle_bytes = Vec::new();
        into_writer(&bundle, &mut bundle_bytes)
            .map_err(|e| MlsError::Serialization(e.to_string()))?;

        // 2. Snapshot OpenMLS storage under a read lock (no HashMap::clone).
        let storage = self.provider.storage();
        let storage_lock = storage.values.read().unwrap();

        // 3. Collect active group IDs (sorted for stable order; note: storage_values is
        //    an unordered HashMap, so the overall CBOR is not deterministic)
        let mut group_ids: Vec<Vec<u8>> = self
            .groups
            .keys()
            .map(|gid_str| gid_str.as_bytes().to_vec())
            .collect();
        group_ids.sort();

        // 4. Encode the global state without copying storage_values
        let persisted = PersistedStateSer {
            identity_bundle: &bundle_bytes,
            storage_values: &storage_lock,
            group_ids: &group_ids,
            forgotten_group_min_epochs: &self.forgotten_group_min_epochs,
        };

        let mut final_bytes = Vec::new();
        into_writer(&persisted, &mut final_bytes)
            .map_err(|e| MlsError::Serialization(e.to_string()))?;

        Ok(final_bytes)
    }

    // --- E. GÉNÉRER MON KEY PACKAGE ---

    /// Builds, persists and serialises one KeyPackage.
    ///
    /// `last_resort` decides the ONE thing that separates the two kinds this device publishes, and
    /// it decides it in the crypto rather than in a convention: `into_group` deletes the private
    /// bundle after a Welcome built on the package is processed *unless* the package carries the
    /// `last_resort` extension (openmls 0.8.1, `group/mls_group/creation.rs:605`). A pool prekey is
    /// claimed once and its server row deleted with it, so it must be forgettable; the static
    /// fallback is served to every peer that finds the pool empty, so it must not be.
    ///
    /// The leaf capabilities have to declare `LastResort` as well - a leaf validates locally that
    /// its capabilities cover the extensions it uses, and a peer re-runs that validation on the
    /// KeyPackage it was handed.
    fn build_key_package(&self, last_resort: bool) -> Result<Vec<u8>, MlsError> {
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

        let credential_with_key = CredentialWithKey {
            credential: self.credential.clone().into(),
            signature_key: self.keypair.public().into(),
        };

        let mut builder = KeyPackage::builder();
        if last_resort {
            builder = builder
                .mark_as_last_resort()
                .leaf_node_capabilities(Capabilities::new(
                    None,
                    None,
                    Some(&[ExtensionType::LastResort]),
                    None,
                    None,
                ));
        }

        let key_package_bundle = builder
            .build(
                ciphersuite,
                &self.provider,
                &self.keypair,
                credential_with_key,
            )
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage creation error: {:?}", e)))?;

        // 2. IMPORTANT: Persist the bundle (private key) in the provider's storage
        let key_package = key_package_bundle.key_package();
        let hash_ref = key_package
            .hash_ref(self.provider.crypto())
            .map_err(|e| MlsError::OpenMls(format!("HashRef error: {:?}", e)))?;

        self.provider
            .storage()
            .write_key_package(&hash_ref, &key_package_bundle)
            .map_err(|e| MlsError::OpenMls(format!("Storage error: {:?}", e)))?;

        self.mark_state_dirty();

        // 3. Return the serialized public KeyPackage
        key_package
            .tls_serialize_detached()
            .map_err(|e| MlsError::OpenMls(format!("Serialization error: {:?}", e)))
    }

    /// A one-time prekey for the server-side pool: consumed by the first Welcome built on it.
    pub fn generate_key_package(&self) -> Result<Vec<u8>, MlsError> {
        self.build_key_package(false)
    }

    /// Deletes every stored `KeyPackage` bundle whose lifetime has ELAPSED. Returns how many went.
    ///
    /// ## The leak this closes, measured rather than assumed
    ///
    /// Minting a key package writes its private bundle to the provider's storage, and until now
    /// NOTHING ever deleted one that was not consumed by a Welcome. The reconciliation that exists
    /// runs the other way - `reconcilePublishedKeyPackages` purges the SERVER of prekeys whose
    /// private key is gone locally - so a bundle the server has stopped publishing is kept for
    /// ever. Two callers make that unbounded:
    ///
    /// - `generateKeyPackageImpl` republishes a FRESH last-resort package on every connection, and
    /// - `republishKeyMaterial` calls `deleteAllOneTimePrekeys()` and mints up to 50 more, once per
    ///   30 s, on every `NoMatchingKeyPackage` storm.
    ///
    /// `tests/state_weight.rs` weighs the result: a bundle is 1 936 bytes, and 200 of them are
    /// 60% of a state that also holds 41 groups. A phone through the 2026-09 healing campaign
    /// reached a 19 548 753-byte `mls.bin` that took 17 s to checkpoint and 22 s to unlock - about
    /// ten thousand accumulated bundles, which is ~200 purge-and-remint rounds.
    ///
    /// ## Why EXPIRY is the discriminator, and not "the server no longer publishes it"
    ///
    /// "Unpublished" is not the same as "dead": the delivery service DELETES a one-time prekey as
    /// it hands it out, so a bundle can be absent from the server precisely because a peer is about
    /// to send the Welcome built on it. Deleting on that signal would race a join and lose it.
    ///
    /// An elapsed lifetime carries no such ambiguity. `not_after` is set at mint time and openmls
    /// defaults it to 84 days; a Welcome that referenced an expired KeyPackage is invalid under
    /// RFC 9420 and every joiner is entitled to refuse it. So this deletes only what could not have
    /// been used anyway, needs no server round-trip, and cannot race anything - which is what makes
    /// it safe to run unattended at load. It BOUNDS the leak at (mint rate x 84 days) rather than
    /// letting it grow with the life of the install.
    ///
    /// A bundle that fails to decode is LEFT ALONE and counted in the log: it is a byte pattern
    /// this build does not understand, and deleting what one cannot read is how a state gets lost.
    ///
    /// Reads the clock ONCE and hands it to [`Self::prune_key_packages_expired_at`], which is where
    /// the decision actually lives - see there for why the two are separate.
    pub fn prune_expired_key_packages(&self) -> Result<usize, MlsError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            // A clock before the epoch cannot say anything is expired, and guessing would delete
            // key material. Prune nothing and say so.
            .map_err(|e| {
                MlsError::OpenMls(format!("System clock is before the UNIX epoch: {e}"))
            })?;
        self.prune_key_packages_expired_at(now)
    }

    /// [`Self::prune_expired_key_packages`] with the current time given rather than read.
    ///
    /// THE CLOCK IS A PARAMETER SO THE RULE CAN BE TESTED WITHOUT ASSERTING ON ONE. `Lifetime`'s own
    /// `is_valid()` consults `SystemTime::now()` internally, so a test written against it could only
    /// prove "nothing minted a moment ago is expired" - it could never reach the branch that
    /// deletes, which is the entire point of this function. Passing `now` in lets a test mint
    /// normally and then ask what the state will look like in a hundred days, which is a statement
    /// about the RULE and not about the machine it ran on.
    ///
    /// Compares against `not_after` alone. `is_valid()` also refuses a package whose `not_before`
    /// is still in the future, and that is a package this device minted moments ago on a machine
    /// with a skewed clock - the one thing that must NOT be deleted.
    pub fn prune_key_packages_expired_at(&self, now_secs: u64) -> Result<usize, MlsError> {
        let storage = self.provider.storage();
        let mut values = storage
            .values
            .write()
            .map_err(|e| MlsError::OpenMls(format!("Storage lock poisoned: {e}")))?;

        let mut undecodable = 0usize;
        let mut doomed: Vec<Vec<u8>> = Vec::new();
        for (k, v) in values.iter() {
            if !k.starts_with(b"KeyPackage") {
                continue;
            }
            let Ok(bundle) = serde_json::from_slice::<KeyPackageBundle>(v) else {
                undecodable += 1;
                continue;
            };

            // THE ENTRY MUST PROVE IT IS THE KEY PACKAGE ITS OWN KEY NAMES, AND NOT MERELY DECODE.
            //
            // The prefix and the decode both look like discrimination and neither is: an empty
            // prefix passes every one of this file's tests, because serde ignores unknown fields
            // and it is the decode that ends up refusing group state - by luck, on a struct that
            // happens not to carry these three field names. Luck is not a safety property when the
            // failure mode is a device that saves and loads while having silently lost every
            // conversation.
            //
            // So recompute the hash reference and require the stored key to contain it. The key is
            // `label || json(hash_ref) || version` by construction, so this is exact, it is what
            // makes the delete provably confined to key packages, and it costs one hash on an entry
            // that is about to be dropped anyway.
            let Ok(hash_ref) = bundle.key_package().hash_ref(self.provider.crypto()) else {
                undecodable += 1;
                continue;
            };
            let Ok(named) = serde_json::to_vec(&hash_ref) else {
                undecodable += 1;
                continue;
            };
            if !k.windows(named.len()).any(|w| w == named.as_slice()) {
                undecodable += 1;
                continue;
            }

            if bundle.key_package().life_time().not_after() < now_secs {
                doomed.push(k.clone());
            }
        }

        for key in &doomed {
            values.remove(key);
        }
        let pruned = doomed.len();
        drop(values);

        if pruned > 0 || undecodable > 0 {
            log::info!(
                "prune_expired_key_packages: removed {} expired bundle(s), left {} undecodable",
                pruned,
                undecodable
            );
        }
        if pruned > 0 {
            self.mark_state_dirty();
        }
        Ok(pruned)
    }

    /// The device's static fallback, served by the delivery service to every peer that finds the
    /// one-time pool empty. Reusable by construction - see [`Self::build_key_package`].
    pub fn generate_last_resort_key_package(&self) -> Result<Vec<u8>, MlsError> {
        self.build_key_package(true)
    }

    pub fn generate_key_packages(&self, count: usize) -> Result<Vec<Vec<u8>>, MlsError> {
        (0..count).map(|_| self.generate_key_package()).collect()
    }

    /// Checks whether the private key for the provided public KeyPackage is still held locally.
    ///
    /// Recomputes the `hash_ref` of the KeyPackage (the key under which its private bundle
    /// was stored at generation time) then queries the keystore. Lets the client detect
    /// KeyPackages published to the server whose local private key has been lost (state reset
    /// or restored from an older backup) - the root cause of `NoMatchingKeyPackage` loops.
    /// These orphan KeyPackages can then be pruned from the server before a peer consumes them.
    pub fn key_package_has_private(&self, kp_bytes: &[u8]) -> Result<bool, MlsError> {
        let kp_in = KeyPackageIn::tls_deserialize(&mut &kp_bytes[..])
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage deserialize error: {:?}", e)))?;
        let key_package = kp_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| MlsError::OpenMls(format!("KeyPackage validate error: {:?}", e)))?;
        let hash_ref = key_package
            .hash_ref(self.provider.crypto())
            .map_err(|e| MlsError::OpenMls(format!("HashRef error: {:?}", e)))?;

        let bundle: Option<KeyPackageBundle> = self
            .provider
            .storage()
            .key_package(&hash_ref)
            .map_err(|e| MlsError::OpenMls(format!("Storage read error: {:?}", e)))?;
        Ok(bundle.is_some())
    }
}
