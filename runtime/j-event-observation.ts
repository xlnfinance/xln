import { ethers } from 'ethers';
import type { JurisdictionEvent } from './types';
import {
  canonicalJurisdictionEventKey,
  normalizeJurisdictionEvents,
} from './j-event-normalization';

export type JEventObservationDigestInput = {
  entityId: string;
  signerId: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  eventsHash: string;
};

export const canonicalJurisdictionEventsHash = (events: JurisdictionEvent[]): string => {
  const keys = normalizeJurisdictionEvents(events)
    .map((event) => canonicalJurisdictionEventKey(event))
    .sort();
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(keys)));
};

export const buildJEventObservationDigest = (input: JEventObservationDigestInput): string => {
  const payload = [
    'xln:j-event-observation:v1',
    String(input.entityId || '').toLowerCase(),
    String(input.signerId || '').toLowerCase(),
    Number(input.blockNumber || 0),
    String(input.blockHash || '').toLowerCase(),
    String(input.transactionHash || ''),
    String(input.eventsHash || '').toLowerCase(),
  ];
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
};
