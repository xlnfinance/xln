/**
 * Worst-case programmable dispute: both peers hold a locally signed resolution
 * frame while the network is partitioned. The starter must commit its HTLC and
 * swap arguments at dispute start; the finalizer supplies the opposite side.
 */

import { ethers } from 'ethers';
import { defaultAccountDisputeConfigForParties } from '../account/dispute-config';

import type { AccountFrame, AccountInput, AccountReplica } from '../types/account';
import type { EntityTx } from '../types/entity-tx';
import type { RoutedEntityInput, RuntimeReplica } from '../runtime/types';
import type { JAdapter } from '../jurisdiction/adapter/types';
import { deriveDisputeTokenFinalization } from '../protocol/dispute/finalization';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import { withDeterministicHtlcTestSecret } from '../protocol/htlc/test-secret-capability';
import { quoteHtlcPaymentRoute } from '../entity/htlc/payment-admission';
import { deriveSwapNetAuthorization } from '../account/swap-net-authorization';
import { ASYNC_PAYMENT_EXPIRY_MS } from '../types/payment';
import { safeStringify } from '../protocol/serialization';
import { releaseUncommittedReliableIngress } from '../runtime/reliable-delivery';
import { bootScenario, fundEntities, registerEntities } from './boot';
import {
  assert,
  advanceScenarioTime,
  converge,
  enableStrictScenario,
  findCommittedScenarioHtlcLockId,
  findReplica,
  getProcess,
  processJEvents,
  processUntilWithoutLocalHtlcAdvance,
  withholdScenarioLocalHtlcAdvances,
  syncChain,
  syncRuntimeToUnixSeconds,
  usd,
} from './helpers';
import { advanceRpcToUnixSeconds } from './rpc-block-mining';

const USDC = 1;
const WETH = 2;
const MAX_FILL_RATIO = 65_535n;
const WETH_LOT = 1_000_000_000_000n;
const SCENARIO_DEADLINE_MS = 4_102_464_800_000n;
const DETERMINISTIC_DISPUTE_START_UNIX = 4_102_445_800;

type Registered = { id: string; signer: string; name: string };
type MineableProvider = { send(method: string, params: unknown[]): Promise<unknown> };
type DecodedArguments = { fillRatios: bigint[]; secrets: string[]; pulls: string[] };
type AccountAckInput = Extract<AccountInput, { kind: 'ack' }>;
type AccountProposalInput = Extract<AccountInput, { kind: 'frame' } | { kind: 'frame_ack' }>;

const requireRegistered = (value: Registered | undefined, name: string): Registered => {
  if (!value) throw new Error(`DISPUTE_TRANSFORMER_MISSING_ENTITY:${name}`);
  return value;
};

const takeQueuedEnvelope = (
  env: RuntimeReplica,
  matches: (output: RoutedEntityInput) => boolean,
): RoutedEntityInput | undefined => {
  const take = (
    queue: readonly RoutedEntityInput[],
    assign: (remaining: RoutedEntityInput[]) => void,
  ): RoutedEntityInput | undefined => {
    const index = queue.findIndex(matches);
    if (index < 0) return undefined;
    const output = queue[index];
    if (!output) throw new Error('DISPUTE_TRANSFORMER_QUEUED_OUTPUT_MISSING');
    assign(queue.filter((_, outputIndex) => outputIndex !== index));
    releaseUncommittedReliableIngress(env, [output], []);
    return output;
  };
  return take(env.pendingOutputs ?? [], (remaining) => { env.pendingOutputs = remaining; })
    ?? take(env.networkInbox ?? [], (remaining) => { env.networkInbox = remaining; })
    ?? take(env.pendingNetworkOutputs ?? [], (remaining) => { env.pendingNetworkOutputs = remaining; })
    ?? take(env.runtimeMempool.entityInputs, (remaining) => { env.runtimeMempool.entityInputs = remaining; });
};

const offersCommitted = (
  env: RuntimeReplica,
  leftEntityId: string,
  rightEntityId: string,
  offerIds: readonly string[],
): boolean => {
  const left = findReplica(env, leftEntityId)[1].state.accounts.get(rightEntityId);
  const right = findReplica(env, rightEntityId)[1].state.accounts.get(leftEntityId);
  return Boolean(left && right && offerIds.every(id =>
    left.state.swapOffers.has(id) && right.state.swapOffers.has(id)
  ));
};

const frameTxTypes = (frame: AccountFrame | undefined): string[] =>
  frame?.accountTxs.map((tx) => tx.type) ?? [];

const accountEvidenceSummary = (account: AccountReplica | undefined) => ({
  status: account?.status,
  pendingFrameTxs: frameTxTypes(account?.pendingFrame),
  mempool: account?.mempool,
});

const findAccountAck = (txs: readonly EntityTx[] | undefined): AccountAckInput | undefined => {
  for (const tx of txs ?? []) {
    if (tx.type === 'accountInput' && tx.data.kind === 'ack') return structuredClone(tx.data);
    if (tx.type === 'consensusOutput' || tx.type === 'runtimeOutput') {
      const nested = findAccountAck(tx.data.entityTxs);
      if (nested) return nested;
    }
  }
  return undefined;
};

const findSwapProposal = (
  txs: readonly EntityTx[] | undefined,
  fromEntityId: string,
  toEntityId: string,
  offerId: string,
): AccountProposalInput | undefined => {
  for (const tx of txs ?? []) {
    if (tx.type === 'accountInput' && (tx.data.kind === 'frame' || tx.data.kind === 'frame_ack')) {
      const matchesParticipants = tx.data.fromEntityId === fromEntityId && tx.data.toEntityId === toEntityId;
      const containsOffer = tx.data.proposal.frame.accountTxs.some((accountTx) =>
        accountTx.type === 'swap_offer' && accountTx.data.offerId === offerId
      );
      if (matchesParticipants && containsOffer) return structuredClone(tx.data);
    }
    if (tx.type === 'consensusOutput' || tx.type === 'runtimeOutput') {
      const nested = findSwapProposal(tx.data.entityTxs, fromEntityId, toEntityId, offerId);
      if (nested) return nested;
    }
  }
  return undefined;
};

const takePendingSwapProposal = (
  env: RuntimeReplica,
  fromEntityId: string,
  toEntityId: string,
  offerId: string,
): AccountProposalInput | undefined => {
  const output = takeQueuedEnvelope(env, (candidate) =>
    findSwapProposal(candidate.entityTxs, fromEntityId, toEntityId, offerId) !== undefined
  );
  if (!output) return undefined;
  const proposal = findSwapProposal(output.entityTxs, fromEntityId, toEntityId, offerId);
  if (!proposal) throw new Error(`DISPUTE_TRANSFORMER_SWAP_PROPOSAL_MISSING:${offerId}`);
  return proposal;
};

const capturePendingSwapProposal = async (
  env: RuntimeReplica,
  withheldAdvances: Parameters<typeof withholdScenarioLocalHtlcAdvances>[1],
  fromEntityId: string,
  toEntityId: string,
  offerId: string,
): Promise<AccountProposalInput> => {
  const process = await getProcess();
  for (let cycle = 0; cycle < 24; cycle += 1) {
    withholdScenarioLocalHtlcAdvances(env, withheldAdvances);
    const proposal = takePendingSwapProposal(env, fromEntityId, toEntityId, offerId);
    if (proposal) return proposal;
    await process(env);
  }
  throw new Error(`DISPUTE_TRANSFORMER_SWAP_PROPOSAL_NOT_QUEUED:${offerId}`);
};

const captureQueuedAck = (env: RuntimeReplica, toEntityId: string): AccountAckInput | undefined => {
  const queues = [
    env.pendingOutputs ?? [],
    env.networkInbox ?? [],
    env.pendingNetworkOutputs ?? [],
    env.runtimeMempool.entityInputs,
  ];
  for (const queue of queues) {
    for (const envelope of queue) {
      const ack = findAccountAck(envelope.entityTxs);
      if (ack?.toEntityId === toEntityId) return ack;
    }
  }
  return undefined;
};

const requirePendingResolution = (account: AccountReplica | undefined, side: string): AccountFrame => {
  const frame = account?.pendingFrame;
  const types = frameTxTypes(frame);
  if (!frame || !types.includes('htlc_resolve') || !types.includes('swap_resolve')) {
    throw new Error(`DISPUTE_TRANSFORMER_PENDING_FRAME_MISSING:${side}:${types.join(',') || 'none'}`);
  }
  return frame;
};

const requirePendingSwapResolution = (
  frame: AccountFrame,
  offerId: string,
  expectedFillRatio: number,
): void => {
  const resolution = frame.accountTxs.find((tx) =>
    tx.type === 'swap_resolve' && tx.data.offerId === offerId
  );
  if (resolution?.type !== 'swap_resolve') {
    throw new Error(`DISPUTE_TRANSFORMER_MATCHER_RESOLUTION_MISSING:${offerId}`);
  }
  if (resolution.data.fillRatio !== expectedFillRatio) {
    throw new Error(
      `DISPUTE_TRANSFORMER_MATCHER_RATIO_MISMATCH:${offerId}:` +
      `${resolution.data.fillRatio}:${expectedFillRatio}`,
    );
  }
};

const containsPartitionedAccountInput = (
  txs: readonly EntityTx[] | undefined,
  leftEntityId: string,
  rightEntityId: string,
): boolean => {
  for (const tx of txs ?? []) {
    if (tx.type === 'accountInput') {
      const participants = new Set([tx.data.fromEntityId, tx.data.toEntityId]);
      if (participants.size === 2 && participants.has(leftEntityId) && participants.has(rightEntityId)) return true;
    }
    if (
      (tx.type === 'consensusOutput' || tx.type === 'runtimeOutput')
      && containsPartitionedAccountInput(tx.data.entityTxs, leftEntityId, rightEntityId)
    ) return true;
  }
  return false;
};

const dropPartitionedOutputs = (
  env: RuntimeReplica,
  leftEntityId: string,
  rightEntityId: string,
): void => {
  const keep = (output: { entityTxs?: EntityTx[] }): boolean =>
    !containsPartitionedAccountInput(output.entityTxs, leftEntityId, rightEntityId);
  env.pendingOutputs = (env.pendingOutputs ?? []).filter(keep);
  env.networkInbox = (env.networkInbox ?? []).filter(keep);
  env.pendingNetworkOutputs = (env.pendingNetworkOutputs ?? []).filter(keep);
  env.runtimeMempool.entityInputs = env.runtimeMempool.entityInputs.filter(keep);
};

const countOrderbookRows = (env: RuntimeReplica, offerIds: ReadonlySet<string>): number => {
  let rows = 0;
  for (const replica of env.state.eReplicas.values()) {
    for (const book of replica.state.orderbookExt?.books?.values() ?? []) {
      for (const orderId of book.orders.keys()) {
        if ([...offerIds].some((offerId) => orderId === offerId || orderId.endsWith(`:${offerId}`))) rows++;
      }
    }
  }
  return rows;
};

const orderbookRowsByEntity = (
  env: RuntimeReplica,
  offerIds: ReadonlySet<string>,
): Record<string, string[]> => Object.fromEntries(
  [...env.state.eReplicas.values()].map((replica) => [
    replica.state.entityId.slice(-4),
    [...(replica.state.orderbookExt?.books?.values() ?? [])]
      .flatMap((book) => [...book.orders.keys()])
      .filter((orderId) =>
        [...offerIds].some((offerId) => orderId === offerId || orderId.endsWith(`:${offerId}`))
      ),
  ]),
);

const advancePastDisputeTimeout = async (
  env: RuntimeReplica,
  jadapter: JAdapter,
  timeoutUnixSeconds: number,
) => {
  const provider = jadapter.provider as unknown as Partial<MineableProvider>;
  if (typeof provider.send !== 'function') {
    throw new Error('DISPUTE_TRANSFORMER_EVM_TIME_REQUIRED');
  }
  const advanced = await advanceRpcToUnixSeconds(
    { send: provider.send.bind(provider) },
    timeoutUnixSeconds,
  );
  syncRuntimeToUnixSeconds(env, timeoutUnixSeconds);
  return advanced;
};

const transformerClauseArguments = (encoded: string, context: string): string => {
  if (encoded === '0x') throw new Error(`DISPUTE_TRANSFORMER_ARGUMENTS_EMPTY:${context}`);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [clauses] = coder.decode(['bytes[]'], encoded) as unknown as [string[]];
  const clause = clauses[0];
  if (!clause) throw new Error(`DISPUTE_TRANSFORMER_CLAUSE_MISSING:${context}`);
  return clause;
};

const decodeArguments = (encoded: string, context: string): DecodedArguments => {
  const clause = transformerClauseArguments(encoded, context);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [decoded] = coder.decode(
    ['tuple(uint16[] fillRatios,bytes32[] secrets)'],
    clause,
  ) as unknown as [{ fillRatios: readonly bigint[]; secrets: readonly string[] }];
  // ethers Result loses named keys under object-spread; copy fields explicitly.
  return {
    fillRatios: Array.from(decoded.fillRatios, (ratio) => BigInt(ratio)),
    secrets: Array.from(decoded.secrets, String),
    pulls: [],
  };
};

const deltaByToken = (frame: AccountFrame, tokenId: number) => {
  const delta = frame.deltas.find((entry) => entry.tokenId === tokenId);
  if (!delta) throw new Error(`DISPUTE_TRANSFORMER_FRAME_DELTA_MISSING:${tokenId}`);
  return delta;
};

const currentDelta = (account: AccountReplica, tokenId: number) => {
  const delta = account.state.deltas.get(tokenId);
  if (!delta) throw new Error(`DISPUTE_TRANSFORMER_BASE_DELTA_MISSING:${tokenId}`);
  return delta;
};

const combinedPendingOffdelta = (
  base: AccountReplica,
  aliceFrame: AccountFrame,
  hubFrame: AccountFrame,
  tokenId: number,
): bigint => {
  const initial = currentDelta(base, tokenId).offdelta;
  return deltaByToken(aliceFrame, tokenId).offdelta + deltaByToken(hubFrame, tokenId).offdelta - initial;
};

const readDebtOutstanding = async (jadapter: JAdapter, entityId: string, tokenId: number): Promise<bigint> =>
  BigInt(await jadapter.depository.debtOutstanding(entityId, tokenId));

export async function runDisputeTransformer(_existingEnv?: RuntimeReplica): Promise<RuntimeReplica> {
  const process = await getProcess();
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'dispute-transformer',
    signerIds: ['2', '3', '4', '5'],
    seed: 'dispute-transformer-deterministic',
    ...(_existingEnv?.scenarioJAdapterMode ? { mode: _existingEnv.scenarioJAdapterMode } : {}),
  });
  env.quietRuntimeLogs = true;
  env.scenarioLogLevel = 'info';
  const restoreStrict = enableStrictScenario(env, 'dispute-transformer');

  try {
    const registered = await registerEntities(env, jadapter, [
      { name: 'Alice', signer: '2', position: { x: -20, y: -30, z: 0 } },
      { name: 'Hub', signer: '3', position: { x: 20, y: -30, z: 0 } },
      { name: 'Bob', signer: '4', position: { x: 40, y: -10, z: 0 } },
      { name: 'Carol', signer: '5', position: { x: -40, y: -10, z: 0 } },
    ], jurisdiction) as Registered[];
    const alice = requireRegistered(registered[0], 'Alice');
    const hub = requireRegistered(registered[1], 'Hub');
    const bob = requireRegistered(registered[2], 'Bob');
    const carol = requireRegistered(registered[3], 'Carol');
    assert(alice.id.toLowerCase() < hub.id.toLowerCase(), 'Alice must be canonical left', env);

    await fundEntities(env, jadapter, [
      { id: alice.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: hub.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: alice.id, tokenId: WETH, amount: 100n * 10n ** 18n },
      { id: hub.id, tokenId: WETH, amount: 100n * 10n ** 18n },
      { id: bob.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: carol.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: bob.id, tokenId: WETH, amount: 100n * 10n ** 18n },
      { id: carol.id, tokenId: WETH, amount: 100n * 10n ** 18n },
    ]);

    await process(env, [
      {
        entityId: alice.id,
        signerId: alice.signer,
        entityTxs: [{ type: 'openAccount', data: {
          targetEntityId: hub.id,
          disputeConfig: defaultAccountDisputeConfigForParties(alice.id, false, hub.id, true),
        } }],
      },
      {
        entityId: bob.id,
        signerId: bob.signer,
        entityTxs: [{ type: 'openAccount', data: {
          targetEntityId: hub.id,
          disputeConfig: defaultAccountDisputeConfigForParties(bob.id, false, hub.id, true),
        } }],
      },
      {
        entityId: carol.id,
        signerId: carol.signer,
        entityTxs: [{ type: 'openAccount', data: {
          targetEntityId: alice.id,
          disputeConfig: defaultAccountDisputeConfigForParties(carol.id, false, alice.id, false),
        } }],
      },
    ]);
    await converge(env, 12);
    await process(env, [
      {
        entityId: alice.id,
        signerId: alice.signer,
        entityTxs: [
          { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: usd(1_000_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: WETH, amount: 100n * 10n ** 18n } },
          { type: 'extendCredit', data: { counterpartyEntityId: carol.id, tokenId: USDC, amount: usd(1_000_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: carol.id, tokenId: WETH, amount: 100n * 10n ** 18n } },
        ],
      },
      {
        entityId: hub.id,
        signerId: hub.signer,
        entityTxs: [
          { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: USDC, amount: usd(1_000_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: WETH, amount: 100n * 10n ** 18n } },
          { type: 'extendCredit', data: { counterpartyEntityId: bob.id, tokenId: USDC, amount: usd(1_000_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: bob.id, tokenId: WETH, amount: 100n * 10n ** 18n } },
        ],
      },
      {
        entityId: bob.id,
        signerId: bob.signer,
        entityTxs: [
          { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: usd(1_000_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: WETH, amount: 100n * 10n ** 18n } },
        ],
      },
      {
        entityId: carol.id,
        signerId: carol.signer,
        entityTxs: [
          { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: USDC, amount: usd(1_000_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: WETH, amount: 100n * 10n ** 18n } },
        ],
      },
    ]);
    await converge(env, 16);

    const { DEFAULT_SPREAD_DISTRIBUTION } = await import('../orderbook');
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'initOrderbookExt',
        data: {
          name: 'Dispute matcher hub',
          spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
          referenceTokenId: USDC,
          usdQuoteAuthorityEntityId: alice.id,
          minTradeSize: 0n,
          supportedPairs: ['1/2'],
        },
      }],
    }]);
    await converge(env, 8);

    // Capture one genuine, quorum-sealed ACK and let the original delivery
    // settle normally. Replaying this exact ACK after disputeStart proves the
    // frozen Account gate rejects late/retried transport input, not merely a
    // hand-written test fixture.
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC,
          amount: usd(11),
          route: [hub.id, alice.id],
          deliveryMode: 'direct',
          description: 'signed-base-payment-and-late-ack-source',
        },
      }],
    }]);
    let lateAck: AccountAckInput | undefined;
    for (let round = 0; round < 16; round += 1) {
      lateAck ??= captureQueuedAck(env, hub.id);
      await process(env);
    }
    await converge(env, 16);
    assert(!!lateAck, 'Failed to capture a real signed ACK for late-delivery replay', env);

    const aliceSecret = ethers.keccak256(ethers.toUtf8Bytes('dispute-transformer:alice-secret'));
    const hubSecret = ethers.keccak256(ethers.toUtf8Bytes('dispute-transformer:hub-secret'));
    const aliceHashlock = hashHtlcSecret(aliceSecret);
    const hubHashlock = hashHtlcSecret(hubSecret);
    advanceScenarioTime(
      env,
      Number(SCENARIO_DEADLINE_MS) - ASYNC_PAYMENT_EXPIRY_MS - env.state.timestamp,
      true,
    );
    const withheldAdvances = [
      { entityId: hub.id, signerId: hub.signer, hashlock: aliceHashlock },
      { entityId: alice.id, signerId: alice.signer, hashlock: hubHashlock },
    ] as const;
    const giveAmount = MAX_FILL_RATIO * WETH_LOT;
    const aliceWantAmount = MAX_FILL_RATIO * 3_000n;
    const hubGiveAmount = 32_768n * WETH_LOT;
    const hubWantAmount = 32_768n * 3_100n;

    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        withDeterministicHtlcTestSecret({
          type: 'htlcPayment',
          data: {
            targetEntityId: hub.id,
            route: [alice.id, hub.id],
            tokenId: USDC,
            amount: usd(7),
            maxSenderDebit: quoteHtlcPaymentRoute(env.gossip.getProfiles(), [alice.id, hub.id], USDC, usd(7)).senderLockAmount,
            deliveryMode: 'async',
            hashlock: aliceHashlock,
            description: 'dispute-transformer-alice-lock',
          },
        }, aliceSecret),
        { type: 'placeSwapOffer', data: { counterpartyEntityId: hub.id, offerId: 'alice-maker-left', giveTokenId: WETH, giveAmount, wantTokenId: USDC, wantAmount: aliceWantAmount, ...deriveSwapNetAuthorization(aliceWantAmount, 1) } },
      ],
    }]);
    await processUntilWithoutLocalHtlcAdvance(
      env,
      withheldAdvances,
      () => findCommittedScenarioHtlcLockId(env, alice.id, hub.id, aliceHashlock) !== undefined
        && offersCommitted(env, alice.id, hub.id, ['alice-maker-left']),
    );
    const aliceLockId = findCommittedScenarioHtlcLockId(env, alice.id, hub.id, aliceHashlock);
    if (!aliceLockId) throw new Error('DISPUTE_TRANSFORMER_ALICE_LOCK_NOT_COMMITTED');
    assert(
      findReplica(env, alice.id)[1].state.orderbookExt === undefined,
      'User Entity commits the maker offer without becoming a matcher',
      env,
    );
    assert(
      countOrderbookRows(env, new Set(['alice-maker-left'])) === 1,
      'Hub matcher owns the single canonical book row',
      env,
    );

    // Initialize the second independent matcher only after Alice's historical
    // maker commit. Its empty book will later contain only Hub's maker.
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'initOrderbookExt',
        data: {
          name: 'Dispute matcher alice',
          spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
          referenceTokenId: USDC,
          usdQuoteAuthorityEntityId: hub.id,
          minTradeSize: 0n,
          supportedPairs: ['1/2'],
        },
      }],
    }]);
    await processUntilWithoutLocalHtlcAdvance(
      env,
      withheldAdvances,
      () => findReplica(env, alice.id)[1].state.orderbookExt !== undefined,
      12,
    );

    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        withDeterministicHtlcTestSecret({
          type: 'htlcPayment',
          data: {
            targetEntityId: alice.id,
            route: [hub.id, alice.id],
            tokenId: USDC,
            amount: usd(3),
            maxSenderDebit: quoteHtlcPaymentRoute(env.gossip.getProfiles(), [hub.id, alice.id], USDC, usd(3)).senderLockAmount,
            deliveryMode: 'async',
            hashlock: hubHashlock,
            description: 'dispute-transformer-hub-lock',
          },
        }, hubSecret),
        {
          type: 'placeSwapOffer',
          data: {
            counterpartyEntityId: alice.id,
            offerId: 'hub-maker-right',
            giveTokenId: WETH,
            giveAmount: hubGiveAmount,
            wantTokenId: USDC,
            wantAmount: hubWantAmount,
            ...deriveSwapNetAuthorization(hubWantAmount, 1),
          },
        },
      ],
    }]);
    await processUntilWithoutLocalHtlcAdvance(
      env,
      withheldAdvances,
      () => findCommittedScenarioHtlcLockId(env, alice.id, hub.id, hubHashlock) !== undefined
        && offersCommitted(env, alice.id, hub.id, ['alice-maker-left', 'hub-maker-right']),
    );
    const hubLockId = findCommittedScenarioHtlcLockId(env, alice.id, hub.id, hubHashlock);
    if (!hubLockId) throw new Error('DISPUTE_TRANSFORMER_HUB_LOCK_NOT_COMMITTED');

    withholdScenarioLocalHtlcAdvances(env, withheldAdvances);

    // Produce the exact signed peer proposals that the two independent
    // matchers consume. We intercept them before delivery so the opposing
    // HTLC resolution enters the same Entity frame as matcher-generated
    // swap_resolve. No scenario-only Account frame or state mutation exists.
    await process(env, [{
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          counterpartyEntityId: hub.id,
          offerId: 'bob-taker-hub',
          giveTokenId: USDC,
          giveAmount: 16_384n * 3_000n,
          wantTokenId: WETH,
          wantAmount: 16_384n * WETH_LOT,
          ...deriveSwapNetAuthorization(16_384n * WETH_LOT, 1),
        },
      }],
    }]);
    const bobProposal = await capturePendingSwapProposal(
      env,
      withheldAdvances,
      bob.id,
      hub.id,
      'bob-taker-hub',
    );

    await process(env, [{
      entityId: carol.id,
      signerId: carol.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          counterpartyEntityId: alice.id,
          offerId: 'carol-taker-alice',
          giveTokenId: USDC,
          giveAmount: 32_768n * 3_100n,
          wantTokenId: WETH,
          wantAmount: 32_768n * WETH_LOT,
          ...deriveSwapNetAuthorization(32_768n * WETH_LOT, 1),
        },
      }],
    }]);
    const carolProposal = await capturePendingSwapProposal(
      env,
      withheldAdvances,
      carol.id,
      alice.id,
      'carol-taker-alice',
    );

    const base = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    assert(!!base, 'Base bilateral account missing', env);
    assert(
      currentDelta(base!, USDC).offdelta === usd(11),
      `Signed base payment mismatch actual=${currentDelta(base!, USDC).offdelta} expected=${usd(11)}`,
      env,
    );
    const baseHeight = base!.currentHeight;
    const baseProofHash = findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.counterpartyDisputeProofBodyHash;
    assert(!!baseProofHash, 'Last mutually signed dispute ProofBody missing', env);
    await process(env, [
      {
        entityId: alice.id,
        signerId: alice.signer,
        entityTxs: [
          { type: 'accountInput', data: carolProposal },
          { type: 'resolveHtlcLock', data: { counterpartyEntityId: hub.id, lockId: hubLockId, secret: hubSecret } },
        ],
      },
      {
        entityId: hub.id,
        signerId: hub.signer,
        entityTxs: [
          { type: 'accountInput', data: bobProposal },
          { type: 'resolveHtlcLock', data: { counterpartyEntityId: alice.id, lockId: aliceLockId, secret: aliceSecret } },
        ],
      },
    ]);
    dropPartitionedOutputs(env, alice.id, hub.id);
    for (let round = 0; round < 8; round += 1) {
      const aliceAccount = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
      const hubAccount = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
      if (aliceAccount?.pendingFrame && hubAccount?.pendingFrame) break;
      await process(env);
      dropPartitionedOutputs(env, alice.id, hub.id);
    }

    const alicePending = requirePendingResolution(findReplica(env, alice.id)[1].state.accounts.get(hub.id), 'alice');
    const hubPending = requirePendingResolution(findReplica(env, hub.id)[1].state.accounts.get(alice.id), 'hub');
    requirePendingSwapResolution(alicePending, 'hub-maker-right', 65_535);
    requirePendingSwapResolution(hubPending, 'alice-maker-left', 16_384);
    console.log(`[DISPUTE_DEBUG:pending-evidence] ${safeStringify({
      alice: accountEvidenceSummary(findReplica(env, alice.id)[1].state.accounts.get(hub.id)),
      hub: accountEvidenceSummary(findReplica(env, hub.id)[1].state.accounts.get(alice.id)),
    })}`);
    const baseAccount = base!;

    const before = new Map<number, { leftReserve: bigint; rightReserve: bigint; collateral: bigint; ondelta: bigint; offdelta: bigint }>();
    for (const tokenId of [USDC, WETH]) {
      before.set(tokenId, {
        leftReserve: await jadapter.getReserves(alice.id, tokenId),
        rightReserve: await jadapter.getReserves(hub.id, tokenId),
        collateral: await jadapter.getCollateral(alice.id, hub.id, tokenId),
        ondelta: currentDelta(baseAccount, tokenId).ondelta,
        offdelta: combinedPendingOffdelta(baseAccount, alicePending, hubPending, tokenId),
      });
    }

    dropPartitionedOutputs(env, alice.id, hub.id);
    await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [{
      type: 'prepareDispute', data: { counterpartyEntityId: alice.id, description: 'mixed-transformer-prepare' },
    }] }]);
    const prepared = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(prepared?.status === 'disputed', 'Ready dispute preparation did not auto-draft disputeStart', env);
    assert(prepared.pendingFrame === undefined, 'Prepare retained an optimistic pending frame', env);
    assert(prepared.currentHeight === baseHeight, 'Prepare changed committed Account height', env);
    assert(prepared.counterpartyDisputeProofBodyHash === baseProofHash, 'Prepare changed signed ProofBody', env);
    console.log(`[DISPUTE_DEBUG:book-rows-after-prepare] ${safeStringify(
      orderbookRowsByEntity(env, new Set(['alice-maker-left', 'hub-maker-right'])),
    )}`);
    assert(
      countOrderbookRows(env, new Set(['alice-maker-left', 'hub-maker-right'])) === 0,
      'Prepare left a disputed swap in an orderbook',
      env,
    );
    assert(
      (prepared.disputePrepare?.pendingOrderbookRemovalIds?.length ?? 0) === 0,
      'Prepare still awaits remote orderbook removal',
      env,
    );
    const start = findReplica(env, hub.id)[1].state.jBatchState?.batch.disputeStarts[0];
    if (!start) throw new Error('DISPUTE_TRANSFORMER_START_NOT_DRAFTED');
    assert(start.proofbodyHash === baseProofHash, 'Dispute start did not use the last mutually signed ProofBody', env);
    const starter = decodeArguments(start.starterInitialArguments, 'starter.initial');
    const signedSnapshot = prepared.disputeArgumentSnapshotsByHash?.[start.proofbodyHash];
    console.log(`[DISPUTE_DEBUG:start] ${safeStringify({
      nonce: start.nonce,
      proofbodyHash: start.proofbodyHash,
      proofBodyStruct: signedSnapshot?.proofBodyStruct,
      argumentPlan: signedSnapshot?.plan,
      starterInitialArguments: start.starterInitialArguments,
      starterCounterArguments: start.starterCounterArguments,
      decoded: starter,
    })}`);
    assert(starter.fillRatios.some((ratio) => ratio > 0n), 'Starter swap fill argument missing', env);
    assert(starter.secrets.map((secret) => secret.toLowerCase()).includes(aliceSecret.toLowerCase()), 'Starter HTLC secret missing', env);

    const frozenBeforeLateAck = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    const frozenHeight = frozenBeforeLateAck?.currentHeight;
    const frozenProofHash = frozenBeforeLateAck?.counterpartyDisputeProofBodyHash;
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{ type: 'accountInput', data: lateAck! }],
    }]);
    const frozenAfterLateAck = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(frozenAfterLateAck?.status === 'disputed', 'Late ACK reopened the disputed Account', env);
    assert(frozenAfterLateAck?.currentHeight === frozenHeight, 'Late ACK changed frozen Account height', env);
    assert(
      frozenAfterLateAck?.counterpartyDisputeProofBodyHash === frozenProofHash,
      'Late ACK changed the selected dispute ProofBody',
      env,
    );
    assert(
      findReplica(env, hub.id)[1].state.jBatchState?.batch.disputeStarts.length === 1,
      'Late ACK drafted a second dispute start',
      env,
    );

    console.log(`[DISPUTE_DEBUG:before-start-broadcast] ${safeStringify({
      alice: accountEvidenceSummary(findReplica(env, alice.id)[1].state.accounts.get(hub.id)),
      hub: accountEvidenceSummary(findReplica(env, hub.id)[1].state.accounts.get(alice.id)),
    })}`);

    // Anvil automining derives a block timestamp from elapsed host time even
    // when genesis is fixed. Pin the economically relevant dispute-start block
    // so repeated runs exercise identical transformer windows and J-event bytes.
    const disputeProvider = jadapter.provider as unknown as Partial<MineableProvider>;
    if (typeof disputeProvider.send !== 'function') {
      throw new Error('dispute-transformer requires RPC provider timestamp control');
    }
    await disputeProvider.send('evm_setNextBlockTimestamp', [DETERMINISTIC_DISPUTE_START_UNIX]);

    await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] }]);
    await syncChain(env, 5);
    console.log(`[DISPUTE_DEBUG:before-start-event] ${safeStringify({
      alice: accountEvidenceSummary(findReplica(env, alice.id)[1].state.accounts.get(hub.id)),
      hub: accountEvidenceSummary(findReplica(env, hub.id)[1].state.accounts.get(alice.id)),
    })}`);
    await processJEvents(env);
    console.log(`[DISPUTE_DEBUG:after-start-event] ${safeStringify({
      alice: accountEvidenceSummary(findReplica(env, alice.id)[1].state.accounts.get(hub.id)),
      hub: accountEvidenceSummary(findReplica(env, hub.id)[1].state.accounts.get(alice.id)),
    })}`);
    await converge(env, 12);
    const aliceActive = findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.activeDispute;
    if (!aliceActive) throw new Error('DISPUTE_TRANSFORMER_ACTIVE_DISPUTE_MISSING');
    const disputeStartUnix = Number(aliceActive.disputeStartTimestamp || 0);
    const timeoutUnix = Number(aliceActive.disputeTimeout || 0);
    assert(disputeStartUnix > 0 && timeoutUnix > disputeStartUnix, 'Active dispute missing absolute unix clock', env);
    const timeAdvance = await advancePastDisputeTimeout(env, jadapter, timeoutUnix);
    // Entity clocks only move inside a signed frame; wake once after the jump.
    await process(env);
    console.log(`[DISPUTE_DEBUG:timeout-advance] ${safeStringify({
      ...timeAdvance,
      runtimeTs: env.state.timestamp,
      aliceEntityTs: findReplica(env, alice.id)[1].state.timestamp,
    })}`);

    const aliceBeforeFinalizeState = findReplica(env, alice.id)[1].state;
    const aliceBeforeFinalize = aliceBeforeFinalizeState.accounts.get(hub.id);
    console.log(`[DISPUTE_DEBUG:finalizer-account] ${safeStringify({
      ...accountEvidenceSummary(aliceBeforeFinalize),
      readyAfter: aliceBeforeFinalize?.disputePrepare?.readyAfter,
      pendingOrderbookRemovalIds: aliceBeforeFinalize?.disputePrepare?.pendingOrderbookRemovalIds,
      jBatch: {
        draftFinalizations: aliceBeforeFinalizeState.jBatchState?.batch.disputeFinalizations?.length ?? 0,
        sentFinalizations:
          aliceBeforeFinalizeState.jBatchState?.sentBatch?.batch.disputeFinalizations?.length ?? 0,
        hasSentBatch: Boolean(aliceBeforeFinalizeState.jBatchState?.sentBatch),
        sentEntityNonce: aliceBeforeFinalizeState.jBatchState?.sentBatch?.entityNonce,
      },
      activeDispute: aliceBeforeFinalize?.activeDispute,
    })}`);

    const readAliceFinalization = () => {
      const state = findReplica(env, alice.id)[1].state;
      return (
        state.jBatchState?.batch.disputeFinalizations[0]
        ?? state.jBatchState?.sentBatch?.batch.disputeFinalizations[0]
      );
    };

    let finalization = readAliceFinalization();
    if (!finalization) {
      await process(env, [{ entityId: alice.id, signerId: alice.signer, entityTxs: [{
        type: 'disputeFinalize', data: { counterpartyEntityId: hub.id, description: 'mixed-transformer-finalize' },
      }] }]);
      finalization = readAliceFinalization();
    }
    const aliceAfterFinalizeAttempt = findReplica(env, alice.id)[1].state;
    if (!finalization) {
      throw new Error(
        `DISPUTE_TRANSFORMER_FINALIZATION_NOT_DRAFTED:` +
        `runtimeTs=${env.state.timestamp}:entityTs=${aliceAfterFinalizeAttempt.timestamp}:` +
        `timeout=${timeoutUnix}:finalizeQueued=${String(
          aliceAfterFinalizeAttempt.accounts.get(hub.id)?.activeDispute?.finalizeQueued,
        )}:jBatch=${safeStringify({
          draft: aliceAfterFinalizeAttempt.jBatchState?.batch.disputeFinalizations?.length ?? 0,
          sent: aliceAfterFinalizeAttempt.jBatchState?.sentBatch?.batch.disputeFinalizations?.length ?? 0,
          hasSentBatch: Boolean(aliceAfterFinalizeAttempt.jBatchState?.sentBatch),
        })}`,
      );
    }
    const finalizer = decodeArguments(finalization.otherArguments, 'finalizer.other');
    console.log(`[DISPUTE_DEBUG:finalize] ${safeStringify({
      initialNonce: finalization.initialNonce,
      finalNonce: finalization.finalNonce,
      initialProofbodyHash: finalization.initialProofbodyHash,
      starterArguments: finalization.starterArguments,
      otherArguments: finalization.otherArguments,
      decoded: finalizer,
    })}`);
    assert(finalizer.fillRatios.some((ratio) => ratio > 0n), 'Finalizer swap fill argument missing', env);
    assert(finalizer.secrets.map((secret) => secret.toLowerCase()).includes(hubSecret.toLowerCase()), 'Finalizer HTLC secret missing', env);

    // Timeout wake may already auto-draft + broadcast finalize into sentBatch.
    const aliceBatch = findReplica(env, alice.id)[1].state.jBatchState;
    const finalizeAlreadySent = (aliceBatch?.sentBatch?.batch.disputeFinalizations?.length ?? 0) > 0;
    if (!finalizeAlreadySent) {
      await process(env, [{ entityId: alice.id, signerId: alice.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] }]);
    }
    await syncChain(env, 8);
    await processJEvents(env);
    await converge(env, 12);

    const clampedDeltas = await jadapter.depository.queryFilter(
      jadapter.depository.filters.TransformerDeltaClamped(),
    );
    console.log(`[DISPUTE_DEBUG:transformers] ${safeStringify({
      clamped: clampedDeltas.map((entry) => ({ blockNumber: entry.blockNumber, args: Array.from(entry.args) })),
    })}`);
    assert(clampedDeltas.length === 0, `Transformer clamped ${clampedDeltas.length} delta(s)`, env);

    // Derive the Account input from the exact signed executable program, not
    // from optimistic pending frames. Pending frames describe candidate RJEA
    // state; dispute finality executes finalProofbody + side-timestamped args,
    // including HTLC payments that never became a bilateral frame.
    const finalProofbody = finalization.finalProofbody;
    const transformer = finalProofbody.transformers[0];
    if (!transformer || finalProofbody.transformers.length !== 1) {
      throw new Error(`DISPUTE_TRANSFORMER_CANONICAL_CLAUSE_COUNT:${finalProofbody.transformers.length}`);
    }
    const finalizedBlock = await jadapter.provider.getBlock('latest');
    if (!finalizedBlock) throw new Error('DISPUTE_TRANSFORMER_FINALIZED_BLOCK_MISSING');
    const startedByLeft = finalization.startedByLeft;
    const transformed = await jadapter.deltaTransformer.applyBatch.staticCall(
      finalProofbody.offdeltas,
      finalProofbody.tokenIds,
      transformer.encodedBatch,
      transformerClauseArguments(
        startedByLeft ? finalization.starterArguments : finalization.otherArguments,
        'expected.left',
      ),
      transformerClauseArguments(
        startedByLeft ? finalization.otherArguments : finalization.starterArguments,
        'expected.right',
      ),
      startedByLeft ? disputeStartUnix : finalizedBlock.timestamp,
      startedByLeft ? finalizedBlock.timestamp : disputeStartUnix,
      alice.id,
      hub.id,
      disputeStartUnix,
      timeoutUnix,
      finalProofbody.leftResponseSeconds,
      finalProofbody.rightResponseSeconds,
    );
    const transformedByToken = new Map(
      finalProofbody.tokenIds.map((tokenId, index) => [Number(tokenId), transformed[index]!] as const),
    );

    for (const tokenId of [USDC, WETH]) {
      const baseInput = before.get(tokenId)!;
      const transformedOffdelta = transformedByToken.get(tokenId);
      if (transformedOffdelta === undefined) {
        throw new Error(`DISPUTE_TRANSFORMER_FINAL_DELTA_MISSING:${tokenId}`);
      }
      const input = { ...baseInput, offdelta: transformedOffdelta };
      const expected = deriveDisputeTokenFinalization({ tokenId, ...input });
      const actual = {
        leftReserve: await jadapter.getReserves(alice.id, tokenId),
        rightReserve: await jadapter.getReserves(hub.id, tokenId),
        leftDebt: await readDebtOutstanding(jadapter, alice.id, tokenId),
        rightDebt: await readDebtOutstanding(jadapter, hub.id, tokenId),
      };
      const expectedValues = {
        leftReserve: expected.after.reserves.left,
        rightReserve: expected.after.reserves.right,
        leftDebt: expected.after.debtOutstanding.left,
        rightDebt: expected.after.debtOutstanding.right,
      };
      console.log(`[DISPUTE_DEBUG:economics] ${safeStringify({ tokenId, input, expected: expectedValues, actual })}`);
      assert(actual.leftReserve === expectedValues.leftReserve, `Left reserve mismatch token=${tokenId} actual=${actual.leftReserve} expected=${expectedValues.leftReserve}`, env);
      assert(actual.rightReserve === expectedValues.rightReserve, `Right reserve mismatch token=${tokenId} actual=${actual.rightReserve} expected=${expectedValues.rightReserve}`, env);
      assert(actual.leftDebt === expectedValues.leftDebt, `Left debt mismatch token=${tokenId} actual=${actual.leftDebt} expected=${expectedValues.leftDebt}`, env);
      assert(actual.rightDebt === expectedValues.rightDebt, `Right debt mismatch token=${tokenId} actual=${actual.rightDebt} expected=${expectedValues.rightDebt}`, env);
      assert(expected.conservation.conserved, `Custody conservation failed for token ${tokenId}`, env);
    }

    console.log('✅ dispute-transformer passed: bilateral arguments + exact reserves/debts');
    return env;
  } finally {
    restoreStrict();
  }
}
