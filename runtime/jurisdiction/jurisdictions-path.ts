export function resolveJurisdictionsJsonPath(): string {
  const overridePath =
    typeof process !== 'undefined' && typeof process.env['XLN_JURISDICTIONS_PATH'] === 'string'
      ? process.env['XLN_JURISDICTIONS_PATH'].trim()
      : '';
  const fileUrl = overridePath.length > 0
    ? new URL(overridePath, new URL(`file://${process.cwd()}/`))
    : new URL('../../jurisdictions/jurisdictions.json', import.meta.url);
  return decodeURIComponent(fileUrl.pathname);
}
