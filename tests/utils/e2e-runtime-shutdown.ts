import type { BrowserContext, Page } from '@playwright/test';

type RuntimeDebugSurface = {
  vault?: {
    suspendAllRuntimeActivity?: () => Promise<void>;
  };
};

const LOCAL_RUNTIME_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const wrappedRuntimeContexts = new Set<BrowserContext>();
const wrappedRuntimePages = new Set<Page>();
const quiescedRuntimePages = new Set<Page>();

const isLocalRuntimePage = (page: Page): boolean => {
  try {
    return LOCAL_RUNTIME_HOSTS.has(new URL(page.url()).hostname);
  } catch {
    return false;
  }
};

/** Close application-owned sockets before Playwright tears down their TCP transport. */
export async function quiesceRuntimePage(page: Page): Promise<'quiesced' | 'no-runtime'> {
  if (page.isClosed()) return 'no-runtime';
  if (!isLocalRuntimePage(page)) return 'no-runtime';
  if (quiescedRuntimePages.has(page)) return 'quiesced';
  const result = await page.evaluate(async () => {
    const target = window as typeof window & {
      __xln?: RuntimeDebugSurface;
      isolatedEnv?: unknown;
    };
    if (!target.isolatedEnv) return 'no-runtime' as const;
    const suspend = target.__xln?.vault?.suspendAllRuntimeActivity;
    if (typeof suspend !== 'function') {
      throw new Error('E2E_RUNTIME_SHUTDOWN_SURFACE_MISSING');
    }
    await suspend();
    return 'quiesced' as const;
  });
  if (result === 'quiesced') {
    quiescedRuntimePages.add(page);
    page.once('close', () => quiescedRuntimePages.delete(page));
  }
  return result;
}

/** A reload creates a fresh runtime document, so its shutdown fence must be armed again. */
export function resetRuntimePageQuiescence(page: Page): void {
  quiescedRuntimePages.delete(page);
}

/** Make every Playwright close path honor the application shutdown contract. */
export function wrapRuntimeContextClose(context: BrowserContext): void {
  if (wrappedRuntimeContexts.has(context)) return;
  wrappedRuntimeContexts.add(context);
  context.once('close', () => wrappedRuntimeContexts.delete(context));
  const close = context.close.bind(context);
  context.close = (async (...args: Parameters<BrowserContext['close']>) => {
    for (const page of context.pages()) await quiesceRuntimePage(page);
    await close(...args);
  }) as BrowserContext['close'];
}

/** Make direct page.close() honor the same shutdown contract as context.close(). */
export function wrapRuntimePageClose(page: Page): void {
  if (wrappedRuntimePages.has(page)) return;
  wrappedRuntimePages.add(page);
  page.once('close', () => wrappedRuntimePages.delete(page));
  const close = page.close.bind(page);
  page.close = (async (...args: Parameters<Page['close']>) => {
    await quiesceRuntimePage(page);
    await close(...args);
  }) as Page['close'];
}

export async function closeRuntimePage(page: Page): Promise<void> {
  wrapRuntimePageClose(page);
  await page.close();
}

export async function closeRuntimeContext(context: BrowserContext): Promise<void> {
  wrapRuntimeContextClose(context);
  await context.close();
}
