import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { roundtripEvidence, roundtripFixture } from './usdc-reserve-roundtrip-support';
import { readVerificationInputs } from '../../../../../jurisdictions/scripts/deployment/operator/readonly-identity';
import { verifyRoundtripReceipts } from '../../../../../jurisdictions/scripts/usdc-reserve-roundtrip/transactions';
import { readCanonicalChainPoint } from '../../../../jurisdiction/adapter/stack-manager/receipts';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import type { Context } from '../../../../../jurisdictions/scripts/usdc-reserve-roundtrip/types';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { toQuantity } from 'ethers';

let fixture: Awaited<ReturnType<typeof roundtripFixture>>;
let original: Context;
let snapshot: string;
beforeAll(async () => {
  fixture = await roundtripFixture();
  await fixture.provider.send('evm_setIntervalMining', [1]);
  const evidence = await roundtripEvidence(fixture);
  if (evidence.status !== 'complete' || !evidence.entityId)
    throw new Error(`ROUNDTRIP_EVIDENCE_FAILED:${evidence.failure}`);
  await fixture.provider.send('evm_setIntervalMining', [0]);
  original = {
    options: {
      network: 'local',
      chainId: 31337,
      token: fixture.request.stablecoin.address,
      deploymentDir: fixture.nativeDirectory,
    },
    provider: fixture.provider,
    wallet: fixture.signer,
    input: await readVerificationInputs(fixture.nativeDirectory),
    depository: Depository__factory.connect(fixture.deployment.manifest.contracts.depository, fixture.signer),
    entityId: evidence.entityId,
    evidence,
    signal: new AbortController().signal,
  };
}, 180_000);
beforeEach(async () => {
  snapshot = await fixture.provider.send('evm_snapshot', []);
});
afterEach(async () => {
  await fixture.provider.send('evm_revert', [snapshot]);
});
afterAll(async () => {
  await fixture.close();
});

test('final evidence rejects an orphaned intermediate snapshot while every financial receipt remains canonical', async () => {
  const evidence = structuredClone(original.evidence);
  const deposited = evidence.snapshots.deposited;
  const restored = evidence.snapshots.restored;
  if (!deposited || !restored) throw new Error('ROUNDTRIP_EVIDENCE_SNAPSHOTS_REQUIRED');
  await fixture.provider.send('anvil_mine', ['0x1']);
  const orphan = await readCanonicalChainPoint(fixture.provider);
  evidence.snapshots.deposited = { ...deposited, point: orphan };
  await fixture.provider.send('evm_revert', [snapshot]);
  snapshot = await fixture.provider.send('evm_snapshot', []);
  await fixture.provider.send('evm_setNextBlockTimestamp', [
    Number((await fixture.provider.getBlock('latest'))!.timestamp) + 2,
  ]);
  await fixture.provider.send('anvil_mine', ['0x1']);
  expect((await readCanonicalChainPoint(fixture.provider)).hash).not.toBe(orphan.hash);
  await expect(verifyRoundtripReceipts({ ...original, evidence }, restored.point)).rejects.toThrow(
    'STACK_MANAGER_CANONICAL_SNAPSHOT_CONFLICT',
  );
  const deploymentEvidence = structuredClone(original.evidence);
  if (!deploymentEvidence.deployment) throw new Error('ROUNDTRIP_EVIDENCE_DEPLOYMENT_REQUIRED');
  deploymentEvidence.deployment = { ...deploymentEvidence.deployment, verifiedAt: orphan };
  await expect(verifyRoundtripReceipts({ ...original, evidence: deploymentEvidence }, restored.point)).rejects.toThrow(
    'STACK_MANAGER_CANONICAL_SNAPSHOT_CONFLICT',
  );
});

test.each([
  { name: 'failed raw status', target: 'receipt', field: 'status', value: '0x0' },
  { name: 'foreign raw transaction', target: 'receipt', field: 'transactionHash', value: 'foreign-transaction' },
  { name: 'changed raw gas usage', target: 'receipt', field: 'gasUsed', value: 'changed-quantity' },
  { name: 'changed raw gas price', target: 'receipt', field: 'effectiveGasPrice', value: 'changed-quantity' },
  { name: 'foreign expense transaction', target: 'expense', field: 'transactionHash', value: 'foreign-transaction' },
  { name: 'changed expense fee', target: 'expense', field: 'feeWei', value: 'changed-fee' },
] as const)('final evidence rejects $name from an actual confirmed receipt', async ({ target, field, value }) => {
  const evidence = structuredClone(original.evidence);
  const entry = evidence.transactions.find(transaction => transaction.stage === 'deposit');
  const restored = evidence.snapshots.restored;
  if (!entry || !restored) throw new Error('ROUNDTRIP_EVIDENCE_TRANSACTION_REQUIRED');
  const recorded = requireBoundaryRecord(entry[target], 'ROUNDTRIP_EVIDENCE_RECORD_REQUIRED');
  recorded[field] =
    value === 'foreign-transaction'
      ? evidence.transactions[0]!.hash
      : value === 'changed-fee'
        ? (BigInt(String(recorded[field])) + 1n).toString()
        : value === 'changed-quantity'
          ? toQuantity(BigInt(String(recorded[field])) + 1n)
          : value;
  await expect(verifyRoundtripReceipts({ ...original, evidence }, restored.point)).rejects.toThrow(
    /USDC_ROUNDTRIP_RECORDED_(RECEIPT|EXPENSE)_CHANGED/,
  );
});
