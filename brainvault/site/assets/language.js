import { locales } from './locales.js';

export function resolveLanguage(saved, preferred = []) {
  for (const value of [saved, ...preferred]) {
    if (typeof value !== 'string') continue;
    const code = value.toLowerCase().split('-')[0];
    if (Object.hasOwn(locales, code)) return code;
  }
  return 'en';
}
