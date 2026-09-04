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
