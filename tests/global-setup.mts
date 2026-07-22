import {
  devices,
  expect,
  request,
  test as base,
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

type BrowserIssueType = 'console' | 'pageerror' | 'requestfailed' | 'http';
type BrowserIssueSeverity = 'error' | 'warning';

type BrowserIssue = {
  type: BrowserIssueType;
  severity: BrowserIssueSeverity;
  message: string;
  url: string | null;
  method: string | null;
  status: number | null;
  testId: string | null;
  timestamp: number;
};

type BrowserIssueExpectation = {
  type?: BrowserIssueType;
  severity?: BrowserIssueSeverity;
  message?: string | RegExp;
  url?: string | RegExp;
  method?: string;
  status?: number;
};

type BrowserWithPatch = Browser & {
  __xlnQaNewContext?: Browser['newContext'];
};

const observedPages = new Set<Page>();
const observedContexts = new Set<BrowserContext>();
const patchedBrowsers = new Set<Browser>();
const expectedBrowserIssuesByTestId = new Map<string, BrowserIssueExpectation[]>();
let activeTestInfo: TestInfo | null = null;
const FAILURE_HOOK_TIMEOUT_MS = 5_000;

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

const writeIssue = (issue: BrowserIssue): void => {
  const path = eventPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(issue)}\n`);
};

const matchesText = (pattern: string | RegExp | undefined, value: string | null): boolean => {
  if (pattern === undefined) return true;
  const text = value ?? '';
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
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
  return rules.some((rule) =>
    (rule.type === undefined || rule.type === type) &&
    (rule.severity === undefined || rule.severity === severity) &&
    (rule.method === undefined || rule.method === details.method) &&
    (rule.status === undefined || rule.status === details.status) &&
    matchesText(rule.message, message) &&
    matchesText(rule.url, details.url),
  );
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
  writeIssue({
    type,
    severity: expected ? 'warning' : severity,
    message: `${expected ? '[expected] ' : ''}${text}`.slice(0, 2_000),
    url: details.url,
    method: details.method,
    status: details.status,
    testId: testId(testInfo),
    timestamp: Date.now(),
  });
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

const captureFailedRuntimeSnapshots = async (testInfo: TestInfo, pages: Page[]): Promise<Error[]> => {
  if (testInfo.status === testInfo.expectedStatus) return [];
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

test.beforeEach(async ({ browser, context, page }, testInfo) => {
  activeTestInfo = testInfo;
  patchBrowser(browser);
  observeContext(context, testInfo);
  observePage(page, testInfo);
  await page.setViewportSize({ width: 1920, height: 1080 });
  setE2ETimingOrigin();
});

test.afterEach(async ({}, testInfo) => {
  const pages = [...observedPages].filter((page) => !page.isClosed());
  const secondaryErrors: Error[] = [];
  try {
    secondaryErrors.push(...await captureFailedRuntimeSnapshots(testInfo, pages));
  } finally {
    try {
      secondaryErrors.push(...await quiesceRuntimePages(pages));
    } finally {
      const id = testId(activeTestInfo);
      if (id) expectedBrowserIssuesByTestId.delete(id);
      activeTestInfo = null;
    }
  }
  if (secondaryErrors.length > 0) {
    throw new AggregateError(secondaryErrors, 'E2E_FAILURE_HOOK_SECONDARY_ERRORS');
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
