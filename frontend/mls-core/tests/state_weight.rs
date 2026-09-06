/// WHAT MAKES `mls.bin` 19.5 MB, ANSWERED BY WEIGHING THE PARTS RATHER THAN BY GUESSING AT THEM.
///
/// Measured on a Mi 9T on 2026-09-06: `stat mls.bin` = 19 548 753 bytes, `save_state` reporting a
/// 19.4 MB CBOR snapshot, and three encrypted checkpoints at 17.1 s, 17.1 s and 19.7 s. Two P1s in
/// `docs/wiki/backlog.md` bottom out here - a PIN unlock that takes 22 s because the state must be
/// decrypted first, and a twenty-second window between a send and its checkpoint in which any death
/// of the process restores a state behind frames that have already left.
///
/// Both entries say the same thing about what comes next: **the blob's composition is a
/// HYPOTHESIS until it is weighed, and no prune may be written before it is.** One candidate has a
/// mechanism already visible in the code - `generate_key_packages` writes every bundle to the
/// provider's storage and nothing deletes them locally, while `deleteAllOneTimePrekeys` only clears
/// the SERVER's pool and the client then mints fifty more on the next fresh start. That is a story,
/// not a measurement. This file turns it into one.
///
/// EVERY FIGURE IN THIS FILE IS A FLOOR, AND 2026-09-06 IS WHY THAT WARNING IS NOW FIRST. A fresh
/// group of one weighs 5 330 bytes here and epochs plateau at 17 kB; a real group on a phone that
/// had lived through the campaign weighed ~490 kB, carried in `Tree` (member leaves) and
/// `MessageSecrets` (per-sender ratchet history) - neither of which a synthetic group accumulates.
/// Reasoning from these numbers to a real device's blob produced two wrong mechanisms in one
/// evening. Use `MlsManager::state_composition`, which reads the device, for anything about a real
/// state; use this only for what one ACTION costs.
///
/// IGNORED, BECAUSE IT IS A MEASUREMENT AND NOT AN ASSERTION. It prints a table and takes tens of
/// seconds; a number is not a pass or a fail, and pinning today's bytes would only manufacture a
/// failing test the first time a legitimate field is added.
///
///   cargo test --release --test state_weight -- --ignored --nocapture
use mls_core::MlsManager;

/// The composition, read from the PRODUCT rather than recomputed here.
///
/// This file used to carry its own copy of the label list and its own scan. That is exactly the
/// duplication that lets a measurement and the thing it measures drift apart, and the labels are a
/// fact about `openmls_memory_storage` rather than about this test - so `MlsManager` owns them and
/// this asks. `state_composition` is also what the load-time log line prints, so what a reader sees
/// on a phone and what this table prints can never disagree.
/// Prints the breakdown, widest first, with each label's share of the whole.
fn print_composition(title: &str, m: &MlsManager) {
    let rows = m.state_composition().expect("composition");
    let total: usize = rows.iter().map(|r| r.bytes).sum();
    println!();
    println!("{title}");
    println!("{}", "-".repeat(96));
    println!(
        "{:<26} {:>8} {:>14} {:>12} {:>8}",
        "label", "entries", "bytes", "each", "share"
    );
    for r in &rows {
        println!(
            "{:<26} {:>8} {:>14} {:>12} {:>7.1}%",
            r.label,
            r.entries,
            r.bytes,
            r.bytes / r.entries.max(1),
            100.0 * r.bytes as f64 / total.max(1) as f64
        );
    }
    println!("{:<26} {:>8} {:>14}", "TOTAL (entries only)", "", total);
}

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

fn weigh(m: &MlsManager) -> usize {
    m.save_state().expect("save_state").len()
}

/// Prints one line per addition so the SHAPE of the growth is visible, not just its total: a cost
/// that is flat per item and one that compounds want different fixes, and a single before/after
/// pair cannot tell them apart.
fn report(label: &str, before: usize, after: usize, count: usize) {
    let delta = after.saturating_sub(before);
    println!(
        "{label:<38} {before:>10} -> {after:>10}  (+{delta:>9} for {count:>4}, {:>7} each)",
        delta.checked_div(count).unwrap_or(0)
    );
}

#[test]
#[ignore = "measurement, not an assertion: run explicitly with --release --nocapture"]
fn what_a_state_weighs_per_key_package_and_per_group() {
    println!();
    println!("bytes of `save_state()` output - the CBOR that gets sealed into mls.bin");
    println!("{}", "-".repeat(96));

    // ── A device that has done nothing at all ───────────────────────────────────────────────────
    let mut alice = make_device("alice", "weigh-1");
    let empty = weigh(&alice);
    println!(
        "{:<38} {:>10}",
        "a fresh device, no groups, no packages", empty
    );

    // ── One-time prekeys, in the batch size the client actually mints ───────────────────────────
    //
    // `TauriMlsService.generateKeyPackageImpl` tops the SERVER pool up to 50 on every connection,
    // and on a fresh start purges the server first - so a client that restarts often mints 50 more
    // each time while every bundle it has ever generated stays in the local keystore. Fifty is
    // therefore the unit this cost arrives in.
    let mut before = empty;
    for round in 1..=4 {
        alice.generate_key_packages(50).expect("50 prekeys");
        let after = weigh(&alice);
        report(
            &format!("+50 one-time prekeys (round {round})"),
            before,
            after,
            50,
        );
        before = after;
    }

    // ── Groups, which is the other candidate ────────────────────────────────────────────────────
    //
    // A group this device CREATES is the cheapest possible group - one member, no history, no
    // ratchet depth - so this is a floor for the per-group cost and not an estimate of a real one.
    let mut before = weigh(&alice);
    for round in 1..=4 {
        for i in 0..10 {
            alice
                .create_group(format!("weigh-g-{round}-{i}"))
                .expect("create_group");
        }
        let after = weigh(&alice);
        report(
            &format!("+10 groups, one member each (round {round})"),
            before,
            after,
            10,
        );
        before = after;
    }

    println!("{}", "-".repeat(96));
    println!(
        "subtotal: {} bytes across {} group(s) and 200 prekeys",
        weigh(&alice),
        alice.get_known_groups().len()
    );

    // ── A group with MEMBERS in it, which the ones above are not ────────────────────────────────
    //
    // The rounds above create a group of one: no other leaves, no ratchet depth, so their 5.3 kB is
    // a FLOOR and nothing more. A real conversation carries a tree. This adds members one batch at
    // a time to the same group so the per-member cost is read off the slope rather than off a
    // single pair of numbers.
    println!();
    println!("a group that has members in it - the rounds above were groups of ONE");
    println!("{}", "-".repeat(96));
    alice
        .create_group("weigh-crowded".to_string())
        .expect("create the crowded group");
    let mut before = weigh(&alice);
    for round in 1..=4 {
        // A DEVICE EACH, not five packages from one. Five key packages from the same device are
        // five ways to add the same leaf, and the second round is refused `AlreadyMember` - which
        // would have measured a tree of one and reported it as a tree of twenty.
        let kps: Vec<Vec<u8>> = (0..5)
            .map(|i| {
                make_device(&format!("member-{round}-{i}"), "weigh-m")
                    .generate_key_package()
                    .expect("kp")
            })
            .collect();
        let refs: Vec<&[u8]> = kps.iter().map(|k| k.as_slice()).collect();
        alice
            .add_members_bulk("weigh-crowded", &refs)
            .expect("add 5 members");
        alice
            .merge_pending_commit_for("weigh-crowded")
            .expect("confirm the add");
        let after = weigh(&alice);
        report(
            &format!("+5 members in one group (round {round})"),
            before,
            after,
            5,
        );
        before = after;
    }

    // ── Sending, which advances the ratchet without adding anybody ──────────────────────────────
    //
    // The other thing a long-lived conversation accumulates. If this is flat, message history is
    // NOT what makes the blob heavy and the answer is elsewhere; if it compounds, a device that has
    // simply been used for months explains itself.
    println!();
    println!("sending into that group - ratchet depth with no new members");
    println!("{}", "-".repeat(96));
    let mut before = weigh(&alice);
    for round in 1..=4 {
        for i in 0..50 {
            alice
                .send_message("weigh-crowded", format!("message {round}-{i}").as_bytes())
                .expect("send");
        }
        let after = weigh(&alice);
        report(&format!("+50 sends (round {round})"), before, after, 50);
        before = after;
    }

    println!("{}", "-".repeat(96));
    println!("final: {} bytes", weigh(&alice));

    // ── WHAT IS ACTUALLY IN THERE ───────────────────────────────────────────────────────────────
    //
    // The slopes above say what each ACTION costs. This says where the bytes ENDED UP, which is the
    // question a prune is written against - an action can be cheap per unit and still dominate, and
    // no per-round delta can show that.
    print_composition("composition of the final state, by storage label", &alice);
    println!();
    println!("The phone's mls.bin was 19 548 753 bytes. Whichever line above has a cost that");
    println!("multiplies out to that is the one a prune has to be written against.");
    println!();
}

/// WHAT ONE KEY PACKAGE COSTS ACROSS EVERY LABEL IT TOUCHES, AND WHAT SURVIVES ITS USE.
///
/// A `KeyPackageBundle` is not one entry. Generating one writes the bundle under `KeyPackage` AND
/// the private halves of its init and encryption keys under their own labels, so a prune that only
/// counted `KeyPackage` rows would under-read the cost and, worse, could delete the cheap third of
/// it and leave the rest. This isolates a device that does nothing else, so the delta is entirely
/// attributable.
#[test]
#[ignore = "measurement, not an assertion: run explicitly with --release --nocapture"]
fn what_one_key_package_costs_across_every_label_it_touches() {
    let bob = make_device("bob", "weigh-kp");
    print_composition("a device that has only just been created", &bob);
    let empty = weigh(&bob);

    bob.generate_key_packages(100).expect("100 prekeys");
    print_composition("the same device after minting 100 one-time prekeys", &bob);
    let full = weigh(&bob);

    println!();
    println!(
        "100 prekeys cost {} bytes of state, {} each",
        full - empty,
        (full - empty) / 100
    );
    println!();
    println!(
        "`TauriMlsService.generateKeyPackageImpl` tops the pool up to 50 on EVERY connection and"
    );
    println!(
        "nothing deletes a local bundle that is never claimed. Divide 19 548 753 by the figure"
    );
    println!("above to get the number of bundles that would explain the phone's blob.");
    println!();
}

/// WHAT AN EPOCH COSTS, WHICH IS THE FIGURE THE 2026-09-06 BLOG ANALYSIS GOT WRONG.
///
/// `what_a_state_weighs_per_key_package_and_per_group` measures a group of ONE with no history and
/// reports ~5.3 kB. That number was labelled a FLOOR in its own comment and then reasoned from as
/// if it were representative, which produced a backlog entry attributing a 20 MB `mls.bin` mostly
/// to key packages.
///
/// The field refuted it. Sweeping 42 abandoned throwaway groups off a Mi 9T took `mls.bin` from
/// 20 812 360 to 8 018 495 bytes - **12.8 MB, 61%, freed by deleting groups** - and left five
/// groups behind holding roughly 1.6 MB each. Three hundred times the floor. What a real group
/// carries and a fresh one does not is EPOCHS: `EpochKeyPairs`, `MessageSecrets`, `EpochSecrets`
/// and `ResumptionPsk` are all stored per epoch, and a group hammered by a healing campaign goes
/// through hundreds.
///
/// This isolates that. The membership is held CONSTANT - one device added, then removed, over and
/// over - so every byte of the slope is epoch and none of it is member count, which the round above
/// cannot separate.
#[test]
#[ignore = "measurement, not an assertion: run explicitly with --release --nocapture"]
fn what_an_epoch_costs_at_constant_membership() {
    let mut alice = make_device("alice", "weigh-epochs");
    alice
        .create_group("weigh-churn".to_string())
        .expect("create the churn group");

    // A resident so the group is never empty, and never touched again.
    let resident = make_device("resident", "weigh-r")
        .generate_key_package()
        .expect("kp");
    alice
        .add_members_bulk("weigh-churn", &[resident.as_slice()])
        .expect("add the resident");
    alice
        .merge_pending_commit_for("weigh-churn")
        .expect("confirm");

    println!();
    println!("epochs at CONSTANT membership - one device added then removed, repeatedly");
    println!("{}", "-".repeat(96));

    let mut before = weigh(&alice);
    for round in 1..=4 {
        for i in 0..10 {
            let tag = format!("churn-{round}-{i}");
            let kp = make_device(&tag, "weigh-c")
                .generate_key_package()
                .expect("kp");
            alice
                .add_members_bulk("weigh-churn", &[kp.as_slice()])
                .expect("add the churn device");
            alice
                .merge_pending_commit_for("weigh-churn")
                .expect("confirm the add");
            let identity = format!("{tag}:weigh-c");
            alice
                .remove_members_for_devices("weigh-churn", &[identity.as_str()])
                .expect("remove the churn device");
            alice
                .merge_pending_commit_for("weigh-churn")
                .expect("confirm the remove");
        }
        let after = weigh(&alice);
        // 10 add/remove pairs is 20 epochs, and the membership is exactly what it was.
        report(&format!("+20 epochs (round {round})"), before, after, 20);
        before = after;
    }

    println!("{}", "-".repeat(96));
    println!(
        "final: {} bytes at epoch {}",
        weigh(&alice),
        alice.get_epoch("weigh-churn").unwrap_or(0)
    );
    print_composition("composition after the churn", &alice);
    println!();
    println!("Multiply the per-epoch figure by the epochs a campaign group really reaches, and");
    println!("compare with the 1.6 MB a group was measured at on the phone.");
    println!();
}
