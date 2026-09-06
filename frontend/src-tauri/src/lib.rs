//! Canari Tauri backend: MLS cryptography, push notifications, and system integration.

mod commands;
mod concurrency;
mod keystore_bridge;
mod state;

// `test` is in the gate so the shared background logic - the outbox batch drain in particular -
// is exercised by a host `cargo test` rather than only by a device build. Nothing in it is
// platform-specific; the gate exists to keep it out of the desktop binary.
#[cfg(any(target_os = "android", target_os = "ios", test))]
mod mobile;

use std::sync::{Arc, Mutex};

use tauri::Manager;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    WindowEvent,
};

use crate::state::{AppState, HttpClient, PendingDb};

// Re-export commands for generate_handler!
use crate::commands::bootstrap::bootstrap_dead_conversation;
use crate::commands::cookies::flush_webview_cookies;
use crate::commands::mls::{
    actualiser_cle_keystore_avec_devicekey, ajouter_membres_bulk, annuler_commit, confirmer_commit,
    creer_groupe, envoyer_message, envoyer_message_bytes, exporter_group_info,
    exporter_ratchet_tree, exporter_secret, generer_key_packages_et_persister, groupe_actif,
    initialiser_mls, key_package_a_clef_privee, lister_groupes, lister_identites_membres,
    obtenir_epoch, oublier_groupe, recevoir_message, recevoir_message_bytes,
    recevoir_messages_batch, recuperer_cle_session_mls, rejoindre_par_commit_externe,
    retirer_membres, retirer_membres_par_appareil, sauvegarder_mls, sauvegarder_mls_et_persister,
    skip_send_generations, supprimer_groupe, trailer_welcome,
};
use crate::commands::push::{
    check_push_secret_health, forget_graine_channel, forget_graine_sessions, get_fcm_token,
    get_push_diagnostic, get_voip_token, load_push_context, read_and_clear_fcm_cache,
    read_and_clear_outbox_sent, read_and_clear_pending_call_accept, read_and_clear_read_watermarks,
    read_outbox_mirror, set_push_context_locale, store_graine_seed, store_outbox_mirror,
    store_push_context, store_push_secret,
};
use crate::commands::storage::{
    clear_app_data, delete_mls_state, get_installer_package, get_local_storage_usage,
    get_native_flags, load_mls_state, mls_foreground_heartbeat, pause_mls_foreground,
    recharger_mls_au_resume, remove_native_flag, save_mls_state, set_native_flag,
};

// ─── JNI functions (Android background push) ──────────────────────────────
// Kept in lib.rs because they use `extern "system"` / `no_mangle` and reference
// `mobile::background` / `mobile::proto_fields` which are conditionally compiled.
// PIN-based JNI variants removed: all decrypt paths now use key-based variants.

#[cfg(target_os = "android")]
static ANDROID_JAVA_VM: std::sync::OnceLock<jni::JavaVM> = std::sync::OnceLock::new();

/// Caches the `JavaVM` when the native library is loaded.
///
/// Every other JNI symbol in this file is called FROM Kotlin, so the JVM hands it a `JNIEnv`.
/// `flush_webview_cookies` is the opposite direction - Rust calling into the framework at a moment
/// Kotlin knows nothing about - and that needs a `JavaVM` to attach the calling thread to.
/// `JNI_OnLoad` is the only hook guaranteed to run before any of our Rust code can, because it is
/// what `System.loadLibrary("mines_app_lib")` invokes (CanariApplication and generated/Rust.kt).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn JNI_OnLoad(
    vm: *mut jni::sys::JavaVM,
    _reserved: *mut std::ffi::c_void,
) -> jni::sys::jint {
    match unsafe { jni::JavaVM::from_raw(vm) } {
        Ok(vm) => {
            let _ = ANDROID_JAVA_VM.set(vm);
        }
        Err(e) => log::error!("[JNI] JNI_OnLoad: JavaVM::from_raw failed: {e}"),
    }
    jni::sys::JNI_VERSION_1_6
}

/// The cached `JavaVM`, or `None` if `JNI_OnLoad` never ran (which would mean the library was not
/// loaded through `System.loadLibrary` - a case that must be visible, never silently absorbed).
#[cfg(target_os = "android")]
pub(crate) fn android_java_vm() -> Option<&'static jni::JavaVM> {
    ANDROID_JAVA_VM.get()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptGraineMessage<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    seed_b64: jni::objects::JString<'a>,
    session_id: jni::objects::JString<'a>,
    message_index: jni::sys::jint,
    nonce_b64: jni::objects::JString<'a>,
    ciphertext_b64: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let result = (|| -> serde_json::Value {
        let decode = |s: jni::objects::JString<'a>, env: &mut jni::JNIEnv<'a>| -> Option<Vec<u8>> {
            let raw: String = env.get_string(&s).ok()?.into();
            STANDARD.decode(raw.trim()).ok()
        };
        // A negative index cannot exist: it is a uint32 on the wire and in the derivation. Refusing
        // it here keeps the cast from wrapping into an index that derives a plausible wrong key.
        if message_index < 0 {
            log::error!("[GraineBG] negative message index {message_index}");
            return serde_json::json!({ "ok": false });
        }
        let session: String = match env.get_string(&session_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let seed = match decode(seed_b64, &mut env) {
            Some(v) => v,
            None => return serde_json::json!({ "ok": false }),
        };
        let nonce = match decode(nonce_b64, &mut env) {
            Some(v) => v,
            None => return serde_json::json!({ "ok": false }),
        };
        let ciphertext = match decode(ciphertext_b64, &mut env) {
            Some(v) => v,
            None => return serde_json::json!({ "ok": false }),
        };
        mobile::background::decrypt_graine_message(
            &seed,
            &session,
            message_index as u32,
            &nonce,
            &ciphertext,
        )
        .unwrap_or_else(|| serde_json::json!({ "ok": false }))
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

// ─── Key-based JNI variants (biometric mode, no PIN) ────────────────────

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessageWithKey<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> serde_json::Value {
        let state_vec = match env.convert_byte_array(&state_bytes) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let key_b64_str: String = match env.get_string(&key_b64) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let user_id_str: String = match env.get_string(&user_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let device_id_str: String = match env.get_string(&device_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let group_id_str: String = match env.get_string(&group_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let cipher_vec = match env.convert_byte_array(&ciphertext) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };

        mobile::background::decrypt_push_message_with_key(
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
            &cipher_vec,
        )
        .unwrap_or_else(|| serde_json::json!({ "ok": false }))
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeGroupEpochWithKey<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
) -> jni::sys::jlong {
    let epoch = (|| -> Option<u64> {
        let state_vec = env.convert_byte_array(&state_bytes).ok()?;
        let key_b64_str: String = env.get_string(&key_b64).ok()?.into();
        let user_id_str: String = env.get_string(&user_id).ok()?.into();
        let device_id_str: String = env.get_string(&device_id).ok()?.into();
        let group_id_str: String = env.get_string(&group_id).ok()?.into();
        mobile::background::background_group_epoch_with_key(
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
        )
    })();
    epoch.map(|e| e as jni::sys::jlong).unwrap_or(-1)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMessageWithCommitsWithKey<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    commits_json: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> serde_json::Value {
        let state_vec = match env.convert_byte_array(&state_bytes) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let key_b64_str: String = match env.get_string(&key_b64) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let user_id_str: String = match env.get_string(&user_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let device_id_str: String = match env.get_string(&device_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let group_id_str: String = match env.get_string(&group_id) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let commits_json_str: String = match env.get_string(&commits_json) {
            Ok(s) => s.into(),
            Err(_) => return serde_json::json!({ "ok": false }),
        };
        let cipher_vec = match env.convert_byte_array(&ciphertext) {
            Ok(v) => v,
            Err(_) => return serde_json::json!({ "ok": false }),
        };

        let commits = mobile::background::decode_commits_b64_json(&commits_json_str);
        mobile::background::decrypt_push_message_with_commits_with_key(
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
            &commits,
            &cipher_vec,
        )
        .unwrap_or_else(|| serde_json::json!({ "ok": false }))
    })();

    let json_str = result.to_string();
    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeDecryptMedia<'a>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    key_b64: jni::objects::JString<'a>,
    iv_b64: jni::objects::JString<'a>,
    ciphertext: jni::objects::JByteArray<'a>,
) -> jni::objects::JByteArray<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let plaintext: Option<Vec<u8>> = (|| {
        let key: String = env.get_string(&key_b64).ok()?.into();
        let iv: String = env.get_string(&iv_b64).ok()?.into();
        let key = STANDARD.decode(key.trim()).ok()?;
        let iv = STANDARD.decode(iv.trim()).ok()?;
        let cipher_vec = env.convert_byte_array(&ciphertext).ok()?;
        mobile::background::decrypt_media_blob(&key, &iv, &cipher_vec)
    })();

    let bytes = plaintext.unwrap_or_default();
    match env.byte_array_from_slice(&bytes) {
        Ok(arr) => arr,
        Err(_) => unsafe { jni::objects::JByteArray::from_raw(std::ptr::null_mut()) },
    }
}

// ─── JNI: Background Worker & Welcome/Send ────────────────────────────────

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_MlsBackgroundWorker_nativeProcessBackgroundTasks(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    files_dir: jni::objects::JString,
    _state_bytes: jni::objects::JByteArray,
    _device_key_b64: jni::objects::JString,
    _user_id: jni::objects::JString,
    _device_id: jni::objects::JString,
) -> jni::sys::jboolean {
    let files_dir_str: String = match env.get_string(&files_dir) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    match mobile::background::cleanup_pending_db(std::path::Path::new(&files_dir_str)) {
        Ok(()) => {
            log::info!("Background Worker completed successfully");
            1
        }
        Err(e) => {
            log::error!("Background Worker failed: {e}");
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeCreateWelcomeBackground<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    group_id: jni::objects::JString<'a>,
    key_package_b64: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key_b64_str: String = env.get_string(&key_b64).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let group_id_str: String = env.get_string(&group_id).map_err(|e| e.to_string())?.into();
        let kp_b64: String = env
            .get_string(&key_package_b64)
            .map_err(|e| e.to_string())?
            .into();

        mobile::background::create_welcome_background_with_key(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &group_id_str,
            &kp_b64,
        )
    })();

    let json_str = match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            log::error!("[BG_WELCOME] nativeCreateWelcomeBackground failed: {e}");
            format!("{{\"ok\":false,\"error\":{:?}}}", e)
        }
    };

    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeProcessWelcomeBackground(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    files_dir: jni::objects::JString,
    state_bytes: jni::objects::JByteArray,
    key_b64: jni::objects::JString,
    user_id: jni::objects::JString,
    device_id: jni::objects::JString,
    welcome_b64: jni::objects::JString,
    ratchet_tree_b64: jni::objects::JString,
) -> jni::sys::jboolean {
    let result = (|| -> Result<(), String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key_b64_str: String = env.get_string(&key_b64).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let welcome_b64_str: String = env
            .get_string(&welcome_b64)
            .map_err(|e| e.to_string())?
            .into();
        let rt_b64_str: String = env
            .get_string(&ratchet_tree_b64)
            .map_err(|e| e.to_string())?
            .into();

        mobile::background::process_welcome_background_with_key(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &welcome_b64_str,
            &rt_b64_str,
        )
    })();

    match result {
        Ok(()) => 1,
        Err(e) => {
            log::error!("[BG_JOIN] nativeProcessWelcomeBackground failed: {e}");
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeBuildTextMessageProto<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    message_id: jni::objects::JString<'a>,
    sent_at: jni::sys::jlong,
    content: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let result = (|| -> Result<String, String> {
        let message_id_str: String = env
            .get_string(&message_id)
            .map_err(|e| e.to_string())?
            .into();
        let content_str: String = env.get_string(&content).map_err(|e| e.to_string())?.into();
        let bytes =
            mobile::proto_fields::build_text_app_message(&message_id_str, sent_at, &content_str);
        Ok(STANDARD.encode(&bytes))
    })();

    let out = result.unwrap_or_else(|e| {
        log::error!("[QUICK_REPLY] nativeBuildTextMessageProto failed: {e}");
        String::new()
    });
    env.new_string(&out)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

/// Builds the `read_watermark` control proto for the "mark as read" and quick-reply notification
/// actions. `at` is the sender's `sent_at` for the message the notification is about, carried down
/// from the push - never this device's clock, for the reason
/// [`mobile::proto_fields::build_read_watermark_app_message`] states.
///
/// Infallible by construction (no string to decode, no JSON to parse), so unlike its neighbours it
/// has no error branch to log: an empty return would mean the JVM could not allocate a string.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeBuildReadWatermarkProto<
    'a,
>(
    env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    at: jni::sys::jlong,
) -> jni::objects::JString<'a> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let bytes = mobile::proto_fields::build_read_watermark_app_message(at);
    let out = STANDARD.encode(&bytes);
    env.new_string(&out)
        .unwrap_or_else(|_| env.new_string("").unwrap())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_fr_emse_canari_CanariFirebaseMessagingService_nativeSendMessagesBackground<
    'a,
>(
    mut env: jni::JNIEnv<'a>,
    _service: jni::objects::JObject<'a>,
    files_dir: jni::objects::JString<'a>,
    state_bytes: jni::objects::JByteArray<'a>,
    key_b64: jni::objects::JString<'a>,
    user_id: jni::objects::JString<'a>,
    device_id: jni::objects::JString<'a>,
    entries_json: jni::objects::JString<'a>,
) -> jni::objects::JString<'a> {
    let result = (|| -> Result<serde_json::Value, String> {
        let files_dir_str: String = env
            .get_string(&files_dir)
            .map_err(|e| e.to_string())?
            .into();
        let state_vec = env
            .convert_byte_array(&state_bytes)
            .map_err(|e| e.to_string())?;
        let key_b64_str: String = env.get_string(&key_b64).map_err(|e| e.to_string())?.into();
        let user_id_str: String = env.get_string(&user_id).map_err(|e| e.to_string())?.into();
        let device_id_str: String = env
            .get_string(&device_id)
            .map_err(|e| e.to_string())?
            .into();
        let entries_str: String = env
            .get_string(&entries_json)
            .map_err(|e| e.to_string())?
            .into();
        let entries = mobile::background::parse_outbox_entries_json(&entries_str)?;

        mobile::background::send_messages_background_with_key(
            std::path::Path::new(&files_dir_str),
            &state_vec,
            &key_b64_str,
            &user_id_str,
            &device_id_str,
            &entries,
        )
    })();

    let json_str = match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            log::error!("[BG_SEND] nativeSendMessagesBackground failed: {e}");
            format!("{{\"ok\":false,\"error\":{:?}}}", e)
        }
    };

    env.new_string(&json_str)
        .unwrap_or_else(|_| env.new_string("{\"ok\":false}").unwrap())
}

// ─── run() ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            log::error!("PANIC: {info}");
            prev(info);
        }));
    }

    #[cfg(all(desktop, not(dev)))]
    let port: u16 = 1421;

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Publishes the COMPILE-TIME target OS to the WebView (window.__TAURI_OS_PLUGIN_INTERNALS__).
        // The frontend used to read the platform out of navigator.userAgent, which an iPad WKWebView
        // does not answer honestly: desktop-class browsing reports "Macintosh", so an iPad fell
        // through every iOS branch - including the OIDC redirect URI, which App Review rejected.
        .plugin(tauri_plugin_os::init());

    #[cfg(all(desktop, not(dev)))]
    let builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_keystore::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_customtabs::init());

    builder
        .manage(AppState {
            mls_manager: Arc::new(Mutex::new(None)),
            device_key: Arc::new(Mutex::new(None)),
        })
        .manage(HttpClient(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("Failed to build reqwest client"),
        ))
        .setup(move |app| {
            let data_dir = app.path().app_data_dir().map_err(|e| format!("{e}"))?;
            log::info!("[Path] app_data_dir = {}", data_dir.display());
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("mls_pending.db");
            let pending_pool = tauri::async_runtime::block_on(async {
                sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(4)
                    .connect_with(
                        sqlx::sqlite::SqliteConnectOptions::new()
                            .filename(&db_path)
                            .create_if_missing(true)
                            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                            .busy_timeout(std::time::Duration::from_secs(5)),
                    )
                    .await
                    .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB init: {e}"))?;

            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS pending_mls_messages (\
                        id         TEXT    PRIMARY KEY,\
                        group_id   TEXT    NOT NULL,\
                        ciphertext BLOB    NOT NULL,\
                        created_at INTEGER NOT NULL,\
                        is_ready   INTEGER NOT NULL DEFAULT 0\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB schema: {e}"))?;

            tauri::async_runtime::block_on(async {
                let _ = sqlx::query(
                    "ALTER TABLE pending_mls_messages \
                     ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&pending_pool)
                .await;
                Ok::<(), String>(())
            })
            .map_err(|e: String| format!("pending DB migration: {e}"))?;

            tauri::async_runtime::block_on(async {
                let _ = sqlx::query(
                    "ALTER TABLE pending_mls_messages \
                     ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&pending_pool)
                .await;
                Ok::<(), String>(())
            })
            .map_err(|e: String| format!("pending DB migration attempt_count: {e}"))?;

            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS mls_state_checkpoint (\
                        id       INTEGER PRIMARY KEY CHECK (id = 1),\
                        state    BLOB    NOT NULL,\
                        saved_at INTEGER NOT NULL\
                    )",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB checkpoint schema: {e}"))?;

            tauri::async_runtime::block_on(async {
                sqlx::query(
                    "CREATE INDEX IF NOT EXISTS idx_pmm_group \
                     ON pending_mls_messages(group_id, created_at)",
                )
                .execute(&pending_pool)
                .await
                .map_err(|e| e.to_string())
            })
            .map_err(|e| format!("pending DB index: {e}"))?;

            app.manage(PendingDb(Arc::new(pending_pool)));

            #[cfg(desktop)]
            {
                #[cfg(dev)]
                let url = tauri::WebviewUrl::App(std::path::PathBuf::from("/"));

                #[cfg(not(dev))]
                let url = {
                    let localhost_url: tauri::Url =
                        format!("http://localhost:{}", port).parse().unwrap();
                    app.add_capability(
                        tauri::ipc::CapabilityBuilder::new("localhost-cap")
                            .permission("core:default")
                            .permission("core:window:allow-show")
                            .permission("core:window:allow-hide")
                            .permission("core:window:allow-set-focus")
                            .permission("core:window:allow-unminimize")
                            .permission("core:window:allow-is-visible")
                            .permission("core:window:allow-close")
                            .permission("core:window:allow-destroy")
                            .permission("core:tray:default")
                            .permission("opener:default")
                            .permission("notification:default")
                            .permission("sql:default")
                            .permission("sql:allow-execute")
                            .remote(localhost_url.to_string())
                            .window("main"),
                    )?;
                    tauri::WebviewUrl::External(localhost_url)
                };

                let mut window_config = app.config().app.windows[0].clone();
                window_config.url = url;

                tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?.build()?;
            }

            #[cfg(mobile)]
            tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App(std::path::PathBuf::from("/")),
            )
            .build()?;

            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }

            #[cfg(mobile)]
            let _ = app;

            #[cfg(desktop)]
            {
                let show_item = MenuItemBuilder::with_id("show", "Afficher Canari").build(app)?;
                let quit_item = MenuItemBuilder::with_id("quit", "Quitter").build(app)?;
                let menu = MenuBuilder::new(app)
                    .item(&show_item)
                    .separator()
                    .item(&quit_item)
                    .build()?;

                let icon = Image::from_path("icons/icon.png")
                    .or_else(|_| Image::from_path("icons/32x32.png"))
                    .unwrap_or_else(|_| {
                        app.default_window_icon().cloned().expect("no default icon")
                    });

                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Canari")
                    .on_menu_event(|app_handle, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                            if button == tauri::tray::MouseButton::Left {
                                let app_handle = tray.app_handle();
                                if let Some(win) = app_handle.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.unminimize();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(mobile)]
            let _ = (window, event);
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            initialiser_mls,
            recuperer_cle_session_mls,
            sauvegarder_mls,
            sauvegarder_mls_et_persister,
            creer_groupe,
            lister_groupes,
            oublier_groupe,
            supprimer_groupe,
            obtenir_epoch,
            groupe_actif,
            generer_key_packages_et_persister,
            key_package_a_clef_privee,
            ajouter_membres_bulk,
            lister_identites_membres,
            retirer_membres,
            retirer_membres_par_appareil,
            confirmer_commit,
            annuler_commit,
            exporter_ratchet_tree,
            exporter_group_info,
            rejoindre_par_commit_externe,
            trailer_welcome,
            envoyer_message,
            envoyer_message_bytes,
            skip_send_generations,
            recevoir_message,
            recevoir_message_bytes,
            recevoir_messages_batch,
            exporter_secret,
            get_fcm_token,
            get_push_diagnostic,
            check_push_secret_health,
            store_push_context,
            set_push_context_locale,
            load_push_context,
            save_mls_state,
            recharger_mls_au_resume,
            mls_foreground_heartbeat,
            pause_mls_foreground,
            delete_mls_state,
            load_mls_state,
            store_push_secret,
            clear_app_data,
            remove_native_flag,
            bootstrap_dead_conversation,
            set_native_flag,
            get_native_flags,
            get_installer_package,
            get_local_storage_usage,
            read_and_clear_fcm_cache,
            read_and_clear_read_watermarks,
            store_outbox_mirror,
            read_outbox_mirror,
            read_and_clear_outbox_sent,
            read_and_clear_pending_call_accept,
            get_voip_token,
            store_graine_seed,
            forget_graine_channel,
            forget_graine_sessions,
            actualiser_cle_keystore_avec_devicekey,
            flush_webview_cookies
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            #[cfg(target_os = "android")]
            log::error!("Tauri failed to start: {e:?}");
            panic!("error while running tauri application: {e:?}");
        });
}
