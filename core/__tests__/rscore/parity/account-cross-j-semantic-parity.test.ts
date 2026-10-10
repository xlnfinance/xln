import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../protocol/serialization';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import {
  executeCrossJAccountSemanticVector,
  inputs,
  makeAccount,
  route,
} from '../../../../rscore/fixtures/account-semantics/cross-j';

test('cross-j Account lock, offer retirement, and close match the shared semantic vector', async () => {
  const actual = await executeCrossJAccountSemanticVector();
  const expected = readFileSync(
    join(import.meta.dir, '../../../../rscore/fixtures/account-semantics/cross-j-v1.json'),
    'utf8',
  );
  expect(`${safeStringify(actual, 2)}\n`).toBe(expected);
  expect(actual.cases.flatMap(testCase => testCase.steps).map(step => step.txType)).toEqual([
    'cross_pull_lock',
    'swap_offer',
    'cross_pull_close',
    'cross_pull_lock',
    'cross_pull_close',
    'cross_pull_lock',
    'cross_pull_lock',
    'swap_offer',
    'cross_pull_close',
  ]);
  const buyer = actual.cases.find(testCase => testCase.name === 'source-buyer-price-improvement');
  expect(buyer?.steps.at(-1)?.offdelta).toBe('-75000000');
  expect(buyer?.steps.at(-1)?.leftHold).toBe('0');
});

test('cross_pull_close with a malformed binary is a typed rejection, matching Rust', async () => {
  // ethers.keccak256 threw on non-hex peer text and halted the Runtime. Rust
  // variable_hex_bytes rejects the same shapes with the same message.
  const txs = inputs(route());
  const account = makeAccount(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, 1, 31_337, `0x${'88'.repeat(20)}`);
  expect((await applyAccountTxToMutableReplica(account, txs.sourceLock, false, 1_000, 10)).ok).toBe(true);
  for (const binary of ['zz', '0x0', '', '0Xab']) {
    const result = await applyAccountTxToMutableReplica(
      account,
      { ...txs.sourceClose, data: { ...txs.sourceClose.data, binary } },
      false,
      2_000,
      20,
    );
    if (result.ok) throw new Error(`CROSS_J_CLOSE_BINARY_ACCEPTED:${binary}`);
    expect(result.rejection.message).toBe('Invalid cross-j close binary');
  }
  expect(account.state.pulls?.size).toBe(1);
});
