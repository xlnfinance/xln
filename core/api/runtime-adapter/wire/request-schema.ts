import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';
import { decodeLocalRuntimeInput } from '../../../runtime/decode';
import { validateStorageSafeValue } from '../../../protocol/boundary/boundary-primitives';
import { MAX_NUMBERED_REGISTRATION_ENTITIES } from '../../../runtime/registration/numbered/numbered-registration-codec';
import { LIMITS } from '../../../config/constants';
import type {
  RuntimeAdapterReadQuery,
  RuntimeAdapterRequest,
} from '../types';
import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { decodeSettlementEvidenceRequest } from '../control/settlement-evidence';

// Exact-shape validation of every runtime-adapter request op, including the
// read query and the numbered-registration input.

const QUERY_KEYS = [
  'atHeight',
  'heights',
  'cursor',
  'limit',
  'entityId',
  'accountId',
  'accountsPage',
  'booksPage',
  'accountsCursor',
  'booksCursor',
  'accountsLimit',
  'booksLimit',
  'sortBy',
  'sortDir',
  'kind',
  'types',
  'q',
  'query',
  'fromTimestamp',
  'toTimestamp',
  'beforeHeight',
  'scanLimit',
  'fromHeight',
  'toHeight',
  'eventNames',
  'sourceEntityId',
  'targetEntityId',
  'fundingAccountId',
  'tokenId',
  'amount',
] as const;

const QUERY_INTEGER_KEYS = [
  'atHeight',
  'limit',
  'accountsPage',
  'booksPage',
  'accountsLimit',
  'booksLimit',
  'fromTimestamp',
  'toTimestamp',
  'beforeHeight',
  'scanLimit',
  'fromHeight',
  'toHeight',
  'tokenId',
] as const;

const QUERY_STRING_KEYS = [
  'cursor',
  'entityId',
  'accountId',
  'accountsCursor',
  'booksCursor',
  'sortBy',
  'q',
  'query',
  'sourceEntityId',
  'targetEntityId',
  'fundingAccountId',
  'amount',
] as const;

export const requireNonEmptyString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

const requireBoundedSecretString = (value: unknown, maximumBytes: number, code: string): string => {
  const text = requireNonEmptyString(value, code);
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error(code);
  return text;
};

const validateStringList = (value: unknown, code: string): void => {
  if (typeof value === 'string') return;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(code);
};

function assertReadQuery(
  query: Record<string, unknown>,
): asserts query is Record<string, unknown> & RuntimeAdapterReadQuery {
  requireExactBoundaryKeys(query, [], QUERY_KEYS, 'RADAPTER_REQUEST_QUERY_FIELDS_INVALID');
  for (const key of QUERY_INTEGER_KEYS) {
    if (query[key] !== undefined) requireBoundaryInteger(query[key], `RADAPTER_REQUEST_QUERY_${key}_INVALID`);
  }
  for (const key of QUERY_STRING_KEYS) {
    if (query[key] !== undefined && typeof query[key] !== 'string') {
      throw new Error(`RADAPTER_REQUEST_QUERY_${key}_INVALID`);
    }
  }
  if (query['heights'] !== undefined) {
    if (typeof query['heights'] === 'string') {
      // The resolver parses the comma-separated debug form. Type validation is
      // intentionally structural here; semantic bounds stay at the read path.
    } else if (Array.isArray(query['heights'])) {
      query['heights'].forEach((height, index) =>
        requireBoundaryInteger(height, `RADAPTER_REQUEST_QUERY_HEIGHT_INVALID:index=${index}`));
    } else {
      throw new Error('RADAPTER_REQUEST_QUERY_HEIGHTS_INVALID');
    }
  }
  if (query['types'] !== undefined) validateStringList(query['types'], 'RADAPTER_REQUEST_QUERY_TYPES_INVALID');
  if (query['eventNames'] !== undefined) {
    validateStringList(query['eventNames'], 'RADAPTER_REQUEST_QUERY_EVENT_NAMES_INVALID');
  }
  if (query['sortDir'] !== undefined && query['sortDir'] !== 'asc' && query['sortDir'] !== 'desc') {
    throw new Error('RADAPTER_REQUEST_QUERY_SORT_DIR_INVALID');
  }
  if (
    query['kind'] !== undefined &&
    query['kind'] !== 'all' &&
    query['kind'] !== 'onchain' &&
    query['kind'] !== 'offchain'
  ) {
    throw new Error('RADAPTER_REQUEST_QUERY_KIND_INVALID');
  }
}

const validateReadQuery = (value: unknown): RuntimeAdapterReadQuery => {
  const query = requireBoundaryRecord(value, 'RADAPTER_REQUEST_QUERY_INVALID');
  assertReadQuery(query);
  return query;
};

const validateNumberedRegistrationInput = (value: unknown): void => {
  const input = requireBoundaryRecord(value, 'RADAPTER_NUMBERED_REGISTRATION_INPUT_INVALID');
  requireExactBoundaryKeys(
    input,
    ['jurisdictionRef', 'payerSignerId', 'entities'],
    [],
    'RADAPTER_NUMBERED_REGISTRATION_INPUT_FIELDS_INVALID',
  );
  requireBoundedSecretString(input['jurisdictionRef'], 512, 'RADAPTER_NUMBERED_REGISTRATION_JURISDICTION_INVALID');
  requireBoundedSecretString(input['payerSignerId'], 128, 'RADAPTER_NUMBERED_REGISTRATION_PAYER_INVALID');
  if (
    !Array.isArray(input['entities']) ||
    input['entities'].length === 0 ||
    input['entities'].length > MAX_NUMBERED_REGISTRATION_ENTITIES
  ) {
    throw new Error('RADAPTER_NUMBERED_REGISTRATION_ENTITIES_INVALID');
  }
  input['entities'].forEach((rawEntity, entityIndex) => {
    const code = `RADAPTER_NUMBERED_REGISTRATION_ENTITY_INVALID:index=${entityIndex}`;
    const entity = requireBoundaryRecord(rawEntity, code);
    requireExactBoundaryKeys(
      entity,
      ['name', 'validators', 'threshold', 'localSignerId', 'entitySeed'],
      ['profileName', 'position'],
      code,
    );
    requireBoundedSecretString(entity['name'], 256, code);
    if (typeof entity['threshold'] !== 'bigint' || entity['threshold'] <= 0n) throw new Error(code);
    if (entity['localSignerId'] !== null) {
      requireBoundedSecretString(entity['localSignerId'], 128, code);
      requireBoundedSecretString(entity['entitySeed'], 130, code);
      if (!/^0x[0-9a-f]{128}$/.test(entity['entitySeed'] as string)) throw new Error(code);
    } else if (entity['entitySeed'] !== null) {
      throw new Error(code);
    }
    if (entity['profileName'] !== undefined) requireBoundedSecretString(entity['profileName'], 256, code);
    if (
      !Array.isArray(entity['validators']) ||
      entity['validators'].length === 0 ||
      entity['validators'].length > LIMITS.MAX_VALIDATORS
    ) {
      throw new Error(code);
    }
    entity['validators'].forEach((rawValidator, validatorIndex) => {
      const validator = requireBoundaryRecord(rawValidator, `${code}:validator=${validatorIndex}`);
      requireExactBoundaryKeys(validator, ['name', 'weight'], [], code);
      requireBoundedSecretString(validator['name'], 128, code);
      const weight = requireBoundaryInteger(validator['weight'], code, 1);
      if (weight > 0xffff) throw new Error(code);
    });
    if (entity['position'] !== undefined) {
      const position = requireBoundaryRecord(entity['position'], code);
      requireExactBoundaryKeys(position, ['x', 'y', 'z'], ['jurisdiction'], code);
      for (const axis of ['x', 'y', 'z'] as const) {
        if (typeof position[axis] !== 'number' || !Number.isFinite(position[axis])) throw new Error(code);
      }
      if (position['jurisdiction'] !== undefined) requireBoundedSecretString(position['jurisdiction'], 256, code);
    }
  });
};

function assertRequest(
  message: Record<string, unknown>,
): asserts message is Record<string, unknown> & RuntimeAdapterRequest {
  requireNonEmptyString(message['id'], 'RADAPTER_REQUEST_ID_INVALID');
  if (message['v'] !== XLN_PROTOCOL_VERSION) throw new Error('RADAPTER_REQUEST_VERSION_INVALID');
  switch (message['op']) {
    case 'auth':
      requireExactBoundaryKeys(
        message,
        ['v', 'id', 'op', 'challenge'],
        ['key', 'ownerSignature'],
        'RADAPTER_REQUEST_AUTH_FIELDS_INVALID',
      );
      requireNonEmptyString(message['challenge'], 'RADAPTER_REQUEST_AUTH_CHALLENGE_INVALID');
      if (message['key'] !== undefined) requireNonEmptyString(message['key'], 'RADAPTER_REQUEST_AUTH_KEY_INVALID');
      if (message['ownerSignature'] !== undefined) {
        requireNonEmptyString(message['ownerSignature'], 'RADAPTER_REQUEST_AUTH_OWNER_SIGNATURE_INVALID');
      }
      break;
    case 'read':
      requireExactBoundaryKeys(message, ['v', 'id', 'op', 'path'], ['query'], 'RADAPTER_REQUEST_READ_FIELDS_INVALID');
      requireNonEmptyString(message['path'], 'RADAPTER_REQUEST_READ_PATH_INVALID');
      if (message['query'] !== undefined) validateReadQuery(message['query']);
      break;
    case 'send':
      requireExactBoundaryKeys(
        message,
        ['v', 'id', 'op', 'commandId', 'commandSequence', 'input'],
        [],
        'RADAPTER_REQUEST_SEND_FIELDS_INVALID',
      );
      requireNonEmptyString(message['commandId'], 'RADAPTER_REQUEST_SEND_COMMAND_ID_INVALID');
      requireBoundaryInteger(message['commandSequence'], 'RADAPTER_REQUEST_SEND_SEQUENCE_INVALID', 1);
      decodeLocalRuntimeInput(message['input'], 'RADAPTER_REQUEST_SEND_INPUT');
      break;
    case 'control':
      requireExactBoundaryKeys(message, ['v', 'id', 'op', 'action'], [], 'RADAPTER_REQUEST_CONTROL_FIELDS_INVALID');
      if (message['action'] !== 'verify-chain') decodeSettlementEvidenceRequest(message['action']);
      break;
    case 'brainvault-derive': {
      requireExactBoundaryKeys(
        message,
        ['v', 'id', 'op', 'jobId', 'input'],
        [],
        'RADAPTER_REQUEST_BRAINVAULT_DERIVE_FIELDS_INVALID',
      );
      requireNonEmptyString(message['jobId'], 'RADAPTER_REQUEST_BRAINVAULT_JOB_ID_INVALID');
      const input = requireBoundaryRecord(message['input'], 'RADAPTER_REQUEST_BRAINVAULT_INPUT_INVALID');
      requireExactBoundaryKeys(
        input,
        ['specId', 'name', 'passphrase', 'shardInput', 'workers'],
        [],
        'RADAPTER_REQUEST_BRAINVAULT_INPUT_FIELDS_INVALID',
      );
      requireBoundedSecretString(input['specId'], 512, 'RADAPTER_REQUEST_BRAINVAULT_SPEC_ID_INVALID');
      requireBoundedSecretString(input['name'], 1_024, 'RADAPTER_REQUEST_BRAINVAULT_NAME_INVALID');
      requireBoundedSecretString(input['passphrase'], 4_096, 'RADAPTER_REQUEST_BRAINVAULT_PASSPHRASE_INVALID');
      const shardInput = requireBoundaryInteger(
        input['shardInput'],
        'RADAPTER_REQUEST_BRAINVAULT_SHARD_INPUT_INVALID',
        1,
      );
      const workers = requireBoundaryInteger(input['workers'], 'RADAPTER_REQUEST_BRAINVAULT_WORKERS_INVALID', 1);
      if (shardInput > 100_000) throw new Error('RADAPTER_REQUEST_BRAINVAULT_SHARD_INPUT_INVALID');
      if (workers > 256) throw new Error('RADAPTER_REQUEST_BRAINVAULT_WORKERS_INVALID');
      break;
    }
    case 'brainvault-cancel':
      requireExactBoundaryKeys(
        message,
        ['v', 'id', 'op', 'jobId'],
        [],
        'RADAPTER_REQUEST_BRAINVAULT_CANCEL_FIELDS_INVALID',
      );
      requireNonEmptyString(message['jobId'], 'RADAPTER_REQUEST_BRAINVAULT_JOB_ID_INVALID');
      break;
    case 'brainvault-reveal':
      requireExactBoundaryKeys(
        message,
        ['v', 'id', 'op'],
        [],
        'RADAPTER_REQUEST_BRAINVAULT_REVEAL_FIELDS_INVALID',
      );
      break;
    case 'numbered-registration':
      requireExactBoundaryKeys(
        message,
        ['v', 'id', 'op', 'input'],
        [],
        'RADAPTER_REQUEST_NUMBERED_REGISTRATION_FIELDS_INVALID',
      );
      validateNumberedRegistrationInput(message['input']);
      break;
    case 'cross-j-intent':
      requireExactBoundaryKeys(
        message,
        ['v', 'id', 'op', 'route'],
        [],
        'RADAPTER_REQUEST_CROSS_J_INTENT_FIELDS_INVALID',
      );
      requireBoundaryRecord(message['route'], 'RADAPTER_REQUEST_CROSS_J_INTENT_ROUTE_INVALID');
      validateStorageSafeValue(message['route'], 'RADAPTER_REQUEST_CROSS_J_INTENT_ROUTE');
      break;
    default:
      throw new Error(`RADAPTER_REQUEST_OP_INVALID:${String(message['op'])}`);
  }
}

export const validateRequest = (message: Record<string, unknown>): RuntimeAdapterRequest => {
  assertRequest(message);
  return message;
};
