import type { QuorumInteraction } from './qa-quorum-types';

const SOURCE_SHA = '15383eb3474d948756bd196d1e41ddb6dd909cd0';

/** Owner-visible reviews verified in the 2026-08-22 performance investigation. */
export const currentQuorumInteractions: readonly QuorumInteraction[] = [
  {
    id: 'fable-wire-fit-20260822', occurredAt: '2026-08-22T18:10:00Z',
    reviewerId: 'claude-fable-performance', reviewer: 'Fable', model: 'Claude Fable 5', family: 'Claude',
    score: 940, verdict: 'verified', category: 'performance', sourceSha: SOURCE_SHA,
    scope: 'Live H1 proposal formation and wire-fit slow start',
    summary: 'Found the previous-frame ×1.15 fit hint that forced a growing ladder of small H1 frames.',
    evidence: 'Live H1 improved 234→272 TPS; frame count fell to 21 with 300–840 inputs. Full-queue regression test is still required.',
    responseMinutes: 96, verifiedImpact: 162, missedHours: 48,
  },
  {
    id: 'fable-cpu-profile-20260822', occurredAt: '2026-08-22T20:12:00Z',
    reviewerId: 'claude-fable-performance', reviewer: 'Fable', model: 'Claude Fable 5', family: 'Claude',
    score: 895, verdict: 'partial', category: 'performance', sourceSha: SOURCE_SHA,
    scope: '60-second live H1 CPU profile',
    summary: 'Separated frame work from transport/storage and ranked crypto plus Account leaf hashing.',
    evidence: 'Measured 12.5 CPU seconds in crypto and 4.9 seconds in Account leaf hashing; projected worker gains remain unverified.',
    responseMinutes: 62, verifiedImpact: 55, challengedInteractionId: 'fable-wire-fit-20260822',
  },
  {
    id: 'grok-frame-audit-20260822', occurredAt: '2026-08-22T10:05:00Z',
    reviewerId: 'cursor-grok-46-high', reviewer: 'Grok', model: 'Grok 4.6 High', family: 'xAI',
    score: 825, verdict: 'partial', category: 'performance', sourceSha: SOURCE_SHA,
    sessionId: '5a95e0e3-745a-4eca-8bf6-3312b2b9567c',
    scope: 'H1 frame count, Account collisions and proposal sizing',
    summary: 'Correctly highlighted small frames and collision churn, but did not isolate the wire-fit hint.',
    evidence: 'Code-path review was useful; the decisive live cause came later from queue-to-selection measurements.',
    responseMinutes: 38, verifiedImpact: 25,
  },
  {
    id: 'glm-storage-audit-20260822', occurredAt: '2026-08-22T11:20:00Z',
    reviewerId: 'opencode-glm-53', reviewer: 'GLM', model: 'GLM 5.3', family: 'Zhipu',
    score: 760, verdict: 'partial', category: 'performance', sourceSha: SOURCE_SHA,
    sessionId: 'ses_fd4ebc021ffeZ0jN7CHTsvRYDt',
    scope: 'Repeated encoding, merge keys and storage commit path',
    summary: 'Found repeated frame packing and unsafe aliasing risks; several projected wins were not authoritative-live bottlenecks.',
    evidence: 'Concrete call sites verified; no live TPS delta was demonstrated for the proposed encoding changes.',
    responseMinutes: 51, verifiedImpact: 18,
  },
  {
    id: 'sonnet-account-input-20260822', occurredAt: '2026-08-22T13:40:00Z',
    reviewerId: 'claude-sonnet-account', reviewer: 'Sonnet', model: 'Claude Sonnet 5', family: 'Claude',
    score: 875, verdict: 'verified', category: 'protocol', sourceSha: SOURCE_SHA,
    sessionId: 'b074b33e-11df-4a6b-aa73-09051142ca95',
    scope: 'Account ACK/proposal simplification and local enqueue ownership',
    summary: 'Confirmed local enqueue must not route and identified the exact H0/H>=1 ACK constraints.',
    evidence: 'The local enqueue split now passes runtime typecheck and 68 targeted tests.',
    responseMinutes: 44, verifiedImpact: 40,
  },
  {
    id: 'deepseek-account-audit-20260822', occurredAt: '2026-08-22T14:05:00Z',
    reviewerId: 'opencode-deepseek-v4', reviewer: 'DeepSeek', model: 'DeepSeek V4', family: 'DeepSeek',
    score: 0, verdict: 'blocked', category: 'protocol', sourceSha: SOURCE_SHA,
    sessionId: 'ses_fd4df97baffeQx27NGk1B8CKPP',
    scope: 'Independent Account ownership and deletion audit',
    summary: 'Provider quota and a stalled local run prevented a complete verdict.',
    evidence: 'No completed review was counted toward quorum.', responseMinutes: 420, verifiedImpact: 0,
  },
  {
    id: 'opus-hot-path-20260822', occurredAt: '2026-08-22T09:10:00Z',
    reviewerId: 'claude-opus-performance', reviewer: 'Opus', model: 'Claude Opus 5 High', family: 'Claude',
    score: 890, verdict: 'verified', category: 'performance', sourceSha: SOURCE_SHA,
    scope: 'Replay and H1 hot-path audit',
    summary: 'Confirmed idle frame delay, Account leaf hashing and repeated certified-frame encoding as P0 candidates.',
    evidence: 'Findings matched profiling; the idle delay and encoding work alone did not close the live TPS gap.',
    responseMinutes: 73, verifiedImpact: 45,
  },
];
