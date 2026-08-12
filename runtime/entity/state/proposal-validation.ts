import { LIMITS } from '../../config/constants';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
  validateObject,
} from '../../protocol/validation-primitives';

export const validateEntityProposals = (
  value: unknown,
  context: string,
): void => {
  const proposals = validateMapInstance(value, `${context}.proposals`);
  if (proposals.size > LIMITS.MAX_PROPOSALS_PER_ENTITY) {
    throw new FinancialDataCorruptionError(
      `${context}.proposals exceeds ${LIMITS.MAX_PROPOSALS_PER_ENTITY} bounded entries`,
    );
  }
  let pendingCount = 0;
  let terminalCount = 0;
  const pendingByProposer = new Set<string>();
  for (const [rawId, rawProposal] of proposals) {
    const id = typeof rawId === 'string' ? rawId : '';
    const item = `${context}.proposals[${id || 'invalid'}]`;
    const proposal = validateObject(rawProposal, item);
    const proposer =
      typeof proposal['proposer'] === 'string'
        ? proposal['proposer'].trim().toLowerCase()
        : '';
    const status = proposal['status'];
    if (
      !/^prop_[0-9a-f]{64}$/.test(id) ||
      proposal['id'] !== id ||
      !proposer ||
      !/^0x[0-9a-f]{64}$/.test(String(proposal['boardHash'] ?? '').toLowerCase()) ||
      !Number.isSafeInteger(proposal['boardEpoch']) ||
      Number(proposal['boardEpoch']) < 0 ||
      !/^0x[0-9a-f]{64}$/.test(String(proposal['actionHash'] ?? '').toLowerCase()) ||
      !(proposal['votes'] instanceof Map) ||
      proposal['votes'].size > LIMITS.MAX_VALIDATORS ||
      !Number.isSafeInteger(proposal['created']) ||
      Number(proposal['created']) < 0 ||
      (status !== 'pending' && status !== 'executed' && status !== 'rejected')
    ) {
      throw new FinancialDataCorruptionError(`${item} invalid`);
    }
    if (status !== 'pending') {
      terminalCount += 1;
      continue;
    }
    pendingCount += 1;
    if (pendingByProposer.has(proposer)) {
      throw new FinancialDataCorruptionError(
        `${context}.proposals has multiple pending entries for ${proposer}`,
      );
    }
    pendingByProposer.add(proposer);
  }
  if (
    pendingCount > LIMITS.MAX_PENDING_PROPOSALS_PER_ENTITY ||
    terminalCount > LIMITS.MAX_TERMINAL_PROPOSALS_PER_ENTITY
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.proposals pending/terminal bounds exceeded`,
      { pendingProposalCount: pendingCount, terminalProposalCount: terminalCount },
    );
  }
};
