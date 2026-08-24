use crate::{AccountOutput, AccountRejection};

pub(crate) enum MutationDecision {
    Applied {
        events: Vec<String>,
        outputs: Vec<AccountOutput>,
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
        }
    }

    pub(crate) fn with_outputs(events: Vec<String>, outputs: Vec<AccountOutput>) -> Self {
        Self::Applied { events, outputs }
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
