//! A DEVICE MUST RECOGNISE ITS OWN PUBLISHED PREKEYS, OR IT PURGES THEM AND MINTS FIFTY MORE.
//!
//! `reconcilePublishedKeyPackages` asks `key_package_has_private` about every prekey the server
//! holds for this device and purges the ones it cannot back. Measured on the Mi 9T on 2026-09-06,
//! in a run with ZERO `NoMatchingKeyPackage` and zero storms:
//!
//!     [MLS][Tauri] generateKeyPackage native batch path needed=49
//!     [MLS] reconcilePublishedKeyPackages: purged 49/50 orphaned prekey(s)
//!
//! The server held 1, the client published 49, and 49 were purged - so the packages it threw away
//! were the ones it had just minted. The pool therefore never fills, `needed` is ~49 on EVERY
//! connection, and each round writes ~50 bundles at 1 936 bytes into a state nothing prunes below
//! 84 days. `mls.bin` went from 19 548 753 to 20 812 360 bytes in one day and a checkpoint from
//! 17 s to 48 s.
//!
//! The round trip is where a mismatch could hide: a prekey is minted, serialised, sent to the
//! server, handed back, deserialised, VALIDATED, and only then is its `hash_ref` recomputed and
//! looked up. This pins that the identity survives all of it.
use mls_core::MlsManager;

#[test]
fn every_freshly_minted_prekey_is_recognised_through_a_publish_round_trip() {
    let m = MlsManager::load_or_create("alice", "kp-roundtrip", None).expect("device");

    // Exactly the batch the client mints when the pool reads as empty.
    let published = m.generate_key_packages(50).expect("50 prekeys");
    assert_eq!(published.len(), 50);

    // The bytes come back from the server as the same opaque blob that was published, so handing
    // them straight back is a faithful round trip - the server stores and returns, it does not
    // re-encode.
    let unrecognised: Vec<usize> = published
        .iter()
        .enumerate()
        .filter(|(_, kp)| !m.key_package_has_private(kp).unwrap_or(false))
        .map(|(i, _)| i)
        .collect();

    assert!(
        unrecognised.is_empty(),
        "{} of 50 freshly minted prekeys were not recognised as this device's own \
         (indices {:?}) - reconcilePublishedKeyPackages would purge them from the server \
         and the pool would never fill",
        unrecognised.len(),
        &unrecognised[..unrecognised.len().min(10)]
    );
}

#[test]
fn the_last_resort_fallback_is_recognised_too() {
    let m = MlsManager::load_or_create("alice", "kp-fallback", None).expect("device");
    let fallback = m.generate_last_resort_key_package().expect("a fallback");
    assert!(
        m.key_package_has_private(&fallback).expect("check"),
        "the static fallback must be recognised as this device's own - it carries the LastResort \
         extension the pool prekeys do not, which is exactly the kind of difference a hash over \
         the encoding would notice"
    );
}

/// The check must still say NO for a package this device never minted, or "recognised" would mean
/// nothing and the purge it drives would never fire when it should.
#[test]
fn another_devices_prekey_is_not_recognised() {
    let mine = MlsManager::load_or_create("alice", "kp-mine", None).expect("device");
    let theirs = MlsManager::load_or_create("bob", "kp-theirs", None).expect("device");
    let foreign = theirs.generate_key_package().expect("their prekey");
    assert!(
        !mine.key_package_has_private(&foreign).expect("check"),
        "a package minted by another device must not be claimed as ours"
    );
}
