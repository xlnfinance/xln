/**
 * Token Color Utilities
 *
 * Deterministic color generation from token symbols with localStorage override support
 */

/**
 * Generate deterministic color from token symbol using djb2 hash
 * @param symbol - Token symbol (e.g., "USDC", "ETH")
 * @returns Hex color number (e.g., 0x2775ca)
 */
export function hashSymbolToColor(symbol: string): number {
  // djb2 hash algorithm (fast, good distribution)
  let hash = 5381;
  for (let i = 0; i < symbol.length; i++) {
    hash = ((hash << 5) + hash) + symbol.charCodeAt(i);
  }

  // Map to RGB (use modulo to get good saturation/brightness)
  const r = (hash & 0xFF0000) >> 16;
  const g = (hash & 0x00FF00) >> 8;
  const b = (hash & 0x0000FF);

  // Boost saturation: ensure at least one channel is >128
  const max = Math.max(r, g, b);
  if (max < 128) {
    const boost = 200;
    return ((Math.min(r + boost, 255) << 16) |
            (Math.min(g + boost, 255) << 8) |
            Math.min(b + boost, 255));
  }

  return (r << 16) | (g << 8) | b;
}

/**
 * Derive credit color from collateral color (lighter/desaturated)
 * Visual cue: credit = less secure than collateral
 *
 * @param collateralColor - Base color for collateral
 * @returns Lighter color for credit (50% toward white)
 */
export function deriveCreditColor(collateralColor: number): number {
  const r = (collateralColor >> 16) & 0xFF;
  const g = (collateralColor >> 8) & 0xFF;
  const b = collateralColor & 0xFF;

  // Lighten by interpolating toward white (192,192,192)
  const mix = 0.5; // 50% lighter
  const newR = Math.floor(r + (192 - r) * mix);
  const newG = Math.floor(g + (192 - g) * mix);
  const newB = Math.floor(b + (192 - b) * mix);

  return (newR << 16) | (newG << 8) | newB;
}

/**
 * Get token colors with localStorage override support
 *
 * @param tokenId - Token ID
 * @param symbol - Token symbol for hash-based generation
 * @returns Object with collateral and credit colors
 */
export function getTokenColor(tokenId: number, symbol: string): { collateral: number; credit: number } {
  // Check localStorage for manual override
  const overrideKey = `tokenColor_${tokenId}`;
  const override = localStorage.getItem(overrideKey);

  if (override) {
    const parsed = parseInt(override.replace('#', ''), 16);
    return {
      collateral: parsed,
      credit: deriveCreditColor(parsed)
    };
  }

  // Use hash-based default
  const baseColor = hashSymbolToColor(symbol);
  return {
    collateral: baseColor,
    credit: deriveCreditColor(baseColor)
  };
}
