import { strict as assert } from 'node:assert';
import { ethers } from 'ethers';
import { buildPreparedCrossJurisdictionRoute, deriveCrossJurisdictionPrivateSeed, buildCrossJurisdictionPullReveal } from '../../../core/extensions/cross-j/index.ts';
import { verifyHashLadderBinary } from '../../../core/protocol/htlc/hash-ladder.ts';
import { resolveFinalizedPullFillRatio } from '../../../core/account/pull-registry-settlement.ts';
import { BATCH_ABI } from '../../../core/protocol/dispute/proof-body.ts';
import { encodeInt512, encodeSignedAmount } from '../../../core/protocol/crypto/abi-money.ts';
import { addr, entity, makeAccount, makeJurisdiction, jref } from '../../../core/__tests__/helpers/cross-j.ts';

const sourceJ = makeJurisdiction('source', 1, '11', '12');
const targetJ = makeJurisdiction('target', 2, '21', '22');
const seed = 'public-synthetic-review-source-hub-seed';
const route = buildPreparedCrossJurisdictionRoute({
  orderId: 'review-mainnet-delayed-source', makerEntityId: entity('01'), hubEntityId: entity('02'),
  sourceSignerId: addr('31'), sourceHubSignerId: addr('32'), targetHubSignerId: addr('33'), targetSignerId: addr('34'),
  source: { jurisdiction: jref(sourceJ), entityId: entity('01'), counterpartyEntityId: entity('02'), tokenId: 1, amount: 1000n },
  target: { jurisdiction: jref(targetJ), entityId: entity('03'), counterpartyEntityId: entity('04'), tokenId: 1, amount: 900n },
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  status: 'intent', createdAt: 1000, updatedAt: 1000, expiresAt: 61000,
}, { runtimeSeed: seed, now: 1000 });
const reveal = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed(seed, route));
const transformer = addr('44');
const results = {};
for (const [role, start, jurisdiction] of [['source', 110, sourceJ], ['target', 100, targetJ]] as const) {
  const leg = route[role];
  const pull = role === 'source' ? route.sourcePull! : route.targetPull!;
  assert.equal(verifyHashLadderBinary(pull, reveal.binary).fillRatio, 65535);
  const account = makeAccount(leg.entityId, leg.counterpartyEntityId, jurisdiction);
  account.activeDispute = { startedByLeft: true, initialProofbodyHash: entity('45'), initialNonce: 1,
    initialProposerIsLeft: true, disputeStartTimestamp: start, disputeTimeout: start + 20, jNonce: 1,
    starterInitialArguments: '0x', starterCounterArguments: '0x', starterCounterProofCommitment: entity('00'), observedOnChain: true };
  const body = { watchSeed: entity('43'), leftResponseSeconds: 10, rightResponseSeconds: 10,
    offdeltas: [encodeInt512(0n)], tokenIds: [1n], transformers: [{ transformerAddress: transformer,
      encodedBatch: ethers.AbiCoder.defaultAbiCoder().encode([ethers.ParamType.from(BATCH_ABI)], [{
        payment: [], swap: [], loans: [], pull: [{ deltaIndex: 0, amount: encodeSignedAmount(pull.signedAmount),
          claimedRatio: 0, fullHash: pull.fullHash, partialRoot: pull.partialRoot, targetRole: role === 'target' }],
      }]), allowances: [] }] };
  const ratio = resolveFinalizedPullFillRatio({ account, proofbody: body, expectedPull: pull,
    canonicalDeltaTransformerAddress: transformer, targetRole: role === 'target', record: { fillRatio: 65535, revealedAt: 120 } });
  results[role] = { start, windowEnd: start + 10, revealAt: 120, ratio, received: (pull.amount * BigInt(ratio) / 65535n).toString() };
}
assert.equal(results.source.received, '1000');
assert.equal(results.target.received, '0');
console.log(JSON.stringify({ reproduced: true, scope: 'production TS ladder verification and settlement projection; not a fresh on-chain exploit', results }, null, 2));
