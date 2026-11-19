import { expect, test } from 'bun:test';
import vector from '../../../fixtures/usdc-poc/right-c2r-authority.json';
import {
  decodeAuthority,
  requireCurrentAuthority,
  fingerprintCandidate,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/authority';
import { validateAuthorizedWire } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/calls';
import { decodeJBatch, createEmptyBatch } from '../../../../jurisdiction/machine/batch';
import { prepareSignedBatch } from '../../../../hanko/batch';
import { generateLazyEntityId } from '../../../../entity/factory';
import { Interface, Wallet, type TransactionRequest } from 'ethers';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';

const sourceWallet = new Wallet(`0x${'11'.repeat(32)}`);
const sourceEntity = generateLazyEntityId([sourceWallet.address], 1n).toLowerCase();
const proposal = {
  ...vector.authority,
  chains: vector.authority.chains.map((chain, index) =>
    index === 0
      ? {
          ...chain,
          userEntity: sourceEntity,
          userSigner: sourceWallet.address.toLowerCase(),
          payers: chain.payers.map(payer => ({ ...payer, address: sourceWallet.address.toLowerCase() })),
        }
      : chain,
  ),
};
const sourceAuthority = () => decodeAuthority(proposal);
const erc20 = new Interface(['function approve(address,uint256) returns(bool)']);
const sourceWire = (patch: TransactionRequest = {}) => {
  const chain = sourceAuthority().chains[0]!;
  return sourceWallet.signTransaction({
    type: 2,
    chainId: chain.chainId,
    nonce: 0,
    to: chain.token,
    data: erc20.encodeFunctionData('approve', [chain.depository, 1_000_000n]),
    value: 0n,
    gasLimit: 200_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    ...patch,
  });
};

test('another committed HEAD invalidates authority even when the dirty file map is identical', () => {
  const files = { 'core/runtime.ts': 'unchanged-working-diff' };
  expect(fingerprintCandidate('1'.repeat(40), files)).not.toBe(fingerprintCandidate('2'.repeat(40), files));
});

test('a source approval and bounded same-nonce replacement stay within the finite grant', async () => {
  const authority = sourceAuthority(),
    chain = authority.chains[0]!;
  const original = validateAuthorizedWire(authority, chain, await sourceWire());
  const replacement = validateAuthorizedWire(authority, chain, await sourceWire({ maxFeePerGas: 2_000_000_000n }));
  expect(original.transaction.nonce).toBe(replacement.transaction.nonce);
  expect(original.payer.totalFeeLimitWei).toBe(replacement.payer.totalFeeLimitWei);
  expect(replacement.runIndex).toBe(0);
});

const denied = [
  { name: 'another chain', patch: { chainId: 421614 } },
  { name: 'a sixth run nonce', patch: { nonce: 15 } },
  { name: 'a larger gas reservation', patch: { gasLimit: 2_000_001n } },
  { name: 'fees beyond the ceiling', patch: { maxFeePerGas: 5_000_000_001n } },
  {
    name: 'priority fees beyond the ceiling',
    patch: { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_001n },
  },
  { name: 'native token value', patch: { value: 1n } },
  { name: 'another token destination', patch: { to: '0x0000000000000000000000000000000000000001' } },
] satisfies { name: string; patch: TransactionRequest }[];

test.each(denied)('the signed wire cannot add $name to its approval', async ({ patch }) => {
  const authority = sourceAuthority();
  const wire = await sourceWire(patch);
  expect(() => validateAuthorizedWire(authority, authority.chains[0]!, wire)).toThrow(
    'USDC_EXECUTION_CALL_NOT_AUTHORIZED',
  );
});

test('a valid signature from another EOA does not inherit the payer grant', async () => {
  const authority = sourceAuthority(),
    chain = authority.chains[0]!;
  const other = new Wallet(`0x${'22'.repeat(32)}`);
  const wire = await other.signTransaction({
    type: 2,
    chainId: chain.chainId,
    nonce: 0,
    to: chain.token,
    data: erc20.encodeFunctionData('approve', [chain.depository, 1_000_000n]),
    value: 0n,
    gasLimit: 200_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  });
  expect(() => validateAuthorizedWire(authority, chain, wire)).toThrow('USDC_EXECUTION_PAYER_NOT_AUTHORIZED');
});

test('the source approval cannot enlarge allowance or change the spender', async () => {
  const authority = sourceAuthority(),
    chain = authority.chains[0]!;
  for (const [spender, amount] of [
    [chain.depository, 2_000_000n],
    [chain.entityProvider, 1_000_000n],
  ] as const) {
    const wire = await sourceWire({ data: erc20.encodeFunctionData('approve', [spender, amount]) });
    expect(() => validateAuthorizedWire(authority, chain, wire)).toThrow('USDC_EXECUTION_CALL_NOT_AUTHORIZED');
  }
});

test('an exact one-USDC ingress cannot hide another batch operation or recipient', async () => {
  const authority = sourceAuthority(),
    chain = authority.chains[0]!;
  for (const attack of ['none', 'extra-operation', 'recipient', 'amount']) {
    const batch = createEmptyBatch();
    batch.externalTokenToReserve.push({
      entity: attack === 'recipient' ? chain.hubEntity : chain.userEntity,
      contractAddress: chain.token,
      externalTokenId: 0n,
      tokenType: 0,
      internalTokenId: 1,
      amount: attack === 'amount' ? 999_999n : 1_000_000n,
    });
    if (attack === 'extra-operation')
      batch.reserveToReserve.push({ receivingEntity: chain.hubEntity, tokenId: 1, amount: 1n });
    const signed = prepareSignedBatch(
      batch,
      chain.userEntity,
      sourceWallet.privateKey,
      BigInt(chain.chainId),
      chain.depository,
      0n,
    );
    const wire = await sourceWire({
      nonce: 1,
      to: chain.depository,
      data: Depository__factory.createInterface().encodeFunctionData('processBatch', [
        signed.encodedBatch,
        signed.hankoData,
        signed.nextNonce,
      ]),
    });
    if (attack === 'none') expect(validateAuthorizedWire(authority, chain, wire).runIndex).toBe(0);
    else expect(() => validateAuthorizedWire(authority, chain, wire)).toThrow('USDC_EXECUTION_CALL_NOT_AUTHORIZED');
  }
});

test('a campaign cannot reserve more worst-case fees than its cumulative allowance', () => {
  const chains = proposal.chains.map((chain, index) =>
    index === 0
      ? { ...chain, payers: chain.payers.map(payer => ({ ...payer, totalFeeLimitWei: '149999999999999999' })) }
      : chain,
  );
  expect(() => decodeAuthority({ ...proposal, chains })).toThrow('USDC_AUTHORITY_CUMULATIVE_LIMIT_INVALID');
  expect(() => decodeAuthority({ ...proposal, allowAnyCall: true })).toThrow('USDC_AUTHORITY_FIELDS');
});

test('missing, expired and changed-candidate authority reject before execution capabilities are opened', () => {
  const authority = sourceAuthority();
  expect(() => requireCurrentAuthority(authority, 'jurisdictions/jurisdictions.json')).toThrow(
    'USDC_EXECUTION_AUTHORITY_MISSING',
  );
  expect(() =>
    requireCurrentAuthority(
      { ...authority, approved: true, expiresAt: Date.now() - 1 },
      'jurisdictions/jurisdictions.json',
    ),
  ).toThrow('USDC_EXECUTION_AUTHORITY_EXPIRED');
  expect(() =>
    requireCurrentAuthority(
      { ...authority, approved: true, candidateDigest: '0'.repeat(64), expiresAt: Date.now() + 60_000 },
      'jurisdictions/jurisdictions.json',
    ),
  ).toThrow('USDC_EXECUTION_AUTHORITY_CANDIDATE_CHANGED');
});

test('a canonical right-side C2R exit has zero ondelta movement and remains inside the payer grant', () => {
  const authority = decodeAuthority(vector.authority);
  const chain = authority.chains[1]!;
  const wire = validateAuthorizedWire(authority, chain, vector.rawTransaction);
  expect(wire.payer.role).toBe('target-user');
  expect(wire.runIndex).toBe(0);
  if (!wire.batch) throw new Error('TEST_EXIT_BATCH_MISSING');
  const diff = decodeJBatch(wire.batch.encoded).settlements[0]!.diffs[0]!;
  expect(diff.ondeltaDiff).toBe(0n);
  expect(diff.rightDiff).toBe(899_801n);
});
