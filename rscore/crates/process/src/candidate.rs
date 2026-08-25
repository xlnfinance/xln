use sha2::{Digest, Sha256};

use xln_rscore_batch::CandidateId;

use crate::ProcessError;

#[derive(Clone, Copy)]
pub(crate) struct ProcessIncarnation([u8; 32]);

impl ProcessIncarnation {
    pub(crate) fn fresh() -> Result<Self, ProcessError> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|error| ProcessError::Entropy(error.to_string()))?;
        Ok(Self(bytes))
    }

    #[cfg(test)]
    pub(crate) const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CandidateToken([u8; 32]);

impl CandidateToken {
    /// Issue an ephemeral capability for one held candidate.
    ///
    /// The random incarnation is process/session control state, never RJEA
    /// consensus state: neither it nor this token enters a parity digest,
    /// checkpoint, WAL row or frame hash. That separation is intentional. A
    /// deterministic token derived only from revision/root/request id would be
    /// reissued after abort or exact restore, letting a delayed Commit name a
    /// different candidate whose financial state happened to be identical.
    pub(crate) fn issue(
        incarnation: ProcessIncarnation,
        protocol_fingerprint: [u8; 32],
        engine_generation: [u8; 8],
        runtime_id: [u8; 20],
        session_id: [u8; 16],
        prepare_request_id: [u8; 8],
        candidate_id: CandidateId,
    ) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"xln.rscore.process-candidate.v1\0");
        digest.update(incarnation.0);
        digest.update(protocol_fingerprint);
        digest.update(engine_generation);
        digest.update(runtime_id);
        digest.update(session_id);
        digest.update(prepare_request_id);
        digest.update(candidate_id.as_bytes());
        Self(digest.finalize().into())
    }

    pub(crate) const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}
