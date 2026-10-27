import { expect, test } from 'bun:test';
import { fullCreditLimits } from '../../../ui/src/runtime/financial/credit-limit';
import type { AccountView } from '../../../ui/src/runtime/views';

const account = (id: string, disputed: boolean, lines: Array<{
  tokenId: number; peerCreditLimit: bigint; inPeerCredit: bigint; inCollateral?: bigint; inOwnCredit?: bigint;
}>) =>
  ({
    counterpartyId: id,
    label: `Hub ${id}`,
    disputed,
    tokens: lines.map(({ tokenId, ...derived }) => ({ tokenId, derived: { inCollateral: 0n, inOwnCredit: 0n, ...derived } })),
  }) as unknown as AccountView;

test('a credit line the user extends is full only when the counterparty owes all of it', () => {
  const limit = 10_000n * 10n ** 6n;
  expect(fullCreditLimits([
    account('a', false, [
      { tokenId: 1, peerCreditLimit: limit, inPeerCredit: 0n },
      { tokenId: 2, peerCreditLimit: limit, inPeerCredit: 1n },
      { tokenId: 3, peerCreditLimit: 0n, inPeerCredit: 0n },
      { tokenId: 4, peerCreditLimit: limit, inPeerCredit: 0n, inCollateral: 5n },
      { tokenId: 5, peerCreditLimit: limit, inPeerCredit: 0n, inOwnCredit: 5n },
    ]),
    account('b', true, [{ tokenId: 1, peerCreditLimit: limit, inPeerCredit: 0n }]),
  ])).toEqual([{ accountId: 'a', label: 'Hub a', tokenId: 1, limit }]);
});
