export type QuorumVerdict = 'verified' | 'partial' | 'noise' | 'blocked';
export type QuorumCategory = 'performance' | 'security' | 'protocol' | 'reliability';
export type QuorumRange = '7d' | '30d' | 'all';
export type QuorumCategoryFilter = QuorumCategory | 'all';

export type QuorumInteraction = Readonly<{
  id: string;
  occurredAt: string;
  reviewerId: string;
  reviewer: string;
  model: string;
  family: string;
  score: number;
  verdict: QuorumVerdict;
  category: QuorumCategory;
  scope: string;
  summary: string;
  evidence: string;
  sourceSha: string;
  sessionId?: string;
  responseMinutes?: number;
  verifiedImpact?: number;
  missedHours?: number;
  challengedInteractionId?: string;
}>;

export type QuorumModelSummary = Readonly<{
  model: string;
  family: string;
  interactions: number;
  averageScore: number;
  verifiedRate: number;
  verifiedImpact: number;
  medianResponseMinutes: number | null;
}>;

export type QuorumModelGroup = QuorumModelSummary & Readonly<{
  entries: readonly QuorumInteraction[];
}>;

export type QuorumReviewChain = Readonly<{
  challenger: QuorumInteraction;
  challenged: QuorumInteraction;
}>;

export type QuorumView = Readonly<{
  interactions: readonly QuorumInteraction[];
  summaries: readonly QuorumModelSummary[];
  modelGroups: readonly QuorumModelGroup[];
  reviewChains: readonly QuorumReviewChain[];
  recentInteractions: readonly QuorumInteraction[];
  selected: QuorumInteraction | null;
  verified: number;
  averageScore: number;
  verifiedImpact: number;
  minTime: number;
  maxTime: number;
  timeSpan: number;
}>;
