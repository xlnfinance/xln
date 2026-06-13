import { broadcastHardResetRequest } from './activeTabLock';
import { shutdownRuntimeResumeListener, vaultOperations } from '../stores/vaultStore';
import { RESET_CONFIRM_COOKIE } from './resetDbGuard';

let activeResetPromise: Promise<void> | null = null;

const RESET_TAB_SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type ResetEverythingRequest = {
  confirmed: true;
  reason: string;
};

const assertResetConfirmed = (request: unknown): ResetEverythingRequest => {
  if (
    request
    && typeof request === 'object'
    && (request as ResetEverythingRequest).confirmed === true
    && typeof (request as ResetEverythingRequest).reason === 'string'
    && (request as ResetEverythingRequest).reason.trim().length > 0
  ) {
    return request as ResetEverythingRequest;
  }
  throw new Error('RESET_CONFIRMATION_REQUIRED');
};

async function stopCurrentRuntimeActivity(): Promise<void> {
  try {
    await vaultOperations.suspendAllRuntimeActivity?.();
    shutdownRuntimeResumeListener?.();
  } catch {
    // best effort
  }
}

async function requestOtherTabsShutdown(): Promise<void> {
  try {
    broadcastHardResetRequest();
  } catch {
    // best effort
  }
}

function randomResetNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function setResetConfirmationCookie(nonce: string): void {
  document.cookie = `${RESET_CONFIRM_COOKIE}=${nonce}; Path=/resetdb; SameSite=Strict; Max-Age=30`;
}

function buildResetDbUrl(nonce: string): string {
  const returnTo =
    window.location.pathname.startsWith('/app') || window.location.pathname === '/loading-screen'
      ? '/app'
      : '/app';
  return `/resetdb?returnTo=${encodeURIComponent(returnTo)}&confirm=${encodeURIComponent(nonce)}`;
}

export async function resetEverything(request: ResetEverythingRequest): Promise<void> {
  assertResetConfirmed(request);
  if (activeResetPromise) return activeResetPromise;

  activeResetPromise = (async () => {
    const nonce = randomResetNonce();
    setResetConfirmationCookie(nonce);
    await stopCurrentRuntimeActivity();
    await requestOtherTabsShutdown();
    await sleep(RESET_TAB_SETTLE_MS);
    window.location.replace(buildResetDbUrl(nonce));
  })();

  return activeResetPromise;
}
