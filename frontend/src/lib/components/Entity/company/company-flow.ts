import type { EntityId, EntityTx, RoutedEntityInput } from '@xln/runtime/api/public/runtime-module';

export const COMPANY_SHARE_SUPPLY = 100_000_000_000n;
export const COMPANY_DIVIDEND_TOKEN_FLAG = 1n << 255n;

export type CompanyShareClass = 'control' | 'dividend';

export type CompanyShareTokenProjection = Readonly<{
  shareClass: CompanyShareClass;
  externalTokenId: bigint;
  internalTokenId: number | null;
  reserve: bigint;
}>;

type CompanyCatalogToken = Readonly<{
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
  if (value <= 0n || value >= COMPANY_DIVIDEND_TOKEN_FLAG) {
    throw new Error(`COMPANY_NUMBERED_ENTITY_REQUIRED:${entityId || 'missing'}`);
  }
  return value;
};

export const getCompanyShareExternalTokenIds = (entityId: EntityId): Readonly<{
  control: bigint;
  dividend: bigint;
}> => {
  const control = numberedEntityValue(entityId);
  return { control, dividend: control | COMPANY_DIVIDEND_TOKEN_FLAG };
};

const parseCatalogExternalTokenId = (token: CompanyCatalogToken): bigint | null => {
  if (token.tokenType !== 2 || typeof token.externalTokenId !== 'string') return null;
  try {
    const value = BigInt(token.externalTokenId);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
};

export const projectCompanyShareTokens = (
  entityId: EntityId,
  catalog: readonly CompanyCatalogToken[],
  reserves: ReadonlyMap<number, bigint>,
): readonly CompanyShareTokenProjection[] => {
  const ids = getCompanyShareExternalTokenIds(entityId);
  const project = (shareClass: CompanyShareClass, externalTokenId: bigint): CompanyShareTokenProjection => {
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

export const buildCompanyShareReleaseInput = (input: Readonly<{
  entityId: EntityId;
  signerId: string;
  depositoryAddress: string;
  controlAmount?: bigint;
  dividendAmount?: bigint;
  purpose?: string;
}>): RoutedEntityInput => {
  const signerId = input.signerId.trim().toLowerCase();
  const depositoryAddress = input.depositoryAddress.trim().toLowerCase();
  const controlAmount = input.controlAmount ?? COMPANY_SHARE_SUPPLY;
  const dividendAmount = input.dividendAmount ?? COMPANY_SHARE_SUPPLY;
  const purpose = input.purpose?.trim() || 'Company treasury issuance';
  numberedEntityValue(input.entityId);
  if (!signerId) throw new Error('COMPANY_SIGNER_REQUIRED');
  if (!/^0x[0-9a-f]{40}$/.test(depositoryAddress)) {
    throw new Error(`COMPANY_DEPOSITORY_ADDRESS_INVALID:${depositoryAddress || 'missing'}`);
  }
  if (controlAmount < 0n || dividendAmount < 0n || controlAmount + dividendAmount === 0n) {
    throw new Error('COMPANY_SHARE_RELEASE_AMOUNT_INVALID');
  }
  const release: EntityTx = {
    type: 'entityProviderReleaseControlShares',
    data: { recipientAddress: depositoryAddress, controlAmount, dividendAmount, purpose },
  };
  return { entityId: input.entityId, signerId, entityTxs: [release] };
};

export const selectDefaultCompanyHub = <T extends Readonly<{
  entityId: string;
  isConnected: boolean;
  isOpening: boolean;
  metadata: Readonly<{ fee: number; peerCount: number }>;
}>>(hubs: readonly T[]): T | null => {
  const available = hubs.filter((hub) => !hub.isConnected && !hub.isOpening);
  return [...available].sort((left, right) =>
    left.metadata.fee - right.metadata.fee
    || right.metadata.peerCount - left.metadata.peerCount
    || left.entityId.localeCompare(right.entityId)
  )[0] ?? null;
};
