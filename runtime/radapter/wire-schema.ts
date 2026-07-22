import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  validateRuntimeInputEnvelope,
} from '../protocol/boundary-validation';
import { validateStorageSafeValue } from '../wal/runtime-machine-schema/primitives';
import type {
  RuntimeAdapterErrorCode,
  RuntimeAdapterErrorPayload,
  RuntimeAdapterPush,
  RuntimeAdapterReadQuery,
  RuntimeAdapterRequest,
  RuntimeAdapterResponse,
} from './types';
import { XLN_PROTOCOL_VERSION } from '../protocol/version';

export type RuntimeAdapterWireMessage = RuntimeAdapterRequest | RuntimeAdapterResponse | RuntimeAdapterPush;

const ERROR_CODES = new Set<RuntimeAdapterErrorCode>([
  'E_UNAUTHORIZED',
  'E_NOT_FOUND',
  'E_BAD_PATH',
  'E_BAD_QUERY',
  'E_RATE_LIMITED',
  'E_COMMAND_PENDING',
  'E_INTERNAL',
]);

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
  'amount',
] as const;

const requireNonEmptyString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

const validateStringList = (value: unknown, code: string): void => {
  if (typeof value === 'string') return;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(code);
};

const validateReadQuery = (value: unknown): RuntimeAdapterReadQuery => {
  const query = requireBoundaryRecord(value, 'RADAPTER_REQUEST_QUERY_INVALID');
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
  return query as RuntimeAdapterReadQuery;
};

const validateRequest = (message: Record<string, unknown>): RuntimeAdapterRequest => {
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
      validateRuntimeInputEnvelope(message['input'], 'RADAPTER_REQUEST_SEND_INPUT');
      break;
    case 'control':
      requireExactBoundaryKeys(message, ['v', 'id', 'op', 'action'], [], 'RADAPTER_REQUEST_CONTROL_FIELDS_INVALID');
      if (message['action'] !== 'verify-chain') throw new Error('RADAPTER_REQUEST_CONTROL_ACTION_INVALID');
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
  return message as unknown as RuntimeAdapterRequest;
};

const validateError = (value: unknown): RuntimeAdapterErrorPayload => {
  const error = requireBoundaryRecord(value, 'RADAPTER_RESPONSE_ERROR_INVALID');
  requireExactBoundaryKeys(
    error,
    ['code', 'message', 'retryable'],
    ['retryAfterMs'],
    'RADAPTER_RESPONSE_ERROR_FIELDS_INVALID',
  );
  if (!ERROR_CODES.has(error['code'] as RuntimeAdapterErrorCode)) throw new Error('RADAPTER_RESPONSE_ERROR_CODE_INVALID');
  if (typeof error['message'] !== 'string') throw new Error('RADAPTER_RESPONSE_ERROR_MESSAGE_INVALID');
  if (typeof error['retryable'] !== 'boolean') throw new Error('RADAPTER_RESPONSE_ERROR_RETRYABLE_INVALID');
  if (error['retryAfterMs'] !== undefined) {
    requireBoundaryInteger(error['retryAfterMs'], 'RADAPTER_RESPONSE_ERROR_RETRY_AFTER_INVALID');
  }
  return error as unknown as RuntimeAdapterErrorPayload;
};

const validateResponse = (message: Record<string, unknown>): RuntimeAdapterResponse => {
  if (message['v'] !== XLN_PROTOCOL_VERSION) throw new Error('RADAPTER_RESPONSE_VERSION_INVALID');
  requireNonEmptyString(message['inReplyTo'], 'RADAPTER_RESPONSE_REPLY_ID_INVALID');
  if (message['ok'] === true) {
    requireExactBoundaryKeys(message, ['v', 'inReplyTo', 'ok', 'payload'], [], 'RADAPTER_RESPONSE_OK_FIELDS_INVALID');
  } else if (message['ok'] === false) {
    requireExactBoundaryKeys(message, ['v', 'inReplyTo', 'ok', 'error'], [], 'RADAPTER_RESPONSE_ERROR_FIELDS_INVALID');
    validateError(message['error']);
  } else {
    throw new Error('RADAPTER_RESPONSE_OK_INVALID');
  }
  return message as unknown as RuntimeAdapterResponse;
};

const validatePush = (message: Record<string, unknown>): RuntimeAdapterPush => {
  requireExactBoundaryKeys(message, ['v', 'op', 'height'], [], 'RADAPTER_PUSH_FIELDS_INVALID');
  if (message['v'] !== XLN_PROTOCOL_VERSION || message['op'] !== 'tick') {
    throw new Error('RADAPTER_PUSH_TYPE_INVALID');
  }
  requireBoundaryInteger(message['height'], 'RADAPTER_PUSH_HEIGHT_INVALID');
  return message as unknown as RuntimeAdapterPush;
};

export const validateRuntimeAdapterWireMessage = (value: unknown): RuntimeAdapterWireMessage => {
  const message = requireBoundaryRecord(value, 'RADAPTER_WIRE_OBJECT_INVALID');
  if (Object.hasOwn(message, 'inReplyTo')) return validateResponse(message);
  if (message['op'] === 'tick' && !Object.hasOwn(message, 'id')) return validatePush(message);
  if (Object.hasOwn(message, 'id')) return validateRequest(message);
  throw new Error('RADAPTER_WIRE_VARIANT_INVALID');
};
