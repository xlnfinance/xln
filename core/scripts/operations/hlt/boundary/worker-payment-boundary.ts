/** Exact decode boundary for the payment workload's durable report. */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';

export type LoadPaymentReport = Readonly<{
  schema: 'xln-hlt-payment-load-v1';
  mode: 'payments';
  completionAuthority: 'committed_entity_metrics_and_bilateral_runtime_quiescence';
  configuredUsers: number;
  configuredRounds: number;
  cadenceMs: number;
  senders: number;
  receivers: number;
  tokenId: number;
  amount: string;
  offeredPaymentRate: number;
  submittedPayments: number;
  deliveredPayments: number;
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  deliveredElapsedMs: number;
  deliveredTps: number;
  hubCompletedPaymentsBefore: number;
  hubCompletedPaymentsAfter: number;
  roundSubmissionLagMs: readonly number[];
  walBytesBefore: number;
  walBytesAfter: number;
  hubDurableBefore: Readonly<{ height: number; canonicalStateHash: string }>;
  hubDurableAfter: Readonly<{ height: number; canonicalStateHash: string }>;
}>;

const HASH_32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const decodeFrame = (value: unknown, code: string): LoadPaymentReport['hubDurableBefore'] => {
  const record = requireBoundaryRecord(value, `${code}_INVALID`);
  requireExactBoundaryKeys(record, ['height', 'canonicalStateHash'], [], `${code}_FIELDS_INVALID`);
  const canonicalStateHash = record['canonicalStateHash'];
  if (typeof canonicalStateHash !== 'string' || !HASH_32.test(canonicalStateHash)) {
    throw new Error(`${code}_HASH_INVALID`);
  }
  return { height: requireBoundaryInteger(record['height'], `${code}_HEIGHT_INVALID`, 0), canonicalStateHash };
};

/**
 * A payment run is only green when every submitted payment was delivered.
 * Decoding rejects a partial run rather than letting a rate be computed from a
 * denominator the population never actually completed.
 */
export const decodeLoadPaymentReport = (value: unknown): LoadPaymentReport => {
  const record = requireBoundaryRecord(value, 'HLT_PAYMENT_REPORT_INVALID');
  requireExactBoundaryKeys(record, [
    'schema', 'mode', 'completionAuthority', 'configuredUsers', 'configuredRounds', 'cadenceMs',
    'senders', 'receivers', 'tokenId', 'amount', 'offeredPaymentRate',
    'submittedPayments', 'deliveredPayments',
    'enqueueAckElapsedMs', 'commandObservedElapsedMs', 'deliveredElapsedMs', 'deliveredTps',
    'hubCompletedPaymentsBefore', 'hubCompletedPaymentsAfter',
    'roundSubmissionLagMs', 'walBytesBefore', 'walBytesAfter', 'hubDurableBefore', 'hubDurableAfter',
  ], [], 'HLT_PAYMENT_REPORT_FIELDS_INVALID');
  if (record['schema'] !== 'xln-hlt-payment-load-v1') throw new Error('HLT_PAYMENT_REPORT_SCHEMA_INVALID');
  if (record['mode'] !== 'payments') throw new Error('HLT_PAYMENT_REPORT_MODE_INVALID');
  if (record['completionAuthority'] !== 'committed_entity_metrics_and_bilateral_runtime_quiescence') {
    throw new Error('HLT_PAYMENT_REPORT_COMPLETION_AUTHORITY_INVALID');
  }
  const amount = record['amount'];
  if (typeof amount !== 'string' || !DECIMAL.test(amount)) throw new Error('HLT_PAYMENT_REPORT_AMOUNT_INVALID');
  const lags = record['roundSubmissionLagMs'];
  if (!Array.isArray(lags)) throw new Error('HLT_PAYMENT_REPORT_LAG_INVALID');
  const submitted = requireBoundaryInteger(record['submittedPayments'], 'HLT_PAYMENT_REPORT_SUBMITTED_INVALID', 1);
  const delivered = requireBoundaryInteger(record['deliveredPayments'], 'HLT_PAYMENT_REPORT_DELIVERED_INVALID', 0);
  if (delivered !== submitted) throw new Error(`HLT_PAYMENT_REPORT_INCOMPLETE:${delivered}:${submitted}`);
  const deliveredTps = record['deliveredTps'];
  if (typeof deliveredTps !== 'number' || !Number.isFinite(deliveredTps) || deliveredTps <= 0) {
    throw new Error('HLT_PAYMENT_REPORT_TPS_INVALID');
  }
  const enqueueAckElapsedMs = requireBoundaryInteger(record['enqueueAckElapsedMs'], 'HLT_PAYMENT_REPORT_ACK_INVALID', 0);
  const commandObservedElapsedMs = requireBoundaryInteger(
    record['commandObservedElapsedMs'],
    'HLT_PAYMENT_REPORT_OBSERVED_INVALID',
    0,
  );
  const deliveredElapsedMs = requireBoundaryInteger(record['deliveredElapsedMs'], 'HLT_PAYMENT_REPORT_ELAPSED_INVALID', 1);
  const hubCompletedPaymentsBefore = requireBoundaryInteger(
    record['hubCompletedPaymentsBefore'],
    'HLT_PAYMENT_REPORT_METRIC_BEFORE_INVALID',
    0,
  );
  const hubCompletedPaymentsAfter = requireBoundaryInteger(
    record['hubCompletedPaymentsAfter'],
    'HLT_PAYMENT_REPORT_METRIC_AFTER_INVALID',
    0,
  );
  if (hubCompletedPaymentsAfter - hubCompletedPaymentsBefore !== delivered) {
    throw new Error('HLT_PAYMENT_REPORT_METRIC_DELTA_INVALID');
  }
  if (commandObservedElapsedMs < enqueueAckElapsedMs) throw new Error('HLT_PAYMENT_REPORT_TIMING_INVALID');
  if (deliveredElapsedMs < commandObservedElapsedMs) throw new Error('HLT_PAYMENT_REPORT_TIMING_INVALID');
  return {
    schema: 'xln-hlt-payment-load-v1',
    mode: 'payments',
    completionAuthority: 'committed_entity_metrics_and_bilateral_runtime_quiescence',
    configuredUsers: requireBoundaryInteger(record['configuredUsers'], 'HLT_PAYMENT_REPORT_USERS_INVALID', 2),
    configuredRounds: requireBoundaryInteger(record['configuredRounds'], 'HLT_PAYMENT_REPORT_ROUNDS_INVALID', 1),
    cadenceMs: requireBoundaryInteger(record['cadenceMs'], 'HLT_PAYMENT_REPORT_CADENCE_INVALID', 1),
    senders: requireBoundaryInteger(record['senders'], 'HLT_PAYMENT_REPORT_SENDERS_INVALID', 1),
    receivers: requireBoundaryInteger(record['receivers'], 'HLT_PAYMENT_REPORT_RECEIVERS_INVALID', 1),
    tokenId: requireBoundaryInteger(record['tokenId'], 'HLT_PAYMENT_REPORT_TOKEN_INVALID', 1),
    amount,
    offeredPaymentRate: requireBoundaryInteger(record['offeredPaymentRate'], 'HLT_PAYMENT_REPORT_OFFERED_INVALID', 1),
    submittedPayments: submitted,
    deliveredPayments: delivered,
    enqueueAckElapsedMs,
    commandObservedElapsedMs,
    deliveredElapsedMs,
    deliveredTps,
    hubCompletedPaymentsBefore,
    hubCompletedPaymentsAfter,
    roundSubmissionLagMs: lags.map((lag, index) =>
      requireBoundaryInteger(lag, `HLT_PAYMENT_REPORT_LAG_INVALID:${index}`, 0)),
    walBytesBefore: requireBoundaryInteger(record['walBytesBefore'], 'HLT_PAYMENT_REPORT_WAL_BEFORE_INVALID', 0),
    walBytesAfter: requireBoundaryInteger(record['walBytesAfter'], 'HLT_PAYMENT_REPORT_WAL_AFTER_INVALID', 0),
    hubDurableBefore: decodeFrame(record['hubDurableBefore'], 'HLT_PAYMENT_REPORT_HUB_BEFORE'),
    hubDurableAfter: decodeFrame(record['hubDurableAfter'], 'HLT_PAYMENT_REPORT_HUB_AFTER'),
  };
};
