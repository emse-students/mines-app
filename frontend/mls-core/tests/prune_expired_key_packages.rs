//! THE LOCAL KEYSTORE MUST SHED KEY PACKAGES IT CAN NO LONGER USE, AND UNTIL 2026-09-06 IT NEVER DID.
//!
//! Minting a key package writes its private bundle to storage. The only reconciliation that existed
//! ran the other way - `reconcilePublishedKeyPackages` purges the SERVER of prekeys whose private
//! key is gone locally - so a bundle the server had stopped publishing was kept for the life of the
//! install. Two callers made that unbounded: a fresh last-resort package is published on EVERY
//! connection, and `republishKeyMaterial` purges the server pool and mints up to 50 more once per
//! 30 s during a `NoMatchingKeyPackage` storm.
//!
//! `tests/state_weight.rs` weighs it: 1 936 bytes a bundle, and 200 bundles are 60% of a state that
//! also holds 41 groups. The phone that ran the 2026-09 healing campaign reached a 19 548 753-byte
//! `mls.bin`, 17 s to checkpoint and 22 s to unlock.
//!
//! These are ASSERTIONS, unlike `state_weight.rs` next door, because they are about the RULE and not
//! about a number: what gets deleted, what is refused deletion, and that pruning is not a way to
//! lose a working device.
use mls_core::MlsManager;

const DAY: u64 = 60 * 60 * 24;

fn device(user: &str) -> MlsManager {
    MlsManager::load_or_create(user, "prune-test", None).expect("create the device")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs()
}

#[test]
fn a_freshly_minted_package_is_never_pruned() {
    let m = device("alice-fresh");
    m.generate_key_packages(20).expect("20 prekeys");
    m.generate_last_resort_key_package().expect("a fallback");

    // The wall clock is READ here rather than asserted on: the claim is "nothing minted a moment
    // ago is expired NOW", and any now the test could run at satisfies it.
    assert_eq!(
        m.prune_expired_key_packages().expect("prune"),
        0,
        "pruning must not touch a package that is still inside its lifetime"
    );
}

#[test]
fn every_package_goes_once_its_lifetime_has_elapsed() {
    let m = device("alice-expired");
    m.generate_key_packages(20).expect("20 prekeys");
    m.generate_last_resort_key_package().expect("a fallback");
    let before = m.save_state().expect("save").len();

    // openmls defaults a key package lifetime to 84 days. A hundred is past every one of them, and
    // is a statement about the RULE rather than about the machine: no clock is asserted, the
    // question is simply what the state looks like at a given instant.
    let pruned = m
        .prune_key_packages_expired_at(now() + 100 * DAY)
        .expect("prune");
    assert_eq!(pruned, 21, "all 20 prekeys and the fallback have elapsed");

    let after = m.save_state().expect("save").len();
    assert!(
        after < before,
        "a prune that frees nothing has not pruned: {before} -> {after}"
    );
    // THE POINT OF THE EXERCISE. Each bundle measured 1 936 bytes; 21 of them is about 40 kB, and a
    // prune that reclaimed only a header would satisfy the inequality above while fixing nothing.
    assert!(
        before - after > 30_000,
        "21 bundles are ~40 kB of state, only {} was reclaimed",
        before - after
    );
}

#[test]
fn the_boundary_is_not_after_and_the_prune_stops_there() {
    let m = device("alice-boundary");
    m.generate_key_packages(5).expect("5 prekeys");

    // One second before the earliest expiry nothing is dead yet. 84 days minus an hour is inside
    // every package's lifetime whatever moment the test started at.
    assert_eq!(
        m.prune_key_packages_expired_at(now() + 83 * DAY)
            .expect("prune"),
        0,
        "a package one day short of its expiry is still usable"
    );
    assert_eq!(
        m.prune_key_packages_expired_at(now() + 85 * DAY)
            .expect("prune"),
        5,
        "a day past the 84-day default they are all dead"
    );
}

#[test]
fn a_pruned_device_still_works_and_the_prune_is_idempotent() {
    let mut m = device("alice-survives");
    m.generate_key_packages(10).expect("10 prekeys");
    m.create_group("after-the-prune".to_string())
        .expect("a group made BEFORE the prune");

    let pruned = m
        .prune_key_packages_expired_at(now() + 100 * DAY)
        .expect("prune");
    assert_eq!(pruned, 10, "the prekeys go");

    // THE GROUP MUST SURVIVE. A scan that matched on the wrong prefix would take `Tree`,
    // `GroupContext` and `EpochSecrets` with it and leave a device that still saves and loads while
    // having silently lost every conversation - the worst available outcome, and invisible to a
    // test that only counted what it deleted.
    assert!(
        m.get_known_groups()
            .contains(&"after-the-prune".to_string()),
        "pruning key packages must not touch group state"
    );
    m.send_message("after-the-prune", b"still ratcheting")
        .expect("the group is still usable after its device was pruned");

    // Running twice must be a no-op, not a second deletion: this is called at load, so a prune with
    // a memory of its own would be a prune that eventually deletes something else.
    assert_eq!(
        m.prune_key_packages_expired_at(now() + 100 * DAY)
            .expect("second prune"),
        0,
        "nothing is left to prune, and the second run must say so"
    );

    // And a device with no key packages can still mint one - the prune removed material, not the
    // ability to make more.
    m.generate_key_package().expect("mint after a full prune");
    assert_eq!(
        m.prune_key_packages_expired_at(now() + 100 * DAY)
            .expect("third prune"),
        1,
        "the freshly minted package is the only thing left to find"
    );
}
