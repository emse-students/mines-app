/// The server hands out the SAME KeyPackage to every peer once a device's one-time pool is empty.
///
/// `resolveKeyPackagePayloadForDevice` (chat-delivery-service) pops a `OneTimeKeyPackage` when one
/// exists and otherwise returns the device's static `KeyPackage` row - unchanged, to every caller,
/// for ever. That fallback is the whole point of the static row: a device with an exhausted pool
/// must still be addable, or a member can never be let back into a group.
///
/// MLS says the opposite about an ordinary KeyPackage. `into_group` deletes the private bundle the
/// moment a Welcome built on it is processed (openmls 0.8.1, `creation.rs:605`), UNLESS the package
/// carries the `last_resort` extension - which exists for exactly this server-side pattern. So an
/// ordinary static fallback is a contradiction: the server promises reuse, the crypto forbids it.
///
/// WHAT THAT COST, MEASURED ON THE Mi 9T ON 2026-09-06. A phone re-entering ten groups at once got
/// ten Welcomes built on the one fallback the server had. The first join consumed it; the other
/// nine failed with `NoMatchingKeyPackage [n_secrets=3..5]`, nineteen times over. The device then
/// re-asked for a Welcome, the responder re-kicked and re-added it on the same dead package, and
/// the loop had no exit until the next connection republished a fallback. The user's report - a
/// notification reading "Nouveau message de <name>" with nothing under it - is the same event seen
/// from the shade: the message could not be decrypted because the group could not be joined.
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

/// Two groups, one fallback KeyPackage, as the server serves it. Both joins must succeed.
#[test]
fn the_static_fallback_survives_being_served_to_more_than_one_group() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let mut carol = make_device("carol", "dev1");

    alice
        .create_group("g-fallback-a".to_string())
        .expect("alice creates her group");
    bob.create_group("g-fallback-b".to_string())
        .expect("bob creates his group");

    // ONE package, handed to both peers - the exact bytes the static `key_package` row holds.
    let fallback = carol
        .generate_last_resort_key_package()
        .expect("carol publishes her static fallback");

    let (_, welcome_a, _, _) = alice
        .add_members_bulk("g-fallback-a", &[&fallback])
        .expect("alice adds carol");
    alice
        .merge_pending_commit_for("g-fallback-a")
        .expect("alice confirms");
    let welcome_a = welcome_a.expect("alice's Welcome");
    let tree_a = alice
        .export_ratchet_tree_for("g-fallback-a")
        .expect("alice's tree");

    let (_, welcome_b, _, _) = bob
        .add_members_bulk("g-fallback-b", &[&fallback])
        .expect("bob adds carol on the same fallback");
    bob.merge_pending_commit_for("g-fallback-b")
        .expect("bob confirms");
    let welcome_b = welcome_b.expect("bob's Welcome");
    let tree_b = bob
        .export_ratchet_tree_for("g-fallback-b")
        .expect("bob's tree");

    assert_eq!(
        carol
            .process_welcome(&welcome_a, Some(&tree_a))
            .expect("first join"),
        "g-fallback-a"
    );

    // THE LINE THE DEVICE DIED ON. An ordinary KeyPackage's private bundle is gone by now and this
    // is `NoMatchingKeyPackage`; a last-resort one is kept, and the second group is reachable.
    let second = carol.process_welcome(&welcome_b, Some(&tree_b));
    assert_eq!(
        second.expect("the fallback must still open the SECOND group the server served it for"),
        "g-fallback-b"
    );
    assert!(
        carol
            .get_known_groups()
            .contains(&"g-fallback-a".to_string())
    );
    assert!(
        carol
            .get_known_groups()
            .contains(&"g-fallback-b".to_string())
    );
}

/// The pool keeps the opposite property, and it must: a one-time prekey is deleted server-side the
/// instant it is claimed, so keeping its private bundle after the join would grow the state without
/// bound. Marking the fallback must not have marked the pool.
#[test]
fn a_pool_prekey_is_still_single_use() {
    let mut alice = make_device("alice", "dev2");
    let mut bob = make_device("bob", "dev2");
    let mut carol = make_device("carol", "dev2");

    alice
        .create_group("g-pool-a".to_string())
        .expect("alice creates her group");
    bob.create_group("g-pool-b".to_string())
        .expect("bob creates his group");

    let prekey = carol.generate_key_package().expect("one pool prekey");

    let (_, welcome_a, _, _) = alice
        .add_members_bulk("g-pool-a", &[&prekey])
        .expect("alice adds carol");
    alice
        .merge_pending_commit_for("g-pool-a")
        .expect("alice confirms");
    let tree_a = alice
        .export_ratchet_tree_for("g-pool-a")
        .expect("alice's tree");

    let (_, welcome_b, _, _) = bob
        .add_members_bulk("g-pool-b", &[&prekey])
        .expect("bob adds carol");
    bob.merge_pending_commit_for("g-pool-b")
        .expect("bob confirms");
    let tree_b = bob.export_ratchet_tree_for("g-pool-b").expect("bob's tree");

    carol
        .process_welcome(&welcome_a.expect("alice's Welcome"), Some(&tree_a))
        .expect("the prekey opens the group it was claimed for");
    assert!(
        carol
            .process_welcome(&welcome_b.expect("bob's Welcome"), Some(&tree_b))
            .is_err(),
        "a pool prekey must NOT survive its one use - the server already deleted its row"
    );
}
