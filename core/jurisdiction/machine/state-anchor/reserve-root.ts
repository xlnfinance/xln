import { ethers } from 'ethers';

// Pure E1 reserve anchor root. The eth_getProof reader (adapter
// rpc-reserve-anchor.ts) and the Entity-side anchor admission build the same
// root from the same canonical leaves.
//
// Storage cannot tell a never-touched reserve from a drained one, while the
// Entity fold keeps a drained token as an explicit 0n. The anchor view holds
// non-zero balances only; compare history through projectNonZeroReserves.

const RESERVE_ANCHOR_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('xln:j-reserve-anchor:v1')).toLowerCase();
const ABI = ethers.AbiCoder.defaultAbiCoder();

const fail = (code: string, detail = ''): never => {
  throw new Error(`RESERVE_ANCHOR_${code}${detail ? `:${detail}` : ''}`);
};

const entityKey = (entityId: string): string => {
  const normalized = String(entityId).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) fail('ENTITY_INVALID', String(entityId));
  return normalized;
};

/** Drops explicit zero balances so a history fold compares with storage. */
export const projectNonZeroReserves = (reserves: ReadonlyMap<number, bigint>): Map<number, bigint> => {
  const projected = new Map<number, bigint>();
  for (const [tokenId, balance] of reserves) {
    if (!Number.isSafeInteger(tokenId) || tokenId < 0) fail('TOKEN_INVALID', String(tokenId));
    if (balance < 0n) fail('BALANCE_NEGATIVE', `${tokenId}:${balance.toString()}`);
    if (balance !== 0n) projected.set(tokenId, balance);
  }
  return projected;
};

/**
 * Canonical root over the enumeration bound and the non-zero reserves of the
 * listed entities. Entities and tokens are sorted; an entity with no non-zero
 * reserve still contributes its id, so omitting an entity moves the root.
 */
export const buildReserveAnchorRoot = (
  tokenCount: bigint,
  reserves: ReadonlyMap<string, ReadonlyMap<number, bigint>>,
): string => {
  if (tokenCount < 1n) fail('TOKEN_COUNT_INVALID', tokenCount.toString());
  const entities = [...reserves.keys()].map(entityKey).sort();
  if (new Set(entities).size !== entities.length) fail('ENTITY_DUPLICATE');
  const leaves = entities.map(entityId => {
    const balances = [...projectNonZeroReserves(reserves.get(entityId) ?? fail('ENTITY_MISSING', entityId))]
      .sort(([left], [right]) => left - right);
    for (const [tokenId] of balances) {
      if (BigInt(tokenId) >= tokenCount) fail('TOKEN_UNLISTED', `${entityId}:${tokenId}:${tokenCount.toString()}`);
    }
    return ethers.keccak256(ABI.encode(
      ['bytes32', 'uint256[]', 'uint256[]'],
      [entityId, balances.map(([tokenId]) => BigInt(tokenId)), balances.map(([, balance]) => balance)],
    ));
  });
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'uint256', 'bytes32[]'],
    [RESERVE_ANCHOR_DOMAIN, tokenCount, leaves],
  )).toLowerCase();
};
