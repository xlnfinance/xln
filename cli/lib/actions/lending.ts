import type { RuntimeInput } from '../runtime-types';
import { fetchLendingState } from '../api';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';

export type LendingOp = 'offer' | 'borrow' | 'repay';

export const buildLendingInput = (input: {
  entityId: string;
  signerId: string;
  op: LendingOp;
  hubEntityId: string;
  tokenId: number;
  amount: bigint;
}): RuntimeInput => {
  if (input.amount <= 0n) throw new Error('Lending amount must be positive');
  const type =
    input.op === 'offer' ? 'lendingOffer' : input.op === 'borrow' ? 'lendingBorrow' : 'lendingRepay';
  return {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: input.entityId.toLowerCase(),
        signerId: input.signerId,
        entityTxs: [
          {
            type,
            data: {
              hubEntityId: input.hubEntityId.toLowerCase(),
              tokenId: input.tokenId,
              amount: input.amount,
            },
          } as never,
        ],
      },
    ],
  };
};

export const executeLending = async (
  session: CliSession,
  args: {
    op: LendingOp;
    hubEntityId: string;
    tokenId: number;
    amount: bigint;
  },
): Promise<void> => {
  const input = buildLendingInput({
    entityId: session.entityId,
    signerId: session.signerId,
    op: args.op,
    hubEntityId: args.hubEntityId,
    tokenId: args.tokenId,
    amount: args.amount,
  });
  await submitAndWait(session.env, input, () => true, `lend:${args.op}`, 45_000);
};

export const readLendingState = async (
  session: CliSession,
  hubEntityId: string,
  tokenId: number,
): Promise<unknown> =>
  fetchLendingState(session.settings, {
    hubEntityId,
    userEntityId: session.entityId,
    tokenId,
  });
