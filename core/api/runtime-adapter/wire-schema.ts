import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type {
  RuntimeAdapterErrorCode,
  RuntimeAdapterErrorPayload,
  RuntimeAdapterPush,
  RuntimeAdapterRequest,
  RuntimeAdapterResponse,
} from './types';
import { XLN_PROTOCOL_VERSION } from '../../protocol/version';
import { requireNonEmptyString, validateRequest } from './wire/request-schema';

export type RuntimeAdapterWireMessage = RuntimeAdapterRequest | RuntimeAdapterResponse | RuntimeAdapterPush;

const isRuntimeAdapterErrorCode = (value: unknown): value is RuntimeAdapterErrorCode => {
  switch (value) {
    case 'E_UNAUTHORIZED':
    case 'E_NOT_FOUND':
    case 'E_BAD_PATH':
    case 'E_BAD_QUERY':
    case 'E_RATE_LIMITED':
    case 'E_COMMAND_PENDING':
    case 'E_INTERNAL':
      return true;
    default:
      return false;
  }
};

function assertError(
  error: Record<string, unknown>,
): asserts error is Record<string, unknown> & RuntimeAdapterErrorPayload {
  requireExactBoundaryKeys(
    error,
    ['code', 'message', 'retryable'],
    ['retryAfterMs'],
    'RADAPTER_RESPONSE_ERROR_FIELDS_INVALID',
  );
  if (!isRuntimeAdapterErrorCode(error['code'])) throw new Error('RADAPTER_RESPONSE_ERROR_CODE_INVALID');
  if (typeof error['message'] !== 'string') throw new Error('RADAPTER_RESPONSE_ERROR_MESSAGE_INVALID');
  if (typeof error['retryable'] !== 'boolean') throw new Error('RADAPTER_RESPONSE_ERROR_RETRYABLE_INVALID');
  if (error['retryAfterMs'] !== undefined) {
    requireBoundaryInteger(error['retryAfterMs'], 'RADAPTER_RESPONSE_ERROR_RETRY_AFTER_INVALID');
  }
}

const validateError = (value: unknown): RuntimeAdapterErrorPayload => {
  const error = requireBoundaryRecord(value, 'RADAPTER_RESPONSE_ERROR_INVALID');
  assertError(error);
  return error;
};

function assertResponse(
  message: Record<string, unknown>,
): asserts message is Record<string, unknown> & RuntimeAdapterResponse {
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
}

const validateResponse = (message: Record<string, unknown>): RuntimeAdapterResponse => {
  assertResponse(message);
  return message;
};

function assertPush(
  message: Record<string, unknown>,
): asserts message is Record<string, unknown> & RuntimeAdapterPush {
  if (message['v'] !== XLN_PROTOCOL_VERSION) throw new Error('RADAPTER_PUSH_VERSION_INVALID');
  if (message['op'] === 'tick') {
    requireExactBoundaryKeys(
      message,
      ['v', 'op', 'height', 'commandReady', 'commandReadyReason'],
      [],
      'RADAPTER_PUSH_FIELDS_INVALID',
    );
    requireBoundaryInteger(message['height'], 'RADAPTER_PUSH_HEIGHT_INVALID');
    if (typeof message['commandReady'] !== 'boolean') throw new Error('RADAPTER_PUSH_COMMAND_READY_INVALID');
    if (message['commandReadyReason'] !== null && typeof message['commandReadyReason'] !== 'string') {
      throw new Error('RADAPTER_PUSH_COMMAND_READY_REASON_INVALID');
    }
    if (message['commandReady'] === true && message['commandReadyReason'] !== null) {
      throw new Error('RADAPTER_PUSH_COMMAND_READY_REASON_INVALID');
    }
    if (message['commandReady'] === false && !String(message['commandReadyReason'] || '').trim()) {
      throw new Error('RADAPTER_PUSH_COMMAND_READY_REASON_INVALID');
    }
    return;
  }
  if (message['op'] === 'brainvault-progress') {
    requireExactBoundaryKeys(message, ['v', 'op', 'jobId', 'progress'], [], 'RADAPTER_PUSH_FIELDS_INVALID');
    requireNonEmptyString(message['jobId'], 'RADAPTER_PUSH_BRAINVAULT_JOB_ID_INVALID');
    const progress = requireBoundaryRecord(message['progress'], 'RADAPTER_PUSH_BRAINVAULT_PROGRESS_INVALID');
    requireExactBoundaryKeys(
      progress,
      ['completed', 'total', 'elapsedMs', 'lastShardMs', 'workers'],
      [],
      'RADAPTER_PUSH_BRAINVAULT_PROGRESS_FIELDS_INVALID',
    );
    requireBoundaryInteger(progress['completed'], 'RADAPTER_PUSH_BRAINVAULT_COMPLETED_INVALID', 0);
    requireBoundaryInteger(progress['total'], 'RADAPTER_PUSH_BRAINVAULT_TOTAL_INVALID', 1);
    requireBoundaryInteger(progress['elapsedMs'], 'RADAPTER_PUSH_BRAINVAULT_ELAPSED_INVALID', 0);
    requireBoundaryInteger(progress['lastShardMs'], 'RADAPTER_PUSH_BRAINVAULT_SHARD_MS_INVALID', 0);
    requireBoundaryInteger(progress['workers'], 'RADAPTER_PUSH_BRAINVAULT_WORKERS_INVALID', 1);
    if (Number(progress['completed']) > Number(progress['total'])) {
      throw new Error('RADAPTER_PUSH_BRAINVAULT_PROGRESS_RANGE_INVALID');
    }
    return;
  }
  throw new Error('RADAPTER_PUSH_TYPE_INVALID');
}

const validatePush = (message: Record<string, unknown>): RuntimeAdapterPush => {
  assertPush(message);
  return message;
};

export const validateRuntimeAdapterWireMessage = (value: unknown): RuntimeAdapterWireMessage => {
  const message = requireBoundaryRecord(value, 'RADAPTER_WIRE_OBJECT_INVALID');
  if (Object.hasOwn(message, 'inReplyTo')) return validateResponse(message);
  if ((message['op'] === 'tick' || message['op'] === 'brainvault-progress') && !Object.hasOwn(message, 'id')) {
    return validatePush(message);
  }
  if (Object.hasOwn(message, 'id')) return validateRequest(message);
  throw new Error('RADAPTER_WIRE_VARIANT_INVALID');
};
