/**
 * Design presets. Four independent axes, each a `data-*` attribute on <html>
 * that the token sheet reacts to, so a preset costs one attribute and zero
 * re-renders. Persisted per device; the inline script in index.html restores
 * them before first paint so nothing flashes.
 */
export type Material = 'obsidian' | 'bank' | 'terminal';
export type Accent = 'indigo' | 'mono' | 'brass' | 'custom';
export type NumberFont = 'sans' | 'serif' | 'tight';
export type RiskColor = 'violet' | 'red' | 'orange';

export type DesignPrefs = {
	material: Material;
	accent: Accent;
	/** Hex like #6e7cff, used when accent = custom. */
	accentHex: string;
	numbers: NumberFont;
	risk: RiskColor;
};

export const DESIGN_KEY = 'xln-ui-design';

export const DEFAULT_DESIGN: DesignPrefs = { material: 'obsidian', accent: 'indigo', accentHex: '#6e7cff', numbers: 'sans', risk: 'violet' };

export const MATERIALS: Array<{ id: Material; title: string; hint: string }> = [
	{ id: 'obsidian', title: 'Obsidian', hint: 'Matte black, two surfaces, hairlines. Light theme is paper.' },
	{ id: 'bank', title: 'Private bank', hint: 'Warm off-white first, ink on paper. Dark theme is charcoal.' },
	{ id: 'terminal', title: 'Terminal', hint: 'Graphite, phosphor green, numbers in mono everywhere.' },
];

export const ACCENTS: Array<{ id: Accent; title: string; hint: string; swatch: string }> = [
	{ id: 'indigo', title: 'Indigo', hint: 'Buttons and links in one calm blue.', swatch: '#6e7cff' },
	{ id: 'mono', title: 'Monochrome', hint: 'Ink on ink. The only colors left are the money.', swatch: '#ecedef' },
	{ id: 'brass', title: 'Brass', hint: 'Warm metal. Expensive, close to the edge.', swatch: '#c9a962' },
	{ id: 'custom', title: 'Custom', hint: 'Any hex you like.', swatch: '' },
];

export const NUMBER_FONTS: Array<{ id: NumberFont; title: string; hint: string; family: string; google: string | null }> = [
	{ id: 'sans', title: 'Sans', hint: 'Instrument Sans. Clean, safe.', family: "'Instrument Sans', -apple-system, BlinkMacSystemFont, sans-serif", google: null },
	{ id: 'serif', title: 'Serif', hint: 'Fraunces for sums. A fortune, not a balance.', family: "'Fraunces', 'Iowan Old Style', Georgia, serif", google: 'Fraunces:opsz,wght@9..144,500;9..144,600' },
	{ id: 'tight', title: 'Tight', hint: 'Inter Tight. Dense, fast, tabular.', family: "'Inter Tight', 'Inter', -apple-system, sans-serif", google: 'Inter+Tight:wght@500;600;700' },
];

export const RISK_COLORS: Array<{ id: RiskColor; title: string; hint: string; swatch: string }> = [
	{ id: 'violet', title: 'Violet', hint: 'Risk is trust, not alarm. Red stays for disputes.', swatch: '#a78bfa' },
	{ id: 'red', title: 'Red', hint: 'Hurts on sight. Same color as a dispute.', swatch: '#f26d6d' },
	{ id: 'orange', title: 'Orange', hint: 'Warm spectrum: obligations amber, exposure orange.', swatch: '#fb923c' },
];

const isHex = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);

export function readDesign(): DesignPrefs {
	try {
		const raw = localStorage.getItem(DESIGN_KEY);
		if (!raw) return DEFAULT_DESIGN;
		const parsed = JSON.parse(raw) as Partial<DesignPrefs>;
		return {
			material: MATERIALS.some(entry => entry.id === parsed.material) ? (parsed.material as Material) : DEFAULT_DESIGN.material,
			accent: ACCENTS.some(entry => entry.id === parsed.accent) ? (parsed.accent as Accent) : DEFAULT_DESIGN.accent,
			accentHex: typeof parsed.accentHex === 'string' && isHex(parsed.accentHex) ? parsed.accentHex.toLowerCase() : DEFAULT_DESIGN.accentHex,
			numbers: NUMBER_FONTS.some(entry => entry.id === parsed.numbers) ? (parsed.numbers as NumberFont) : DEFAULT_DESIGN.numbers,
			risk: RISK_COLORS.some(entry => entry.id === parsed.risk) ? (parsed.risk as RiskColor) : DEFAULT_DESIGN.risk,
		};
	} catch {
		return DEFAULT_DESIGN;
	}
}

/** Mix a hex with black or white; enough for the two derived accent tones. */
function mix(hex: string, target: 0 | 255, weight: number): string {
	const channel = (index: number): string => {
		const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
		return Math.round(value + (target - value) * weight)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function rgba(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const loadedFonts = new Set<string>();

/** Fonts beyond the default pair load only when a preset asks for them. */
function ensureFont(google: string | null): void {
	if (!google || loadedFonts.has(google)) return;
	loadedFonts.add(google);
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = `https://fonts.googleapis.com/css2?family=${google}&display=swap`;
	document.head.appendChild(link);
}

export function applyDesign(prefs: DesignPrefs): void {
	const root = document.documentElement;
	root.dataset['material'] = prefs.material;
	root.dataset['accent'] = prefs.accent;
	root.dataset['numbers'] = prefs.numbers;
	root.dataset['risk'] = prefs.risk;
	const font = NUMBER_FONTS.find(entry => entry.id === prefs.numbers) ?? NUMBER_FONTS[0]!;
	ensureFont(font.google);
	root.style.setProperty('--font-num', font.family);
	if (prefs.accent === 'custom' && isHex(prefs.accentHex)) {
		const hex = prefs.accentHex.toLowerCase();
		root.style.setProperty('--accent', hex);
		root.style.setProperty('--accent-2', mix(hex, 255, 0.25));
		root.style.setProperty('--accent-dim', rgba(hex, 0.16));
		root.style.setProperty('--credit', hex);
		// Dark accents want white button ink, light ones black.
		const luma = 0.299 * parseInt(hex.slice(1, 3), 16) + 0.587 * parseInt(hex.slice(3, 5), 16) + 0.114 * parseInt(hex.slice(5, 7), 16);
		root.style.setProperty('--btn-ink', luma > 160 ? '#0b0d12' : '#ffffff');
	} else {
		for (const name of ['--accent', '--accent-2', '--accent-dim', '--credit', '--btn-ink']) root.style.removeProperty(name);
	}
}

export function saveDesign(prefs: DesignPrefs): void {
	localStorage.setItem(DESIGN_KEY, JSON.stringify(prefs));
	applyDesign(prefs);
}
