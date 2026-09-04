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

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const value = button.getAttribute('data-copy');
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = 'Copy';
      }, 1500);
    } catch {
      button.textContent = 'Select';
    }
  });
}

for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const selector = button.getAttribute('data-copy-target');
    const target = selector ? document.querySelector(selector) : null;
    const value = target?.textContent?.trim();
    if (!value) {
      return;
    }

    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = label;
      }, 1500);
    } catch {
      button.textContent = 'Select prompt';
    }
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
