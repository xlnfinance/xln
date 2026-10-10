import type { HubChild, HubHealthPayload, HubInfoPayload } from '../orchestrator-types';
import { parseRuntimeSecurityIncidentTelemetry } from '../health/runtime-security-telemetry';

const invalid = (path: string, expected: string): never => {
  throw new Error(`BOOTSTRAP_HEALTH_PAYLOAD_INVALID:path=${path}:expected=${expected}`);
};

const recordAt = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'object');
  return value as Record<string, unknown>;
};

const optionalArray = (value: unknown, path: string): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(path, 'array');
  return value as unknown[];
};

const optionalField = (
  record: Record<string, unknown>,
  key: string,
  type: 'boolean' | 'number' | 'string',
  path: string,
): void => {
  const value = record[key];
  if (value !== undefined && typeof value !== type) invalid(`${path}.${key}`, type);
};

const optionalSafeInteger = (record: Record<string, unknown>, key: string, path: string): void => {
  const value = record[key];
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    invalid(`${path}.${key}`, 'nonnegative-safe-integer');
  }
};

const requiredSafeInteger = (record: Record<string, unknown>, key: string, path: string): void => {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`${path}.${key}`, 'nonnegative-safe-integer');
  }
};

const requiredNullableSafeInteger = (record: Record<string, unknown>, key: string, path: string): void => {
  const value = record[key];
  if (value !== null && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    invalid(`${path}.${key}`, 'null-or-nonnegative-safe-integer');
  }
};

const requiredField = (
  record: Record<string, unknown>,
  key: string,
  type: 'boolean' | 'string',
  path: string,
): void => {
  if (typeof record[key] !== type) invalid(`${path}.${key}`, type);
};

const requiredNullableString = (record: Record<string, unknown>, key: string, path: string): void => {
  const value = record[key];
  if (value !== null && typeof value !== 'string') invalid(`${path}.${key}`, 'null-or-string');
};

const stringArray = (value: unknown, path: string): void => {
  for (const [index, entry] of optionalArray(value, path).entries()) {
    if (typeof entry !== 'string') invalid(`${path}[${index}]`, 'string');
  }
};

const validateToken = (value: unknown, path: string): void => {
  const token = recordAt(value, path);
  optionalSafeInteger(token, 'tokenId', path);
  for (const key of ['symbol', 'current', 'expectedMin'] as const) optionalField(token, key, 'string', path);
  optionalSafeInteger(token, 'decimals', path);
  for (const key of ['ready', 'operational', 'targetMet'] as const) optionalField(token, key, 'boolean', path);
};

const validateMesh = (value: unknown): void => {
  if (value === undefined) return;
  const mesh = recordAt(value, 'mesh');
  optionalField(mesh, 'ready', 'boolean', 'mesh');
  for (const [index, valueAtIndex] of optionalArray(mesh['pairs'], 'mesh.pairs').entries()) {
    const path = `mesh.pairs[${index}]`;
    const pair = recordAt(valueAtIndex, path);
    requiredSafeInteger(pair, 'currentHeight', path);
    requiredNullableSafeInteger(pair, 'pendingFrameHeight', path);
    requiredNullableString(pair, 'pendingFrameHash', path);
    // Every pair field is read unconditionally downstream (hub baseline
    // progress lowercases counterpartyId), so none of them is optional here.
    for (const key of ['counterpartyId', 'counterpartyName', 'grantedByMe', 'grantedByPeer'] as const) {
      requiredField(pair, key, 'string', path);
    }
    for (const key of ['hasAccount', 'ready'] as const) requiredField(pair, key, 'boolean', path);
  }
};

const validateReserves = (value: unknown): void => {
  if (value === undefined) return;
  const reserves = recordAt(value, 'bootstrapReserves');
  optionalField(reserves, 'ok', 'boolean', 'bootstrapReserves');
  optionalField(reserves, 'targetMet', 'boolean', 'bootstrapReserves');
  optionalArray(reserves['tokens'], 'bootstrapReserves.tokens')
    .forEach((token, index) => validateToken(token, `bootstrapReserves.tokens[${index}]`));
  for (const [index, valueAtIndex] of optionalArray(reserves['entities'], 'bootstrapReserves.entities').entries()) {
    const path = `bootstrapReserves.entities[${index}]`;
    const entity = recordAt(valueAtIndex, path);
    for (const key of ['entityId', 'jurisdictionName'] as const) optionalField(entity, key, 'string', path);
    for (const key of ['primary', 'ready', 'targetMet'] as const) optionalField(entity, key, 'boolean', path);
    optionalArray(entity['tokens'], `${path}.tokens`)
      .forEach((token, tokenIndex) => validateToken(token, `${path}.tokens[${tokenIndex}]`));
  }
};

const validateTimings = (value: unknown): void => {
  if (value === undefined) return;
  const timings = recordAt(value, 'timings');
  for (const [key, stageValue] of Object.entries(timings)) {
    const path = `timings.${key}`;
    const stage = recordAt(stageValue, path);
    for (const field of ['startedAt', 'completedAt', 'ms'] as const) {
      const entry = stage[field];
      if (entry !== null && entry !== undefined && (!Number.isFinite(entry) || Number(entry) < 0)) {
        invalid(`${path}.${field}`, 'null-or-nonnegative-number');
      }
    }
  }
};

export const validateHubHealthPayload = (value: unknown): HubHealthPayload => {
  const health = recordAt(value, 'health');
  optionalSafeInteger(health, 'height', 'health');
  let sanitizedRuntime: Record<string, unknown> | undefined;
  if (health['runtime'] !== undefined) {
    const runtime = recordAt(health['runtime'], 'health.runtime');
    optionalField(runtime, 'halted', 'boolean', 'health.runtime');
    optionalField(runtime, 'lifecyclePhase', 'string', 'health.runtime');
    sanitizedRuntime = {
      ...runtime,
      securityIncidents: parseRuntimeSecurityIncidentTelemetry(runtime['securityIncidents']),
    };
  }
  if (health['gossip'] !== undefined) {
    const gossip = recordAt(health['gossip'], 'gossip');
    stringArray(gossip['visibleHubNames'], 'gossip.visibleHubNames');
    stringArray(gossip['visibleHubIds'], 'gossip.visibleHubIds');
    optionalField(gossip, 'ready', 'boolean', 'gossip');
  }
  validateMesh(health['mesh']);
  validateReserves(health['bootstrapReserves']);
  validateTimings(health['timings']);
  return {
    ...health,
    ...(sanitizedRuntime ? { runtime: sanitizedRuntime } : {}),
  } as HubHealthPayload;
};

export const validateHubInfoPayload = (value: unknown): HubInfoPayload => {
  const info = recordAt(value, 'info');
  optionalField(info, 'deliveryReady', 'boolean', 'info');
  for (const [index, valueAtIndex] of optionalArray(info['hubEntities'], 'info.hubEntities').entries()) {
    const path = `info.hubEntities[${index}]`;
    const entity = recordAt(valueAtIndex, path);
    for (const key of ['entityId', 'signerId', 'name', 'jurisdictionName', 'depositoryAddress', 'entityProviderAddress'] as const) {
      optionalField(entity, key, 'string', path);
    }
    optionalSafeInteger(entity, 'chainId', path);
    optionalField(entity, 'primary', 'boolean', path);
    optionalField(entity, 'isHub', 'boolean', path);
  }
  return info as HubInfoPayload;
};

export const requireHubBootstrapOwners = (child: HubChild) => {
  const inventory = child.lastInfo?.hubEntities;
  if (child.engine === 'rust' && inventory?.some(owner => typeof owner.isHub !== 'boolean')) {
    throw new Error(`RUST_HUB_BOOTSTRAP_OWNER_ROLE:${child.name}`);
  }
  const owners = child.engine === 'rust' ? inventory?.filter(owner => owner.isHub === true) : inventory;
  if (!owners?.length) throw new Error(`RUST_HUB_BOOTSTRAP_INVENTORY_MISSING:${child.name}`);
  return owners.map(owner => {
    const entityId = String(owner.entityId || '').trim().toLowerCase();
    const signerId = String(owner.signerId || '').trim().toLowerCase();
    const jurisdictionName = String(owner.jurisdictionName || '').trim();
    if (!/^0x[0-9a-f]{64}$/.test(entityId) || !/^0x[0-9a-f]{40}$/.test(signerId) || !jurisdictionName) {
      throw new Error(`RUST_HUB_BOOTSTRAP_OWNER_AUTHORITY:${child.name}`);
    }
    return { entityId, signerId, jurisdictionName };
  });
};
