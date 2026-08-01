import { createFrameHash } from '../../account/consensus/frame';
import { computeAccountStateRoot } from '../../account/state-root';
import { applyAccountTx } from '../../account/tx/apply';
import { projectAccountDoc } from '../../storage/projections';
import type { StorageAccountDoc } from '../../storage/types';
import type { AccountTx } from '../../types/account';
import { makeAccount } from './cross-j';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;

export type StorageAccountFixture = {
  doc: StorageAccountDoc;
  owner: string;
  counterparty: string;
};

/** Build persisted state through the same financial transition used in production. */
export const makeStorageAccountFixture = async (): Promise<StorageAccountFixture> => {
  const owner = digest('11');
  const counterparty = digest('22');
  const account = makeAccount(owner, counterparty);
  const tx = {
    type: 'settle_transition',
    data: {
      kind: 'upsert',
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
      memo: 'storage recovery fixture',
    },
  } as AccountTx;
  const transition = await applyAccountTx(account, tx, true, 1_000);
  if (!transition.success) throw new Error(`TEST_SETTLEMENT_TRANSITION_FAILED:${transition.error}`);
  const delta = account.state.deltas.get(1)!;
  account.currentHeight = 1;
  account.currentFrame = {
    height: 1,
    timestamp: 1_000,
    jHeight: 0,
    accountTxs: [tx],
    prevFrameHash: 'genesis',
    accountStateRoot: computeAccountStateRoot(account.state),
    stateHash: '',
    byLeft: true,
    deltas: [{ ...delta }],
  };
  account.currentFrame.stateHash = await createFrameHash(account.currentFrame);
  return { doc: projectAccountDoc(account), owner, counterparty };
};
