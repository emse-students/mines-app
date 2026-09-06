use log::{Level, Metadata, Record};
use mls_core::MlsManager;
use wasm_bindgen::prelude::*;

mod pin_crypto;
pub use pin_crypto::*;

// --- Custom Logger that calls JS function `window.wasm_bindings_log(level, msg)` ---

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = window, js_name = wasm_bindings_log)]
    fn js_log(level: &str, s: &str);
}

struct WebLogger;

impl log::Log for WebLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let message = format!("{}", record.args());
            // WrongEpoch / SecretReuseError can happen during replay and are
            // handled gracefully by the frontend; don't emit them as ERROR noise.
            //
            // `CannotDecryptOwnMessage` used to be listed here as well, and it no longer needs to
            // be: `mls-core` now classifies our own re-offered frame at the throw and logs it at
            // DEBUG, so nothing reaches this logger at ERROR carrying that marker. Demoting a
            // severity by re-reading the text is a rule that survives its own cause - it hid the
            // fact that native, which has no such shim, was logging a real ERROR per own frame AND
            // queueing it for retry. Every entry left here still has a live ERROR emitter.
            if record.level() == Level::Error
                && (message.contains("Wrong Epoch")
                    || message.contains("wrong epoch")
                    || message.contains("SecretReuseError"))
            {
                js_log("DEBUG", &message);
                return;
            }
            js_log(&record.level().to_string(), &message);
        }
    }

    fn flush(&self) {}
}

static LOGGER: WebLogger = WebLogger;

// Call this once from JS
#[wasm_bindgen]
pub fn init_logger() {
    // Attempt to init logger. If fails (already init), ignore.
    let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Info));
}

/// ChaCha20 encrypt of a plain MLS CBOR snapshot with a base64-encoded 32-byte key.
/// Wire format: `[nonce (12) || ciphertext]` — no salt prefix. Safe to call from a Web Worker.
#[wasm_bindgen]
pub fn encrypt_mls_state_blob_with_key(
    plain_state: &[u8],
    key_b64: &str,
) -> Result<Vec<u8>, JsValue> {
    let key =
        mls_core::crypto::decode_base64_to_32_bytes(key_b64).map_err(|e| JsValue::from_str(&e))?;
    MlsManager::encrypt_state_blob_with_key(plain_state, &key)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// ChaCha20 decrypt of an MLS CBOR snapshot (produced by `encrypt_mls_state_blob_with_key`).
/// Wire format: `[nonce (12) || ciphertext]` — no salt prefix.
#[wasm_bindgen]
pub fn decrypt_mls_state_blob_with_key(
    encrypted: &[u8],
    key_b64: &str,
) -> Result<Vec<u8>, JsValue> {
    if encrypted.len() < 12 {
        return Err(JsValue::from_str("Invalid encrypted data length"));
    }
    let key =
        mls_core::crypto::decode_base64_to_32_bytes(key_b64).map_err(|e| JsValue::from_str(&e))?;
    mls_core::security::decrypt_blob(&key, encrypted).map_err(|e| JsValue::from_str(&e))
}

// ----------------------------------------------------

// Wrapper structure exposed to JavaScript.
#[wasm_bindgen]
pub struct WasmMlsClient {
    // The manager lives inside the WASM instance.
    manager: MlsManager,
}

#[wasm_bindgen]
impl WasmMlsClient {
    /// Constructor called from JavaScript (e.g. new WasmMlsClient(...))
    ///
    /// When `device_key_b64` is provided with an encrypted state blob, the state is
    /// decrypted with the given key (ChaCha20-Poly1305 direct, no Argon2id). Otherwise,
    /// the state is loaded/created as plain CBOR.
    ///
    /// `state_was_expected` says whether the CALLER had reason to believe this device already held
    /// a state - true when the device id pre-existed this boot, false when it was minted just now.
    /// Nothing inside this constructor can derive it: a first enrolment and a device that lost its
    /// snapshot arrive here as the same pair of arguments. Passing it down is what lets the warning
    /// below accuse the second without crying over the first, which is why the parameter exists.
    #[wasm_bindgen(constructor)]
    pub fn new(
        user_id: &str,
        device_id: &str,
        state_bytes: Option<Vec<u8>>,
        device_key_b64: Option<String>,
        state_was_expected: bool,
    ) -> Result<WasmMlsClient, JsValue> {
        // Redirect Rust panics to the browser console.
        console_error_panic_hook::set_once();

        // Identifiers are truncated to eight characters, as they are everywhere else in this
        // client's logs. A full 64-character user id next to a full device id is what a debugging
        // session prints, and this line runs on EVERY construction - several times per page load.
        log::info!(
            "WasmMlsClient::new called for user: {} device: {}",
            user_id.chars().take(8).collect::<String>(),
            device_id.chars().take(8).collect::<String>()
        );

        let manager = if let (Some(blob), Some(key_b64)) =
            (state_bytes.clone(), device_key_b64.clone())
        {
            log::info!("Loading encrypted state with device key");
            let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64)
                .map_err(|e| JsValue::from_str(&e))?;
            MlsManager::load_with_key(user_id, device_id, Some(blob), &key)
                .map_err(|e| JsValue::from_str(&e.to_string()))?
        } else {
            if state_bytes.is_none() && device_key_b64.is_some() && state_was_expected {
                log::warn!(
                    "device_key_b64 provided but no encrypted state - key ignored, creating fresh state"
                );
            }
            log::info!("Loading/Creating clean state");
            MlsManager::load_or_create(user_id, device_id, state_bytes)
                .map_err(|e| JsValue::from_str(&e.to_string()))?
        };

        Ok(WasmMlsClient { manager })
    }

    // Create a group
    #[wasm_bindgen]
    pub fn create_group(&mut self, group_id: String) -> Result<(), JsValue> {
        log::info!("create_group: {}", group_id);
        self.manager
            .create_group(group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Wipes any existing orphan state for this groupId then creates a fresh group.
    /// Use for re-bootstrap after losing local MLS state (phantom group recovery).
    #[wasm_bindgen]
    pub fn force_create_group(&mut self, group_id: String) -> Result<(), JsValue> {
        log::info!("force_create_group: {}", group_id);
        self.manager
            .force_create_group(group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn get_groups(&self) -> js_sys::Array {
        let groups = self.manager.get_known_groups();
        let arr = js_sys::Array::new();
        for g in groups {
            arr.push(&JsValue::from_str(&g));
        }
        arr
    }

    #[wasm_bindgen]
    pub fn forget_group(&mut self, group_id: String, min_epoch: f64) {
        // f64 at the JS boundary (wasm-bindgen has no u64 -> number; f64 is exact for any
        // realistic epoch, <= 2^53). Convert back to u64 (source width). [[S4]]
        log::info!("forget_group: {}, min_epoch={}", group_id, min_epoch);
        self.manager.forget_group(&group_id, min_epoch as u64);
    }

    /// Permanent purge of a group (Poison Pill): memory, OpenMLS storage, and epoch lock
    /// set to MAX. No Welcome will ever be accepted for this groupId.
    #[wasm_bindgen]
    pub fn drop_group(&mut self, group_id: String) {
        log::info!("drop_group (poison pill): {}", group_id);
        self.manager.drop_group(&group_id);
    }

    /// Returns the current MLS epoch for a group as an f64 (a plain JS `number`). wasm-bindgen has
    /// no u64 -> JS number mapping (it would yield a BigInt); f64 represents every epoch exactly up
    /// to 2^53, far beyond any realistic group lifetime, so there is no truncation. [[S4]]
    #[wasm_bindgen]
    pub fn get_epoch(&self, group_id: String) -> Result<f64, JsValue> {
        let epoch = self
            .manager
            .get_epoch(&group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(epoch as f64)
    }

    /// Whether this device is still a member (false once a Remove commit naming it was applied).
    /// See `MlsManager::is_group_active`: this is the fact that makes an eviction knowable at the
    /// commit instead of at the refused send.
    #[wasm_bindgen]
    pub fn is_group_active(&self, group_id: String) -> Result<bool, JsValue> {
        self.manager
            .is_group_active(&group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Save state (returns a Uint8Array in JS).
    ///
    /// When `device_key_b64` is provided, the state is encrypted with ChaCha20-Poly1305
    /// using the given key (no Argon2id). Otherwise, the state is saved as plain CBOR
    /// (legacy/dev fallback).
    #[wasm_bindgen]
    pub fn save_state(&self, device_key_b64: Option<String>) -> Result<Vec<u8>, JsValue> {
        if let Some(key_b64) = device_key_b64 {
            let key = mls_core::crypto::decode_base64_to_32_bytes(&key_b64)
                .map_err(|e| JsValue::from_str(&e))?;
            self.manager
                .save_encrypted_with_key(&key)
                .map_err(|e| JsValue::from_str(&e.to_string()))
        } else {
            self.manager
                .save_state()
                .map_err(|e| JsValue::from_str(&e.to_string()))
        }
    }

    #[wasm_bindgen]
    pub fn generate_key_package(&self) -> Result<Vec<u8>, JsValue> {
        log::info!("generate_key_package");
        self.manager
            .generate_key_package()
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The device's STATIC fallback. Reusable: the delivery service serves this one package to
    /// every peer that finds the one-time pool empty, and an ordinary KeyPackage would be consumed
    /// by the first Welcome built on it.
    #[wasm_bindgen]
    pub fn generate_last_resort_key_package(&self) -> Result<Vec<u8>, JsValue> {
        log::info!("generate_last_resort_key_package");
        self.manager
            .generate_last_resort_key_package()
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn generate_key_packages(&self, count: usize) -> Result<js_sys::Array, JsValue> {
        log::info!("generate_key_packages count={}", count);
        let packages = self
            .manager
            .generate_key_packages(count)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let arr = js_sys::Array::new();
        for kp in packages {
            arr.push(&js_sys::Uint8Array::from(kp.as_slice()));
        }
        Ok(arr)
    }

    #[wasm_bindgen]
    pub fn key_package_has_private(&self, key_package_bytes: Vec<u8>) -> Result<bool, JsValue> {
        self.manager
            .key_package_has_private(&key_package_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn add_member(
        &mut self,
        group_id: String,
        key_package_bytes: Vec<u8>,
    ) -> Result<js_sys::Array, JsValue> {
        log::info!(
            "add_member to group: {} ({} bytes)",
            group_id,
            key_package_bytes.len()
        );
        // C7-A stage-only: returns [commit, welcome]. The commit is NOT merged; the caller
        // validates it server-side, then merge_pending_commit / clear_pending_commit, and reads
        // the post-merge ratchet tree via export_ratchet_tree.
        let (commit, welcome) = self
            .manager
            .add_member(&group_id, &key_package_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&commit[..]));
        if let Some(w) = welcome {
            array.push(&js_sys::Uint8Array::from(&w[..]));
        } else {
            array.push(&JsValue::UNDEFINED);
        }
        Ok(array)
    }

    /// Add multiple members in a single commit (single epoch increment). Stage-only (C7-A): the
    /// commit is NOT merged - the caller validates it server-side then merge/clear, and reads the
    /// post-merge ratchet tree via `export_ratchet_tree`.
    /// `key_packages` is a JS Array of Uint8Array.
    /// Returns [commit: Uint8Array, welcome: Uint8Array, added_indices: number[],
    /// skipped_indices: number[]].
    /// `added_indices` lists, in order, the positions within the input `key_packages` array that
    /// were actually included in the commit - positions skipped (invalid, or already a member of
    /// the group) are omitted rather than collapsing to a bare count, so the caller can correctly
    /// map indices back to its own per-device bookkeeping. `skipped_indices` lists the positions of
    /// KeyPackages dropped because they were **invalid/undeserializable** (not the already-member
    /// dedup), so the caller can surface a non-silent member loss. [[C5]]
    #[wasm_bindgen]
    pub fn add_members_bulk(
        &mut self,
        group_id: String,
        key_packages: js_sys::Array,
    ) -> Result<js_sys::Array, JsValue> {
        log::info!(
            "add_members_bulk to group: {} ({} key packages)",
            group_id,
            key_packages.length()
        );

        // Convert JS Array<Uint8Array> -> Vec<Vec<u8>>
        let kp_vecs: Vec<Vec<u8>> = key_packages
            .iter()
            .filter_map(|v| {
                let arr = js_sys::Uint8Array::from(v);
                if arr.length() == 0 {
                    None
                } else {
                    Some(arr.to_vec())
                }
            })
            .collect();

        let kp_slices: Vec<&[u8]> = kp_vecs.iter().map(|v| v.as_slice()).collect();

        let (commit, welcome, added_indices, skipped_indices) = self
            .manager
            .add_members_bulk(&group_id, &kp_slices)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&commit[..]));
        if let Some(w) = welcome {
            array.push(&js_sys::Uint8Array::from(&w[..]));
        } else {
            array.push(&JsValue::UNDEFINED);
        }
        let indices_array = js_sys::Array::new();
        for idx in added_indices {
            indices_array.push(&JsValue::from_f64(idx as f64));
        }
        array.push(&indices_array);
        let skipped_array = js_sys::Array::new();
        for idx in skipped_indices {
            skipped_array.push(&JsValue::from_f64(idx as f64));
        }
        array.push(&skipped_array);
        Ok(array)
    }

    #[wasm_bindgen]
    pub fn process_welcome(
        &mut self,
        welcome_bytes: Vec<u8>,
        ratchet_tree_bytes: Option<Vec<u8>>,
    ) -> Result<String, JsValue> {
        log::info!("process_welcome ({} bytes)", welcome_bytes.len());
        self.manager
            .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn send_message(&mut self, group_id: String, message: String) -> Result<Vec<u8>, JsValue> {
        log::info!(
            "send_message to group: {} (len: {})",
            group_id,
            message.len()
        );
        self.manager
            .send_message(&group_id, message.as_bytes())
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Encrypts raw bytes (e.g. a proto-encoded AppMessage) as the MLS application payload.
    #[wasm_bindgen]
    pub fn send_message_bytes(
        &mut self,
        group_id: String,
        message_bytes: Vec<u8>,
    ) -> Result<Vec<u8>, JsValue> {
        log::debug!(
            "send_message_bytes to group: {} ({} bytes)",
            group_id,
            message_bytes.len()
        );
        self.manager
            .send_message(&group_id, &message_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Advances the send ratchet by `count` generations without emitting anything, repairing a
    /// snapshot that was restored behind frames this device had already sent. See
    /// `MlsManager::skip_send_generations` for why it encrypts and why over-shooting is safe.
    #[wasm_bindgen]
    pub fn skip_send_generations(&mut self, group_id: String, count: u32) -> Result<u32, JsValue> {
        self.manager
            .skip_send_generations(&group_id, count)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn export_secret(
        &self,
        group_id: String,
        label: String,
        context: Option<Vec<u8>>,
        key_len: usize,
    ) -> Result<Vec<u8>, JsValue> {
        log::info!(
            "export_secret: {} label={} len={}",
            group_id,
            label,
            key_len
        );
        let ctx = context.unwrap_or(vec![]);
        self.manager
            .export_secret(&group_id, &label, &ctx, key_len)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn process_incoming_message(
        &mut self,
        group_id: String,
        message_bytes: Vec<u8>,
    ) -> Result<Option<String>, JsValue> {
        log::debug!(
            "process_incoming_message for group: {} ({} bytes)",
            group_id,
            message_bytes.len()
        );
        let res = self
            .manager
            .process_incoming_message(&group_id, &message_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        match res {
            Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
            None => Ok(None),
        }
    }

    /// Returns the raw decrypted bytes of an MLS application message (proto-encoded AppMessage).
    #[wasm_bindgen]
    pub fn process_incoming_message_bytes(
        &mut self,
        group_id: String,
        message_bytes: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, JsValue> {
        log::debug!(
            "process_incoming_message_bytes for group: {} ({} bytes)",
            group_id,
            message_bytes.len()
        );
        self.manager
            .process_incoming_message(&group_id, &message_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Decrypts a batch of MLS ciphertexts for one group in ratchet order, in a single
    /// JS<->WASM crossing. Per-message failures are captured instead of aborting the whole
    /// batch, so the caller can map each outcome independently (history catch-up path).
    ///
    /// `messages` is a JS Array of `Uint8Array`. Returns a JS Array of plain objects, one
    /// per input, preserving order:
    /// - `{ ok: true, data: Uint8Array }` decrypted application plaintext,
    /// - `{ ok: true, data: null }` control message with no plaintext,
    /// - `{ ok: false, error: string }` recoverable per-message decrypt error.
    #[wasm_bindgen]
    pub fn process_incoming_messages_batch(
        &mut self,
        group_id: String,
        messages: js_sys::Array,
    ) -> js_sys::Array {
        log::debug!(
            "process_incoming_messages_batch for group: {} ({} messages)",
            group_id,
            messages.length()
        );

        let mut rust_messages = Vec::with_capacity(messages.length() as usize);
        for entry in messages.iter() {
            rust_messages.push(js_sys::Uint8Array::new(&entry).to_vec());
        }
        let message_refs: Vec<&[u8]> = rust_messages.iter().map(|v| v.as_slice()).collect();
        let outcomes = self
            .manager
            .process_incoming_messages(&group_id, &message_refs);

        let ok_key = JsValue::from_str("ok");
        let data_key = JsValue::from_str("data");
        let error_key = JsValue::from_str("error");
        let results = js_sys::Array::new();

        for outcome in outcomes {
            let obj = js_sys::Object::new();
            match outcome {
                Ok(Some(plaintext)) => {
                    let _ = js_sys::Reflect::set(&obj, &ok_key, &JsValue::TRUE);
                    let data = js_sys::Uint8Array::from(plaintext.as_slice());
                    let _ = js_sys::Reflect::set(&obj, &data_key, &data);
                }
                Ok(None) => {
                    let _ = js_sys::Reflect::set(&obj, &ok_key, &JsValue::TRUE);
                    let _ = js_sys::Reflect::set(&obj, &data_key, &JsValue::NULL);
                }
                // Every error is REPORTED, `SecretReuse` included. It used to answer
                // "nothing to show" here, on the argument that a consumed generation during a
                // history REPLAY is the expected case - which is true, and was still the wrong
                // place to decide it. Whether this frame is one already read or one lost to a
                // rewound sender is settled by its own bytes against the seen-frame ledger, which
                // lives in `history.ts`; this layer has neither, so it must report and not rule.
                // Mirrors `map_decrypt_outcome` on native - the two paths must not diverge on the
                // same frame (WP-PENDING-2).
                Err(e) => {
                    let _ = js_sys::Reflect::set(&obj, &ok_key, &JsValue::FALSE);
                    let _ =
                        js_sys::Reflect::set(&obj, &error_key, &JsValue::from_str(&e.to_string()));
                }
            }
            results.push(&obj);
        }
        results
    }

    /// Every leaf identity (`userId:deviceId`) currently in the group's ratchet tree.
    ///
    /// The tree is the only authority on who can read a group. The delivery service's membership
    /// rows answer who it will ROUTE to, which is a different question and can be empty for a group
    /// whose tree is full - so a reconciliation that decides whether a leaf still belongs reads
    /// this, and a routing table never stands in for it.
    #[wasm_bindgen]
    pub fn get_member_identities(&self, group_id: String) -> Result<js_sys::Array, JsValue> {
        let identities = self
            .manager
            .member_identities(&group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(identities
            .into_iter()
            .map(|id| JsValue::from_str(&id))
            .collect())
    }

    /// Remove all devices of one or more users from a group.
    /// `user_ids` is a JS Array of strings (usernames/identities).
    /// Returns the serialized commit bytes to broadcast to remaining group members.
    #[wasm_bindgen]
    pub fn remove_members(
        &mut self,
        group_id: String,
        user_ids: js_sys::Array,
    ) -> Result<Vec<u8>, JsValue> {
        let ids: Vec<String> = user_ids.iter().filter_map(|v| v.as_string()).collect();
        log::info!("remove_members from group: {} (users: {:?})", group_id, ids);
        let id_slices: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        self.manager
            .remove_members_for_users(&group_id, &id_slices)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Remove specific device leaves by their `userId:deviceId` identity string.
    /// Only removes the targeted leaves, leaving other devices of the same user intact.
    #[wasm_bindgen]
    pub fn remove_members_by_device(
        &mut self,
        group_id: String,
        device_identities: js_sys::Array,
    ) -> Result<Vec<u8>, JsValue> {
        let ids: Vec<String> = device_identities
            .iter()
            .filter_map(|v| v.as_string())
            .collect();
        log::info!(
            "remove_members_by_device from group: {} (devices: {:?})",
            group_id,
            ids
        );
        let id_slices: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        self.manager
            .remove_members_for_devices(&group_id, &id_slices)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Merges the *staged* commit (ADD or REMOVE) AFTER the server accepts it (`validateCommit`).
    /// Advances the local epoch. Counterpart of `clear_pending_commit`. [[C7]] Option A:
    /// validate-then-merge.
    #[wasm_bindgen]
    pub fn merge_pending_commit(&mut self, group_id: String) -> Result<(), JsValue> {
        self.manager
            .merge_pending_commit_for(&group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Clears the *staged* commit (ADD or REMOVE) when the server REJECTS it. The local epoch stays
    /// unchanged (no fork) and a new commit can be generated. [[C7]] Option A.
    #[wasm_bindgen]
    pub fn clear_pending_commit(&mut self, group_id: String) -> Result<(), JsValue> {
        self.manager
            .clear_pending_commit_for(&group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Export the group's current ratchet tree (TLS-serialised). For an ADD this MUST be called
    /// AFTER `merge_pending_commit` so the tree reflects the post-commit epoch the newly welcomed
    /// member joins. [[C7]]
    #[wasm_bindgen]
    pub fn export_ratchet_tree(&self, group_id: String) -> Result<Vec<u8>, JsValue> {
        self.manager
            .export_ratchet_tree_for(&group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Export a self-contained GroupInfo (ratchet tree included) for `group_id`, to be stored by the
    /// delivery service and served to an authorized member who then joins via `join_by_external_commit`.
    #[wasm_bindgen]
    pub fn export_group_info(&self, group_id: String) -> Result<Vec<u8>, JsValue> {
        self.manager
            .export_group_info(&group_id)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Join a group via an external commit built from a served GroupInfo. The returned group is at
    /// the new epoch with the commit STAGED: submit the commit for server epoch validation (against
    /// the GroupInfo's base epoch), then `merge_pending_commit` on accept, or `forget_group` +
    /// retry with a fresher GroupInfo on reject (an external commit cannot be cleared). Returns
    /// [group_id: string, commit: Uint8Array].
    #[wasm_bindgen]
    pub fn join_by_external_commit(
        &mut self,
        group_info_bytes: Vec<u8>,
    ) -> Result<js_sys::Array, JsValue> {
        let (group_id, commit) = self
            .manager
            .join_by_external_commit(&group_info_bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let array = js_sys::Array::new();
        array.push(&JsValue::from_str(&group_id));
        array.push(&js_sys::Uint8Array::from(&commit[..]));
        Ok(array)
    }
}
