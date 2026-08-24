import { describe, expect, test } from 'bun:test';

import {
  INSTALL_CHANNELS,
  LOCAL_RUNTIME_COMMAND,
  getSiteMetadata,
  resolveSitePage,
} from '../../../frontend/apps/site/src/site-model';
import packageJson from '../../../frontend/package.json';

describe('React site pilot', () => {
  test('resolves the five migrated site routes', () => {
    expect(resolveSitePage('/')).toEqual({ kind: 'home' });
    expect(resolveSitePage('/install')).toEqual({ kind: 'install' });
    expect(resolveSitePage('/install/')).toEqual({ kind: 'install' });
    expect(resolveSitePage('/rcpan')).toEqual({ kind: 'rcpan' });
    expect(resolveSitePage('/rcpan/')).toEqual({ kind: 'rcpan' });
    expect(resolveSitePage('/unicast')).toEqual({ kind: 'unicast' });
    expect(resolveSitePage('/unicast/')).toEqual({ kind: 'unicast' });
    expect(resolveSitePage('/releases')).toEqual({ kind: 'releases' });
    expect(resolveSitePage('/releases/')).toEqual({ kind: 'releases' });
    expect(resolveSitePage('/market-cap')).toEqual({ kind: 'pending', pathname: '/market-cap' });
    expect(() => resolveSitePage('install')).toThrow('SITE_PATHNAME_INVALID');
  });

  test('publishes route-specific document metadata', () => {
    expect(getSiteMetadata(resolveSitePage('/')).title).toBe('xln — cross-local network');
    expect(getSiteMetadata(resolveSitePage('/install')).description).toContain('persistent local runtime');
    expect(getSiteMetadata(resolveSitePage('/rcpan')).title).toBe('RCPAN — provable bilateral accounts | xln');
    expect(getSiteMetadata(resolveSitePage('/rcpan')).description).toContain('bounded counterparty risk');
    expect(getSiteMetadata(resolveSitePage('/unicast')).title).toBe('Why broadcast dies at scale | xln');
    expect(getSiteMetadata(resolveSitePage('/unicast')).description).toContain('O(1) unicast routing');
    expect(getSiteMetadata(resolveSitePage('/releases')).title).toBe('Releases | xln');
    expect(getSiteMetadata(resolveSitePage('/releases')).description).toContain('verified codebase metrics');
    expect(getSiteMetadata(resolveSitePage('/reviews')).title).toContain('migration candidate');
  });

  test('keeps the local launcher version-pinned to the frontend release', () => {
    expect(LOCAL_RUNTIME_COMMAND).toContain(`/v${packageJson.version}/`);
    expect(LOCAL_RUNTIME_COMMAND).toEndWith(`xlnfinance-${packageJson.version}.tgz`);
    expect(INSTALL_CHANNELS.find(({ id }) => id === 'cli')?.command).toBe(LOCAL_RUNTIME_COMMAND);
  });

  test('preserves all five install channels and their authority boundaries', () => {
    expect(INSTALL_CHANNELS.map(({ id }) => id)).toEqual([
      'cli',
      'web',
      'desktop',
      'mobile',
      'extension',
    ]);
    expect(INSTALL_CHANNELS.find(({ id }) => id === 'web')?.href).toBe('/app');
    expect(INSTALL_CHANNELS.filter(({ href }) => href.startsWith('https://'))).toHaveLength(4);
    expect(INSTALL_CHANNELS.every(({ benefit, tradeoff }) => benefit.length > 0 && tradeoff.length > 0)).toBe(true);
  });
});
