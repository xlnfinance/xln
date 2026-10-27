import type { WalletView } from '../views';
import { requireAdapter } from '../adapter';
import { peekXLN } from '../xln-loader';
import { requestFaucet } from '../financial/external';
import { readAccountState } from '../financial/swap';
import { accountNetBalance } from '@xln/frontend/lib/utils/ui/accountBalance';
import { waitFor } from '../tx';
import { formatAmount, parseAmount } from '../format';
import { CreditLimitFullError } from './credit-limit';
import { getTokenMeta, knownTokenIds } from '../token-meta';

export async function receiveTestMoney(wallet: WalletView, onStage: (stage: string) => void): Promise<void> {
  const hub = wallet.accounts.find(account => account.isHub && !account.disputed);
  if (!hub) throw new Error('Connect a hub before receiving test money.');
  const xln = peekXLN();
  if (!xln) throw new Error('Wallet runtime is not ready');
  const entityId = wallet.entityId;
  if (!knownTokenIds().includes(1)) throw new Error('The test faucet asset is not registered on this network.');
  const token = getTokenMeta(1);
  const amount = parseAmount('100', token.decimals);
  const input = {
    ownerEntityId: entityId,
    counterpartyEntityId: hub.counterpartyId,
    tokenId: 1,
    requiredInboundAmount: amount,
    collateralPercent: 0,
    creditBufferBps: 0 as const,
    allowOpenAccount: false,
  };
  const read = async () => {
    if (!requireAdapter().commandReady)
      throw new Error('Wallet connection stopped. Reopen the wallet before continuing.');
    const account = await readAccountState(entityId, hub.counterpartyId);
    if (!account) throw new Error('Hub account is not ready');
    return account;
  };
  const balance = (account: Awaited<ReturnType<typeof read>>) => {
    const delta = account.deltas.get(1);
    return delta
      ? accountNetBalance(xln.deriveDelta(delta, entityId.toLowerCase() === account.leftEntity.toLowerCase()))
      : 0n;
  };
  const account = await read();
  const before = balance(account);
  // The faucet is a plain payment: it never changes a credit limit. When the
  // limit the user extends cannot hold it, say so and leave the raise to them.
  const plan = xln.planReceiveCapacity({ ...input, account });
  if (plan.status !== 'ready') {
    const money = (value: bigint) => `${formatAmount(value, token.decimals, 2)} ${token.symbol}`;
    throw new CreditLimitFullError(hub.counterpartyId,
      `Your credit limit to ${hub.label} is too low for this faucet: you can receive ${money(plan.currentInboundCapacity)} more on a ${money(plan.currentPeerCreditLimit)} limit, and it sends ${money(amount)}. The faucet never raises it; raise the limit, then try again.`);
  }
  onStage('Receiving…');
  await requestFaucet('offchain', {
    jurisdiction: wallet.jurisdiction,
    entityId,
    signerId: wallet.signerId,
    runtimeId: requireAdapter().runtimeId,
    hubEntityId: hub.counterpartyId,
    tokenId: 1,
    tokenSymbol: token.symbol,
    amount: '100',
  });
  await waitFor(async () => balance(await read()) >= before + amount, 'confirmed test payment');
}
