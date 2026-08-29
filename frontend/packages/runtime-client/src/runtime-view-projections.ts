import {
  normalizeEntityIdForRuntimeView,
  runtimeViewQueryAtHeight,
  type RuntimeViewFrameModel,
} from './runtime-view-model';

export type RuntimeViewProjectionQuery = {
  atHeight?: number;
  entityId?: string;
  accountsLimit?: number;
  booksLimit?: number;
  cursor?: string;
  limit?: number;
};

export type RuntimeViewProjectionDependencies<Frame, Account, History> = Readonly<{
  readAtHeight: () => number | null;
  readViewFrame: (query: RuntimeViewProjectionQuery) => Promise<Frame>;
  readAccount: (
    entityId: string,
    counterpartyId: string,
    query: RuntimeViewProjectionQuery,
  ) => Promise<Account>;
  readSwapHistory: (
    entityId: string,
    counterpartyId: string,
    query: RuntimeViewProjectionQuery,
  ) => Promise<History>;
}>;

const normalizeProjectionPair = (
  entityId: string,
  counterpartyId: string,
  errorCode: string,
): readonly [string, string] => {
  const owner = normalizeEntityIdForRuntimeView(entityId);
  const counterparty = normalizeEntityIdForRuntimeView(counterpartyId);
  if (!owner || !counterparty) throw new Error(errorCode);
  return [owner, counterparty];
};

export class RuntimeViewProjectionReader<
  Frame extends RuntimeViewFrameModel,
  Account,
  History,
> {
  constructor(
    private readonly dependencies: RuntimeViewProjectionDependencies<Frame, Account, History>,
  ) {}

  readonly readEntityFrame = async (entityId: string): Promise<Frame> => {
    const expectedEntityId = normalizeEntityIdForRuntimeView(entityId);
    if (!expectedEntityId) throw new Error('RUNTIME_ENTITY_PROJECTION_ID_MISSING');
    const frame = await this.dependencies.readViewFrame(this.atSelectedHeight({
      entityId: expectedEntityId,
      accountsLimit: 10,
      booksLimit: 10,
    }));
    const actualEntityId = normalizeEntityIdForRuntimeView(
      frame.activeEntityId || frame.activeEntity?.summary?.entityId || frame.activeEntity?.core?.entityId,
    );
    if (actualEntityId !== expectedEntityId) {
      throw new Error(
        `RUNTIME_ENTITY_PROJECTION_MISMATCH:${expectedEntityId}:${actualEntityId || 'missing'}`,
      );
    }
    return frame;
  };

  readonly readAccount = async (entityId: string, counterpartyId: string): Promise<Account> => {
    const [owner, counterparty] = normalizeProjectionPair(
      entityId,
      counterpartyId,
      'RUNTIME_ACCOUNT_PROJECTION_ID_MISSING',
    );
    return this.dependencies.readAccount(owner, counterparty, this.atSelectedHeight({}));
  };

  readonly readSwapHistory = async (
    entityId: string,
    counterpartyId: string,
    cursor: string | null,
  ): Promise<History> => {
    const [owner, counterparty] = normalizeProjectionPair(
      entityId,
      counterpartyId,
      'RUNTIME_SWAP_HISTORY_ID_MISSING',
    );
    return this.dependencies.readSwapHistory(
      owner,
      counterparty,
      this.atSelectedHeight({ ...(cursor === null ? {} : { cursor }), limit: 100 }),
    );
  };

  private atSelectedHeight(query: RuntimeViewProjectionQuery): RuntimeViewProjectionQuery {
    return runtimeViewQueryAtHeight(query, this.dependencies.readAtHeight());
  }
}
