import {
  devices,
  expect,
  request,
  test as base,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setE2ETimingOrigin } from './utils/e2e-timing.mts';
import {
  quiesceRuntimePage,
  wrapRuntimeContextClose,
  wrapRuntimePageClose,
} from './utils/e2e-runtime-shutdown.mts';
import { isBenignConsoleMessage } from './utils/browser-health-classification.mts';
import {
  formatE2EGuardFailure,
  matchesBrowserIssue,
  unexpectedBrowserErrors,
  unexpectedOpenIncidents,
  type E2EBrowserIssue as BrowserIssue,
  type E2EBrowserIssueExpectation as BrowserIssueExpectation,
  type E2EBrowserIssueSeverity as BrowserIssueSeverity,
  type E2EBrowserIssueType as BrowserIssueType,
  type E2EDebugIncident,
  type E2EDebugIncidentExpectation,
} from './utils/e2e-browser-guard.mts';

type BrowserWithPatch = Browser & {
  __xlnQaNewContext?: Browser['newContext'];
};

const observedPages = new Set<Page>();
const observedContexts = new Set<BrowserContext>();
const patchedBrowsers = new Set<Browser>();
const expectedBrowserIssuesByTestId = new Map<string, BrowserIssueExpectation[]>();
const expectedDebugIncidentsByTestId = new Map<string, E2EDebugIncidentExpectation[]>();
const browserIssuesByTestId = new Map<string, BrowserIssue[]>();
const incidentCursorByTestId = new Map<string, number>();
let activeTestInfo: TestInfo | null = null;
const FAILURE_HOOK_TIMEOUT_MS = 5_000;
const INCIDENT_QUERY_TIMEOUT_MS = 5_000;

const asError = (value: unknown, label: string): Error =>
  value instanceof Error ? value : new Error(`${label}: ${String(value)}`);

const withFailureHookTimeout = async <T,>(label: string, operation: () => Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`E2E_FAILURE_HOOK_TIMEOUT:${label}:${FAILURE_HOOK_TIMEOUT_MS}`)),
          FAILURE_HOOK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const eventPath = (): string => process.env['E2E_BROWSER_EVENTS_PATH']?.trim() ?? '';

const testId = (testInfo: TestInfo | null): string | null => {
  if (!testInfo) return null;
  return [testInfo.project.name, testInfo.file, testInfo.title].filter(Boolean).join(' :: ');
};

const requiresIncidentGuard = (testInfo: TestInfo): boolean =>
  testInfo.tags.includes('@functional') || testInfo.tags.includes('@resilience');

const debugApiBaseUrl = (testInfo: TestInfo): string => {
  const configured = [
    process.env['E2E_API_BASE_URL'],
    process.env['E2E_BASE_URL'],
    process.env['PW_BASE_URL'],
    typeof testInfo.project.use.baseURL === 'string' ? testInfo.project.use.baseURL : undefined,
  ].find(value => typeof value === 'string' && value.trim().length > 0);
  if (!configured) throw new Error('E2E_DEBUG_INCIDENT_API_BASE_URL_MISSING');
  return configured.replace(/\/+$/, '');
};

const readIncidentSnapshot = async (
  api: APIRequestContext,
  testInfo: TestInfo,
  afterId = 0,
): Promise<{ highestEventId: number; incidents: E2EDebugIncident[] }> => {
  const response = await api.get(
    `${debugApiBaseUrl(testInfo)}/api/debug/incidents?state=open&afterId=${afterId}&limit=1000`,
    { headers: { 'Cache-Control': 'no-store' }, timeout: INCIDENT_QUERY_TIMEOUT_MS },
  );
  if (!response.ok()) {
    throw new Error(`E2E_DEBUG_INCIDENT_QUERY_FAILED:status=${response.status()}`);
  }
  const body = await response.json() as {
    highestEventId?: unknown;
    incidents?: unknown;
  };
  const highestEventId = Number(body.highestEventId);
  if (!Number.isSafeInteger(highestEventId) || highestEventId < 0 || !Array.isArray(body.incidents)) {
    throw new Error('E2E_DEBUG_INCIDENT_RESPONSE_INVALID');
  }
  const incidents = body.incidents.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`E2E_DEBUG_INCIDENT_INVALID:index=${index}`);
    }
    const incident = value as Record<string, unknown>;
    const lastEventId = Number(incident['lastEventId']);
    const required = ['fingerprint', 'state', 'source', 'code', 'message'] as const;
    if (
      !required.every(field => typeof incident[field] === 'string') ||
      !Number.isSafeInteger(lastEventId) ||
      lastEventId <= afterId
    ) {
      throw new Error(`E2E_DEBUG_INCIDENT_INVALID:index=${index}`);
    }
    return {
      fingerprint: incident['fingerprint'] as string,
      state: incident['state'] as string,
      source: incident['source'] as string,
      code: incident['code'] as string,
      message: incident['message'] as string,
      ...(typeof incident['runtimeId'] === 'string' ? { runtimeId: incident['runtimeId'] } : {}),
      lastEventId,
    } satisfies E2EDebugIncident;
  });
  return { highestEventId, incidents };
};

const writeIssue = (issue: BrowserIssue): void => {
  const path = eventPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(issue)}\n`);
};

const isExpectedBrowserIssue = (
  testInfo: TestInfo | null,
  type: BrowserIssueType,
  severity: BrowserIssueSeverity,
  message: string,
  details: Pick<BrowserIssue, 'url' | 'method' | 'status'>,
): boolean => {
  const id = testId(testInfo);
  if (!id) return false;
  const rules = expectedBrowserIssuesByTestId.get(id) ?? [];
  return rules.some(rule => matchesBrowserIssue(rule, {
    type,
    severity,
    message,
    ...details,
  }));
};

const emitIssue = (
  testInfo: TestInfo | null,
  type: BrowserIssueType,
  severity: BrowserIssueSeverity,
  message: string,
  details: Pick<BrowserIssue, 'url' | 'method' | 'status'> = { url: null, method: null, status: null },
): void => {
  const text = message.trim();
  if (!text) return;
  const expected = isExpectedBrowserIssue(testInfo, type, severity, text, details);
  const issue = {
    type,
    severity: expected ? 'warning' : severity,
    message: `${expected ? '[expected] ' : ''}${text}`.slice(0, 2_000),
    url: details.url,
    method: details.method,
    status: details.status,
    testId: testId(testInfo),
    timestamp: Date.now(),
  } satisfies BrowserIssue;
  writeIssue(issue);
  const id = testId(testInfo);
  if (id) browserIssuesByTestId.set(id, [...(browserIssuesByTestId.get(id) ?? []), issue]);
};

const getConsoleResourceStatus = (message: string): number | null => {
  const match = message.match(/Failed to load resource: the server responded with a status of (\d{3})/);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
};

const isBenignRequestFailure = (request: Request, message: string): boolean => {
  if (message !== 'net::ERR_ABORTED') return false;
  return true;
};

const isBenignPageError = (url: string | null, message: string): boolean =>
  url === 'about:blank' &&
  message.includes("Failed to read the 'localStorage' property") &&
  message.includes('Access is denied');

const observePage = (page: Page, testInfo: TestInfo | null): void => {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  wrapRuntimePageClose(page);
  page.on('close', () => observedPages.delete(page));
  page.on('console', (message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') return;
    if (type === 'warning' && isBenignConsoleMessage(message.text())) return;
    const resourceStatus = getConsoleResourceStatus(message.text());
    const severity: BrowserIssueSeverity =
      resourceStatus !== null
        ? resourceStatus >= 500 ? 'error' : 'warning'
        : type === 'error' ? 'error' : 'warning';
    emitIssue(testInfo, 'console', severity, message.text(), {
      url: page.url() || null,
      method: null,
      status: null,
    });
  });
  page.on('pageerror', (error) => {
    if (isBenignPageError(page.url() || null, error.message)) return;
    emitIssue(testInfo, 'pageerror', 'error', error.message, {
      url: page.url() || null,
      method: null,
      status: null,
    });
  });
  page.on('requestfailed', (request) => {
    const failureMessage = request.failure()?.errorText || 'request failed';
    if (isBenignRequestFailure(request, failureMessage)) return;
    emitIssue(testInfo, 'requestfailed', 'error', failureMessage, {
      url: request.url(),
      method: request.method(),
      status: null,
    });
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    emitIssue(testInfo, 'http', status >= 500 ? 'error' : 'warning', `HTTP ${status}`, {
      url: response.url(),
      method: response.request().method(),
      status,
    });
  });
};

const observeContext = (context: BrowserContext, testInfo: TestInfo | null): void => {
  if (observedContexts.has(context)) return;
  observedContexts.add(context);
  wrapRuntimeContextClose(context);
  context.on('close', () => observedContexts.delete(context));
  for (const page of context.pages()) observePage(page, testInfo);
  context.on('page', (page) => observePage(page, testInfo));
};

const patchBrowser = (browser: Browser): void => {
  if (patchedBrowsers.has(browser)) return;
  patchedBrowsers.add(browser);
  browser.on('disconnected', () => patchedBrowsers.delete(browser));
  const target = browser as BrowserWithPatch;
  target.__xlnQaNewContext = browser.newContext.bind(browser);
  target.newContext = async (...args: Parameters<Browser['newContext']>) => {
    const context = await target.__xlnQaNewContext!(...args);
    observeContext(context, activeTestInfo);
    return context;
  };
};

const captureFailedRuntimeSnapshots = async (
  testInfo: TestInfo,
  pages: Page[],
  force = false,
): Promise<Error[]> => {
  if (!force && testInfo.status === testInfo.expectedStatus) return [];
  const settled = await Promise.allSettled(pages.map(async (page, index) => {
    const artifactName = `browser-runtime-${index + 1}.json`;
    try {
      const snapshot = await withFailureHookTimeout(`snapshot:${index + 1}`, async () => page.evaluate(() => {
        const root = (window as Window & { __xln?: Record<string, unknown> }).__xln;
        if (!root) throw new Error('E2E_FAILURE_DEBUG_SURFACE_MISSING');
        const wire = root['wire'] as { stringifyJson?: (value: unknown) => string } | undefined;
        if (typeof wire?.stringifyJson !== 'function') {
          throw new Error('E2E_FAILURE_DEBUG_SERIALIZER_MISSING');
        }
        const runtimeSnapshot = root['liveRuntimeSnapshot'];
        if (!runtimeSnapshot) throw new Error('E2E_FAILURE_RUNTIME_SNAPSHOT_MISSING');
        return wire.stringifyJson(runtimeSnapshot);
      }));
      const artifactPath = testInfo.outputPath(artifactName);
      await writeFile(artifactPath, snapshot, 'utf8');
      await testInfo.attach(artifactName, { path: artifactPath, contentType: 'application/json' });
    } catch (reason) {
      const error = asError(reason, `snapshot:${index + 1}`);
      const errorName = `browser-runtime-${index + 1}.error.txt`;
      const errorPath = testInfo.outputPath(errorName);
      await writeFile(errorPath, `url=${page.url()}\n${error.stack ?? error.message}\n`, 'utf8');
      await testInfo.attach(errorName, { path: errorPath, contentType: 'text/plain' });
      throw error;
    }
  }));
  return settled.flatMap((result, index) =>
    result.status === 'rejected' ? [asError(result.reason, `snapshot:${index + 1}`)] : []
  );
};

const quiesceRuntimePages = async (pages: Page[]): Promise<Error[]> => {
  const settled = await Promise.allSettled(pages.map((page, index) =>
    withFailureHookTimeout(`quiesce:${index + 1}`, async () => quiesceRuntimePage(page))
  ));
  return settled.flatMap((result, index) =>
    result.status === 'rejected' ? [asError(result.reason, `quiesce:${index + 1}`)] : []
  );
};

export const test = base.extend({});

test.beforeEach(async ({ browser, context, page, request: api }, testInfo) => {
  activeTestInfo = testInfo;
  const id = testId(testInfo);
  if (!id) throw new Error('E2E_TEST_ID_MISSING');
  browserIssuesByTestId.set(id, []);
  if (requiresIncidentGuard(testInfo)) {
    const snapshot = await readIncidentSnapshot(api, testInfo);
    incidentCursorByTestId.set(id, snapshot.highestEventId);
  }
  patchBrowser(browser);
  observeContext(context, testInfo);
  observePage(page, testInfo);
  await page.setViewportSize({ width: 1920, height: 1080 });
  setE2ETimingOrigin();
});

test.afterEach(async ({ request: api }, testInfo) => {
  const pages = [...observedPages].filter((page) => !page.isClosed());
  const id = testId(testInfo);
  const guardErrors: Error[] = [];
  const secondaryErrors: Error[] = [];
  try {
    const browserIssues = unexpectedBrowserErrors(browserIssuesByTestId.get(id ?? '') ?? []);
    let incidents: E2EDebugIncident[] = [];
    if (requiresIncidentGuard(testInfo)) {
      const cursor = incidentCursorByTestId.get(id ?? '');
      if (cursor === undefined) throw new Error('E2E_DEBUG_INCIDENT_CURSOR_MISSING');
      const snapshot = await readIncidentSnapshot(api, testInfo, cursor);
      incidents = unexpectedOpenIncidents(
        snapshot.incidents,
        expectedDebugIncidentsByTestId.get(id ?? '') ?? [],
        expectedBrowserIssuesByTestId.get(id ?? '') ?? [],
      );
    }
    if (browserIssues.length > 0 || incidents.length > 0) {
      guardErrors.push(new Error(
        `E2E_GLOBAL_ERROR_GUARD_FAILED:${formatE2EGuardFailure(browserIssues, incidents)}`,
      ));
    }
  } catch (reason) {
    guardErrors.push(asError(reason, 'global-error-guard'));
  }
  try {
    secondaryErrors.push(...await captureFailedRuntimeSnapshots(
      testInfo,
      pages,
      guardErrors.length > 0,
    ));
  } finally {
    try {
      secondaryErrors.push(...await quiesceRuntimePages(pages));
    } finally {
      if (id) {
        expectedBrowserIssuesByTestId.delete(id);
        expectedDebugIncidentsByTestId.delete(id);
        browserIssuesByTestId.delete(id);
        incidentCursorByTestId.delete(id);
      }
      activeTestInfo = null;
    }
  }
  const errors = [...guardErrors, ...secondaryErrors];
  if (errors.length > 0) {
    throw new AggregateError(errors, 'E2E_FAILURE_HOOK_ERRORS');
  }
});

export const allowBrowserIssue = (rule: BrowserIssueExpectation): void => {
  const id = testId(activeTestInfo);
  if (!id) throw new Error('allowBrowserIssue must be called inside a running test');
  expectedBrowserIssuesByTestId.set(id, [
    ...(expectedBrowserIssuesByTestId.get(id) ?? []),
    rule,
  ]);
};

export const allowDebugIncident = (rule: E2EDebugIncidentExpectation): void => {
  const id = testId(activeTestInfo);
  if (!id) throw new Error('allowDebugIncident must be called inside a running test');
  expectedDebugIncidentsByTestId.set(id, [
    ...(expectedDebugIncidentsByTestId.get(id) ?? []),
    rule,
  ]);
};

export { devices, expect, request };
export type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
  TestInfo,
} from '@playwright/test';
