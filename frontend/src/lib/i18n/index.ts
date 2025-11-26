/**
 * XLN Internationalization System
 * Supports 10 languages for global superapp experience
 */

import { writable, derived, get } from 'svelte/store';

// Static imports for all locales (Vite requires static imports for JSON)
import en from './locales/en.json';
import zh from './locales/zh.json';
import es from './locales/es.json';
import ru from './locales/ru.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import pt from './locales/pt.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import tr from './locales/tr.json';

// Supported locales
export const LOCALES = {
  en: { name: 'English', flag: '🇺🇸' },
  zh: { name: '中文', flag: '🇨🇳' },
  es: { name: 'Español', flag: '🇪🇸' },
  ru: { name: 'Русский', flag: '🇷🇺' },
  ja: { name: '日本語', flag: '🇯🇵' },
  ko: { name: '한국어', flag: '🇰🇷' },
  pt: { name: 'Português', flag: '🇧🇷' },
  de: { name: 'Deutsch', flag: '🇩🇪' },
  fr: { name: 'Français', flag: '🇫🇷' },
  tr: { name: 'Türkçe', flag: '🇹🇷' },
} as const;

export type Locale = keyof typeof LOCALES;

// Translation dictionary type
type TranslationDict = Record<string, string | Record<string, string>>;

// Translations storage - pre-loaded
const translations: Record<Locale, TranslationDict> = {
  en,
  zh,
  es,
  ru,
  ja,
  ko,
  pt,
  de,
  fr,
  tr,
};

// Current locale store
function createLocaleStore() {
  // Try to get saved locale or detect from browser
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('xln-locale') : null;
  const browserLang = typeof navigator !== 'undefined' ? navigator.language.split('-')[0] ?? 'en' : 'en';
  const initial = (saved as Locale) || (browserLang in LOCALES ? browserLang as Locale : 'en');

  const { subscribe, set } = writable<Locale>(initial);

  return {
    subscribe,
    set: (locale: Locale) => {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('xln-locale', locale);
      }
      set(locale);
    },
  };
}

export const locale = createLocaleStore();

// Load translations for a locale (no-op since all are pre-loaded)
export async function loadTranslations(_loc: Locale): Promise<void> {
  // All translations are statically imported - nothing to do
}

// Get nested value from object using dot notation
function getNestedValue(obj: TranslationDict, path: string): string | undefined {
  const keys = path.split('.');
  let current: any = obj;

  for (const key of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }

  return typeof current === 'string' ? current : undefined;
}

// Translation function - use with $t('key') in components
export function t(key: string, params?: Record<string, string | number>): string {
  const currentLocale = get(locale);
  let text = getNestedValue(translations[currentLocale], key);

  // Fallback to English
  if (!text && currentLocale !== 'en') {
    text = getNestedValue(translations.en, key);
  }

  // Return key if no translation found
  if (!text) return key;

  // Replace parameters {name} -> value
  if (params) {
    for (const [param, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${param}\\}`, 'g'), String(value));
    }
  }

  return text;
}

// Reactive translation store for Svelte
export const translations$ = derived(locale, ($locale) => {
  return (key: string, params?: Record<string, string | number>) => t(key, params);
});

// Initialize (no-op since all translations are pre-loaded)
export async function initI18n(): Promise<void> {
  // All translations are statically imported - nothing to do
}
