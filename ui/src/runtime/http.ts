import { useApp } from './store';

/**
 * HTTP origin of the runtime this wallet talks to. A remote vault derives it
 * from the WebSocket URL the way the SvelteKit frontend does; an embedded
 * runtime (sandbox, brainvault, mnemonic) has no server of its own, so the
 * page origin is the only candidate and callers must expect 404s there.
 */
export function resolveApiBase(): string {
	const state = useApp.getState();
	const vault = state.vaults.find(entry => entry.id === state.activeVaultId) ?? null;
	const wsUrl = vault?.remote?.wsUrl;
	if (wsUrl) {
		const parsed = new URL(wsUrl);
		parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
		parsed.pathname = '/';
		parsed.search = '';
		parsed.hash = '';
		return parsed.origin;
	}
	return window.location.origin;
}

const NO_API = 'The runtime has no HTTP API at this address';

export async function readJson(response: Response): Promise<Record<string, unknown>> {
	// A dev server or static host answers unknown paths with the SPA's index.html: that is "no API", not a reply.
	if (!String(response.headers.get('content-type') || '').toLowerCase().includes('json')) throw new Error(NO_API);
	const text = await response.text();
	if (!text.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return { error: text.slice(0, 200) };
	}
}

/** POST a JSON body and return the parsed reply; throws with the server's error text. */
export async function postJson(path: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response: Response;
	try {
		response = await fetch(new URL(path, resolveApiBase()), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (error) {
		const aborted = error instanceof DOMException && error.name === 'AbortError';
		throw new Error(aborted ? `Request timed out after ${timeoutMs} ms` : NO_API);
	} finally {
		clearTimeout(timer);
	}
	const result = await readJson(response);
	if (!response.ok || result['success'] !== true) {
		throw new Error(String(result['error'] || `Request failed (${response.status})`));
	}
	return result;
}

export async function getJson(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
	const url = new URL(path, resolveApiBase());
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	let response: Response;
	try {
		response = await fetch(url, { cache: 'no-store' });
	} catch {
		throw new Error(NO_API);
	}
	const result = await readJson(response);
	if (!response.ok || result['success'] !== true) {
		throw new Error(String(result['error'] || `Request failed (${response.status})`));
	}
	return result;
}
