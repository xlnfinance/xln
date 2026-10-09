import { describe, expect, test } from 'bun:test';
import { locales } from './assets/locales.js';
import { resolveLanguage } from './assets/language.js';

describe('public language selection', () => {
  test('all ten languages cover every visible label and recovery instruction', async () => {
    expect(Object.keys(locales).sort()).toEqual(['de','en','es','fr','ja','ko','pt','ru','tr','zh']);
    const keys = Object.keys(locales.en).sort();
    const html = await Bun.file(`${import.meta.dir}/index.html`).text();
    for (const dictionary of Object.values(locales)) {
      expect(Object.keys(dictionary).sort()).toEqual(keys);
      for (const value of Object.values(dictionary)) expect(value.trim().length).toBeGreaterThan(0);
      expect(dictionary.wallets).toContain('BIP-39');
      expect(dictionary.auditText).toContain('--ignore-scripts');
    }
    for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) expect(keys).toContain(key);
  });
  test('explicit choice wins; unsupported preferences fall through to supported browser language', () => {
    expect(resolveLanguage('ru', ['de-DE'])).toBe('ru');
    expect(resolveLanguage('unknown', ['ar', 'pt-BR'])).toBe('pt');
    expect(resolveLanguage(null, ['zh-Hant-TW'])).toBe('zh');
    expect(resolveLanguage(null, ['JA-jp'])).toBe('ja');
    expect(resolveLanguage('__proto__', ['constructor'])).toBe('en');
    expect(resolveLanguage(null, [])).toBe('en');
  });
});
