import { signEntityHashes } from '../../hanko/signing';
import type { RuntimeReplica } from '../../runtime/types';
import type { AccountInput } from '../../types/account';

type AccountDraft = {
  accountInput?: AccountInput;
  hashesToSign?: Array<{
    hash: string;
    type: 'accountFrame' | 'dispute';
    context: string;
  }>;
};

/**
 * Account consensus is signer-blind: it returns hashes, then Entity authority
 * attaches the draft Hankos. QA and benchmarks entering below Entity consensus must
 * reproduce that boundary instead of feeding an impossible unsigned input.
 */
export const attachAccountDraftHankosAsEntity = async (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  draft: AccountDraft,
): Promise<AccountInput> => {
  if (!draft.accountInput || !draft.hashesToSign?.length) {
    throw new Error('QA_ACCOUNT_DRAFT_MANIFEST_REQUIRED');
  }
  const input = structuredClone(draft.accountInput);
  const hankos = await signEntityHashes(
    env,
    entityId,
    signerId,
    draft.hashesToSign.map(entry => entry.hash),
  );
  const witnesses = new Map(
    draft.hashesToSign.map((entry, index) => {
      const hanko = hankos[index];
      if (!hanko) throw new Error(`QA_ACCOUNT_DRAFT_HANKO_MISSING:${entry.context}`);
      return [entry.hash.toLowerCase(), hanko] as const;
    }),
  );
  const requireWitness = (hash: string): string => {
    const hanko = witnesses.get(hash.toLowerCase());
    if (!hanko) throw new Error(`QA_ACCOUNT_DRAFT_WITNESS_UNDECLARED:${hash}`);
    return hanko;
  };

  if (input.kind === 'ack' || input.kind === 'ack_frame') {
    input.ack.frameHanko = requireWitness(input.ack.frameHash);
    if (input.ack.disputeHanko) input.ack.disputeHanko.hanko = requireWitness(input.ack.disputeHanko.hash);
  }
  if (input.kind === 'frame' || input.kind === 'ack_frame') {
    input.proposal.frameHanko = requireWitness(input.proposal.frame.stateHash);
    if (input.proposal.disputeHanko) {
      input.proposal.disputeHanko.hanko = requireWitness(input.proposal.disputeHanko.hash);
    }
  }
  return input;
};
