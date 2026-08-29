export type WalletRecoveryCandidateChoice = Readonly<{
  id: string;
  source: string;
  runtimeHeight: number;
  createdAt: number;
}>;

export type WalletRecoveryCandidateSummary<
  Candidate extends WalletRecoveryCandidateChoice,
> = Readonly<{
  selectedCandidate: Candidate | null;
  peerBackupCount: number;
}>;

export const summarizeWalletRecoveryCandidates = <
  Candidate extends WalletRecoveryCandidateChoice,
>(
  candidates: readonly Candidate[],
  selectedCandidateId: string,
): WalletRecoveryCandidateSummary<Candidate> => {
  let selectedCandidate: Candidate | null = null;
  let peerBackupCount = 0;
  for (const candidate of candidates) {
    if (candidate.source === 'peer') peerBackupCount += 1;
    if (candidate.id === selectedCandidateId && selectedCandidate === null) {
      selectedCandidate = candidate;
    }
  }
  return {
    selectedCandidate: selectedCandidate ?? candidates[0] ?? null,
    peerBackupCount,
  };
};

export const mergeWalletRecoveryCandidate = <
  Candidate extends WalletRecoveryCandidateChoice,
>(
  candidates: readonly Candidate[],
  candidate: Candidate,
): Candidate[] => [
  candidate,
  ...candidates.filter((existing) => existing.id !== candidate.id),
].sort((left, right) => {
  if (right.runtimeHeight !== left.runtimeHeight) {
    return right.runtimeHeight - left.runtimeHeight;
  }
  return right.createdAt - left.createdAt;
});

export type WalletRecoveryContinuation = 'choose-backup' | 'open-local' | 'create-fresh';

export const resolveWalletRecoveryContinuation = (input: Readonly<{
  hasCandidates: boolean;
  localRuntimeAvailable: boolean;
}>): WalletRecoveryContinuation => {
  if (input.hasCandidates) return 'choose-backup';
  return input.localRuntimeAvailable ? 'open-local' : 'create-fresh';
};
