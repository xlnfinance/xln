import { Contract } from 'ethers';
import { decodeUint768 } from '../../../core/protocol/crypto/abi-money';
import {
  readCanonicalChainPoint,
  assertCanonicalChainPoint,
} from '../../../core/jurisdiction/adapter/stack-manager/receipts';
import type { Context, Snapshot } from './types';
import { ONE_USDC } from './types';

export const tokenContract = (context: Pick<Context, 'options' | 'wallet'>) =>
  new Contract(
    context.options.token,
    [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address,address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)',
    ],
    context.wallet,
  );

export const readRoundtripPoint = async (context: Context) => {
  context.signal.throwIfAborted();
  const point = await readCanonicalChainPoint(context.provider);
  const floor = context.evidence.transactions.reduce(
    (minimum, transaction) => (transaction.confirmedAt ? Math.max(minimum, transaction.confirmedAt.number) : minimum),
    0,
  );
  if (point.number < floor) throw new Error(`USDC_ROUNDTRIP_STALE_CHAIN_TIP:${point.number}:${floor}`);
  return point;
};

export const readRoundtripBalances = async (context: Context): Promise<Snapshot> => {
  const { provider, wallet, depository, entityId } = context;
  const point = await readRoundtripPoint(context);
  const block = { blockTag: point.number };
  const token = tokenContract(context);
  const [balance, reserve, nativeWei, debt, entityNonce, allowance] = await Promise.all([
    token.getFunction('balanceOf')(wallet.address, block) as Promise<bigint>,
    depository._reserves(entityId, 1, block),
    provider.getBalance(wallet.address, point.number),
    depository.debtOutstanding(entityId, 1, block),
    depository.entityNonces(entityId, block),
    token.getFunction('allowance')(
      wallet.address,
      context.input.manifest.contracts.depository,
      block,
    ) as Promise<bigint>,
  ]);
  await assertCanonicalChainPoint(provider, point);
  return { point, token: balance, reserve, nativeWei, debt: decodeUint768(debt), entityNonce, allowance };
};

export const assertCleanFundedReserve = async (context: Context, balance: Snapshot): Promise<void> => {
  if (balance.reserve !== 0n || balance.debt !== 0n) throw new Error('USDC_ROUNDTRIP_REQUIRES_CLEAN_DEBT_FREE_RESERVE');
  if (balance.token < ONE_USDC) throw new Error(`USDC_ROUNDTRIP_TOKEN_FUNDING_INSUFFICIENT:${balance.token}`);
  if (balance.nativeWei <= 0n) throw new Error('USDC_ROUNDTRIP_NATIVE_FUNDING_INSUFFICIENT');
  const nonces = await Promise.all(
    ['latest', 'pending'].map(tag => context.provider.getTransactionCount(context.wallet.address, tag)),
  );
  if (nonces[0] !== nonces[1]) throw new Error('USDC_ROUNDTRIP_SIGNER_HAS_PENDING_TRANSACTIONS');
};

export const assertRoundtripDelta = (initial: Snapshot, current: Snapshot, deposited: boolean): void => {
  const amount = deposited ? ONE_USDC : 0n;
  if (current.token !== initial.token - amount || current.reserve !== initial.reserve + amount || current.debt !== 0n)
    throw new Error(`USDC_ROUNDTRIP_BALANCE_MISMATCH:${deposited ? 'deposit' : 'restoration'}`);
};
