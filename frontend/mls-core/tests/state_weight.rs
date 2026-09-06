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
/// IGNORED, BECAUSE IT IS A MEASUREMENT AND NOT AN ASSERTION. It prints a table and takes tens of
/// seconds; a number is not a pass or a fail, and pinning today's bytes would only manufacture a
/// failing test the first time a legitimate field is added.
///
///   cargo test --release --test state_weight -- --ignored --nocapture
use mls_core::{MlsManager, PersistedState};
use std::collections::BTreeMap;

/// Every label `openmls_memory_storage` prefixes its keys with, in the order a reader wants them.
///
/// A key is `label || serde_json(id) || u16 version`, built by that crate's `build_key_from_vec`,
/// so the label is a plain byte PREFIX and a scan can attribute every entry to exactly one owner.
/// That is the whole reason a prune is possible at all: the state is not opaque, and the bundles a
/// device has minted are separable from the groups it belongs to.
///
/// A label that is a prefix of another would mis-attribute, so the list is checked for that below
/// rather than trusted - `Psk` and `Tree` are short enough for it to be a real risk.
const LABELS: &[&str] = &[
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

/// Count and total byte weight of every storage entry, grouped by the label that owns it.
///
/// WEIGHING THE PARTS IS THE ONLY THING THAT TURNS "the blob is big" INTO A FIX. A total says a
/// prune is needed; a breakdown says WHAT the prune must delete, and whether deleting it is even
/// allowed. Both numbers are kept per label because they answer different questions - 10 000 cheap
/// entries and 10 expensive ones are the same megabytes and not the same defect.
fn composition(m: &MlsManager) -> BTreeMap<String, (usize, usize)> {
    let bytes = m.save_state().expect("save_state");
    let state: PersistedState =
        ciborium::from_reader(bytes.as_slice()).expect("a state we just wrote must decode");
    let mut by_label: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (k, v) in &state.storage_values {
        // Longest match wins, so `Tree` cannot steal an `ApplicationExportTree` key.
        let label = LABELS
            .iter()
            .filter(|l| k.starts_with(l.as_bytes()))
            .max_by_key(|l| l.len())
            .map(|l| (*l).to_string())
            .unwrap_or_else(|| {
                format!(
                    "UNKNOWN({})",
                    String::from_utf8_lossy(&k[..k.len().min(24)])
                )
            });
        let e = by_label.entry(label).or_insert((0, 0));
        e.0 += 1;
        e.1 += k.len() + v.len();
    }
    by_label
}

/// Prints the breakdown, widest first, with each label's share of the whole.
fn print_composition(title: &str, m: &MlsManager) {
    let by_label = composition(m);
    let total: usize = by_label.values().map(|(_, b)| *b).sum();
    println!();
    println!("{title}");
    println!("{}", "-".repeat(96));
    println!(
        "{:<26} {:>8} {:>14} {:>12} {:>8}",
        "label", "entries", "bytes", "each", "share"
    );
    let mut rows: Vec<_> = by_label.into_iter().collect();
    rows.sort_by_key(|(_, (_, b))| std::cmp::Reverse(*b));
    for (label, (count, bytes)) in rows {
        println!(
            "{label:<26} {count:>8} {bytes:>14} {:>12} {:>7.1}%",
            bytes / count.max(1),
            100.0 * bytes as f64 / total.max(1) as f64
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
