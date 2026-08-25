/**
 * Whether this process runs the Account layer authoritatively.
 *
 * Kept apart from the provider so the driver can ask without importing the
 * executor it installs.
 */
export const authorityCutoverEnabled = (): boolean =>
  typeof process !== 'undefined'
  && process.env?.['XLN_RSCORE_AUTHORITY_CUTOVER'] === '1'
  && process.env?.['XLN_RSCORE_AUTHORITY'] === '1';
