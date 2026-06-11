import { ethers } from 'ethers';
import type { JurisdictionEvent } from './types';
import type { DisputeFinalizationEvidence } from './types/jurisdiction-events';
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
  disputeFinalizationEvidenceHash?: string;
};

export const canonicalJurisdictionEventsHash = (events: JurisdictionEvent[]): string => {
  const keys = normalizeJurisdictionEvents(events)
    .map((event) => canonicalJurisdictionEventKey(event))
    .sort();
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
    normHex(evidence.initialProofbodyHash),
    normHex(evidence.finalProofbodyHash),
    normHex(evidence.leftArguments),
    normHex(evidence.rightArguments),
    normHex(evidence.starterInitialArguments),
    normHex(evidence.starterIncrementedArguments),
  ]);
};

export const canonicalDisputeFinalizationEvidenceHash = (
  evidence: readonly DisputeFinalizationEvidence[] = [],
): string => {
  const keys = evidence.map(canonicalDisputeFinalizationEvidenceKey).sort();
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(keys)));
};

export const buildJEventObservationDigest = (input: JEventObservationDigestInput): string => {
  const evidenceHash = String(input.disputeFinalizationEvidenceHash || '').trim().toLowerCase();
  const payload = [
    'xln:j-event-observation:v1',
    String(input.entityId || '').toLowerCase(),
    String(input.signerId || '').toLowerCase(),
    Number(input.blockNumber || 0),
    String(input.blockHash || '').toLowerCase(),
    String(input.transactionHash || ''),
    String(input.eventsHash || '').toLowerCase(),
    // Optional calldata-derived evidence is not part of canonical event
    // consensus. If a validator includes it, bind it into that validator's
    // observation signature so an untrusted relayer cannot graft side effects
    // onto a valid block/event attestation.
    ...(evidenceHash ? [evidenceHash] : []),
  ];
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
};
