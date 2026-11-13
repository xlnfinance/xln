import { expect, test } from 'bun:test';
import { Transaction, Wallet, toBeHex, toQuantity, zeroPadValue, type TransactionReceipt } from 'ethers';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EntityProvider__factory } from '../../../../jurisdictions/typechain-types/factories/EntityProvider__factory';
import { safeStringify } from '../../../protocol/serialization';
import { until } from '../stack-manager-recovery/stack-manager-resume-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { observeRpc } from './standalone-deployment-rpc-support';
import { startStandaloneNode } from './standalone-deployment-support';
import {
  readJson,
  sends,
  waitForSends,
  type Fixture,
  type Session,
} from './standalone-deployment-transactions-support';

// Public, funded Anvil account 1 relays the already signed Foundation action.
// Hanko authority is unchanged, but executing nonce 0 first makes the original
// native transaction an adversarial replay of that consumed action nonce.
const relayerKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const foundationId = zeroPadValue(toBeHex(1), 32);

const interceptListing = (fixture: Fixture) => {
  let listing: Transaction | undefined;
  const observer = observeRpc(fixture, {
    before: async request => {
      if (request.method !== 'eth_sendRawTransaction') return;
      const transaction = Transaction.from(String(request.params[0]));
      if (transaction.nonce !== fixture.initialNonce + 10 || listing) return;
      expect(transaction.from?.toLowerCase()).toBe(fixture.signer.address.toLowerCase());
      listing = transaction;
      await fixture.provider.send('evm_setAutomine', [false]);
    },
  });
  return {
    ...observer,
    listing: () => {
      if (!listing?.hash || !listing.to || listing.maxFeePerGas === null || listing.maxPriorityFeePerGas === null) {
        throw new Error('REVERT_TEST_SIGNED_LISTING_MISSING');
      }
      return listing;
    },
  };
};

const relayListing = async (fixture: Fixture, native: Transaction) => {
  if (!native.to || native.maxFeePerGas === null || native.maxPriorityFeePerGas === null) {
    throw new Error('REVERT_TEST_LISTING_ENVELOPE_INVALID');
  }
  const relayer = new Wallet(relayerKey, fixture.provider);
  await fixture.provider.send('evm_setBlockGasLimit', [toQuantity(native.gasLimit)]);
  const relay = await relayer.sendTransaction({
    to: native.to,
    data: native.data,
    value: native.value,
    gasLimit: native.gasLimit,
    maxFeePerGas: native.maxFeePerGas * 4n + 1n,
    maxPriorityFeePerGas: native.maxPriorityFeePerGas * 4n + 1n,
  });
  await fixture.provider.send('anvil_mine', ['0x1']);
  const receipt = await fixture.provider.getTransactionReceipt(relay.hash);
  expect(receipt!.status).toBe(1);
  expect(await fixture.provider.getTransactionReceipt(native.hash!)).toBeNull();
  const ep = EntityProvider__factory.connect(native.to, fixture.provider);
  const foundationNonce = await ep.entityActionNonces(foundationId);
  expect(foundationNonce).toBe(1n);
  return { receipt: receipt!, foundationNonce };
};

const expectRejectedResume = async (
  fixture: Fixture,
  session: Session,
  before: number,
  code: string,
  stalled?: () => boolean,
) => {
  await until(
    async () => session.outcome() !== undefined || fixture.submissions() > before || Boolean(stalled?.()),
    code,
  );
  expect(fixture.submissions()).toBe(before);
  expect(session.outcome()).not.toBeUndefined();
  expect(await session.exited).not.toBe(0);
  expect(await session.log()).toContain(code);
  const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
  expect(result.status).toBe('failed');
  expect(result.phase).toBe('deploying');
  expect(result.error.code).toBe(code);
  return result;
};

const snapshotEvidence = async (fixture: Fixture) => {
  const paths = ['journal.jsonl', 'manifest.json.execution.json', 'manifest.json.listing.json'];
  return Promise.all(
    paths.map(async path => ({ path, bytes: await readFile(join(fixture.nativeDirectory, path), 'utf8') })),
  );
};

const assertExpenses = async (fixture: Fixture, initialBalance: bigint, result: any, failedHash: string) => {
  expect(result.expenses.broadcasts).toBe(11);
  expect(result.expenses.mined).toBe(11);
  const known = await sends(fixture);
  const receipts = await Promise.all(
    known.map(message => fixture.provider.getTransactionReceipt(message.transaction.hash)),
  );
  const fees = receipts.reduce((total, receipt) => total + receipt!.fee, 0n);
  expect(receipts.map(receipt => receipt!.status).filter(status => status === 0)).toEqual([0]);
  expect(BigInt(result.expenses.attemptTransactionFeesWei)).toBe(fees);
  expect(initialBalance - (await fixture.provider.getBalance(fixture.signer.address))).toBe(fees);
  expect(result.expenses.balance.deltaWei).toBe(fees.toString());
  expect(result.expenses.balance.unaccountedDeltaWei).toBe('0');
  const failed = receipts.find(receipt => receipt!.hash === failedHash)!;
  expect(result.expenses.receipts.find((receipt: any) => receipt.transactionHash === failedHash)).toMatchObject({
    status: 'mined',
    reverted: true,
    feeWei: failed!.fee.toString(),
  });
  return fees;
};

test('a relayed Foundation action cannot authorize resume and its reverted native replay retains exact fees', async () => {
  const fixture = await startStandaloneNode(0);
  const initialBalance = await fixture.provider.getBalance(fixture.signer.address);
  const observer = interceptListing(fixture);
  let session = launchDeployment(fixture, 'revert-original', { rpcUrl: observer.url });
  try {
    const history = await waitForSends(fixture, session, 11);
    const native = observer.listing();
    expect(history[10].transaction.hash).toBe(native.hash);
    const relayed = await relayListing(fixture, native);
    await session.stop();
    const original = await readJson(join(fixture.nativeDirectory, 'result.json'));
    const evidence = await snapshotEvidence(fixture);
    const before = fixture.submissions();
    const reads = observer.receiptReads(native.hash!);
    session = launchDeployment(fixture, 'foundation-conflict', { mode: 'resume', rpcUrl: observer.url });
    const conflict = await expectRejectedResume(
      fixture,
      session,
      before,
      'STACK_MANAGER_FOUNDATION_NONCE_CONFLICT',
      () => observer.receiptReads(native.hash!) > reads + 2,
    );
    await fixture.provider.send('evm_setBlockGasLimit', [toQuantity(60_000_000)]);
    await fixture.provider.send('anvil_mine', ['0x1']);
    const reverted = await fixture.provider.getTransactionReceipt(native.hash!);
    expect(reverted!.status).toBe(0);
    session = launchDeployment(fixture, 'reverted-resume', { mode: 'resume', rpcUrl: observer.url });
    const failure = await expectRejectedResume(fixture, session, before, 'STACK_MANAGER_NATIVE_TRANSACTION_REVERTED');
    await verifyRetainedEvidence(fixture, original, conflict, evidence);
    const fees = await assertExpenses(fixture, initialBalance, failure, native.hash!);
    await writeProof(fixture, native, relayed, reverted!, fees, original, conflict, failure);
  } finally {
    await session.stop();
    await observer.close();
    await fixture.close();
  }
}, 180_000);

const verifyRetainedEvidence = async (
  fixture: Fixture,
  original: any,
  conflict: any,
  evidence: Awaited<ReturnType<typeof snapshotEvidence>>,
) => {
  for (const entry of evidence)
    expect(await readFile(join(fixture.nativeDirectory, entry.path), 'utf8')).toBe(entry.bytes);
  const archived = await readJson(join(original.invocation, 'result.json'));
  expect(archived).toEqual({ ...original, status: 'interrupted' });
  expect(await readJson(join(conflict.invocation, 'result.json'))).toEqual(conflict);
  expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
  expect(await readFile(join(fixture.nativeDirectory, 'manifest.json'), 'utf8')).toBe('');
};

const writeProof = async (
  fixture: Fixture,
  native: Transaction,
  relay: { receipt: TransactionReceipt; foundationNonce: bigint },
  reverted: TransactionReceipt,
  fees: bigint,
  original: any,
  conflict: any,
  failure: any,
) => {
  const path = join(fixture.directory, 'reverted-listing-proof.json');
  await writeFile(
    path,
    safeStringify({
      initialNonce: fixture.initialNonce,
      nativeNonce: native.nonce,
      relay: { hash: relay.receipt.hash, status: relay.receipt.status, foundationNonce: relay.foundationNonce },
      native: { hash: reverted.hash, status: reverted.status },
      errors: [conflict.error.code, failure.error.code],
      nativeBroadcasts: fixture.submissions(),
      knownNativeFeesWei: fees,
      expenses: failure.expenses,
      retainedInvocations: [original.invocation, conflict.invocation, failure.invocation],
    }),
  );
  console.log(`STANDALONE_REVERT_EVIDENCE:${path}`);
};
