const RANGE_SELECTOR = 'input[type="range"]';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function syncRangeSliderProgress(input: HTMLInputElement): void {
  if (input.type !== 'range') return;
  const min = Number.isFinite(Number(input.min)) ? Number(input.min) : 0;
  const max = Number.isFinite(Number(input.max)) ? Number(input.max) : 100;
  const value = Number.isFinite(Number(input.value)) ? Number(input.value) : min;
  const span = max - min;
  const progress = span > 0 ? ((value - min) / span) * 100 : 0;
  input.style.setProperty('--xln-slider-progress', `${clamp(progress, 0, 100)}%`);
}

export function installRangeSliderProgress(): () => void {
  if (typeof document === 'undefined') return () => undefined;

  const syncAll = () => {
    document.querySelectorAll<HTMLInputElement>(RANGE_SELECTOR).forEach(syncRangeSliderProgress);
  };

  const syncTarget = (target: EventTarget | null) => {
    if (target instanceof HTMLInputElement && target.type === 'range') {
      syncRangeSliderProgress(target);
    }
  };

  const onInput = (event: Event) => {
    syncTarget(event.target);
  };

  syncAll();
  const frameId = requestAnimationFrame(syncAll);

  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        syncTarget(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLInputElement && node.type === 'range') {
          syncRangeSliderProgress(node);
          continue;
        }
        if (node instanceof Element) {
          node.querySelectorAll<HTMLInputElement>(RANGE_SELECTOR).forEach(syncRangeSliderProgress);
        }
      }
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['value', 'min', 'max'],
    });
  }

  return () => {
    cancelAnimationFrame(frameId);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onInput, true);
    observer.disconnect();
  };
}
