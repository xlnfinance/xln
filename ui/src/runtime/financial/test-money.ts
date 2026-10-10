import type { WalletView } from '../views';
import { requireAdapter } from '../adapter';
import { peekXLN } from '../xln-loader';
import { requestFaucet } from '../financial/external';
import { readAccountState } from '../financial/swap';
import { accountNetBalance } from '@xln/frontend/lib/utils/ui/accountBalance';
import { sendEntityTxs, waitFor } from '../tx';

export async function receiveTestMoney(wallet: WalletView, onStage: (stage: string) => void): Promise<void> {
  const hub = wallet.accounts.find(account => account.isHub && !account.disputed);
  if (!hub) throw new Error('Connect a hub before receiving test money.');
  const xln = peekXLN();
  if (!xln) throw new Error('Wallet runtime is not ready');
  const entityId = wallet.entityId;
  const input = {
    ownerEntityId: entityId,
    counterpartyEntityId: hub.counterpartyId,
    tokenId: 1,
    requiredInboundAmount: 100_000_000n,
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
  const plan = xln.planReceiveCapacity({ ...input, account });
  if (plan.status !== 'ready') {
    if (plan.status !== 'credit') throw new Error('This account cannot receive test money yet');
    onStage('Preparing…');
    await sendEntityTxs(entityId, wallet.signerId, [...plan.setupTxs]);
    await waitFor(
      async () => xln.planReceiveCapacity({ ...input, account: await read() }).status === 'ready',
      'hub confirmation',
    );
  }
  onStage('Receiving…');
  await requestFaucet('offchain', {
    jurisdiction: wallet.jurisdiction,
    entityId,
    signerId: wallet.signerId,
    runtimeId: requireAdapter().runtimeId,
    hubEntityId: hub.counterpartyId,
    tokenId: 1,
    tokenSymbol: 'USDC',
    amount: '100',
  });
  await waitFor(async () => balance(await read()) >= before + 100_000_000n, 'confirmed test payment');
}
