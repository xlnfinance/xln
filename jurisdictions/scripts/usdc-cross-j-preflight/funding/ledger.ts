import { Transaction, type JsonRpcProvider } from 'ethers';
import { Depository__factory, ERC20Mock__factory } from '../../../typechain-types';
import { decodeUint768 } from '../../../../core/protocol/crypto/abi-money';
import {
  readCanonicalChainPoint,
  assertCanonicalChainPoint,
  readConfirmedReceipt,
} from '../../../../core/jurisdiction/adapter/stack-manager/receipts';
import { readNonceReceipt } from '../execution/nonce-receipt';
import { verifyBatchHanko } from '../execution/submission';
import type { ExecutionProviders } from '../execution/providers';
import { validateFundingWire } from './wires';
import { fundingSlotBudget, fundingSlots, type FundingChain, type FundingSlot } from './authority';

/** Receipt depth is part of the operator-funding policy, including on private
 * owning chains. No local-chain shortcut changes the accepted evidence. */
const confirmations = 12;

export const waitFundingReceipt = async (provider: JsonRpcProvider, hash: string) => {
  // Twelve Ethereum blocks normally exceed two minutes. Keep confirmation
  // depth intact and bound the host wait independently of private mining speed.
  const deadline = Date.now() + 600_000;
  while (true) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt && receipt.status !== 1) throw new Error(`USDC_FUNDING_MINED_REVERT:${hash}`);
    const tip = await provider.getBlockNumber();
    if (receipt && tip - receipt.blockNumber + 1 >= confirmations)
      return readConfirmedReceipt(
        provider,
        hash,
        confirmations,
        value => {
          if (!value || value.status !== 1) throw new Error('USDC_FUNDING_RECEIPT_INVALID');
          return value;
        },
        tip,
      );
    if (Date.now() >= deadline) throw new Error(`USDC_FUNDING_RECEIPT_UNRESOLVED:${hash}`);
    await Bun.sleep(250);
  }
};

const consumedFunding = async (providers: ExecutionProviders, chain: FundingChain, count: number, slots: number) => {
  if (count < chain.funder.firstNonce) throw new Error('USDC_FUNDING_NONCE_BEFORE_ANCHOR');
  const entries = [];
  for (let index = 0; index < slots && chain.funder.firstNonce + index < count; index++) {
    const known = await readNonceReceipt(providers, chain, chain.funder, chain.funder.firstNonce + index);
    if (!known) throw new Error('USDC_FUNDING_CONSUMED_SLOT_UNRESOLVED');
    const receipt = await waitFundingReceipt(providers.current, known.transaction.hash);
    const verified = validateFundingWire(chain, Transaction.from(known.transaction).serialized);
    if (verified.batch) await verifyBatchHanko(providers.historical, chain, verified.batch, receipt.blockNumber);
    entries.push({ ...known, receipt, stage: verified.stage });
  }
  return entries;
};

const fundingSnapshot = async (provider: JsonRpcProvider, chain: FundingChain, height?: number) => {
  const point = height === undefined ? await readCanonicalChainPoint(provider) : await provider.getBlock(height);
  if (!point || !point.hash) throw new Error('USDC_FUNDING_SNAPSHOT_BLOCK_MISSING');
  const number = point.number;
  const depos = Depository__factory.connect(chain.depository, provider);
  const usdc = ERC20Mock__factory.connect(chain.token, provider);
  const at = { blockTag: number };
  const user = chain.limits.userFunding;
  const result = {
    point: { number, hash: point.hash },
    funderUsdc: await usdc.balanceOf(chain.funder.address, at),
    hubReserve: await depos._reserves(chain.hubEntity, 1, at),
    backing: await usdc.balanceOf(chain.depository, at),
    hubDebt: decodeUint768(await depos.debtOutstanding(chain.hubEntity, 1, at)),
    funderNativeWei: await provider.getBalance(chain.funder.address, number),
    hubNativeWei: await provider.getBalance(chain.hubSigner, number),
    funderNonce: await provider.getTransactionCount(chain.funder.address, number),
    entityNonce: await depos.entityNonces(chain.funderEntity, at),
    ...(user
      ? {
          user: {
            usdc: await usdc.balanceOf(user.signer, at),
            nativeWei: await provider.getBalance(user.signer, number),
          },
        }
      : {}),
  };
  await assertCanonicalChainPoint(provider, result.point);
  return result;
};

const fundingMovements = (chain: FundingChain, slots: readonly FundingSlot[]) => {
  const native = (stage: FundingSlot['stage']) => slots.find(slot => slot.stage === stage)?.valueWei ?? 0n;
  return {
    deposited: slots.some(slot => slot.stage === 'deposit') ? chain.limits.amount : 0n,
    userUsdc: slots.some(slot => slot.stage === 'user-principal-transfer') ? chain.limits.userFunding!.usdcAtoms : 0n,
    hubNative: native('native-topup'),
    userNative: native('user-native-topup'),
  };
};

type FundingSnapshot = Awaited<ReturnType<typeof fundingSnapshot>>;

const verifyFundingAccounting = (
  chain: FundingChain,
  before: FundingSnapshot,
  after: FundingSnapshot,
  movements: ReturnType<typeof fundingMovements>,
  fees: bigint,
  count: number,
): void => {
  const { deposited, userUsdc, hubNative, userNative } = movements;
  if (
    before.point.hash !== chain.anchorHash ||
    before.entityNonce !== chain.entityNonce ||
    before.hubReserve !== chain.hubReserveBefore ||
    before.hubDebt !== 0n ||
    after.hubDebt !== 0n ||
    before.funderUsdc - after.funderUsdc !== deposited + userUsdc ||
    after.hubReserve - before.hubReserve !== deposited ||
    after.backing - before.backing !== deposited ||
    after.hubNativeWei - before.hubNativeWei !== hubNative ||
    before.funderNativeWei - after.funderNativeWei !== fees + hubNative + userNative ||
    after.entityNonce !== chain.entityNonce + (deposited ? 1n : 0n) ||
    after.funderNonce !== chain.funder.firstNonce + count ||
    (after.user?.usdc ?? 0n) - (before.user?.usdc ?? 0n) !== userUsdc ||
    (after.user?.nativeWei ?? 0n) - (before.user?.nativeWei ?? 0n) !== userNative
  )
    throw new Error('USDC_FUNDING_CHAIN_ACCOUNTING_MISMATCH');
};

export const checkFundingProgress = async (providers: ExecutionProviders, chain: FundingChain) => {
  const slots = fundingSlots(chain.limits);
  const point = await readCanonicalChainPoint(providers.current);
  const count = await providers.current.getTransactionCount(chain.funder.address, point.number);
  const entries = await consumedFunding(providers, chain, count, slots.length);
  const before = await fundingSnapshot(providers.historical, chain, chain.anchorNumber);
  const finalReceipt = entries.length === slots.length ? entries.at(-1)!.receipt : undefined;
  const after = finalReceipt
    ? await fundingSnapshot(providers.historical, chain, finalReceipt.blockNumber)
    : await fundingSnapshot(providers.current, chain, point.number);
  if (after.point.hash !== (finalReceipt?.blockHash ?? point.hash))
    throw new Error('USDC_FUNDING_SNAPSHOT_BLOCK_MISMATCH');
  const movements = fundingMovements(chain, slots.slice(0, entries.length));
  const { deposited, userUsdc, userNative } = movements;
  const value = movements.hubNative + userNative;
  const fees = entries.reduce((n, entry) => n + entry.receipt.fee, 0n);
  verifyFundingAccounting(chain, before, after, movements, fees, entries.length);
  const remaining = fundingSlotBudget(slots.slice(entries.length));
  if (
    fees + remaining.fees > chain.limits.totalFeeLimitWei ||
    fees + value + remaining.fees + remaining.value > chain.limits.totalNativeOutflowLimitWei
  )
    throw new Error('USDC_FUNDING_REMAINING_BUDGET_INSUFFICIENT');
  if (
    entries.length < slots.length &&
    (after.funderNativeWei < remaining.fees + remaining.value ||
      after.funderUsdc < chain.limits.amount - deposited + (chain.limits.userFunding?.usdcAtoms ?? 0n) - userUsdc)
  )
    throw new Error('USDC_FUNDING_PAYER_BALANCE_INSUFFICIENT');
  return { entries, before, after, fees, value, deposited, userUsdc, userNative };
};
