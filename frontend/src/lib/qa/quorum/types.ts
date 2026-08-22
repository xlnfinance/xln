export type QuorumVerdict = 'verified' | 'partial' | 'noise' | 'blocked';
export type QuorumCategory = 'performance' | 'security' | 'protocol' | 'reliability';

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
