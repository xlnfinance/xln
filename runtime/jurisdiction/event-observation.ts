import { ethers } from 'ethers';
import type { JurisdictionEvent } from '../types';
import type { DisputeFinalizationEvidence } from '../types/jurisdiction-events';
import { getJurisdictionIdentityRef } from './jurisdiction-runtime';
import {
  canonicalJurisdictionEventKey,
  compareCanonicalJurisdictionEvents,
  normalizeJurisdictionEvents,
} from './event-normalization';

export const UNCONFIGURED_J_EVENT_JURISDICTION = 'unconfigured';

export const getJEventJurisdictionRef = (jurisdiction: unknown): string =>
  getJurisdictionIdentityRef(jurisdiction) || UNCONFIGURED_J_EVENT_JURISDICTION;

export const canonicalJurisdictionEventsHash = (events: JurisdictionEvent[]): string => {
  const keys = normalizeJurisdictionEvents(events)
    .sort(compareCanonicalJurisdictionEvents)
    .map((event) => canonicalJurisdictionEventKey(event));
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(keys)));
};

const normHex = (value: unknown): string => {
  const text = String(value || '').trim();
  return text.startsWith('0x') ? text.toLowerCase() : text;
};

const normDecimal = (value: unknown): string => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value).toString() : '';
  return String(value || '').trim();
};

export const canonicalDisputeFinalizationEvidenceKey = (evidence: DisputeFinalizationEvidence): string => {
  return JSON.stringify([
    normHex(evidence.sender),
    normHex(evidence.counterentity),
    normDecimal(evidence.initialNonce),
    normDecimal(evidence.finalNonce),
    normHex(evidence.initialProofbodyHash),
    normHex(evidence.finalProofbodyHash),
    normHex(evidence.leftArguments),
    normHex(evidence.rightArguments),
    normHex(evidence.starterInitialArguments),
    normHex(evidence.starterIncrementedArguments),
    normHex(evidence.sig),
  ]);
};

export const canonicalDisputeFinalizationEvidenceHash = (
  evidence: readonly DisputeFinalizationEvidence[] = [],
): string => {
  const keys = evidence.map(canonicalDisputeFinalizationEvidenceKey).sort();
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(keys)));
};
