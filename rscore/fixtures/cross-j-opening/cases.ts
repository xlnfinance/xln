import { createHash } from 'node:crypto';

import { encodeAccountStateValue } from '../../../core/account/commitment/state-root';
import {
  canonicalAccountTxForFrameHash,
  computeFrameHash,
} from '../../../core/account/consensus/frame/hash';
import { selectCrossJOpeningAccountProposalTxs } from '../../../core/entity/transition/cross-j-proposer-materialization';
import type { EntityState } from '../../../core/entity/types';
import type { AccountFrame, AccountReplica, AccountTx } from '../../../core/types/account';
import type { CrossJurisdictionSwapRoute } from '../../../core/types/cross-jurisdiction';
import type { RuntimeReplica } from '../../../core/runtime/types';
import { createEmptyEnv } from '../../../core/runtime';
import {
  addReplica,
  addr,
  entity,
  makeJurisdiction,
  makeState,
  getTestAccountForWrite,
  secret,
} from '../../../core/__tests__/helpers/cross-j';

export type CrossJOpeningRole = 'source-user' | 'source-hub' | 'target-hub' | 'target-user';
export type CrossJOpeningTxLabel = `pull:${string}` | `offer:${string}` | 'ordinary';

export type CrossJOpeningVectorSpec = Readonly<{
  name: string;
  localRole: CrossJOpeningRole;
  localMempool: readonly CrossJOpeningTxLabel[];
  siblingMempool: readonly CrossJOpeningTxLabel[];
  siblingPending?: readonly CrossJOpeningTxLabel[];
}>;

export type CrossJOpeningVectorResult = Readonly<{
  kind: 'ordinary' | 'wait' | 'selected';
  selected: readonly CrossJOpeningTxLabel[];
  selectedTxDigests: readonly string[];
  frameHash?: string;
}>;

const SOURCE_USER = entity('11');
const SOURCE_HUB = entity('22');
const TARGET_HUB = entity('33');
const TARGET_USER = entity('44');
const SOURCE_USER_SIGNER = addr('51');
const SOURCE_HUB_SIGNER = addr('52');
const TARGET_HUB_SIGNER = addr('53');
const TARGET_USER_SIGNER = addr('54');

const ROLES = {
  'source-user': {
    entityId: SOURCE_USER,
    signerId: SOURCE_USER_SIGNER,
    accountId: SOURCE_HUB,
    siblingRole: 'target-user' as const,
  },
  'source-hub': {
    entityId: SOURCE_HUB,
    signerId: SOURCE_HUB_SIGNER,
    accountId: SOURCE_USER,
    siblingRole: 'target-hub' as const,
  },
  'target-hub': {
    entityId: TARGET_HUB,
    signerId: TARGET_HUB_SIGNER,
    accountId: TARGET_USER,
    siblingRole: 'source-hub' as const,
  },
  'target-user': {
    entityId: TARGET_USER,
    signerId: TARGET_USER_SIGNER,
    accountId: TARGET_HUB,
    siblingRole: 'source-user' as const,
  },
} satisfies Record<CrossJOpeningRole, {
  entityId: string;
  signerId: string;
  accountId: string;
  siblingRole: CrossJOpeningRole;
}>;

const orderByte = (orderId: string): string => {
  const byte = createHash('sha256').update(orderId).digest('hex').slice(0, 2);
  return secret(byte);
};

const route = (orderId: string): CrossJurisdictionSwapRoute => ({
  orderId,
  routeHash: orderByte(`route:${orderId}`),
  makerEntityId: SOURCE_USER,
  hubEntityId: SOURCE_HUB,
  sourceSignerId: SOURCE_USER_SIGNER,
  sourceHubSignerId: SOURCE_HUB_SIGNER,
  targetHubSignerId: TARGET_HUB_SIGNER,
  targetSignerId: TARGET_USER_SIGNER,
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  source: {
    jurisdiction: `stack:1:${addr('61')}`,
    entityId: SOURCE_USER,
    counterpartyEntityId: SOURCE_HUB,
    tokenId: 1,
    amount: 10n,
  },
  target: {
    jurisdiction: `stack:2:${addr('62')}`,
    entityId: TARGET_HUB,
    counterpartyEntityId: TARGET_USER,
    tokenId: 2,
    amount: 20n,
  },
  status: 'intent',
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 61_000,
});

const roleLeg = (role: CrossJOpeningRole): 'source' | 'target' =>
  role === 'source-user' || role === 'source-hub' ? 'source' : 'target';

const txFor = (label: CrossJOpeningTxLabel, role: CrossJOpeningRole): AccountTx => {
  if (label === 'ordinary') return { type: 'swap_cancel_request', data: { offerId: 'ordinary' } };
  const [kind, orderId] = label.split(':') as ['pull' | 'offer', string];
  const crossRoute = route(orderId);
  if (kind === 'offer') {
    return {
      type: 'swap_offer',
      data: {
        offerId: orderId,
        giveTokenId: 1,
        giveTokenDecimals: 6,
        giveAmount: 10n,
        wantTokenId: 2,
        wantTokenDecimals: 6,
        wantAmount: 20n,
        maxFee: 0n,
        minNetReceive: 20n,
        timeInForce: 0,
        crossJurisdiction: crossRoute,
      },
    };
  }
  const leg = roleLeg(role);
  return {
    type: 'cross_pull_lock',
    data: {
      pullId: `${orderId}-${leg}`,
      tokenId: leg === 'source' ? 1 : 2,
      amount: leg === 'source' ? -10n : -20n,
      fullHash: orderByte(`full:${orderId}`),
      partialRoot: orderByte(`partial:${orderId}`),
      crossJurisdiction: { orderId, routeHash: crossRoute.routeHash!, leg },
      crossJurisdictionRoute: crossRoute,
    },
  };
};

const labelFor = (tx: AccountTx): CrossJOpeningTxLabel => {
  if (tx.type === 'cross_pull_lock') return `pull:${tx.data.crossJurisdiction.orderId}`;
  if (tx.type === 'swap_offer' && tx.data.crossJurisdiction) {
    return `offer:${tx.data.crossJurisdiction.orderId}`;
  }
  return 'ordinary';
};

const txDigest = (tx: AccountTx): string => `0x${createHash('sha256')
  .update(encodeAccountStateValue(canonicalAccountTxForFrameHash(tx)))
  .digest('hex')}`;

const frameHash = (txs: readonly AccountTx[]): string => computeFrameHash({
  height: 3,
  timestamp: 1_700_000_000_000,
  jHeight: 7,
  accountTxs: [...txs],
  prevFrameHash: secret('71'),
  accountStateRoot: secret('72'),
  stateHash: '',
} satisfies AccountFrame);

const buildState = (
  spec: CrossJOpeningVectorSpec,
): { env: RuntimeReplica; state: EntityState; account: AccountReplica } => {
  const local = ROLES[spec.localRole];
  const sibling = ROLES[local.siblingRole];
  const sourceJ = makeJurisdiction('Source', 1, '61', '63');
  const targetJ = makeJurisdiction('Target', 2, '62', '64');
  const localJ = spec.localRole.startsWith('source') ? sourceJ : targetJ;
  const siblingJ = local.siblingRole.startsWith('source') ? sourceJ : targetJ;
  const env = createFixtureRuntime();
  const state = makeState(local.entityId, local.signerId, localJ, local.accountId);
  const siblingState = makeState(
    sibling.entityId,
    sibling.signerId,
    siblingJ,
    sibling.accountId,
  );
  const account = getTestAccountForWrite(state, local.accountId);
  const siblingAccount = getTestAccountForWrite(siblingState, sibling.accountId);
  account.mempool = spec.localMempool.map(label => txFor(label, spec.localRole));
  siblingAccount.mempool = spec.siblingMempool.map(label => txFor(label, local.siblingRole));
  if (spec.siblingPending) {
    siblingAccount.pendingFrame = {
      ...siblingAccount.currentFrame,
      height: 1,
      accountTxs: spec.siblingPending.map(label => txFor(label, local.siblingRole)),
      stateHash: secret('73'),
    };
  }
  addReplica(env, siblingState, sibling.signerId);
  return { env, state, account };
};

const createFixtureRuntime = (): RuntimeReplica => {
  // The selector reads only committed sibling Entity replicas; the seed fixes
  // every helper-derived identity without entering the expected projection.
  const env = createEmptyEnv('cross-j-opening-selector-v1');
  env.state.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  return env;
};

export const CROSS_J_OPENING_VECTOR_SPECS: readonly CrossJOpeningVectorSpec[] = [
  {
    name: 'lexical-first-preserves-local-order',
    localRole: 'source-user',
    localMempool: ['pull:b', 'offer:b', 'pull:a', 'offer:a'],
    siblingMempool: ['pull:b', 'pull:a'],
  },
  {
    name: 'sibling-pending-freezes-order',
    localRole: 'source-user',
    localMempool: ['pull:a', 'offer:a', 'pull:b', 'offer:b'],
    siblingMempool: ['pull:a', 'pull:b'],
    siblingPending: ['pull:b'],
  },
  {
    name: 'missing-reciprocal-waits',
    localRole: 'source-user',
    localMempool: ['pull:a', 'offer:a'],
    siblingMempool: ['pull:other'],
  },
  ...(['source-user', 'source-hub', 'target-hub', 'target-user'] as const).map(localRole => ({
    name: `role-${localRole}`,
    localRole,
    localMempool: ['pull:role'] as const,
    siblingMempool: ['pull:role'] as const,
  })),
];

export const executeCrossJOpeningVector = (
  spec: CrossJOpeningVectorSpec,
): CrossJOpeningVectorResult => {
  const { env, state, account } = buildState(spec);
  const selection = selectCrossJOpeningAccountProposalTxs(env, state, account);
  if (selection === undefined) return { kind: 'ordinary', selected: [], selectedTxDigests: [] };
  if (selection === null) return { kind: 'wait', selected: [], selectedTxDigests: [] };
  return {
    kind: 'selected',
    selected: selection.map(labelFor),
    selectedTxDigests: selection.map(txDigest),
    frameHash: frameHash(selection),
  };
};
