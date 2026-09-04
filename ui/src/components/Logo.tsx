/**
 * The xln mark: a pyramid cut into three layers, the trilayer (Runtime, Entity,
 * Account) standing on the jurisdiction. Vector geometry traced from the
 * original raster in frontend/static/img/logo.png; fills `currentColor`, so it
 * takes the accent, the text colour or white as the surface needs.
 *
 * `lit` paints one layer in the accent: the Home hero lights the bottom layer
 * when a frame commits, the Gate lights none.
 */
export const LOGO_PATH =
	'M1052 3 L2104 1832 L0 1832 Z ' +
	'M1052 274 L1260 636 L844 636 Z ' +
	'M766 771 L1338 771 L1566 1167 L538 1167 Z ' +
	'M461 1301 L1643 1301 L1871 1697 L233 1697 Z';

const LAYERS = [
	'M1052 274 L1260 636 L844 636 Z',
	'M766 771 L1338 771 L1566 1167 L538 1167 Z',
	'M461 1301 L1643 1301 L1871 1697 L233 1697 Z',
];

export function Logo({ size = 24, lit, className, title = 'xln' }: { size?: number; lit?: 0 | 1 | 2; className?: string; title?: string }) {
	const height = Math.round((size * 1833) / 2104);
	return (
		<svg width={size} height={height} viewBox="0 0 2104 1833" className={className} role="img" aria-label={title} data-testid="logo">
			<path d={LOGO_PATH} fill="currentColor" fillRule="evenodd" />
			{lit !== undefined ? <path d={LAYERS[lit]} className="logo-lit" fill="var(--accent)" /> : null}
		</svg>
	);
}
