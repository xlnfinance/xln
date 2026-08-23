// The shared fixture module serves several test binaries; this one uses a subset.
#[allow(dead_code)]
mod common;

use xln_rscore_batch::StatefulBatchEngine;
use xln_rscore_protocol::{EMPTY_RADIX_ROOT, PersistentRadixMap};

use common::{direct_job, generation, seed};

/// Independent O(n) oracle: rebuild the accounts tree from scratch out of the
/// committed replicas. Any incremental rebranch bug in the engine's path-copy
/// maintenance diverges from this root.
fn cold_accounts_root(engine: &StatefulBatchEngine) -> [u8; 32] {
    let mut tree = PersistentRadixMap::empty();
    for (account_id, replica) in engine.accounts_after(None) {
        let root = replica
            .state()
            .payment_profile_account_state_root()
            .expect("account state root");
        tree = tree
            .updated(account_id.as_bytes().to_vec(), root, root)
            .expect("cold tree update");
    }
    tree.root_hash()
}

// 1, 2 share 63 nibbles (leaf split at the last nibble); 0x0100_0000 splits
// the shared 56-nibble zero extension much higher up.
const SPLIT_IDS: [u32; 3] = [1, 2, 0x0100_0000];

#[test]
fn restore_builds_the_accounts_tree_and_matches_the_cold_oracle() {
    let engine = StatefulBatchEngine::new(
        generation(),
        2,
        SPLIT_IDS.iter().copied().map(seed).collect(),
    )
    .expect("batch engine");
    let root = engine.accounts_root();
    assert_ne!(root, EMPTY_RADIX_ROOT);
    assert_eq!(root, cold_accounts_root(&engine));
}

#[test]
fn seed_order_does_not_change_the_accounts_root() {
    let forward = StatefulBatchEngine::new(
        generation(),
        1,
        SPLIT_IDS.iter().copied().map(seed).collect(),
    )
    .expect("forward engine");
    let reverse = StatefulBatchEngine::new(
        generation(),
        1,
        SPLIT_IDS.iter().rev().copied().map(seed).collect(),
    )
    .expect("reverse engine");
    assert_eq!(forward.accounts_root(), reverse.accounts_root());
}

#[test]
fn every_membership_change_or_update_moves_the_root() {
    let mut roots = Vec::new();
    for count in 1..=SPLIT_IDS.len() {
        let engine = StatefulBatchEngine::new(
            generation(),
            1,
            SPLIT_IDS[..count].iter().copied().map(seed).collect(),
        )
        .expect("batch engine");
        roots.push(engine.accounts_root());
    }
    assert_eq!(roots.len(), 3);
    assert!(roots.windows(2).all(|pair| pair[0] != pair[1]));
    assert!(roots.iter().all(|root| *root != EMPTY_RADIX_ROOT));
}

#[test]
fn commit_rebranches_only_touched_leaves_and_reports_the_new_root() {
    let mut engine = StatefulBatchEngine::new(
        generation(),
        2,
        SPLIT_IDS.iter().copied().map(seed).collect(),
    )
    .expect("batch engine");
    let before = engine.accounts_root();

    let prepared = engine
        .prepare(&[direct_job(0, SPLIT_IDS[0], 5)])
        .expect("prepare");
    // Prepare must not move the committed root; only commit does.
    assert_eq!(engine.accounts_root(), before);

    let response = engine.commit(prepared).expect("commit");
    let after = engine.accounts_root();
    assert_ne!(after, before);
    assert_eq!(response.accounts_root, after);
    assert_eq!(after, cold_accounts_root(&engine));
}
