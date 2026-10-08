import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from './Icons';
import { useApp } from '../runtime/store';
import { useWallet } from '../runtime/views';
import { TOUR_STEPS, type TourContext } from '../tour/steps';

type Rect = { top: number; left: number; width: number; height: number };
const nodeFor = (id: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].find(node => node.getClientRects().length > 0);
const dom: TourContext['dom'] = {
  has: id => Boolean(nodeFor(id)),
  value: id => (nodeFor(id) as HTMLInputElement | undefined)?.value ?? '',
  text: id => nodeFor(id)?.textContent ?? '',
};

/** Small guidance beside the current control; only the user performs actions. */
export function Tour() {
  const tour = useApp(s => s.tour);
  const setTour = useApp(s => s.setTour);
  const entityId = useApp(s => s.activeEntityId);
  const wallet = useWallet(entityId);
  const { pathname } = useLocation();
  const baseline = useRef(new Map<string, number>());
  const entered = useRef('');
  const card = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardHeight, setCardHeight] = useState(150);
  const [menuBottom, setMenuBottom] = useState<number | null>(null);
  const clicked = useRef(new Set<string>());
  const ctx = useMemo(
    () => ({ wallet, pathname, baseline: baseline.current, clicked: clicked.current, dom }),
    [wallet, pathname],
  );
  const index = Math.min(tour.index, TOUR_STEPS.length - 1);
  const step = tour.active ? TOUR_STEPS[index] : undefined;
  const target = step?.target(ctx) ?? '';

  useEffect(() => {
    if (!step) {
      entered.current = '';
      return;
    }
    const key = `${wallet.entityId}:${step.id}`;
    if (entered.current !== key) {
      entered.current = key;
      clicked.current.clear();
      step.enter?.(ctx);
    }
    if (step.done?.(ctx)) setTour({ index: index + 1 });
  }, [step, ctx, index, setTour, tick]);

  useEffect(() => {
    if (!step) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 200);
    // Escape closes an open sheet first; only with nothing open does it leave the guide.
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.sheet')) setTour({ active: false });
    };
    // A click on any test id is recorded for the open step; the step decides whether it was the one that counts.
    const press = (event: MouseEvent) => {
      const id = (event.target as Element | null)?.closest('[data-testid]')?.getAttribute('data-testid');
      if (!id) return;
      clicked.current.add(id);
      setTick(value => value + 1);
    };
    window.addEventListener('keydown', close);
    document.addEventListener('click', press, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', close);
      document.removeEventListener('click', press, true);
    };
  }, [step, setTour]);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    const node = nodeFor(target);
    if (!node) {
      setRect(null);
      return;
    }
    const bounds = node.getBoundingClientRect();
    const menu = document.querySelector<HTMLElement>('.picker-menu');
    setMenuBottom(menu && menu.getClientRects().length > 0 ? menu.getBoundingClientRect().bottom : null);
    const next = { top: bounds.top - 6, left: bounds.left - 6, width: bounds.width + 12, height: bounds.height + 12 };
    setRect(previous =>
      previous && Object.keys(next).every(key => previous[key as keyof Rect] === next[key as keyof Rect])
        ? previous
        : next,
    );
    if (card.current) setCardHeight(card.current.offsetHeight);
  }, [target, tick]);

  useEffect(() => {
    if (!target) return;
    nodeFor(target)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [target]);

  if (!step) return null;
  const width = Math.min(340, window.innerWidth - 24);
  const below = rect ? Math.max(rect.top + rect.height, menuBottom ?? 0) + 14 : 24;
  const above = rect ? rect.top - cardHeight - 14 : -1;
  const fitsAbove = above >= 12;
  const fitsBelow = below + cardHeight <= window.innerHeight - 12;
  // A tall target leaves no room above or below: sit beside it when the screen is wide enough.
  const beside = rect && !fitsAbove && !fitsBelow && rect.left + rect.width + 14 + width <= window.innerWidth - 12;
  const left = !rect
    ? window.innerWidth - width - 12
    : beside
      ? rect.left + rect.width + 14
      : Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const preferred = beside ? (rect?.top ?? 24) : fitsAbove && (menuBottom !== null || !fitsBelow) ? above : below;
  // The card, and its Next button, always stay on screen.
  const top = Math.max(12, Math.min(preferred, window.innerHeight - cardHeight - 12));
  const menuNeedsSpace = menuBottom !== null && !fitsAbove && !fitsBelow;
  const finish = step.id === 'finish';
  const total = TOUR_STEPS.length - 1;
  return (
    <div className="tour" data-testid="tour" data-step={step.id} data-target={target} data-chapter={step.chapter}>
      {rect && <div className={`tour-ring${step.detail ? ' detail' : ''}`} style={rect} />}
      <div
        ref={card}
        className="tour-card anchored"
        style={{
          left,
          top,
          width,
          right: 'auto',
          bottom: 'auto',
          pointerEvents: 'none',
          visibility: menuNeedsSpace ? 'hidden' : 'visible',
        }}
        role="status"
        aria-live="polite"
      >
        <div className="tour-head">
          <span className="tour-kicker">
            {step.chapter} · {Math.min(index + 1, total)} of {total}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Exit the tour"
            data-testid="tour-exit"
            style={{ pointerEvents: 'auto' }}
            onClick={() => setTour({ active: false })}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <h2 className="tour-title">{step.title}</h2>
        <p className="tour-body" data-testid="tour-hint">
          {step.instruction(ctx)}
        </p>
        <div className="tour-progress" aria-hidden>
          <span style={{ width: `${Math.round((Math.min(index, total) / total) * 100)}%` }} />
        </div>
        {step.detail && (
          <button
            type="button"
            className="btn primary sm"
            data-testid="tour-next"
            style={{ pointerEvents: 'auto' }}
            onClick={() => setTour({ index: index + 1 })}
          >
            Next
          </button>
        )}
        {finish && (
          <button
            type="button"
            className="btn primary sm"
            data-testid="tour-next"
            style={{ pointerEvents: 'auto' }}
            onClick={() => setTour({ active: false, index: 0, completed: true })}
          >
            Finish
          </button>
        )}
      </div>
    </div>
  );
}
