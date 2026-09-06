//! MLS Tauri commands: initialisation, groups, encryption, decryption.

use crate::concurrency::write_mls_state_blob;
use crate::keystore_bridge::PluginDeviceKeyStore;
use crate::state::{
    decrypt_messages_batch, AppState, BatchDecryptItem, KeyPackageBatchResult, PendingDb,
};
use mls_core::{DecryptErrorKind, DeviceKeyStore, MlsManager};
use std::sync::Mutex;

/// The two situational inputs of [`initialiser_mls`], grouped so the command keeps a workable
/// arity. Every field is optional and the whole struct defaults, so a frontend that sends nothing
/// still initialises - neither input is required for a normal login.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct InitMlsOptions {
    /// One-shot migration path for `mls.bin` files written before v0.11.0, sealed in the Argon2id
    /// envelope `[salt (16) || nonce (12) || ciphertext]` keyed on the raw PIN. Nothing ever
    /// rewrote them, so on the first v0.11.x launch they fail to decrypt exactly like a snapshot
    /// sealed with another device's key. When it is supplied and the normal load fails, the legacy
    /// envelope is tried once; on success the snapshot is re-sealed under the device key and
    /// written back, so the conversion happens at most once per install.
    pub legacy_pin: Option<String>,
    /// Localized text for the sheet that biometric mode raises. This is the only command that can
    /// supply it: the native keystore plugin has no access to the app's message catalogue, and the
    /// frontend is the only layer that knows the active locale.
    pub biometric_prompt: Option<tauri_plugin_keystore::BiometricPromptText>,
}

/// Initialises the MLS manager for this session and caches its at-rest key.
#[tauri::command]
pub(crate) async fn initialiser_mls(
    app: tauri::AppHandle,
    user_id: String,
    device_id: String,
    device_key_b64: String,
    encrypted_state: Option<Vec<u8>>,
    opts: Option<InitMlsOptions>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let opts = opts.unwrap_or_default();
    let legacy_pin = opts.legacy_pin;
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    let keystore = PluginDeviceKeyStore::new(app.clone())
        .with_prompt(opts.biometric_prompt.unwrap_or_default());

    // Empty device_key_b64 → biometric mode: the keystore holds the device key directly.
    // resolve_at_rest_key then takes Path A (retrieve_device_key), which triggers a single
    // BiometricPrompt on Android/iOS.
    let key_b64_opt = if device_key_b64.is_empty() {
        None
    } else {
        Some(device_key_b64)
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve the key explicitly instead of letting the loader do it internally: the
        // resolved key is cached below so later saves in this session (which arrive with an
        // empty device_key_b64 in biometric mode) never have to prompt again.
        let key = MlsManager::resolve_at_rest_key(
            &user_id,
            &device_id,
            encrypted_state.as_deref(),
            key_b64_opt,
            &keystore,
        )
        .map_err(|e| e.to_string())?;

        let manager =
            match MlsManager::load_with_key(&user_id, &device_id, encrypted_state.clone(), &key) {
                Ok(manager) => manager,
                Err(e) => {
                    let migrated = match (&encrypted_state, &legacy_pin) {
                        (Some(blob), Some(pin)) => migrate_legacy_state_blob(&app, blob, pin, &key),
                        _ => None,
                    };
                    match migrated {
                        Some(resealed) => {
                            log::info!("[MLS] Pre-v0.11.0 mls.bin re-sealed under the device key.");
                            MlsManager::load_with_key(&user_id, &device_id, Some(resealed), &key)
                                .map_err(|e| e.to_string())?
                        }
                        None => return Err(e.to_string()),
                    }
                }
            };

        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        *lock = Some(manager);
        *device_key_state
            .lock()
            .map_err(|_| "Failed to lock device key".to_string())? = Some(key);
        Ok::<String, String>("MLS Initialized".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a pre-v0.11.0 `mls.bin` (Argon2id, `[salt (16) || nonce (12) || ciphertext]`) with `pin`
/// and rewrites it sealed under `key`, returning the re-sealed bytes.
///
/// Returns `None` when the blob is not that envelope or `pin` does not open it - the caller then
/// keeps the original load error and falls back to recovery. The rewrite happens here rather than
/// being left to the opportunistic save on the JS side: a snapshot left in the legacy envelope
/// replays this migration on every launch, and any failure in between resurfaces as a bogus
/// "PIN changed on another device".
fn migrate_legacy_state_blob(
    app: &tauri::AppHandle,
    blob: &[u8],
    pin: &str,
    key: &[u8; 32],
) -> Option<Vec<u8>> {
    if blob.len() < 16 + 12 {
        return None;
    }
    let (salt, sealed) = blob.split_at(16);
    let legacy_key = mls_core::security::derive_key_from_pin_owned(pin.to_string(), salt).ok()?;
    let plain = mls_core::security::decrypt_blob(&legacy_key, sealed).ok()?;

    let resealed = MlsManager::encrypt_state_blob_with_key(&plain, key)
        .map_err(|e| log::error!("[MLS] Re-sealing the legacy snapshot failed: {e}"))
        .ok()?;
    write_mls_state_blob(app, &resealed)
        .map_err(|e| log::error!("[MLS] Persisting the re-sealed snapshot failed: {e}"))
        .ok()?;
    Some(resealed)
}

/// Resolve the at-rest key for a save: the caller's base64 key when it supplied one, otherwise
/// the key `initialiser_mls` cached for this session.
///
/// The JS layer passes an empty string on the biometric path, where it never holds the key.
fn session_at_rest_key(
    device_key_b64: &str,
    cached: &Mutex<Option<[u8; 32]>>,
) -> Result<[u8; 32], String> {
    if !device_key_b64.is_empty() {
        return mls_core::crypto::decode_base64_to_32_bytes(device_key_b64)
            .map_err(|e| format!("invalid device_key_b64: {e}"));
    }
    (*cached
        .lock()
        .map_err(|_| "Failed to lock device key".to_string())?)
    .ok_or_else(|| "no device key for this session - MLS not initialized".to_string())
}

/// Returns the at-rest key [`initialiser_mls`] cached for this session, base64-encoded, or `None`
/// when no session has been initialised yet.
///
/// Biometric mode is the only caller. There the frontend calls `initialiser_mls` with an empty
/// `device_key_b64` and never learns the key - but the key seals more than `mls.bin`: locally
/// stored messages are AES-256-GCM blobs encrypted **in JS** (`db/sqlite.ts`) under that same key.
/// Without it every stored row fails to decrypt and every new row fails to be written, silently,
/// for the whole session.
///
/// Handing the cached copy back costs no second prompt, which reading the keystore again would.
/// It is also not a new exposure: on the PIN and vault paths `deriveDeviceKeyB64` produces this
/// exact key in the WebView to begin with - biometric mode was the one path where the frontend
/// was missing something it needs.
#[tauri::command]
pub(crate) async fn recuperer_cle_session_mls(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    use base64::Engine;
    let cached = *state
        .device_key
        .lock()
        .map_err(|_| "Failed to lock device key".to_string())?;
    Ok(cached.map(|key| base64::engine::general_purpose::STANDARD.encode(key)))
}

#[tauri::command]
pub(crate) async fn sauvegarder_mls(
    device_key_b64: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let key = session_at_rest_key(&device_key_b64, &device_key_state)?;
        let encrypted = manager
            .save_encrypted_with_key(&key)
            .map_err(|e| e.to_string())?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn sauvegarder_mls_et_persister(
    device_key_b64: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<u8>, String> {
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let key = session_at_rest_key(&device_key_b64, &device_key_state)?;
        let encrypted = manager
            .save_encrypted_with_key(&key)
            .map_err(|e| e.to_string())?;
        write_mls_state_blob(&app, &encrypted)?;
        Ok::<Vec<u8>, String>(encrypted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn creer_groupe(group_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager.create_group(group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn key_package_a_clef_privee(
    key_package_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        let has_private = manager
            .key_package_has_private(&key_package_bytes)
            .map_err(|e| e.to_string())?;
        Ok::<bool, String>(has_private)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn generer_key_packages_et_persister(
    device_key_b64: String,
    count: usize,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<KeyPackageBatchResult, String> {
    let manager_state = state.mls_manager.clone();
    let device_key_state = state.device_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_ref()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;

        log::debug!(
            "generer_key_packages_et_persister start count={} (batch native path)",
            count
        );
        // The STATIC fallback, and it is last-resort because the delivery service serves this one
        // package to every peer that finds the pool empty (`resolveKeyPackagePayloadForDevice`).
        // An ordinary KeyPackage's private bundle dies with the first Welcome built on it, so the
        // second peer to be served it could never join - see `mls-core/tests/last_resort_key_package.rs`.
        let fallback = manager
            .generate_last_resort_key_package()
            .map_err(|e| e.to_string())?;
        let pool_packages = if count > 0 {
            manager
                .generate_key_packages(count)
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        let key = session_at_rest_key(&device_key_b64, &device_key_state)?;
        let encrypted_state = manager
            .save_encrypted_with_key(&key)
            .map_err(|e| e.to_string())?;
        write_mls_state_blob(&app, &encrypted_state)?;
        log::debug!(
            "generer_key_packages_et_persister done count={} state_bytes={}",
            count,
            encrypted_state.len()
        );

        Ok::<KeyPackageBatchResult, String>(KeyPackageBatchResult {
            fallback,
            pool_packages,
            state: encrypted_state,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn oublier_groupe(
    group_id: String,
    // u64: same width as the source epoch (Tauri serializes it as a JSON number on the JS side). [[S4]]
    min_epoch: u64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.forget_group(&group_id, min_epoch);
    Ok(())
}

/// Permanent purge of a group (poison pill): memory + OpenMLS storage + epoch lock at MAX.
/// No Welcome will ever be accepted for this groupId after this call.
#[tauri::command]
pub(crate) fn supprimer_groupe(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager.drop_group(&group_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn lister_groupes(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    Ok(manager.get_known_groups())
}

/// Whether this device is still a member of the group (false once a Remove commit naming it was
/// applied). See `MlsManager::is_group_active`: the fact that makes an eviction knowable at the
/// commit rather than at the refused send.
#[tauri::command]
pub(crate) fn groupe_actif(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<bool, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .is_group_active(&group_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn obtenir_epoch(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<u64, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    // u64: no truncation; Tauri serializes it as a JSON number (exact <= 2^53, never reached). [[S4]]
    manager.get_epoch(&group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn ajouter_membres_bulk(
    group_id: String,
    key_packages_bytes: Vec<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<mls_core::AddMembersBulkResult, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    // Stage-only (C7-A): the commit is NOT merged here. The caller validates it server-side then
    // calls confirmer_commit (accepted) / annuler_commit (rejected), and reads the post-merge
    // ratchet tree via exporter_ratchet_tree.
    let refs: Vec<&[u8]> = key_packages_bytes.iter().map(|v| v.as_slice()).collect();
    manager
        .add_members_bulk(&group_id, &refs)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn trailer_welcome(
    welcome_bytes: Vec<u8>,
    ratchet_tree_bytes: Option<Vec<u8>>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .process_welcome(&welcome_bytes, ratchet_tree_bytes.as_deref())
        .map_err(|e| {
            log::error!(
                "[WELCOME] Erreur critique lors du traitement du Welcome MLS: {:?}",
                e
            );
            e.to_string()
        })
}

#[tauri::command]
pub(crate) fn envoyer_message(
    group_id: String,
    message: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .send_message(&group_id, message.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn envoyer_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .send_message(&group_id, &message_bytes)
        .map_err(|e| e.to_string())
}

/// Advances the send ratchet by `count` generations without emitting anything, repairing an
/// `mls.bin` restored behind frames this device had already sent. ONE invoke for the whole burn:
/// a per-generation crossing would marshal a discarded ciphertext back over IPC every time.
/// See `MlsManager::skip_send_generations` for why it encrypts and why over-shooting is safe.
#[tauri::command]
pub(crate) fn skip_send_generations(
    group_id: String,
    count: u32,
    state: tauri::State<AppState>,
) -> Result<u32, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    manager
        .skip_send_generations(&group_id, count)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn recevoir_message(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<Option<String>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let res = manager
        .process_incoming_message(&group_id, &message_bytes)
        .map_err(|e| {
            log::error!("recevoir_message failed: group={} err={}", group_id, e);
            e.to_string()
        })?;

    match res {
        Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        None => Ok(None),
    }
}

/// Every leaf identity (`userId:deviceId`) currently in the group's ratchet tree.
///
/// The tree is the only authority on who can READ a group. The delivery service's membership rows
/// answer who it will ROUTE to - a different question, and one a community's key-distribution group
/// has no rows for at all - so a reconciliation deciding whether a leaf still belongs reads this.
#[tauri::command]
pub(crate) fn lister_identites_membres(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager.member_identities(&group_id).map_err(|e| {
        log::error!(
            "lister_identites_membres failed: group={} err={}",
            group_id,
            e
        );
        e.to_string()
    })
}

#[tauri::command]
pub(crate) fn retirer_membres(
    group_id: String,
    user_ids: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = user_ids.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_users(&group_id, &id_slices)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn retirer_membres_par_appareil(
    group_id: String,
    device_identities: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;

    let id_slices: Vec<&str> = device_identities.iter().map(|s| s.as_str()).collect();
    manager
        .remove_members_for_devices(&group_id, &id_slices)
        .map_err(|e| e.to_string())
}

/// Confirms (merges) a *staged* commit (ADD or REMOVE) AFTER the server accepts it
/// (`validateCommit`). Advances the local epoch. Counterpart of `annuler_commit`. [[C7]] Option A:
/// validate-then-merge, never a local fork on rejection (unified ADD+REMOVE regime).
///
/// Does NOT persist: the caller chains `persistMlsStateAfterMutation` (which holds the device key,
/// retrieved from the session-level keystore) as for any other mutation - same merge->persist
/// window as before.
#[tauri::command]
pub(crate) fn confirmer_commit(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .merge_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Clears a *staged* commit (ADD or REMOVE) when the server REJECTS it. The local epoch stays
/// unchanged (no fork). No persistence: `mls.bin` is already at the pre-stage state. [[C7]]
#[tauri::command]
pub(crate) fn annuler_commit(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .clear_pending_commit_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exports the group's ratchet tree from the CURRENT state (post-merge) for the Welcome. For an
/// ADD, call it AFTER `confirmer_commit` (the new member joins at epoch N+1). [[C7]]
#[tauri::command]
pub(crate) fn exporter_ratchet_tree(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_ratchet_tree_for(&group_id)
        .map_err(|e| e.to_string())
}

/// Exports a self-contained GroupInfo (tree included) for `group_id`, to be stored server-side and
/// served to authorized members joining via an external commit (`rejoindre_par_commit_externe`).
#[tauri::command]
pub(crate) fn exporter_group_info(
    group_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;
    manager
        .export_group_info(&group_id)
        .map_err(|e| e.to_string())
}

/// Joins a group via an external commit built from a served GroupInfo. The returned group is at
/// epoch N+1 with the commit *staged*: the caller submits the commit for epoch validation
/// server-side (against the GroupInfo's base epoch), then `confirmer_commit` if accepted, or
/// `oublier_groupe` + retry with a fresher GroupInfo if rejected (an external commit cannot be
/// rolled back). Returns (group_id, commit).
#[tauri::command]
pub(crate) fn rejoindre_par_commit_externe(
    group_info_bytes: Vec<u8>,
    state: tauri::State<AppState>,
) -> Result<(String, Vec<u8>), String> {
    let mut lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
    manager
        .join_by_external_commit(&group_info_bytes)
        .map_err(|e| e.to_string())
}

/// Dechiffre un message MLS entrant.
/// If decryption fails with "Process error:" (Sender Ratchet gap: the received generation is
/// higher than the expected one), the message is stored in SQLite via PendingDb and the command
/// returns Err("GAP_QUEUED:<group_id>") so the frontend knows it must fetch the missing messages.
#[tauri::command]
pub(crate) async fn recevoir_message_bytes(
    group_id: String,
    message_bytes: Vec<u8>,
    state: tauri::State<'_, AppState>,
    pending_db: tauri::State<'_, PendingDb>,
) -> Result<Option<Vec<u8>>, String> {
    // Chantier 1 : detection proactive de l'epoch gap AVANT tout dechiffrement.
    // The epoch is cleartext in the MLS header -> no ratchet key consumed.
    // The MutexGuard is released in the inner block BEFORE any .await.
    let epoch_gap: Option<(u64, u64)> = {
        let lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        match lock.as_ref() {
            Some(manager) => {
                let group_epoch = manager.get_epoch(&group_id).ok();
                match (MlsManager::parse_message_epoch(&message_bytes), group_epoch) {
                    (Some(msg_ep), Some(group_ep)) if msg_ep > group_ep => Some((msg_ep, group_ep)),
                    _ => None,
                }
            }
            None => None,
        }
        // lock is released here - no await has happened yet
    };
    if let Some((msg_ep, group_ep)) = epoch_gap {
        log::warn!(
            "[GAP] Epoch gap detecte AVANT dechiffrement : \
             msg_epoch={} > group_epoch={} pour group={}. \
             Mise en attente et declenchement de la resync.",
            msg_ep,
            group_ep,
            group_id
        );
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        let id = format!("{}-epoch-{}", group_id, ts);
        let insert_result = sqlx::query(
            "INSERT OR IGNORE INTO pending_mls_messages \
             (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
        )
        .bind(&id)
        .bind(&group_id)
        .bind(message_bytes.as_slice())
        .bind(ts)
        .execute(&*pending_db.0)
        .await;
        match insert_result {
            Ok(_) => (),
            Err(db_e) => {
                log::error!("[GAP] DB insert (epoch pre-check) failed: {}", db_e);
                return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
            }
        }
        return Err(format!(
            "GAP_QUEUED:{}:msg_epoch={}:group_epoch={}",
            group_id, msg_ep, group_ep
        ));
    }

    // Acquire + release the Mutex BEFORE any async operation, to avoid deadlocks with
    // std::sync::Mutex (non-Send across await points).
    let result = {
        let mut lock = state
            .mls_manager
            .lock()
            .map_err(|_| "Failed to lock state")?;
        let manager = lock.as_mut().ok_or("MLS Manager not initialized")?;
        manager.process_incoming_message(&group_id, &message_bytes)
    };

    match result {
        Ok(val) => Ok(val),
        Err(e) => {
            let err_str = e.to_string();
            // Classification centralisee cote mls-core (source unique du string-matching). [[S5]]
            let kind = e.decrypt_kind();

            // SEVERITY IS THE CLASSIFICATION'S TO REPORT, NOT THE BARE FACT THAT A DECRYPT RETURNED
            // `Err`. Every arm below already logs the conclusion it reached, and this line sat above
            // all of them at `error!` - so an own frame re-offered by a replay, or a generation the
            // ratchet has already consumed, each announced an application ERROR on the phone, where
            // logs are hardest to read, every single time the protocol worked as specified. An error
            // that fires on the normal path is one its reader learns to skip. Only what NOTHING has
            // explained keeps `error!`.
            if matches!(
                kind,
                DecryptErrorKind::Other | DecryptErrorKind::Unrecoverable
            ) {
                log::error!(
                    "recevoir_message_bytes failed: group={} err={}",
                    group_id,
                    err_str
                );
            } else {
                log::debug!(
                    "recevoir_message_bytes classified: group={} kind={:?} err={}",
                    group_id,
                    kind,
                    err_str
                );
            }

            match kind {
                // Corruption detected by mls-core -> unrecoverable state, trigger a re-bootstrap.
                DecryptErrorKind::Unrecoverable => Err(format!("UNRECOVERABLE:{}", group_id)),

                // SecretReuseError = this message's ratchet key was already consumed. Unlike a
                // FUTURE generation gap, it will NEVER decrypt: queueing it in SQLite would loop
                // forever. It is NOT necessarily a duplicate, and this used to answer Ok(None),
                // which said "nothing to show" and lost the distinction: a sender whose ratchet
                // rewound (WP-LOSS-1, WP-MULTITAB-1) encrypts a NEW message at a generation the
                // receiver already consumed, and it read here exactly like a second delivery of one
                // already displayed. The error is surfaced instead, so the shared frontend
                // classifier can compare the frame against the ones it has processed and, when it
                // has never seen this one, ask the sender to send it again. The frontend still
                // ACKs; only the diagnosis changes. Parity with the web WASM path, which reaches
                // the same classifier through its own thrown error.
                DecryptErrorKind::SecretReuse => {
                    log::debug!(
                        "[DUP] SecretReuseError group={} - already-consumed generation, handing the classification to the frontend",
                        group_id
                    );
                    Err(format!(
                        "SecretReuseError: already-consumed generation in group {}",
                        group_id
                    ))
                }

                // The generation is beyond what OpenMLS will derive forward: this device missed too
                // many of that sender's frames. Deliberately NOT queued in SQLite - it can never
                // decrypt, so a retry row is dead weight forever, exactly as for SecretReuse. The
                // error is surfaced verbatim so the shared frontend classifier recognises
                // `TooDistantInTheFuture` and escalates to a re-Welcome, which is the only thing
                // that resets the ratchets. It used to reach the frontend as a plain `GAP_QUEUED`,
                // which ran a commit replay that applied nothing, declared the gap healed, and ACKed
                // the message off the server (WP-PENDING-2).
                DecryptErrorKind::GenerationTooFarAhead => {
                    log::warn!(
                        "[GAP] Generation too far ahead for group={} - unrecoverable locally, escalating to the frontend",
                        group_id
                    );
                    Err(err_str)
                }

                // A frame this device itself encrypted, handed back by a replay of its own mailbox.
                // NOT queued, for the reason the two arms above are not: no retry can decrypt what
                // MLS forbids us to decrypt. Until this arm existed the string fell through to
                // `SenderRatchetGap` below, so every own frame cost a row in `pending_mls_messages`
                // and three drain attempts before the sweeper removed it. Surfaced verbatim so the
                // frontend classifier answers `own-message` and ACKs - nothing is lost, the sender's
                // optimistic render wrote this message already (WP-ECHO-1).
                DecryptErrorKind::OwnMessage => Err(err_str),

                // "Process error:" = OpenMLS error on the same epoch -> likely a Sender Ratchet gap
                // (future generation received) -> queued in SQLite for retry.
                DecryptErrorKind::SenderRatchetGap => {
                    log::warn!(
                        "[GAP] Sender Ratchet gap for group={} - message queued in SQLite",
                        group_id
                    );
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as i64;
                    let id = format!("{}-gen-{}", group_id, ts);
                    let insert_result = sqlx::query(
                        "INSERT OR IGNORE INTO pending_mls_messages \
                         (id, group_id, ciphertext, created_at, is_ready) VALUES (?, ?, ?, ?, 0)",
                    )
                    .bind(&id)
                    .bind(&group_id)
                    .bind(message_bytes.as_slice())
                    .bind(ts)
                    .execute(&*pending_db.0)
                    .await;
                    if let Err(db_e) = insert_result {
                        log::error!("[GAP] DB store failed: {}", db_e);
                        return Err(format!("GAP_DB_INSERT_FAILED:{}:{}", group_id, db_e));
                    }
                    // Embed the original OpenMLS error so the frontend can log it.
                    Err(format!("GAP_QUEUED:{}:{}", group_id, err_str))
                }

                // An application frame from an epoch whose secrets we no longer hold. Not queued in
                // SQLite, for the same reason as the two arms above: no retry can decrypt it, so a
                // row here is dead weight forever. Surfaced verbatim so the shared frontend
                // classifier reaches the same policy it applies to a consumed generation - a LOST
                // frame, and an id-addressed history diff, which is the only thing that recovers a
                // message a member still holds in its durable store.
                DecryptErrorKind::PastEpochApplication => {
                    log::warn!(
                        "[GAP] Past-epoch application frame for group={} - unreadable locally, escalating to the frontend",
                        group_id
                    );
                    Err(err_str)
                }

                // A FRAME FOR A GROUP THIS DEVICE HAS BEEN REMOVED FROM. Never queued: a row here
                // would be retried against a group whose Remove commit retired our leaf, which no
                // attempt can change. Surfaced verbatim so the shared frontend classifier reaches
                // the ONE policy that separates this from every other permanent kind above - ACK
                // and retire, and specifically NO recovery. The out-of-sync answer this used to
                // fall into asks to be re-added to a group we were deliberately removed from, and
                // the commit request behind it can only ever be refused.
                DecryptErrorKind::Evicted => {
                    log::warn!(
                        "[EVICT] Frame for group={} arrived after this device was evicted - handing the classification to the frontend, no repair is owed",
                        group_id
                    );
                    Err(err_str)
                }

                // REFUSED AT EXACTLY ITS OWN EPOCH. Never queued, for the reason the arms above
                // are not: a retry reads the same immutable epoch state and is refused again, so
                // the row is dead weight until the sweeper reaches it. Surfaced verbatim, and the
                // loop it closes is on the OTHER side of the boundary - on the web an
                // unacknowledged frame comes back on every single connection, for ever.
                DecryptErrorKind::SameEpochRefusal => {
                    log::warn!(
                        "[MLS] Same-epoch refusal for group={} - unreadable for good however often it is retried, escalating to the frontend",
                        group_id
                    );
                    Err(err_str)
                }

                DecryptErrorKind::Other => Err(err_str),
            }
        }
    }
}

/// Decrypts a page of MLS ciphertexts in one IPC crossing (ratchet order preserved).
#[tauri::command]
pub(crate) async fn recevoir_messages_batch(
    group_id: String,
    messages: Vec<Vec<u8>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BatchDecryptItem>, String> {
    let manager_state = state.mls_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut lock = manager_state
            .lock()
            .map_err(|_| "Failed to lock state".to_string())?;
        let manager = lock
            .as_mut()
            .ok_or_else(|| "MLS Manager not initialized".to_string())?;
        log::debug!(
            "recevoir_messages_batch group={} count={}",
            group_id,
            messages.len()
        );
        Ok::<Vec<BatchDecryptItem>, String>(decrypt_messages_batch(manager, &group_id, &messages))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn exporter_secret(
    group_id: String,
    label: String,
    context: Option<Vec<u8>>,
    key_len: usize,
    state: tauri::State<AppState>,
) -> Result<Vec<u8>, String> {
    let lock = state
        .mls_manager
        .lock()
        .map_err(|_| "Failed to lock state")?;
    let manager = lock.as_ref().ok_or("MLS Manager not initialized")?;

    manager
        .export_secret(
            &group_id,
            &label,
            context.as_deref().unwrap_or(&[]),
            key_len,
        )
        .map_err(|e| e.to_string())
}

/// Stores the new deviceKeyB64 straight into the keystore after a PIN change.
/// The derivation (PBKDF2-SHA256, see `$lib/crypto/deviceKey.ts`) already happened on the frontend.
///
/// Decodes the base64 into 32 bytes and stores them under the alias
/// `mls_device_key_{user_id}_{device_id}`. Best-effort: if the keystore is unavailable the error is
/// logged but the command still succeeds (the next PIN login re-derives the key automatically).
#[tauri::command]
pub(crate) async fn actualiser_cle_keystore_avec_devicekey(
    device_key_b64: String,
    user_id: String,
    device_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let alias = format!("mls_device_key_{user_id}_{device_id}");
    let keystore = PluginDeviceKeyStore::new(app);

    let key_bytes = mls_core::crypto::decode_base64_to_32_bytes(&device_key_b64)
        .map_err(|e| format!("invalid device_key_b64: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        keystore.store_device_key(&key_bytes, &alias).map_err(|e| {
            log::warn!("[DEVICEKEY_CHANGE] Failed to refresh keystore key: {e}");
            // Non-fatal: the next login will re-derive and store the key.
            e
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
