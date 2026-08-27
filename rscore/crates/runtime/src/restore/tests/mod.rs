use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
struct FakeInput {
    commitments: RestoreCommitments,
    fail: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FakeFailure {
    Accounts,
    Entity,
    Runtime,
    Wal,
}

impl std::fmt::Display for FakeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FakeTarget {
    head: RestoreHead,
    checkpoint_commitments: RestoreCommitments,
    fail_at: Option<FakeFailure>,
    mutations: Vec<&'static str>,
}

impl ExactRestoreTarget for FakeTarget {
    type CheckpointPayload = ();
    type RuntimeInput = FakeInput;
    type Error = FakeFailure;

    fn fork_restore_candidate(&self) -> Result<Self, Self::Error> {
        Ok(self.clone())
    }

    fn restore_account_shards(
        &mut self,
        _checkpoint: &ExactRuntimeCheckpoint<Self::CheckpointPayload>,
    ) -> Result<(), Self::Error> {
        if self.fail_at == Some(FakeFailure::Accounts) {
            return Err(FakeFailure::Accounts);
        }
        self.mutations.push("accounts");
        self.head.commitments.accounts_root = self.checkpoint_commitments.accounts_root;
        Ok(())
    }

    fn restore_entity(
        &mut self,
        _checkpoint: &ExactRuntimeCheckpoint<Self::CheckpointPayload>,
    ) -> Result<(), Self::Error> {
        if self.fail_at == Some(FakeFailure::Entity) {
            return Err(FakeFailure::Entity);
        }
        self.mutations.push("entity");
        self.head.commitments.entity_state_root = self.checkpoint_commitments.entity_state_root;
        self.head.commitments.paybook_root = self.checkpoint_commitments.paybook_root;
        self.head.commitments.orderbook_root = self.checkpoint_commitments.orderbook_root;
        Ok(())
    }

    fn restore_runtime(
        &mut self,
        checkpoint: &ExactRuntimeCheckpoint<Self::CheckpointPayload>,
    ) -> Result<(), Self::Error> {
        if self.fail_at == Some(FakeFailure::Runtime) {
            return Err(FakeFailure::Runtime);
        }
        self.mutations.push("runtime");
        self.head.height = checkpoint.height;
        self.head.timestamp = checkpoint.timestamp;
        self.head.commitments = self.checkpoint_commitments.clone();
        Ok(())
    }

    fn apply_runtime_wal_frame(
        &mut self,
        frame: &ExactRuntimeWalFrame<Self::RuntimeInput>,
    ) -> Result<(), Self::Error> {
        if self.fail_at == Some(FakeFailure::Wal) || frame.input.fail {
            return Err(FakeFailure::Wal);
        }
        self.mutations.push("wal");
        self.head = RestoreHead {
            height: frame.height,
            timestamp: frame.timestamp,
            commitments: frame.input.commitments.clone(),
        };
        Ok(())
    }

    fn head(&self) -> Result<RestoreHead, Self::Error> {
        Ok(self.head.clone())
    }
}

fn digest(byte: u8) -> RestoreDigest {
    [byte; 32]
}

fn commitments(seed: u8) -> RestoreCommitments {
    RestoreCommitments {
        runtime_machine_root: Some(digest(seed)),
        canonical_state_hash: Some(digest(seed.wrapping_add(1))),
        runtime_state_hash: Some(digest(seed.wrapping_add(2))),
        post_state_hash: Some(digest(seed.wrapping_add(3))),
        entity_state_root: Some(digest(seed.wrapping_add(4))),
        accounts_root: Some(digest(seed.wrapping_add(5))),
        paybook_root: Some(digest(seed.wrapping_add(6))),
        orderbook_root: Some(digest(seed.wrapping_add(7))),
        output_count: Some(u64::from(seed)),
        outputs_digest: Some(digest(seed.wrapping_add(8))),
        event_count: Some(u64::from(seed.wrapping_add(1))),
        events_digest: Some(digest(seed.wrapping_add(9))),
    }
}

fn live(expected: RestoreCommitments) -> FakeTarget {
    FakeTarget {
        head: RestoreHead {
            height: 91,
            timestamp: 910,
            commitments: commitments(90),
        },
        checkpoint_commitments: expected,
        fail_at: None,
        mutations: Vec::new(),
    }
}

fn identity() -> DurableRuntimeIdentity {
    DurableRuntimeIdentity {
        runtime_id: "h1-runtime".into(),
        owner_entity_id: digest(1),
        signer_id: "h1-hub".into(),
        protocol_fingerprint: digest(2),
    }
}

fn checkpoint(expected: RestoreCommitments) -> ExactRuntimeCheckpoint<()> {
    ExactRuntimeCheckpoint {
        height: 100,
        timestamp: 1_000,
        account_count: 1,
        identity: None,
        expected,
        payload: (),
    }
}

fn frame(
    height: u64,
    timestamp: u64,
    expected: RestoreCommitments,
) -> ExactRuntimeWalFrame<FakeInput> {
    ExactRuntimeWalFrame {
        height,
        timestamp,
        input: FakeInput {
            commitments: expected.clone(),
            fail: false,
        },
        expected,
    }
}

#[test]
fn checkpoint_and_wal_tail_restore_exactly() {
    let checkpoint_commitments = commitments(10);
    let frame_101 = commitments(20);
    let frame_102 = commitments(30);
    let restored = restore_exact_runtime(
        &live(checkpoint_commitments.clone()),
        &checkpoint(checkpoint_commitments),
        &[
            frame(101, 1_001, frame_101),
            frame(102, 1_001, frame_102.clone()),
        ],
    )
    .expect("exact restore");
    assert_eq!(restored.head.height, 102);
    assert_eq!(restored.head.commitments, frame_102);
    assert_eq!(
        restored.mutations,
        ["accounts", "entity", "runtime", "wal", "wal"]
    );
}

#[test]
fn failed_tail_never_mutates_live_state() {
    let checkpoint_commitments = commitments(10);
    let mut corrupt = frame(101, 1_001, commitments(20));
    corrupt.expected.outputs_digest = Some(digest(250));
    let original = live(checkpoint_commitments.clone());
    let before = original.clone();
    let error = restore_exact_runtime(&original, &checkpoint(checkpoint_commitments), &[corrupt])
        .expect_err("corrupt output digest must fail");
    assert!(matches!(
        error,
        ExactRestoreError::CommitmentMismatch {
            boundary: RestoreBoundary::OutputsDigest,
            ..
        }
    ));
    assert_eq!(original, before);
}

#[test]
fn truncated_or_reordered_wal_is_rejected_before_apply() {
    let expected = commitments(10);
    let original = live(expected.clone());
    let error = restore_exact_runtime(
        &original,
        &checkpoint(expected),
        &[frame(102, 1_002, commitments(20))],
    )
    .expect_err("height gap must fail");
    assert_eq!(
        error,
        ExactRestoreError::WalGap {
            expected: 101,
            actual: 102,
        }
    );
    assert!(original.mutations.is_empty());
}

#[test]
fn backend_crash_after_partial_candidate_work_leaves_live_unchanged() {
    let expected = commitments(10);
    let mut original = live(expected.clone());
    original.fail_at = Some(FakeFailure::Entity);
    let before = original.clone();
    let error = restore_exact_runtime(&original, &checkpoint(expected), &[])
        .expect_err("entity restore crash must fail");
    assert!(matches!(
        error,
        ExactRestoreError::Backend {
            stage: RestoreStage::Entity,
            ..
        }
    ));
    assert_eq!(original, before);
}

#[test]
fn empty_account_checkpoint_requires_durable_signer_identity() {
    let expected = commitments(10);
    let mut checkpoint = checkpoint(expected.clone());
    checkpoint.account_count = 0;
    let error = restore_exact_runtime(&live(expected.clone()), &checkpoint, &[])
        .expect_err("empty checkpoint without identity must fail");
    assert_eq!(error, ExactRestoreError::IdentityRequired { height: 100 });

    checkpoint.identity = Some(identity());
    restore_exact_runtime(&live(expected), &checkpoint, &[])
        .expect("durable identity makes empty restore unambiguous");
}

#[test]
fn timestamp_regression_is_rejected() {
    let expected = commitments(10);
    let error = restore_exact_runtime(
        &live(expected.clone()),
        &checkpoint(expected),
        &[frame(101, 999, commitments(20))],
    )
    .expect_err("time travel must fail");
    assert!(matches!(
        error,
        ExactRestoreError::TimestampRegression { .. }
    ));
}
