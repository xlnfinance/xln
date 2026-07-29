import type { ValidatorJBlockHeader } from '../types';
import type { JEventIngress } from './types';

export type JEventIngressBatch = {
  events: JEventIngress[];
  blockNumber: number;
  blockHash: string;
};

export type JHistoryRangeIngress = {
  scannedThroughHeight: number;
  tipBlockHash: string;
  headers: ValidatorJBlockHeader[];
};

export type JBlockHeadersIngress = ValidatorJBlockHeader[];

type Transform<T> = ((value: T) => T) | null;

let eventTransform: Transform<JEventIngressBatch> = null;
let historyRangeTransform: Transform<JHistoryRangeIngress> = null;
let blockHeadersTransform: Transform<JBlockHeadersIngress> = null;

const installTransform = <T>(
  read: () => Transform<T>,
  write: (transform: Transform<T>) => void,
  transform: Transform<T>,
): (() => void) => {
  const previous = read();
  write(transform);
  return () => write(previous);
};

/**
 * Determinism tests replace external block identity at this adapter boundary.
 * The restore closure makes nested record/replay scopes exact and reversible.
 */
export const setJEventIngressTransform = (
  transform: Transform<JEventIngressBatch>,
): (() => void) =>
  installTransform(
    () => eventTransform,
    value => {
      eventTransform = value;
    },
    transform,
  );

export const setJHistoryRangeIngressTransform = (
  transform: Transform<JHistoryRangeIngress>,
): (() => void) =>
  installTransform(
    () => historyRangeTransform,
    value => {
      historyRangeTransform = value;
    },
    transform,
  );

export const setJBlockHeadersIngressTransform = (
  transform: Transform<JBlockHeadersIngress>,
): (() => void) =>
  installTransform(
    () => blockHeadersTransform,
    value => {
      blockHeadersTransform = value;
    },
    transform,
  );

export const applyJEventIngressTransform = (
  batch: JEventIngressBatch,
): JEventIngressBatch => (eventTransform ? eventTransform(batch) : batch);

export const applyJHistoryRangeIngressTransform = (
  range: JHistoryRangeIngress,
): JHistoryRangeIngress =>
  historyRangeTransform ? historyRangeTransform(range) : range;

export const applyJBlockHeadersIngressTransform = (
  headers: JBlockHeadersIngress,
): JBlockHeadersIngress => {
  const transformed = blockHeadersTransform
    ? blockHeadersTransform(headers.map(header => ({ ...header })))
    : headers;
  if (transformed.length !== headers.length) {
    throw new Error('J_HISTORY_HEADER_TRACE_LENGTH_MISMATCH');
  }
  return transformed.map((header, index) => {
    const expectedHeight = headers[index]?.jHeight;
    if (header.jHeight !== expectedHeight || !String(header.jBlockHash || '').trim()) {
      throw new Error(`J_HISTORY_HEADER_TRACE_INVALID:index=${index}`);
    }
    return {
      jHeight: header.jHeight,
      jBlockHash: header.jBlockHash.toLowerCase(),
    };
  });
};
