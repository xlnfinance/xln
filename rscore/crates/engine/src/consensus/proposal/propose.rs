//! Building, executing and signing our own account frame.
//!
//! Parity target: core/account/consensus/proposal/{propose,frame,transactions}.ts.
//! The window is the whole mempool; a transaction that its own handler rejects
//! is dropped from the frame rather than failing the proposal, and the frame
//! commits the candidate state the surviving transactions produced.

use crate::consensus::frame::hash::AccountFrame;
use crate::consensus::replica::{AccountConsensus, PendingFrame};
use crate::consensus::signing::SigningIdentity;
use crate::error::StateError;
use crate::tx::apply::{AccountVerdict, SequentialAccountEngine};
use crate::{
    AccountExecutionContext, AccountOutput, AccountRejection, AccountReplica, AccountTx, Delta,
    Side,
};

/// One transaction the proposer could not include, with the reason its own
/// handler gave. The runtime reports these to the payer; they are not frame
/// failures.
#[derive(Clone, Debug)]
pub struct DroppedTx {
    pub index: usize,
    pub rejection: AccountRejection,
}

/// A frame this side built, signed, and is waiting to have acknowledged.
#[derive(Debug)]
pub struct ProposedFrame {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    pub outputs: Vec<AccountOutput>,
    pub dropped: Vec<DroppedTx>,
}

#[derive(Debug)]
pub enum ProposalOutcome {
    /// Nothing to propose: an empty queue, a frame already in flight, or a
    /// window where every transaction was rejected.
    Idle {
        dropped: Vec<DroppedTx>,
    },
    Proposed(Box<ProposedFrame>),
}

/// Only off-chain bilateral state belongs in frame comparison: `ondelta`
/// follows independently observed J events and may reach the two peers at
/// different Runtime frames.
///
/// Parity target: `collectFrameDeltas` + `shouldIncludeToken`
/// (core/account/consensus/proposal/frame.ts, core/account/consensus/helpers.ts).
pub(crate) fn collect_frame_deltas(replica: &AccountReplica) -> Vec<Delta> {
    replica
        .state()
        .deltas()
        .filter(|delta| should_include_token(delta))
        .cloned()
        .collect()
}

fn should_include_token(delta: &Delta) -> bool {
    let zero = num_bigint::BigInt::from(0);
    let has_holds = *delta.hold(Side::Left) != zero || *delta.hold(Side::Right) != zero;
    !(*delta.offdelta() == zero
        && *delta.left_credit_limit() == zero
        && *delta.right_credit_limit() == zero
        && !has_holds)
}

/// Execute a window against a candidate, keeping the transactions that apply.
pub(crate) struct WindowExecution {
    pub candidate: AccountReplica,
    pub applied: Vec<AccountTx>,
    pub outputs: Vec<AccountOutput>,
    pub dropped: Vec<DroppedTx>,
}

pub(crate) fn execute_window(
    base: &AccountReplica,
    proposer: Side,
    window: Vec<AccountTx>,
    context: &AccountExecutionContext,
    stop_on_rejection: bool,
) -> Result<WindowExecution, StateError> {
    let mut candidate = base.clone();
    let mut applied = Vec::with_capacity(window.len());
    let mut outputs = Vec::new();
    let mut dropped = Vec::new();
    for (index, tx) in window.into_iter().enumerate() {
        let transition =
            SequentialAccountEngine::apply_with_context(&candidate, proposer, &tx, context)
                .map_err(|error| StateError::TransitionFailed(error.to_string()))?;
        match transition.verdict() {
            AccountVerdict::Applied => {
                outputs.extend_from_slice(transition.outputs());
                candidate = transition.committed().expect("applied transition commits");
                applied.push(tx);
            }
            AccountVerdict::Rejected(rejection) => {
                let rejection = rejection.clone();
                dropped.push(DroppedTx { index, rejection });
                if stop_on_rejection {
                    return Ok(WindowExecution {
                        candidate,
                        applied,
                        outputs,
                        dropped,
                    });
                }
            }
        }
    }
    Ok(WindowExecution {
        candidate,
        applied,
        outputs,
        dropped,
    })
}

/// Propose the next frame for this account.
pub fn propose_account_frame(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    timestamp: u64,
    j_height: u64,
) -> Result<ProposalOutcome, StateError> {
    if account.pending().is_some() {
        // One proposal per height. The peer either acks it or wins the
        // collision; a second frame here would fork our own chain.
        return Ok(ProposalOutcome::Idle {
            dropped: Vec::new(),
        });
    }
    let window = account.take_mempool();
    if window.is_empty() {
        return Ok(ProposalOutcome::Idle {
            dropped: Vec::new(),
        });
    }
    let height = account.current_height() + 1;
    let context = AccountExecutionContext::new(
        timestamp,
        timestamp,
        j_height,
        account.current_height(),
        j_height,
    );
    let proposer = account.replica().owner_side();
    let execution = execute_window(account.replica(), proposer, window, &context, false)?;
    let WindowExecution {
        mut candidate,
        applied,
        outputs,
        dropped,
    } = execution;
    if applied.is_empty() {
        return Ok(ProposalOutcome::Idle { dropped });
    }
    let account_state_root = candidate.refresh_account_state_root()?;
    let frame = AccountFrame {
        height,
        timestamp,
        j_height,
        txs: applied,
        prev_frame_hash: account.prev_frame_hash(),
        account_state_root,
        by_left: proposer == Side::Left,
        deltas: collect_frame_deltas(&candidate),
    };
    let state_hash = frame.hash()?;
    let hanko = identity.sign_frame(&state_hash)?;
    account.set_pending(PendingFrame {
        frame: frame.clone(),
        state_hash,
        hanko: hanko.clone(),
        candidate,
    });
    Ok(ProposalOutcome::Proposed(Box::new(ProposedFrame {
        frame,
        state_hash,
        hanko,
        outputs,
        dropped,
    })))
}
