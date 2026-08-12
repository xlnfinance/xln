import { normalizeJurisdictionEvent } from '../../jurisdiction/machine/events/event-normalization';
import { assertExactMultiRecipientCiphertextSchema } from '../../protocol/htlc/multi-recipient-schema';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import { validateAccountTxDataFields } from './fields';

const validateCloseProof = (value: unknown, code: string): void => {
  const proof = validateAccountTxDataFields(value, {
    required: {
      orderId: 'string', routeHash: 'string', sourcePullId: 'string',
      targetPullId: 'string', fillRatio: 'integer', cumulativeSourceAmount: 'bigint',
      cumulativeTargetAmount: 'bigint', binaryHash: 'string', closeMode: 'string',
    },
    literals: { closeMode: ['full', 'partial_cancel_remainder', 'pure_cancel'] },
  }, code);
  const fillRatio = proof['fillRatio'];
  if (
    typeof fillRatio !== 'number'
    || !Number.isSafeInteger(fillRatio)
    || fillRatio < 0
    || fillRatio > 0xffff
  ) {
    throw new Error(`${code}_FILL_RATIO`);
  }
};

const validateHtlcEnvelope = (value: unknown, code: string): void => {
  if (typeof value === 'string') return;
  const envelope = requireBoundaryRecord(value, code);
  if (Object.hasOwn(envelope, 'version')) {
    assertExactMultiRecipientCiphertextSchema(envelope);
    return;
  }
  requireExactBoundaryKeys(
    envelope,
    [],
    [
      'nextHop', 'finalRecipient', 'secretOffer', 'description',
      'startedAtMs', 'innerEnvelope', 'forwardAmount',
    ],
    `${code}_FIELDS`,
  );
  for (const field of ['nextHop', 'description', 'forwardAmount']) {
    if (envelope[field] !== undefined && typeof envelope[field] !== 'string') {
      throw new Error(`${code}_${field.toUpperCase()}`);
    }
  }
  if (envelope['finalRecipient'] !== undefined && typeof envelope['finalRecipient'] !== 'boolean') {
    throw new Error(`${code}_FINAL_RECIPIENT`);
  }
  if (envelope['startedAtMs'] !== undefined) {
    requireBoundaryInteger(envelope['startedAtMs'], `${code}_STARTED_AT`);
  }
  for (const field of ['secretOffer', 'innerEnvelope']) {
    if (envelope[field] !== undefined) assertExactMultiRecipientCiphertextSchema(envelope[field]);
  }
};

const validateHtlcLock = (value: unknown, code: string): void => {
  const data = validateAccountTxDataFields(value, {
    required: {
      lockId: 'string', hashlock: 'string', timelock: 'bigint',
      revealBeforeHeight: 'integer', amount: 'bigint', tokenId: 'integer',
    },
    optional: { deliveryMode: 'string', envelope: 'recordOrString' },
    literals: { deliveryMode: ['instant', 'async'] },
  }, code);
  if (data['envelope'] !== undefined) validateHtlcEnvelope(data['envelope'], `${code}_ENVELOPE`);
};

const validateHtlcResolve = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  if (data['outcome'] === 'offer') {
    requireExactBoundaryKeys(data, ['lockId', 'outcome', 'offer'], [], `${code}_FIELDS`);
    if (typeof data['lockId'] !== 'string') throw new Error(`${code}_LOCK_ID`);
    assertExactMultiRecipientCiphertextSchema(data['offer']);
    return;
  }
  if (data['outcome'] === 'secret') {
    const hasSecret = Object.hasOwn(data, 'secret');
    const hasOfferHash = Object.hasOwn(data, 'offerHash');
    if (hasSecret === hasOfferHash) throw new Error(`${code}_SECRET_VARIANT`);
    requireExactBoundaryKeys(
      data,
      ['lockId', 'outcome', hasSecret ? 'secret' : 'offerHash'],
      [],
      `${code}_FIELDS`,
    );
    if (
      typeof data['lockId'] !== 'string' ||
      typeof data[hasSecret ? 'secret' : 'offerHash'] !== 'string'
    ) throw new Error(`${code}_SECRET`);
    return;
  }
  if (data['outcome'] !== 'error') throw new Error(`${code}_OUTCOME`);
  requireExactBoundaryKeys(data, ['lockId', 'outcome'], ['reason'], `${code}_FIELDS`);
  if (typeof data['lockId'] !== 'string') throw new Error(`${code}_LOCK_ID`);
  if (data['reason'] !== undefined && typeof data['reason'] !== 'string') throw new Error(`${code}_REASON`);
};

const validateSettlementOps = (value: unknown, code: string): void => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  value.forEach((raw, index) => {
    const opCode = `${code}_${index}`;
    const op = requireBoundaryRecord(raw, opCode);
    if (op['type'] === 'forgive') {
      validateAccountTxDataFields(op, { required: { type: 'string', tokenId: 'integer' } }, opCode);
      return;
    }
    if (op['type'] === 'r2c' || op['type'] === 'c2r' || op['type'] === 'r2r') {
      validateAccountTxDataFields(
        op,
        { required: { type: 'string', tokenId: 'integer', amount: 'bigint' } },
        opCode,
      );
      return;
    }
    if (op['type'] !== 'rawDiff') throw new Error(`${opCode}_TYPE`);
    validateAccountTxDataFields(op, {
      required: {
        type: 'string', tokenId: 'integer', leftDiff: 'bigint', rightDiff: 'bigint',
        collateralDiff: 'bigint', ondeltaDiff: 'bigint',
      },
    }, opCode);
  });
};

const validatePostProof = (value: unknown, code: string): void => {
  validateAccountTxDataFields(value, {
    required: {
      nonce: 'integer', proposerIsLeft: 'boolean', proofBodyHash: 'string', disputeHash: 'string',
    },
    optional: { hanko: 'string' },
  }, code);
};

const validateSettlementTransition = (value: unknown, code: string): void => {
  const data = requireBoundaryRecord(value, code);
  if (data['kind'] === 'upsert') {
    validateAccountTxDataFields(data, {
      required: { kind: 'string', revision: 'integer', ops: 'array', executorIsLeft: 'boolean' },
      optional: { previousWorkspaceHash: 'string', memo: 'string' },
    }, code);
    validateSettlementOps(data['ops'], `${code}_OPS`);
    return;
  }
  if (data['kind'] === 'submit' || data['kind'] === 'clear') {
    validateAccountTxDataFields(
      data,
      { required: { kind: 'string', revision: 'integer', workspaceHash: 'string' } },
      code,
    );
    return;
  }
  if (data['kind'] !== 'seal') throw new Error(`${code}_KIND`);
  validateAccountTxDataFields(data, {
    required: {
      kind: 'string', revision: 'integer', workspaceHash: 'string',
      settlementNonce: 'integer', settlementHash: 'string', postProof: 'record',
    },
    optional: { settlementHanko: 'string' },
  }, code);
  validatePostProof(data['postProof'], `${code}_POST_PROOF`);
};

const validateJClaimProof = (value: unknown, code: string): void => {
  const proof = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(proof, ['version', 'nodes'], [], `${code}_FIELDS`);
  if (proof['version'] !== 1 || !Array.isArray(proof['nodes'])) throw new Error(code);
  proof['nodes'].forEach((raw, index) => {
    const nodeCode = `${code}_NODE_${index}`;
    const node = requireBoundaryRecord(raw, nodeCode);
    if (node['version'] !== 1) throw new Error(`${nodeCode}_VERSION`);
    if (node['type'] === 'branch') {
      validateAccountTxDataFields(node, {
        required: {
          version: 'integer', type: 'string', bit: 'integer', left: 'string', right: 'string',
        },
      }, nodeCode);
      return;
    }
    if (node['type'] !== 'leaf') throw new Error(`${nodeCode}_TYPE`);
    validateAccountTxDataFields(node, {
      required: { version: 'integer', type: 'string', key: 'string', record: 'record' },
    }, nodeCode);
    validateAccountTxDataFields(node['record'], {
      required: {
        version: 'integer', accountKey: 'string', side: 'string', jHeight: 'integer',
        jBlockHash: 'string', eventsHash: 'string',
      },
      literals: { side: ['left', 'right'] },
    }, `${nodeCode}_RECORD`);
  });
};

const validateJEventClaim = (value: unknown, code: string): void => {
  const data = validateAccountTxDataFields(value, {
    required: { jHeight: 'integer', jBlockHash: 'string', events: 'array' },
    optional: { leftProof: 'record', rightProof: 'record' },
  }, code);
  const events = data['events'];
  if (!Array.isArray(events)) throw new Error(`${code}_EVENTS`);
  for (const [index, event] of events.entries()) {
    if (!normalizeJurisdictionEvent(event)) throw new Error(`${code}_EVENT_${index}`);
  }
  if (data['leftProof'] !== undefined) validateJClaimProof(data['leftProof'], `${code}_LEFT_PROOF`);
  if (data['rightProof'] !== undefined) validateJClaimProof(data['rightProof'], `${code}_RIGHT_PROOF`);
};

export const validateSpecialAccountTxData = (
  type: string,
  value: unknown,
  code: string,
): boolean => {
  if (type === 'htlc_lock') validateHtlcLock(value, code);
  else if (type === 'htlc_resolve') validateHtlcResolve(value, code);
  else if (type === 'cross_pull_close') {
    const data = validateAccountTxDataFields(
      value,
      { required: { pullId: 'string', binary: 'string', proof: 'record' } },
      code,
    );
    validateCloseProof(data['proof'], `${code}_PROOF`);
  } else if (type === 'settle_transition') validateSettlementTransition(value, code);
  else if (type === 'j_event_claim') validateJEventClaim(value, code);
  else return false;
  return true;
};
