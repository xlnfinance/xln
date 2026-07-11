import type { XlnAssistantMessage } from './xln-assistant-client';

type DocsEntry = Readonly<{
  id: string;
  path: string;
  title: string;
  summary: string;
  kind: string;
}>;

type DocsManifest = Readonly<{ items?: readonly DocsEntry[] }>;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'can', 'does', 'for', 'from', 'how', 'into',
  'the', 'this', 'what', 'when', 'where', 'why', 'with', 'как', 'что', 'это', 'для', 'или', 'про',
  'при', 'где', 'когда', 'зачем', 'почему', 'работает', 'работать', 'расскажи', 'объясни',
]);

const ROUTE_HINTS: Record<string, readonly string[]> = {
  '/app': ['intro', 'core/12_invariant', 'architecture/bilaterality', 'core/11_jurisdiction_machine'],
  '/rcpan': ['intro', 'core/12_invariant', 'architecture/bilaterality', 'architecture/why-evm'],
};

function tokens(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter(token => token.length > 2 && !STOP_WORDS.has(token));
}

export function rankXlnGuideDocs(
  query: string,
  pathname: string,
  entries: readonly DocsEntry[],
  limit = 2,
): DocsEntry[] {
  const queryTokens = tokens(query);
  const hints = ROUTE_HINTS[pathname] ?? ROUTE_HINTS['/app']!;
  return entries
    .filter(entry => entry.kind === 'live')
    .map(entry => {
      const title = entry.title.toLocaleLowerCase();
      const summary = entry.summary.toLocaleLowerCase();
      const path = entry.path.toLocaleLowerCase();
      const tokenScore = queryTokens.reduce((score, token) =>
        score + (title.includes(token) ? 5 : 0) + (summary.includes(token) ? 2 : 0) + (path.includes(token) ? 3 : 0), 0);
      const hintIndex = hints.findIndex(hint => entry.id.toLocaleLowerCase().includes(hint));
      return { entry, score: tokenScore + (hintIndex >= 0 ? 4 - Math.min(hintIndex, 3) : 0) };
    })
    .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
    .slice(0, Math.max(1, limit))
    .map(item => item.entry);
}

function routeDescription(pathname: string): string {
  if (pathname.startsWith('/app')) {
    return 'The user is inside the xln wallet workspace with entities, bilateral account machines, reserves, collateral, credit and Jurisdiction machines.';
  }
  if (pathname.startsWith('/rcpan')) {
    return 'The user is viewing the RCPAN dispute microscope comparing FCUAN and provable reserve-credit accounts.';
  }
  return `The user is viewing the xln surface at ${pathname}.`;
}

function docsUrl(path: string): string {
  return `/docs-catalog/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export async function loadXlnGuideGrounding(query: string, pathname: string, signal?: AbortSignal): Promise<string> {
  const manifestResponse = await fetch('/docs-catalog/manifest.json', {
    cache: 'force-cache',
    ...(signal ? { signal } : {}),
  });
  if (!manifestResponse.ok) {
    throw new Error(`XLN docs manifest is unavailable (${manifestResponse.status}).`);
  }
  const manifest = await manifestResponse.json() as DocsManifest;
  const ranked = rankXlnGuideDocs(query, pathname, manifest.items ?? []);
  if (ranked.length === 0) throw new Error('XLN docs catalog has no live guide sources.');
  const documents = await Promise.all(ranked.map(async entry => {
    const response = await fetch(docsUrl(entry.path), {
      cache: 'force-cache',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`XLN guide source is unavailable (${response.status}): ${entry.title}`);
    const text = (await response.text()).slice(0, 2_800);
    return `SOURCE: ${entry.title}\nDOC: /docs?doc=${encodeURIComponent(entry.id)}\n${text}`;
  }));
  const grounding = documents.filter(Boolean).join('\n\n---\n\n').slice(0, 6_200);
  if (!grounding) throw new Error('XLN guide sources are empty.');
  return grounding;
}

export async function buildXlnGuideMessages(input: Readonly<{
  query: string;
  pathname: string;
  history: readonly XlnAssistantMessage[];
  signal?: AbortSignal;
}>): Promise<XlnAssistantMessage[]> {
  const grounding = await loadXlnGuideGrounding(input.query, input.pathname, input.signal);
  const system = [
    'You are the compact xln guide embedded in the xln application.',
    'Reply in the user\'s language. Be direct and normally stay under 180 words.',
    'Explain; never claim that you executed a payment, dispute, signature or state change.',
    'Use only the supplied xln documentation for protocol-specific claims. If it is insufficient, say so and point to Docs.',
    'Never request or expose seeds, private keys, signatures, auth tokens or full runtime state.',
    routeDescription(input.pathname),
    grounding ? `\nTRUSTED XLN DOCUMENTATION\n${grounding}` : '',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, ...input.history.slice(-10), { role: 'user', content: input.query }];
}

export function suggestedXlnGuideQuestions(pathname: string): string[] {
  if (pathname.startsWith('/rcpan')) return ['Why is RCPAN safer?', 'Walk me through a dispute', 'What does collateral protect?'];
  return ['What am I looking at?', 'How do account machines work?', 'Explain reserves vs collateral'];
}
