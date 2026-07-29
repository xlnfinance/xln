import type { JurisdictionEvent } from '../types';
import type { RawJEvent } from './helpers';

export const buildAccountSettledEvents = (event: RawJEvent, entityId: string): JurisdictionEvent[] => {
  const settledRaw = event.args['settled'] ?? event.args[''] ?? event.args[0] ?? [];
  const settled = Array.isArray(settledRaw) ? settledRaw : [];
  const results: JurisdictionEvent[] = [];
  for (const rawSettlement of settled) {
    const settlement = rawSettlement as Record<string, unknown> & unknown[];
    const left = settlement[0] ?? settlement['left'];
    const right = settlement[1] ?? settlement['right'];
    if (
      String(left).toLowerCase() !== entityId.toLowerCase() &&
      String(right).toLowerCase() !== entityId.toLowerCase()
    ) {
      continue;
    }
    const tokensRaw = settlement[2] ?? settlement['tokens'] ?? [];
    const tokens = Array.isArray(tokensRaw) ? tokensRaw : [];
    const nonce = Number(settlement[3] ?? settlement['nonce'] ?? 0);
    for (const rawToken of tokens) {
      const token = rawToken as Record<string, unknown> & unknown[];
      results.push({
        type: 'AccountSettled',
        data: {
          leftEntity: String(left),
          rightEntity: String(right),
          tokenId: Number(token[0] ?? token['tokenId'] ?? 0),
          leftReserve: (token[1] ?? token['leftReserve'] ?? 0n).toString(),
          rightReserve: (token[2] ?? token['rightReserve'] ?? 0n).toString(),
          collateral: (token[3] ?? token['collateral'] ?? 0n).toString(),
          ondelta: (token[4] ?? token['ondelta'] ?? 0n).toString(),
          nonce,
        },
      });
    }
  }
  return results;
};

export const buildDebtEvent = (event: RawJEvent): JurisdictionEvent[] => {
  const args = event.args;
  switch (event.name) {
    case 'DebtCreated':
      return [
        {
          type: 'DebtCreated',
          data: {
            debtor: String(args['debtor'] ?? ''),
            creditor: String(args['creditor'] ?? ''),
            tokenId: Number(args['tokenId']),
            amount: (args['amount'] ?? 0).toString(),
            debtIndex: Number(args['debtIndex'] ?? 0),
          },
        },
      ];
    case 'DebtEnforced':
      return [
        {
          type: 'DebtEnforced',
          data: {
            debtor: String(args['debtor'] ?? ''),
            creditor: String(args['creditor'] ?? ''),
            tokenId: Number(args['tokenId']),
            amountPaid: (args['amountPaid'] ?? 0).toString(),
            remainingAmount: (args['remainingAmount'] ?? 0).toString(),
            newDebtIndex: Number(args['newDebtIndex'] ?? 0),
          },
        },
      ];
    case 'DebtForgiven':
      return [
        {
          type: 'DebtForgiven',
          data: {
            debtor: String(args['debtor'] ?? ''),
            creditor: String(args['creditor'] ?? ''),
            tokenId: Number(args['tokenId']),
            amountForgiven: (args['amountForgiven'] ?? 0).toString(),
            debtIndex: Number(args['debtIndex'] ?? 0),
          },
        },
      ];
    default:
      return [];
  }
};
