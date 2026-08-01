/**
 * Canonical data contract for evidence-driven modular audits.
 *
 * The registry stores facts rather than prose: module ownership, falsifiable
 * invariants, exact-source evidence, independently adjudicated findings, and
 * agent runs. Derived percentages and rankings are computed by tools/audit.ts;
 * they are never hand-edited into this schema.
 */

export const EVIDENCE_KINDS = [
  'codeTrace',
  'l1Regression',
  'l2TargetedFlow',
  'failureInjection',
  'l3BroadGate',
  'independentVerification',
] as const;

export const EVIDENCE_STATES = ['PASS', 'FAIL'] as const;
export const MODULE_CRITICALITIES = ['critical', 'high', 'medium', 'low'] as const;
export const FINDING_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export const FINDING_STATES = [
  'CANDIDATE',
  'CONFIRMED',
  'REJECTED',
  'ACCEPTED',
  'OWNER_DEFERRED',
  'FIXED',
  'VERIFIED',
] as const;
export const AGENT_RUN_STATES = ['RUNNING', 'COMPLETED', 'BLOCKED'] as const;
export const REVIEWER_STATES = ['PROVISIONAL', 'RANKED'] as const;

export type EvidenceKind = typeof EVIDENCE_KINDS[number];
export type EvidenceState = typeof EVIDENCE_STATES[number];
export type ModuleCriticality = typeof MODULE_CRITICALITIES[number];
export type FindingSeverity = typeof FINDING_SEVERITIES[number];
export type FindingState = typeof FINDING_STATES[number];
export type AgentRunState = typeof AGENT_RUN_STATES[number];
export type ReviewerState = typeof REVIEWER_STATES[number];

export type AuditPolicy = Readonly<{
  evidenceWeights: Readonly<Record<EvidenceKind, number>>;
  releaseCoverageMinimum: number;
  independentConfidenceThreshold: number;
  idealModuleScoreMinimum: number;
  idealReviewQuorum: number;
  idealReviewFamilyQuorum: number;
}>;

export type AuditScope = Readonly<{
  sourceGlobs: readonly string[];
  testGlobs: readonly string[];
  exclusions: readonly Readonly<{ glob: string; reason: string }>[];
}>;

export type AuditModule = Readonly<{
  id: string;
  title: string;
  purpose: string;
  criticality: ModuleCriticality;
  structuralDebt: number;
  sourceGlobs: readonly string[];
  testGlobs: readonly string[];
  dependencies: readonly string[];
  exclusions: readonly Readonly<{ glob: string; reason: string }>[];
}>;

export type AuditInvariant = Readonly<{
  id: string;
  moduleId: string;
  title: string;
  importance: number;
  requiredEvidence: readonly EvidenceKind[];
}>;

export type AuditEvidence = Readonly<{
  id: string;
  invariantId: string;
  kind: EvidenceKind;
  state: EvidenceState;
  sourceSha: string;
  moduleFingerprint: string;
  command: string;
  commandFingerprint: string;
  environmentFingerprint: string;
  artifactPath: string;
  artifactFingerprint: string;
  summary: string;
  recordedAt: string;
  agentRunIds: readonly string[];
}>;

export type AuditFinding = Readonly<{
  id: string;
  rootCauseKey: string;
  moduleId: string;
  invariantIds: readonly string[];
  title: string;
  severity: FindingSeverity;
  confidence: number;
  state: FindingState;
  sourceSha: string;
  reproduction: string;
  todoRef?: string;
}>;

export type AuditReviewer = Readonly<{
  id: string;
  label: string;
  family: string;
  state: ReviewerState;
}>;

export type AuditAgentRun = Readonly<{
  id: string;
  reviewerId: string;
  sourceSha: string;
  moduleIds: readonly string[];
  scope: string;
  state: AgentRunState;
  usefulnessScore: number;
  provisional: boolean;
  confirmedFindingIds: readonly string[];
  candidateFindingIds: readonly string[];
  summary: string;
}>;

export type AuditModuleReview = Readonly<{
  id: string;
  moduleId: string;
  agentRunId: string;
  sourceSha: string;
  moduleFingerprint: string;
  environmentFingerprint: string;
  score: number;
  confidence: number;
  blockerFindingIds: readonly string[];
  summary: string;
  recordedAt: string;
}>;

export type AuditRegistry = Readonly<{
  schemaVersion: 1;
  protocol: string;
  scope: AuditScope;
  policy: AuditPolicy;
  modules: readonly AuditModule[];
  invariants: readonly AuditInvariant[];
  evidence: readonly AuditEvidence[];
  findings: readonly AuditFinding[];
  reviewers: readonly AuditReviewer[];
  agentRuns: readonly AuditAgentRun[];
  moduleReviews: readonly AuditModuleReview[];
}>;

export type InvariantAuditStatus = Readonly<{
  id: string;
  moduleId: string;
  coverage: number;
  missingEvidence: readonly EvidenceKind[];
  staleEvidence: readonly EvidenceKind[];
}>;

export type ModuleAuditState = 'MAPPED' | 'IN_REVIEW' | 'AUDITED' | 'STALE' | 'BLOCKED';

export type ModuleAuditStatus = Readonly<{
  id: string;
  title: string;
  criticality: ModuleCriticality;
  state: ModuleAuditState;
  coverage: number;
  quality: number;
  currentEvidence: number;
  staleEvidence: number;
  openFindings: number;
  openHighFindings: number;
  reviewFloor: number;
  reviewCount: number;
  reviewFamilyCount: number;
  staleReviews: number;
  reviewGoalMet: boolean;
}>;

export type AuditStatus = Readonly<{
  sourceSha: string;
  environmentFingerprint: string;
  coverage: number;
  quality: number;
  modules: readonly ModuleAuditStatus[];
  invariants: readonly InvariantAuditStatus[];
  currentEvidence: number;
  staleEvidence: number;
}>;
