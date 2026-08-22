import { expect, test } from 'bun:test';

import { fitEntityProposalToWireBudget } from '../../../entity/consensus/proposal/wire-budget';

test('wire fit rejects a required prefix longer than the proposal', async () => {
  await expect(fitEntityProposalToWireBudget({
    env: {} as never,
    replica: {} as never,
    proposalTxs: [],
    usePersistedReplayContext: false,
    requiredPrefixCount: 1,
  })).rejects.toThrow('ENTITY_WIRE_FIT_REQUIRED_PREFIX_INVALID');
});
