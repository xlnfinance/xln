import type { RuntimeInput } from '../runtime-types';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';

export type MoveKind = 'r2c' | 'r2r' | 'r2e';

export const buildMoveInput = (input: {
  entityId: string;
  signerId: string;
  kind: MoveKind;
  tokenId: number;
  amount: bigint;
  counterpartyId?: string;
  toEntityId?: string;
  receivingEntity?: string;
}): RuntimeInput => {
  if (input.amount <= 0n) throw new Error('Move amount must be positive');
  let entityTx: { type: string; data: Record<string, unknown> };
  if (input.kind === 'r2c') {
    if (!input.counterpartyId) throw new Error('r2c requires --counterparty');
    entityTx = {
      type: 'r2c',
      data: {
        counterpartyId: input.counterpartyId.toLowerCase(),
        tokenId: input.tokenId,
        amount: input.amount,
      },
    };
  } else if (input.kind === 'r2r') {
    if (!input.toEntityId) throw new Error('r2r requires --to');
    entityTx = {
      type: 'r2r',
      data: {
        toEntityId: input.toEntityId.toLowerCase(),
        tokenId: input.tokenId,
        amount: input.amount,
      },
    };
  } else {
    if (!input.receivingEntity) throw new Error('r2e requires --to');
    entityTx = {
      type: 'r2e',
      data: {
        receivingEntity: input.receivingEntity.toLowerCase(),
        tokenId: input.tokenId,
        amount: input.amount,
      },
    };
  }
  return {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: input.entityId.toLowerCase(),
        signerId: input.signerId,
        entityTxs: [entityTx as never],
      },
    ],
  };
};

export const executeMove = async (
  session: CliSession,
  args: {
    kind: MoveKind;
    tokenId: number;
    amount: bigint;
    counterpartyId?: string;
    to?: string;
  },
): Promise<number> => {
  const input = buildMoveInput({
    entityId: session.entityId,
    signerId: session.signerId,
    kind: args.kind,
    tokenId: args.tokenId,
    amount: args.amount,
    counterpartyId: args.counterpartyId,
    toEntityId: args.kind === 'r2r' ? args.to : undefined,
    receivingEntity: args.kind === 'r2e' ? args.to : undefined,
  });
  return submitAndWait(session.env, input, () => true, `move:${args.kind}`, 45_000);
};
