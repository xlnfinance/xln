import path from 'path';

export function resolveJurisdictionsJsonPath(): string {
  const overridePath =
    typeof process !== 'undefined' && typeof process.env.XLN_JURISDICTIONS_PATH === 'string'
      ? process.env.XLN_JURISDICTIONS_PATH.trim()
      : '';
  if (overridePath.length > 0) return path.resolve(overridePath);
  const canonicalUrl = new URL('../jurisdictions/jurisdictions.json', import.meta.url);
  return path.resolve(decodeURIComponent(canonicalUrl.pathname));
}
