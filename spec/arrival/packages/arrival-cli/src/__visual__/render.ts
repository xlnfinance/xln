/**
 * Rasterize the SVG twin. Prefers `@resvg/resvg-js` (no browser); falls back to
 * `sharp` if that's what the host has. Missing both → no PNG, HTML/SVG still write.
 */
export async function svgToPng(svg: string): Promise<Uint8Array | undefined> {
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    return new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
  } catch {
    try {
      const sharp = (await import("sharp")).default;
      return await sharp(Buffer.from(svg)).png().toBuffer();
    } catch {
      return undefined;
    }
  }
}
