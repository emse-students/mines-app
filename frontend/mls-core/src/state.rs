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

impl MlsManager {
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

            Ok(Self {
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
            })
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
