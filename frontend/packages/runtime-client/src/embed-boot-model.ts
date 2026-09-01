// Pure boot contract for the embeddable workspace demo, extracted from the
// canonical Svelte /embed route so the React workspace consumes the identical
// URL semantics. No I/O: the route injects the URL, the model decides.

export type EmbedBootRequest =
  | Readonly<{ kind: 'plain' }>
  | Readonly<{ kind: 'trail'; encodedTrail: string; autoplay: boolean; speed: number }>
  | Readonly<{ kind: 'scenario'; scenario: string; autoplay: boolean; speed: number }>;

export const EMBED_TITLE_BASE = 'xln';
export const EMBED_WORKSPACE_TITLE = 'Embedded Workspace';

const trimmedQuery = (url: URL, key: string): string => url.searchParams.get(key)?.trim() ?? '';

const encodedTrailFromHash = (url: URL): string =>
  new URLSearchParams(url.hash.replace(/^#/, '')).get('trail')?.trim() ?? '';

// Canonical quirk kept deliberately: `Number(value || 1) || 1` maps an absent,
// unusable, or zero speed to 1× rather than rejecting the embed.
const playbackSpeed = (url: URL): number => Number(url.searchParams.get('speed') || 1) || 1;

export const parseEmbedBootRequest = (url: URL): EmbedBootRequest => {
  const autoplay = url.searchParams.get('autoplay') === '1';
  const speed = playbackSpeed(url);
  const encodedTrail = encodedTrailFromHash(url);
  // A recorded trail wins: it is exact, and it does not need a runtime to replay.
  if (encodedTrail) return { kind: 'trail', encodedTrail, autoplay, speed };
  const scenario = trimmedQuery(url, 'scenario');
  if (scenario) return { kind: 'scenario', scenario, autoplay, speed };
  return { kind: 'plain' };
};

export const embedBootTitle = (request: EmbedBootRequest, base = EMBED_TITLE_BASE): string =>
  `${base} — ${request.kind === 'scenario' ? `${request.scenario} scenario` : EMBED_WORKSPACE_TITLE}`;

export const embedBootErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'demo failed');
