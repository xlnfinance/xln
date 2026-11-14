import { getJson } from '../http';
import { decodeLendingState, type LendingState } from './lending';

export async function fetchLendingState(input: {
  hubEntityId: string;
  userEntityId: string;
  tokenId: number;
  requestId?: string;
}): Promise<LendingState> {
  const result = await getJson('/api/lending/state', {
    hubEntityId: input.hubEntityId,
    userEntityId: input.userEntityId,
    tokenId: String(input.tokenId),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return decodeLendingState(result, input);
}

