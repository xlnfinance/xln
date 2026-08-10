import { addMessage } from '../frame-events';
import { getTokenInfo } from '../../account/utils';
import { formatTokenAmount } from '../../account/financial-utils';
import {
  applySignerEntityExternalWalletDelta,
  applySignerEntityExternalWalletSnapshot,
} from '../signer-wallet';
import { applyKnownHtlcSecret } from './j-events-htlc';
import { applyDebtCreated, applyDebtEnforced, applyDebtForgiven } from './j-events-debt';
import type { FinalizedJEventContext } from './j-events';

const displayTokenAmount = (tokenId: number, amount: unknown): string => {
  return formatTokenAmount(tokenId, BigInt(amount as string | number | bigint));
};

export const applyReserveUpdatedJEvent = (context: FinalizedJEventContext): void => {
  const { entityState, newState, event, blockNumber, transactionHash } = context;
  if (event.type !== 'ReserveUpdated') {
    throw new Error(`J_EVENT_RESERVE_ROUTE_MISMATCH:${event.type}`);
  }
  const tokenId = Number(event.data.tokenId);
  if (String(event.data.entity).toLowerCase() === entityState.entityId.toLowerCase()) {
    newState.reserves.set(
      tokenId,
      BigInt(event.data.newBalance as string | number | bigint),
    );
  }
  addMessage(
    newState,
    `📊 RESERVE: ${displayTokenAmount(tokenId, event.data.newBalance)} | ` +
    `Block ${blockNumber} | Tx ${transactionHash.slice(0, 10)}...`,
  );
};

export const applyExternalWalletJEvent = (context: FinalizedJEventContext): void => {
  const { entityState, newState, event, blockNumber, transactionHash } = context;
  if (event.type !== 'ExternalWalletSnapshot' && event.type !== 'ExternalWalletDelta') {
    throw new Error(`J_EVENT_EXTERNAL_WALLET_ROUTE_MISMATCH:${event.type}`);
  }
  if (String(event.data.entityId).toLowerCase() !== entityState.entityId.toLowerCase()) {
    return;
  }
  const owner = event.type === 'ExternalWalletSnapshot'
    ? applySignerEntityExternalWalletSnapshot(newState, event, blockNumber, transactionHash)
    : applySignerEntityExternalWalletDelta(newState, event, blockNumber, transactionHash);
  const kind = event.type === 'ExternalWalletSnapshot' ? 'snapshot' : 'delta';
  addMessage(
    newState,
    `💼 EXTERNAL: ${owner.slice(0, 10)} ${kind} | Block ${blockNumber} | ` +
    `Tx ${transactionHash.slice(0, 10)}...`,
  );
};

export const applySecretRevealedJEvent = (context: FinalizedJEventContext): void => {
  const { newState, event, blockNumber, accountTxs, outputs } = context;
  if (event.type !== 'SecretRevealed') {
    throw new Error(`J_EVENT_SECRET_ROUTE_MISMATCH:${event.type}`);
  }
  applyKnownHtlcSecret(
    newState,
    accountTxs,
    outputs,
    String(event.data.hashlock),
    String(event.data.secret),
    blockNumber,
    'SecretRevealed',
  );
};

export const applyDebtJEvent = (context: FinalizedJEventContext): void => {
  const { newState, event, blockNumber } = context;
  if (event.type === 'DebtCreated') {
    const { debtor, creditor, tokenId, amount } = event.data;
    applyDebtCreated(newState, event);
    addMessage(
      newState,
      `🔴 DEBT: ${String(debtor).slice(-8)} owes ` +
      `${displayTokenAmount(Number(tokenId), amount)} ${getTokenInfo(Number(tokenId)).symbol} ` +
      `to ${String(creditor).slice(-8)} | Block ${blockNumber}`,
    );
    return;
  }
  if (event.type === 'DebtEnforced') {
    const { creditor, tokenId, amountPaid } = event.data;
    applyDebtEnforced(newState, event);
    addMessage(
      newState,
      `✅ DEBT PAID: ${displayTokenAmount(Number(tokenId), amountPaid)} ` +
      `${getTokenInfo(Number(tokenId)).symbol} to ${String(creditor).slice(-8)} | ` +
      `Block ${blockNumber}`,
    );
    return;
  }
  if (event.type === 'DebtForgiven') {
    const { debtor, creditor, tokenId, amountForgiven, debtIndex } = event.data;
    applyDebtForgiven(newState, event);
    addMessage(
      newState,
      `🩶 DEBT FORGIVEN: ${displayTokenAmount(Number(tokenId), amountForgiven)} ` +
      `${getTokenInfo(Number(tokenId)).symbol} between ${String(debtor).slice(-8)} ` +
      `and ${String(creditor).slice(-8)} | Block ${blockNumber} · debt #${debtIndex}`,
    );
    return;
  }
  throw new Error(`J_EVENT_DEBT_ROUTE_MISMATCH:${event.type}`);
};
