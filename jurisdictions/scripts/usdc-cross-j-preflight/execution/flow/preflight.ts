import { Depository__factory, ERC20Mock__factory } from '../../../../typechain-types';
import {
  assertCanonicalChainPoint,
  readCanonicalChainPoint,
} from '../../../../../core/jurisdiction/adapter/stack-manager/receipts';
import { inspectCrossPayout } from '../../../../../core/scenarios/usdc-poc/cross-swap';
import { userReplica, type PocUser } from '../../../../../core/scenarios/usdc-poc/user';
import { targetUser } from '../../../../../core/scenarios/usdc-poc/journey/context';
import type { JsonRpcProvider } from 'ethers';
import type { ChainAuthority, ExecutionAuthority, PayerGrant } from '../authority';
import type { ExecutionProviders } from '../providers';

const readPreflightState = async <T>(
  { current, historical }: ExecutionProviders,
  read: (provider: JsonRpcProvider, blockNumber: number) => Promise<T>,
) => {
  const block = await readCanonicalChainPoint(current);
  // The live and archive RPCs can disagree after the approved anchor.
  // A balance on an archive fork cannot back a payout at the live block.
  await assertCanonicalChainPoint(historical, block);
  const state = await read(historical, block.number);
  await Promise.all([assertCanonicalChainPoint(historical, block), assertCanonicalChainPoint(current, block)]);
  return { block, state };
};

export const requireTargetBacking = async (chain: ChainAuthority, providers: ExecutionProviders, net: bigint) => {
  const {
    block,
    state: [reserve, backing, hubDebts, userDebts],
  } = await readPreflightState(providers, (provider, blockTag) => {
    const depos = Depository__factory.connect(chain.depository, provider);
    const token = ERC20Mock__factory.connect(chain.token, provider);
    return Promise.all([
      depos._reserves(chain.hubEntity, 1, { blockTag }),
      token.balanceOf(chain.depository, { blockTag }),
      depos.activeDebts(chain.hubEntity, { blockTag }),
      depos.activeDebts(chain.userEntity, { blockTag }),
    ]);
  });
  if (reserve < net || backing < net || hubDebts !== 0n || userDebts !== 0n)
    throw new Error(`USDC_EXECUTION_TARGET_BACKING_INSUFFICIENT:reserve=${reserve}:backing=${backing}:need=${net}`);
  return { block, reserve, backing, hubDebts, userDebts };
};

const firstRunNonce = (payer: PayerGrant, runIndex: number): number =>
  payer.firstNonce + runIndex * (payer.role === 'source-user' ? 3 : 1);

const readFreshPayer = async (
  chain: ChainAuthority,
  payer: PayerGrant,
  runIndex: number,
  providers: ExecutionProviders,
  blockTag: number,
) => {
  const { current, historical } = providers;
  const [nonce, pending, balance] = await Promise.all([
    historical.getTransactionCount(payer.address, blockTag),
    current.getTransactionCount(payer.address, 'pending'),
    historical.getBalance(payer.address, blockTag),
  ]);
  const expected = firstRunNonce(payer, runIndex);
  if (nonce !== expected || pending !== expected) throw new Error(`USDC_EXECUTION_FRESH_PAYER_NONCE:${payer.role}`);
  const slots = payer.role === 'source-user' ? 3n : 1n;
  if (balance < slots * payer.gasLimit * payer.maxFeePerGasWei)
    throw new Error(`USDC_EXECUTION_PAYER_NATIVE_INSUFFICIENT:${payer.role}`);
  const evidence = { role: payer.role, nonce, pending, balance };
  if (payer.role !== 'source-user') return evidence;
  const token = ERC20Mock__factory.connect(chain.token, historical);
  const principal = await token.balanceOf(payer.address, { blockTag });
  if (principal < 1_000_000n) throw new Error('USDC_EXECUTION_SOURCE_PRINCIPAL_MISSING');
  return { ...evidence, principal };
};

const readFreshPayers = async (chain: ChainAuthority, providers: ExecutionProviders, runIndex: number) => {
  const { block, state: payers } = await readPreflightState(providers, (_historical, height) =>
    Promise.all(chain.payers.map(payer => readFreshPayer(chain, payer, runIndex, providers, height))),
  );
  return { chainId: chain.chainId, block, payers };
};

export const preflightFreshRun = async (
  user: PocUser,
  authority: ExecutionAuthority,
  providers: readonly ExecutionProviders[],
  runIndex: number,
) => {
  const [source, target] = authority.chains;
  const quote = await inspectCrossPayout(user, source!.hubEntity, authority.apiBase, authority.expiresAt);
  if (quote.targetHub !== target!.hubEntity) throw new Error('USDC_EXECUTION_PREFLIGHT_TARGET_HUB_MISMATCH');
  const [targetBacking, ...chains] = await Promise.all([
    requireTargetBacking(target!, providers[1]!, quote.backingRequired),
    ...authority.chains.map((chain, index) => readFreshPayers(chain, providers[index]!, runIndex)),
  ]);
  if (quote.expiresAt <= Date.now()) throw new Error('USDC_EXECUTION_PREFLIGHT_QUOTE_EXPIRED');
  return { checkedAt: Date.now(), quote, targetBacking, chains };
};

export const refreshApprovalBacking = async (
  user: PocUser,
  authority: ExecutionAuthority,
  provider: ExecutionProviders,
  previous: Awaited<ReturnType<typeof preflightFreshRun>>,
) => {
  const [source, target] = authority.chains;
  const quote = await inspectCrossPayout(user, source!.hubEntity, authority.apiBase, authority.expiresAt);
  if (
    quote.targetHub !== target!.hubEntity ||
    quote.makerRouteHash !== previous.quote.makerRouteHash ||
    quote.gross !== previous.quote.gross
  )
    throw new Error('USDC_POC_QUOTE_OR_TARIFF_CHANGED');
  const targetBacking = await requireTargetBacking(target!, provider, quote.backingRequired);
  const account = userReplica(targetUser(user, authority.apiBase)).state.accounts.get(target!.hubEntity);
  if (quote.expiresAt <= Date.now() || account?.currentFrame.stateHash !== quote.proof.stateHash)
    throw new Error('USDC_POC_QUOTE_OR_TARIFF_CHANGED');
  return { ...previous, checkedAt: Date.now(), quote, targetBacking };
};
