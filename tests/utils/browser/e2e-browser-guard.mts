export type E2EBrowserIssueType = 'console' | 'pageerror' | 'requestfailed' | 'http';
export type E2EBrowserIssueSeverity = 'error' | 'warning';

export type E2EBrowserIssue = {
  type: E2EBrowserIssueType;
  severity: E2EBrowserIssueSeverity;
  message: string;
  url: string | null;
  method: string | null;
  status: number | null;
  testId: string | null;
  timestamp: number;
};

export type E2EBrowserIssueExpectation = {
  type?: E2EBrowserIssueType;
  severity?: E2EBrowserIssueSeverity;
  message?: string | RegExp;
  url?: string | RegExp;
  method?: string;
  status?: number;
};

export type E2EDebugIncident = {
  fingerprint: string;
  state: string;
  source: string;
  code: string;
  message: string;
  runtimeId?: string;
  lastEventId: number;
};

export type E2EDebugIncidentExpectation = {
  source?: string | RegExp;
  code?: string | RegExp;
  message?: string | RegExp;
  runtimeId?: string | RegExp;
};

const matchesText = (
  pattern: string | RegExp | undefined,
  value: string | null | undefined,
): boolean => {
  if (pattern === undefined) return true;
  const text = value ?? '';
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
};

export const matchesBrowserIssue = (
  rule: E2EBrowserIssueExpectation,
  issue: Pick<E2EBrowserIssue, 'type' | 'severity' | 'message' | 'url' | 'method' | 'status'>,
): boolean =>
  (rule.type === undefined || rule.type === issue.type) &&
  (rule.severity === undefined || rule.severity === issue.severity) &&
  (rule.method === undefined || rule.method === issue.method) &&
  (rule.status === undefined || rule.status === issue.status) &&
  matchesText(rule.message, issue.message) &&
  matchesText(rule.url, issue.url);

export const unexpectedBrowserErrors = (
  issues: readonly E2EBrowserIssue[],
): E2EBrowserIssue[] => issues.filter(issue =>
  issue.severity === 'error' && !issue.message.startsWith('[expected] ')
);

const browserRuleAllowsIncident = (
  rule: E2EBrowserIssueExpectation,
  incident: E2EDebugIncident,
): boolean =>
  incident.source === 'browser' &&
  (rule.severity === undefined || rule.severity === 'error') &&
  matchesText(rule.message, incident.message);

export const unexpectedOpenIncidents = (
  incidents: readonly E2EDebugIncident[],
  incidentRules: readonly E2EDebugIncidentExpectation[],
  browserRules: readonly E2EBrowserIssueExpectation[],
): E2EDebugIncident[] => incidents.filter(incident =>
  incident.state !== 'resolved' &&
  !incidentRules.some(rule =>
    matchesText(rule.source, incident.source) &&
    matchesText(rule.code, incident.code) &&
    matchesText(rule.message, incident.message) &&
    matchesText(rule.runtimeId, incident.runtimeId)
  ) &&
  !browserRules.some(rule => browserRuleAllowsIncident(rule, incident))
);

export const formatE2EGuardFailure = (
  browserIssues: readonly E2EBrowserIssue[],
  incidents: readonly E2EDebugIncident[],
): string => JSON.stringify({
  browserIssues: browserIssues.map(issue => ({
    type: issue.type,
    message: issue.message,
    url: issue.url,
    status: issue.status,
  })),
  incidents: incidents.map(incident => ({
    fingerprint: incident.fingerprint,
    source: incident.source,
    code: incident.code,
    message: incident.message,
    runtimeId: incident.runtimeId ?? null,
    lastEventId: incident.lastEventId,
  })),
});
