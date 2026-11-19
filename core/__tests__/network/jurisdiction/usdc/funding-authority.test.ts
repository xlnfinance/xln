import { expect, test } from 'bun:test';
import { Wallet, Transaction, Interface } from 'ethers';
import { generateLazyEntityId } from '../../../../entity/factory';
import { prepareSignedBatch } from '../../../../hanko/batch';
import { createEmptyBatch } from '../../../../jurisdiction/machine/batch';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import {
  candidateHead,
  candidateDigest,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/authority';
import {
  decodeFundingAuthority,
  requireFundingAuthority,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/funding/authority';
import {
  signFundingWires,
  validateFundingWire,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/funding/wires';
import { privateDemoFundingLimits, privateFundingLimits } from '../../../market/startup/usdc-session/funding-limits';

const wallet = new Wallet(`0x${'11'.repeat(32)}`);
const entity = (address: string) => generateLazyEntityId([address], 1n).toLowerCase();
const template = () => ({
  version: 2,
  operation: 'operator-funding',
  approved: true,
  candidateHead: candidateHead(),
  candidateDigest: candidateDigest(),
  catalogDigest: 'a'.repeat(64),
  expiresAt: Date.now() + 60_000,
  chains: privateFundingLimits().chains.map((limits, index) => {
    const hub = new Wallet(`0x${(index === 0 ? '22' : '33').repeat(32)}`).address.toLowerCase();
    const depository = `0x${'44'.repeat(20)}`,
      entityProvider = `0x${'55'.repeat(20)}`,
      token = `0x${'66'.repeat(20)}`;
    return {
      chainId: limits.chainId,
      anchorNumber: 10,
      anchorHash: `0x${'77'.repeat(32)}`,
      depository,
      entityProvider,
      token,
      codeHashes: Object.fromEntries([depository, entityProvider, token].map(a => [a, `0x${'88'.repeat(32)}`])),
      funder: { address: wallet.address.toLowerCase(), firstNonce: 2 },
      funderEntity: entity(wallet.address),
      entityNonce: '0',
      hubEntity: entity(hub),
      hubSigner: hub,
      hubReserveBefore: '0',
      limits,
    };
  }),
});

const demoTemplate = () => {
  const value = template();
  const limits = privateDemoFundingLimits([`0x${'ab'.repeat(20)}`, `0x${'ac'.repeat(20)}`]);
  return { ...value, chains: value.chains.map((chain, index) => ({ ...chain, limits: limits.chains[index]! })) };
};

test('funding reconstructs three exact signed nonce slots without a mutable receipt store', async () => {
  const authority = decodeFundingAuthority(template());
  for (const chain of authority.chains) {
    const wires = await signFundingWires(chain, wallet);
    expect(await signFundingWires(chain, wallet)).toEqual(wires);
    expect(wires.map(raw => validateFundingWire(chain, raw).stage)).toEqual(['approval', 'deposit', 'native-topup']);
  }
});

test('one-run funding reconstructs only the five source and four target slots', async () => {
  const [source, target] = decodeFundingAuthority(demoTemplate()).chains;
  for (const [chain, stages] of [
    [source!, ['approval', 'deposit', 'native-topup', 'user-principal-transfer', 'user-native-topup']],
    [target!, ['approval', 'deposit', 'native-topup', 'user-native-topup']],
  ] as const) {
    const wires = await signFundingWires(chain, wallet);
    expect(wires.map(raw => validateFundingWire(chain, raw).stage)).toEqual([...stages]);
    expect(await signFundingWires(chain, wallet)).toEqual(wires);
    const outside = Transaction.from(wires.at(-1)!);
    const raw = await wallet.signTransaction({ ...outside.toJSON(), nonce: outside.nonce + 1 });
    expect(() => validateFundingWire(chain, raw)).toThrow('USDC_FUNDING_CALL_NOT_AUTHORIZED');
  }
});

test('one-run funding fixes the user principal, token, ETH value and recipient', async () => {
  const chain = decodeFundingAuthority(demoTemplate()).chains[0]!;
  const user = chain.limits.userFunding!;
  const wires = await signFundingWires(chain, wallet);
  const abi = new Interface(['function transfer(address,uint256) returns(bool)']);
  for (const [slot, patch] of [
    [3, { data: abi.encodeFunctionData('transfer', [chain.hubSigner, user.usdcAtoms]) }],
    [3, { data: abi.encodeFunctionData('transfer', [user.signer, user.usdcAtoms + 1n]) }],
    [3, { to: chain.depository }],
    [3, { value: 1n }],
    [4, { to: chain.hubSigner }],
    [4, { value: user.nativeTopupWei + 1n }],
  ] as const) {
    const tx = Transaction.from(wires[slot]!);
    const raw = await wallet.signTransaction({ ...tx.toJSON(), ...patch });
    expect(() => validateFundingWire(chain, raw)).toThrow('USDC_FUNDING_CALL_NOT_AUTHORIZED');
  }
});

test('one-run authority rejects mixed scopes, existing user roles and unreserved user calls', () => {
  const mixed = demoTemplate();
  expect(() => decodeFundingAuthority({ ...mixed, chains: [mixed.chains[0], template().chains[1]] })).toThrow(
    'USDC_FUNDING_AUTHORITY_SCOPE_INVALID',
  );
  const wrongRecipient = demoTemplate();
  wrongRecipient.chains[0]!.limits.userFunding.signer = wrongRecipient.chains[0]!.hubSigner;
  expect(() => decodeFundingAuthority(wrongRecipient)).toThrow('USDC_FUNDING_IDENTITY_INVALID');
  const extraPrincipal = demoTemplate();
  extraPrincipal.chains[1]!.limits.userFunding.usdcAtoms = '1';
  expect(() => decodeFundingAuthority(extraPrincipal)).toThrow('USDC_FUNDING_USER_SCOPE_INVALID');
  const budget = demoTemplate();
  budget.chains[0]!.limits.totalFeeLimitWei = '5500000000000000';
  expect(() => decodeFundingAuthority(budget)).toThrow('USDC_FUNDING_CUMULATIVE_LIMIT_INVALID');
});

test('a same-nonce fee replacement remains inside the original finite funding reservation', async () => {
  const chain = decodeFundingAuthority(template()).chains[0]!;
  const raw = (await signFundingWires(chain, wallet))[0]!;
  const tx = Transaction.from(raw);
  const lower = await wallet.signTransaction({
    ...tx.toJSON(),
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 500_000_000n,
  });
  const first = validateFundingWire(chain, lower),
    replacement = validateFundingWire(chain, raw);
  expect(first.transaction.nonce).toBe(replacement.transaction.nonce);
  expect(first.stage).toBe(replacement.stage);
  expect(replacement.transaction.gasLimit * replacement.transaction.maxFeePerGas!).toBeLessThanOrEqual(
    chain.limits.calls.approval.gasLimit * chain.limits.calls.approval.maxFeePerGasWei,
  );
});

for (const [name, slot, patch] of [
  ['another chain', 0, { chainId: 1 }],
  ['a new nonce', 0, { nonce: 5 }],
  ['larger gas', 0, { gasLimit: 200001n }],
  ['larger maximum fee', 0, { maxFeePerGas: 5000000001n }],
  ['larger priority fee', 0, { maxPriorityFeePerGas: 1000000001n }],
  ['another token', 0, { to: `0x${'99'.repeat(20)}` }],
  ['hidden native value', 0, { value: 1n }],
  ['larger ETH topup', 2, { value: 100000000000001n }],
  ['another ETH recipient', 2, { to: wallet.address }],
  ['hidden ETH calldata', 2, { data: '0x01' }],
] as const)
  test(`funding rejects ${name} before broadcast`, async () => {
    const chain = decodeFundingAuthority(template()).chains[1]!;
    const raw = (await signFundingWires(chain, wallet))[slot]!;
    const tx = Transaction.from(raw);
    const altered = await wallet.signTransaction({ ...tx.toJSON(), ...patch, type: 2 });
    expect(() => validateFundingWire(chain, altered)).toThrow('USDC_FUNDING_CALL_NOT_AUTHORIZED');
  });

test('a different real signer cannot inherit the funder grant', async () => {
  const chain = decodeFundingAuthority(template()).chains[0]!;
  const other = new Wallet(`0x${'aa'.repeat(32)}`);
  const raw = (await signFundingWires(chain, wallet))[0]!;
  const tx = Transaction.from(raw);
  const altered = await other.signTransaction(tx.toJSON());
  expect(() => validateFundingWire(chain, altered)).toThrow('USDC_FUNDING_CALL_NOT_AUTHORIZED');
});

test('approval cannot enlarge the amount or change the spender', async () => {
  const chain = decodeFundingAuthority(template()).chains[1]!;
  const tx = Transaction.from((await signFundingWires(chain, wallet))[0]!);
  const abi = new Interface(['function approve(address,uint256) returns(bool)']);
  for (const data of [
    abi.encodeFunctionData('approve', [chain.depository, chain.limits.amount + 1n]),
    abi.encodeFunctionData('approve', [wallet.address, chain.limits.amount]),
  ]) {
    const raw = await wallet.signTransaction({ ...tx.toJSON(), data });
    expect(() => validateFundingWire(chain, raw)).toThrow('USDC_FUNDING_CALL_NOT_AUTHORIZED');
  }
});

test('a Hub deposit cannot redirect capital, add another operation or change its Entity nonce', async () => {
  const chain = decodeFundingAuthority(template()).chains[1]!;
  const tx = Transaction.from((await signFundingWires(chain, wallet))[1]!);
  for (const mode of ['recipient', 'extra', 'nonce']) {
    const batch = createEmptyBatch();
    batch.externalTokenToReserve.push({
      entity: mode === 'recipient' ? chain.funderEntity : chain.hubEntity,
      contractAddress: chain.token,
      externalTokenId: 0n,
      tokenType: 0,
      internalTokenId: 1,
      amount: chain.limits.amount,
    });
    if (mode === 'extra') batch.reserveToReserve.push({ receivingEntity: chain.funderEntity, tokenId: 1, amount: 1n });
    const signed = prepareSignedBatch(
      batch,
      chain.funderEntity,
      wallet.privateKey,
      BigInt(chain.chainId),
      chain.depository,
      mode === 'nonce' ? chain.entityNonce + 1n : chain.entityNonce,
    );
    const data = Depository__factory.createInterface().encodeFunctionData('processBatch', [
      signed.encodedBatch,
      signed.hankoData,
      signed.nextNonce,
    ]);
    const raw = await wallet.signTransaction({ ...tx.toJSON(), data });
    expect(() => validateFundingWire(chain, raw)).toThrow('USDC_FUNDING_CALL_NOT_AUTHORIZED');
  }
});

test('both fee and native-outflow budgets reserve all slots before approval', () => {
  for (const kind of ['fees', 'value']) {
    const value = template();
    if (kind === 'fees') value.chains[0]!.limits.totalFeeLimitWei = '1';
    else value.chains[0]!.limits.totalNativeOutflowLimitWei = '10000000000000000';
    expect(() => decodeFundingAuthority(value)).toThrow('USDC_FUNDING_CUMULATIVE_LIMIT_INVALID');
  }
});

test('unapproved, expired and changed-candidate funding grants cannot reach a writer', () => {
  const value = template();
  for (const patch of [{ approved: false }, { expiresAt: 0 }, { candidateDigest: '0'.repeat(64) }]) {
    const authority = decodeFundingAuthority({ ...value, ...patch });
    expect(() => requireFundingAuthority(authority, '/no-catalog')).toThrow();
  }
});
