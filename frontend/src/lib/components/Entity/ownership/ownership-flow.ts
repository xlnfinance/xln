import type { EntityId, EntityTx, RoutedEntityInput } from '@xln/runtime/api/public/runtime-module';

export const ENTITY_SHARE_SUPPLY = 100_000_000_000n;
export const ENTITY_DIVIDEND_TOKEN_FLAG = 1n << 255n;

export type EntityShareClass = 'control' | 'dividend';

export type EntityShareTokenProjection = Readonly<{
  shareClass: EntityShareClass;
  externalTokenId: bigint;
  internalTokenId: number | null;
  reserve: bigint;
}>;

type EntityCatalogToken = Readonly<{
  tokenId: number | undefined;
  tokenType?: number;
  externalTokenId?: string;
}>;

const numberedEntityValue = (entityId: EntityId): bigint => {
  let value: bigint;
  try {
    value = BigInt(entityId);
  } catch {
    throw new Error(`COMPANY_NUMBERED_ENTITY_REQUIRED:${entityId || 'missing'}`);
  }
  if (value <= 0n || value >= ENTITY_DIVIDEND_TOKEN_FLAG) {
    throw new Error(`ENTITY_SHARE_NUMBERED_ID_REQUIRED:${entityId || 'missing'}`);
  }
  return value;
};

export const getEntityShareExternalTokenIds = (entityId: EntityId): Readonly<{
  control: bigint;
  dividend: bigint;
}> => {
  const control = numberedEntityValue(entityId);
  return { control, dividend: control | ENTITY_DIVIDEND_TOKEN_FLAG };
};

const parseCatalogExternalTokenId = (token: EntityCatalogToken): bigint | null => {
  if (token.tokenType !== 2 || typeof token.externalTokenId !== 'string') return null;
  try {
    const value = BigInt(token.externalTokenId);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
};

export const projectEntityShareTokens = (
  entityId: EntityId,
  catalog: readonly EntityCatalogToken[],
  reserves: ReadonlyMap<number, bigint>,
): readonly EntityShareTokenProjection[] => {
  const ids = getEntityShareExternalTokenIds(entityId);
  const project = (shareClass: EntityShareClass, externalTokenId: bigint): EntityShareTokenProjection => {
    const token = catalog.find((candidate) => parseCatalogExternalTokenId(candidate) === externalTokenId);
    const internalTokenId = Number.isSafeInteger(token?.tokenId) && Number(token?.tokenId) > 0
      ? Number(token?.tokenId)
      : null;
    return {
      shareClass,
      externalTokenId,
      internalTokenId,
      reserve: internalTokenId === null ? 0n : reserves.get(internalTokenId) ?? 0n,
    };
  };
  return [project('control', ids.control), project('dividend', ids.dividend)];
};

export const buildEntityShareReleaseInput = (input: Readonly<{
  entityId: EntityId;
  signerId: string;
  depositoryAddress: string;
  controlAmount?: bigint;
  dividendAmount?: bigint;
  purpose?: string;
}>): RoutedEntityInput => {
  const signerId = input.signerId.trim().toLowerCase();
  const depositoryAddress = input.depositoryAddress.trim().toLowerCase();
  const controlAmount = input.controlAmount ?? ENTITY_SHARE_SUPPLY;
  const dividendAmount = input.dividendAmount ?? ENTITY_SHARE_SUPPLY;
  const purpose = input.purpose?.trim() || 'Entity treasury issuance';
  numberedEntityValue(input.entityId);
  if (!signerId) throw new Error('ENTITY_SHARE_SIGNER_REQUIRED');
  if (!/^0x[0-9a-f]{40}$/.test(depositoryAddress)) {
    throw new Error(`ENTITY_SHARE_DEPOSITORY_ADDRESS_INVALID:${depositoryAddress || 'missing'}`);
  }
  if (controlAmount < 0n || dividendAmount < 0n || controlAmount + dividendAmount === 0n) {
    throw new Error('ENTITY_SHARE_RELEASE_AMOUNT_INVALID');
  }
  const release: EntityTx = {
    type: 'entityProviderReleaseControlShares',
    data: { recipientAddress: depositoryAddress, controlAmount, dividendAmount, purpose },
  };
  return { entityId: input.entityId, signerId, entityTxs: [release] };
};
