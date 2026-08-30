use crate::{AccountOutput, AccountRejection, CounterpartyDispute, DisputeDraft};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AccountConsensusEffect {
    ActivatePostSettlementProof {
        local: DisputeDraft,
        counterparty: CounterpartyDispute,
        next_proof_nonce: u64,
    },
}

pub(crate) enum MutationDecision {
    Applied {
        events: Vec<String>,
        outputs: Vec<AccountOutput>,
        consensus_effects: Vec<AccountConsensusEffect>,
    },
    Rejected {
        rejection: AccountRejection,
        events: Vec<String>,
    },
}

impl MutationDecision {
    pub(crate) fn applied(events: Vec<String>) -> Self {
        Self::Applied {
            events,
            outputs: Vec::new(),
            consensus_effects: Vec::new(),
        }
    }

    pub(crate) fn with_outputs(events: Vec<String>, outputs: Vec<AccountOutput>) -> Self {
        Self::Applied {
            events,
            outputs,
            consensus_effects: Vec::new(),
        }
    }

    pub(crate) fn with_outputs_and_effects(
        events: Vec<String>,
        outputs: Vec<AccountOutput>,
        consensus_effects: Vec<AccountConsensusEffect>,
    ) -> Self {
        Self::Applied {
            events,
            outputs,
            consensus_effects,
        }
    }

    pub(crate) fn rejected(rejection: AccountRejection) -> Self {
        Self::Rejected {
            rejection,
            events: Vec::new(),
        }
    }

    pub(crate) fn rejected_with_events(rejection: AccountRejection, events: Vec<String>) -> Self {
        Self::Rejected { rejection, events }
    }
}
