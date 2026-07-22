const paymentHashPath = (parsed: URL): string => {
	const pathname = parsed.pathname.replace(/^\/+/, '').trim();
	const params = new URLSearchParams(parsed.search);
	if (pathname && !params.has('target')) params.set('target', pathname);
	const target = String(params.get('target') || '').trim();
	if (!target) return `/app#pay${parsed.search}`;
	params.delete('target');
	const invoice = params.size > 0 ? `${target}?${params.toString()}` : target;
	return `/app#pay/${encodeURIComponent(invoice)}`;
};

export const normalizeNativeDeepLinkPath = (url: string): string | null => {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'xln:') return null;
		const host = parsed.hostname.toLowerCase();
		const params = parsed.search || '';
		if (host === 'pay' || host === 'invoice') return paymentHashPath(parsed);
		if (host === 'runtime') return `/app#runtime${params}`;
		if (host === 'app') {
			const appPath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
			return `/app${appPath}${params}${parsed.hash || ''}`;
		}
		return `/app#${host}${params}`;
	} catch {
		return null;
	}
};
