/** Exact decode boundary for the payment workload's durable report. */

import { decodeHltEnvironmentManifest, type HltEnvironmentManifest } from './environment-manifest';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';

export type LoadPaymentReport = Readonly<{
  schema: 'xln-hlt-payment-load-v1';
  mode: 'payments';
  runId: string;
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
  sourceDispatchFinishedElapsedMs: number;
  sourceAllAckedElapsedMs: number;
  commandObservedElapsedMs: number;
  deliveredElapsedMs: number;
  deliveredTps: number;
  hubCompletedPaymentsBefore: number;
  hubCompletedPaymentsAfter: number;
  hubAcceptedPaymentsBefore: number;
  hubAcceptedPaymentsAfter: number;
  hubIngressElapsedMs: number;
  settlementSamples: readonly PaymentSettlementSample[];
  roundSubmissionLagMs: readonly number[];
  walBytesBefore: number;
  walBytesAfter: number;
  hubDurableBefore: Readonly<{ height: number; canonicalStateHash: string }>;
  hubDurableAfter: Readonly<{ height: number; canonicalStateHash: string }>;
  environment: HltEnvironmentManifest;
}>;

export type PaymentSettlementSample = Readonly<{
  elapsedMs: number;
  runtimeHeight: number;
  acceptedPayments: number;
  completedPayments: number;
  lockBookOpen: number;
}>;

const HASH_32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const RUN_ID = /^[A-Za-z0-9._-]+$/;

const decodeSettlementSamples = (
  value: unknown,
  submitted: number,
  hubIngressElapsedMs: number,
  deliveredElapsedMs: number,
): readonly PaymentSettlementSample[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('HLT_PAYMENT_REPORT_SAMPLES_INVALID');
  let previous: PaymentSettlementSample | null = null;
  const samples = value.map((sample, index): PaymentSettlementSample => {
    const record = requireBoundaryRecord(sample, `HLT_PAYMENT_REPORT_SAMPLE_INVALID:${index}`);
    requireExactBoundaryKeys(record, [
      'elapsedMs', 'runtimeHeight', 'acceptedPayments', 'completedPayments', 'lockBookOpen',
    ], [], `HLT_PAYMENT_REPORT_SAMPLE_FIELDS_INVALID:${index}`);
    const decoded = {
      elapsedMs: requireBoundaryInteger(record['elapsedMs'], `HLT_PAYMENT_REPORT_SAMPLE_ELAPSED_INVALID:${index}`, 1),
      runtimeHeight: requireBoundaryInteger(record['runtimeHeight'], `HLT_PAYMENT_REPORT_SAMPLE_HEIGHT_INVALID:${index}`, 0),
      acceptedPayments: requireBoundaryInteger(record['acceptedPayments'], `HLT_PAYMENT_REPORT_SAMPLE_ACCEPTED_INVALID:${index}`, 0),
      completedPayments: requireBoundaryInteger(record['completedPayments'], `HLT_PAYMENT_REPORT_SAMPLE_COMPLETED_INVALID:${index}`, 0),
      lockBookOpen: requireBoundaryInteger(record['lockBookOpen'], `HLT_PAYMENT_REPORT_SAMPLE_OPEN_INVALID:${index}`, 0),
    };
    if (
      decoded.acceptedPayments > submitted ||
      decoded.completedPayments > decoded.acceptedPayments ||
      previous !== null && (
        decoded.elapsedMs < previous.elapsedMs || decoded.runtimeHeight < previous.runtimeHeight ||
        decoded.acceptedPayments < previous.acceptedPayments ||
        decoded.completedPayments < previous.completedPayments
      )
    ) throw new Error(`HLT_PAYMENT_REPORT_SAMPLE_SEQUENCE_INVALID:${index}`);
    previous = decoded;
    return decoded;
  });
  const ingress = samples.find(sample => sample.acceptedPayments === submitted);
  const delivered = samples.find(sample => sample.completedPayments === submitted && sample.lockBookOpen === 0);
  const final = samples.at(-1)!;
  if (
    ingress?.elapsedMs !== hubIngressElapsedMs || delivered?.elapsedMs !== deliveredElapsedMs ||
    final.acceptedPayments !== submitted || final.completedPayments !== submitted || final.lockBookOpen !== 0
  ) throw new Error('HLT_PAYMENT_REPORT_SAMPLE_TERMINAL_INVALID');
  return samples;
};

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
    'schema', 'mode', 'runId', 'completionAuthority', 'configuredUsers', 'configuredRounds', 'cadenceMs',
    'senders', 'receivers', 'tokenId', 'amount', 'offeredPaymentRate',
    'submittedPayments', 'deliveredPayments',
    'enqueueAckElapsedMs', 'sourceDispatchFinishedElapsedMs', 'sourceAllAckedElapsedMs',
    'commandObservedElapsedMs', 'deliveredElapsedMs', 'deliveredTps',
    'hubCompletedPaymentsBefore', 'hubCompletedPaymentsAfter',
    'hubAcceptedPaymentsBefore', 'hubAcceptedPaymentsAfter', 'hubIngressElapsedMs', 'settlementSamples',
    'roundSubmissionLagMs', 'walBytesBefore', 'walBytesAfter', 'hubDurableBefore', 'hubDurableAfter',
    'environment',
  ], [], 'HLT_PAYMENT_REPORT_FIELDS_INVALID');
  if (record['schema'] !== 'xln-hlt-payment-load-v1') throw new Error('HLT_PAYMENT_REPORT_SCHEMA_INVALID');
  if (record['mode'] !== 'payments') throw new Error('HLT_PAYMENT_REPORT_MODE_INVALID');
  const runId = record['runId'];
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('HLT_PAYMENT_REPORT_RUN_ID_INVALID');
  if (record['completionAuthority'] !== 'committed_entity_metrics_and_bilateral_runtime_quiescence') {
    throw new Error('HLT_PAYMENT_REPORT_COMPLETION_AUTHORITY_INVALID');
  }
  const amount = record['amount'];
  if (typeof amount !== 'string' || !DECIMAL.test(amount)) throw new Error('HLT_PAYMENT_REPORT_AMOUNT_INVALID');
  const lags = record['roundSubmissionLagMs'];
  if (!Array.isArray(lags)) throw new Error('HLT_PAYMENT_REPORT_LAG_INVALID');
  const submitted = requireBoundaryInteger(record['submittedPayments'], 'HLT_PAYMENT_REPORT_SUBMITTED_INVALID', 1);
  if (lags.length !== submitted) throw new Error(`HLT_PAYMENT_REPORT_LAG_COUNT_INVALID:${lags.length}:${submitted}`);
  const delivered = requireBoundaryInteger(record['deliveredPayments'], 'HLT_PAYMENT_REPORT_DELIVERED_INVALID', 0);
  if (delivered !== submitted) throw new Error(`HLT_PAYMENT_REPORT_INCOMPLETE:${delivered}:${submitted}`);
  const deliveredTps = record['deliveredTps'];
  if (typeof deliveredTps !== 'number' || !Number.isFinite(deliveredTps) || deliveredTps <= 0) {
    throw new Error('HLT_PAYMENT_REPORT_TPS_INVALID');
  }
  const enqueueAckElapsedMs = requireBoundaryInteger(record['enqueueAckElapsedMs'], 'HLT_PAYMENT_REPORT_ACK_INVALID', 0);
  const sourceDispatchFinishedElapsedMs = requireBoundaryInteger(
    record['sourceDispatchFinishedElapsedMs'], 'HLT_PAYMENT_REPORT_SOURCE_DISPATCH_INVALID', 1,
  );
  const sourceAllAckedElapsedMs = requireBoundaryInteger(
    record['sourceAllAckedElapsedMs'], 'HLT_PAYMENT_REPORT_SOURCE_ACKED_INVALID', 1,
  );
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
  const hubAcceptedPaymentsBefore = requireBoundaryInteger(
    record['hubAcceptedPaymentsBefore'],
    'HLT_PAYMENT_REPORT_ACCEPTED_BEFORE_INVALID',
    0,
  );
  const hubAcceptedPaymentsAfter = requireBoundaryInteger(
    record['hubAcceptedPaymentsAfter'],
    'HLT_PAYMENT_REPORT_ACCEPTED_AFTER_INVALID',
    0,
  );
  const hubIngressElapsedMs = requireBoundaryInteger(
    record['hubIngressElapsedMs'],
    'HLT_PAYMENT_REPORT_INGRESS_ELAPSED_INVALID',
    1,
  );
  if (hubCompletedPaymentsAfter - hubCompletedPaymentsBefore !== delivered) {
    throw new Error('HLT_PAYMENT_REPORT_METRIC_DELTA_INVALID');
  }
  if (hubAcceptedPaymentsAfter - hubAcceptedPaymentsBefore !== submitted) {
    throw new Error('HLT_PAYMENT_REPORT_ACCEPTED_DELTA_INVALID');
  }
  const settlementSamples = decodeSettlementSamples(
    record['settlementSamples'], submitted, hubIngressElapsedMs, deliveredElapsedMs,
  );
  if (
    sourceAllAckedElapsedMs < sourceDispatchFinishedElapsedMs ||
    sourceAllAckedElapsedMs < enqueueAckElapsedMs ||
    commandObservedElapsedMs !== sourceAllAckedElapsedMs
  ) throw new Error('HLT_PAYMENT_REPORT_TIMING_INVALID');
  if (deliveredElapsedMs < commandObservedElapsedMs) throw new Error('HLT_PAYMENT_REPORT_TIMING_INVALID');
  if (hubIngressElapsedMs < commandObservedElapsedMs || hubIngressElapsedMs > deliveredElapsedMs) {
    throw new Error('HLT_PAYMENT_REPORT_TIMING_INVALID');
  }
  return {
    schema: 'xln-hlt-payment-load-v1',
    mode: 'payments',
    runId,
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
    sourceDispatchFinishedElapsedMs,
    sourceAllAckedElapsedMs,
    commandObservedElapsedMs,
    deliveredElapsedMs,
    deliveredTps,
    hubCompletedPaymentsBefore,
    hubCompletedPaymentsAfter,
    hubAcceptedPaymentsBefore,
    hubAcceptedPaymentsAfter,
    hubIngressElapsedMs,
    settlementSamples,
    roundSubmissionLagMs: lags.map((lag, index) =>
      requireBoundaryInteger(lag, `HLT_PAYMENT_REPORT_LAG_INVALID:${index}`, 0)),
    walBytesBefore: requireBoundaryInteger(record['walBytesBefore'], 'HLT_PAYMENT_REPORT_WAL_BEFORE_INVALID', 0),
    walBytesAfter: requireBoundaryInteger(record['walBytesAfter'], 'HLT_PAYMENT_REPORT_WAL_AFTER_INVALID', 0),
    hubDurableBefore: decodeFrame(record['hubDurableBefore'], 'HLT_PAYMENT_REPORT_HUB_BEFORE'),
    hubDurableAfter: decodeFrame(record['hubDurableAfter'], 'HLT_PAYMENT_REPORT_HUB_AFTER'),
    environment: decodeHltEnvironmentManifest(record['environment'], 'HLT_PAYMENT_REPORT_ENVIRONMENT'),
  };
};
