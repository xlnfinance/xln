import { locales } from './locales.js';
import { resolveLanguage } from './language.js';

const language = document.querySelector('#language');
let current = 'en';
const translate = (key) => locales[current][key] ?? locales.en[key];
function setLanguage(value) {
  current = resolveLanguage(value);
  document.documentElement.lang = current;
  language.value = current;
  language.setAttribute('aria-label', translate('language'));
  document.title = translate('title');
  const description = `${translate('thesis')} ${translate('explain')}`;
  document.querySelector('meta[name="description"]').content = description;
  document.querySelector('meta[property="og:description"]').content = description;
  document.querySelector('meta[property="og:title"]').content = translate('title');
  for (const node of document.querySelectorAll('[data-i18n-label]')) {
    node.setAttribute('aria-label', translate(node.dataset.i18nLabel));
  }
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = translate(node.dataset.i18n);
  }
}
let saved;
try { saved = localStorage.getItem('brainvault-language'); } catch { /* Storage may be disabled; the page remains usable. */ }
setLanguage(resolveLanguage(saved, navigator.languages));
language.addEventListener('change', () => {
  setLanguage(language.value);
  try { localStorage.setItem('brainvault-language', current); } catch { /* Keep the choice for this page when storage is unavailable. */ }
});

const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#nav');

menuButton?.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  navigation?.classList.toggle('open', !isOpen);
});

navigation?.addEventListener('click', (event) => {
  if (!(event.target instanceof HTMLAnchorElement)) {
    return;
  }
  menuButton?.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('open');
});

const installTabs = Array.from(document.querySelectorAll('[data-install-tab]'));

function selectInstallTab(tab) {
  const selected = tab.getAttribute('data-install-tab');
  for (const candidate of installTabs) {
    candidate.setAttribute('aria-selected', String(candidate === tab));
    candidate.tabIndex = candidate === tab ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('[data-install-panel]')) {
    panel.hidden = panel.getAttribute('data-install-panel') !== selected;
  }
}

for (const tab of installTabs) {
  tab.addEventListener('click', () => selectInstallTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = installTabs[(installTabs.indexOf(tab) + offset + installTabs.length) % installTabs.length];
    next?.focus();
    if (next) {
      selectInstallTab(next);
    }
  });
}

for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const target = document.querySelector(button.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.textContent = translate('copied');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = translate('select');
    }
    window.setTimeout(() => { button.textContent = translate(button.dataset.i18n); }, 2000);
  });
}

const demoVideo = document.querySelector('.demo-frame video');
if (demoVideo instanceof HTMLVideoElement && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  demoVideo.autoplay = false;
  demoVideo.pause();
}

const year = document.querySelector('#year');
if (year) {
  year.textContent = String(new Date().getFullYear());
}
