import { signEntityHashes } from '../../hanko/signing';
import type { AccountInput } from '../../types/account';
import type { RuntimeState } from '../../runtime/types';

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
 * seals the draft. Tests entering below Entity consensus must reproduce that
 * boundary instead of feeding an impossible unsigned peer input.
 */
export const sealAccountDraftAsEntity = async (
  env: RuntimeState,
  entityId: string,
  signerId: string,
  draft: AccountDraft,
): Promise<AccountInput> => {
  if (!draft.accountInput || !draft.hashesToSign?.length) {
    throw new Error('TEST_ACCOUNT_DRAFT_MANIFEST_REQUIRED');
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
      if (!hanko) throw new Error(`TEST_ACCOUNT_DRAFT_HANKO_MISSING:${entry.context}`);
      return [entry.hash.toLowerCase(), hanko] as const;
    }),
  );
  const requireWitness = (hash: string) => {
    const hanko = witnesses.get(hash.toLowerCase());
    if (!hanko) throw new Error(`TEST_ACCOUNT_DRAFT_WITNESS_UNDECLARED:${hash}`);
    return hanko;
  };

  if (input.kind === 'ack' || input.kind === 'frame_ack') {
    input.ack.frameHanko = requireWitness(input.ack.frameHash);
    if (input.ack.disputeSeal) input.ack.disputeSeal.hanko = requireWitness(input.ack.disputeSeal.hash);
  }
  if (input.kind === 'frame' || input.kind === 'frame_ack') {
    input.proposal.frameHanko = requireWitness(input.proposal.frame.stateHash);
    if (input.proposal.disputeSeal) {
      input.proposal.disputeSeal.hanko = requireWitness(input.proposal.disputeSeal.hash);
    }
  }
  return input;
};
