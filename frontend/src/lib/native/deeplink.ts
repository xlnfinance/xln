export const normalizeNativeDeepLinkPath = (url: string): string | null => {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'xln:') return null;
		const host = parsed.hostname.toLowerCase();
		const params = parsed.search || '';
		if (host === 'pay') return `/app#pay${params}`;
		if (host === 'invoice') return `/app#invoice${params}`;
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
