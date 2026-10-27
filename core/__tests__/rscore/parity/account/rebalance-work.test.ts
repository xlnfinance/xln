import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { createDefaultDelta } from '../../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import { ACCOUNT_WORK_REBALANCE, classifyAccountWork } from '../../../../entity/account/account-work-flags';
import { entity, makeAccount } from '../../../helpers/cross-j';

// Rust executes these exact rows through ResidentConsensusEngine restore
// (batch/tests/resident_consensus.rs). One WETH caught the old 500-WETH limit.
const rows = readFileSync(new URL('../../../../../rscore/fixtures/rebalance-work.tsv', import.meta.url), 'utf8')
  .trim().split('\n').map(row => {
    const [id, raw, expected] = row.split('\t');
    if (!id || !raw || !expected) throw new Error('REBALANCE_WORK_VECTOR_INVALID');
    return [id, raw, expected] as const;
  });

test.each(rows)('TS/Rust rebalance work: token=%s collateral=%s expected=%s', (id, raw, expected) => {
  const tokenId = Number(id);
  const collateral = BigInt(raw);
  for (const [owner, peer] of [[entity('11'), entity('22')], [entity('22'), entity('11')]] as const) {
    const account = makeAccount(owner, peer);
    const delta = { ...createDefaultDelta(tokenId), collateral,
      ondelta: owner === account.state.leftEntity ? collateral : 0n };
    account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[tokenId, delta]]);
    expect(Boolean(classifyAccountWork(owner, peer, account) & ACCOUNT_WORK_REBALANCE)).toBe(expected === 'true');
  }
});
