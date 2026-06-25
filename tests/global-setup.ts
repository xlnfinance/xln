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
import { dirname } from 'node:path';
import { setE2ETimingOrigin } from './utils/e2e-timing';

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

const isBenignConsoleMessage = (message: string): boolean =>
  message === 'Ignoring Event: localhost';

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

export const test = base.extend({});

test.beforeEach(async ({ browser, context, page }, testInfo) => {
  activeTestInfo = testInfo;
  patchBrowser(browser);
  observeContext(context, testInfo);
  observePage(page, testInfo);
  await page.setViewportSize({ width: 1920, height: 1080 });
  setE2ETimingOrigin();
});

test.afterEach(async () => {
  const id = testId(activeTestInfo);
  if (id) expectedBrowserIssuesByTestId.delete(id);
  activeTestInfo = null;
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
