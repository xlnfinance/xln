import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icons';
import { useApp } from '../runtime/store';
import { useWallet } from '../runtime/views';
import { TOUR_STEPS, type TourContext } from '../tour/steps';

const nodeFor = (id: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].find(node => node.getClientRects().length > 0);
const dom: TourContext['dom'] = {
  has: id => Boolean(nodeFor(id)),
  value: id => (nodeFor(id) as HTMLInputElement | undefined)?.value ?? '',
  text: id => nodeFor(id)?.textContent ?? '',
};

/** Guidance stays in page flow: it never covers controls, moves focus, or signs on the user's behalf. */
export function Tour() {
  const navigate = useNavigate();
  const tour = useApp(s => s.tour);
  const setTour = useApp(s => s.setTour);
  const wallet = useWallet(useApp(s => s.activeEntityId));
  const { pathname } = useLocation();
  const baseline = useRef(new Map<string, bigint>());
  const entered = useRef('');
  const [tick, setTick] = useState(0);
  const ctx = useMemo(() => ({ wallet, pathname, baseline: baseline.current, dom }), [wallet, pathname]);
  const index = Math.max(0, Math.min(tour.index, TOUR_STEPS.length - 1));
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
      step.enter?.(ctx);
    }
    if (step.done?.(ctx)) setTour({ index: index + 1 });
  }, [step, ctx, index, setTour, tick]);

  useEffect(() => {
    if (!step) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 200);
    return () => clearInterval(timer);
  }, [step]);

  useEffect(() => {
    if (step?.route) navigate(step.route(ctx));
  }, [step]);

  useEffect(() => {
    if (!target) return;
    const node = nodeFor(target);
    node?.classList.add('tutorial-target');
    return () => node?.classList.remove('tutorial-target');
  }, [target, pathname, tick]);

  if (!step) return null;
  const finish = step.id === 'finish';
  return (
    <section
      className="tour tour-inline"
      data-testid="tour"
      data-step={step.id}
      data-target={target}
      aria-label="Wallet tutorial"
    >
      <div className="tour-card anchored">
        <div className="tour-head">
          <label className="tour-chapters">
            <span className="tour-kicker">
              Tutorial · {Math.min(index + 1, TOUR_STEPS.length - 1)} / {TOUR_STEPS.length - 1}
            </span>
            <select
              aria-label="Tutorial chapter"
              data-testid="tour-chapter"
              value={step.id}
              onChange={event => setTour({ index: TOUR_STEPS.findIndex(chapter => chapter.id === event.target.value) })}
            >
              {TOUR_STEPS.map((chapter, i) => (
                <option key={chapter.id} value={chapter.id}>
                  {chapter.id === 'finish' ? 'Finish' : `${i + 1}.`} {chapter.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="icon-btn"
            aria-label="Pause tutorial"
            data-testid="tour-exit"
            onClick={() => setTour({ active: false })}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        {step.value && (
          <p className="tour-value" data-testid="tour-value">
            {step.value}
          </p>
        )}
        {step.prerequisite && <p className="note" data-testid="tour-prerequisite"><strong>Before you start: </strong>{step.prerequisite}</p>}
        <p className="tour-body" data-testid="tour-hint">
          {step.instruction(ctx)}
          {step.id === 'company' && (
            <>
              {' '}
              <Link to="/assets" data-testid="tour-company-gas">
                Get registration gas →
              </Link>
            </>
          )}
        </p>
        {step.outcome && <p className="note" data-testid="tour-result"><strong>Check the result: </strong>{step.outcome}</p>}
        <div className="tour-footer">
          {step.example && (
            <details className="tour-example">
              <summary>Example & result</summary>
              <p>{step.example}</p>
              <p className="note">Changing chapters explores the guide; it does not complete a transaction.</p>
            </details>
          )}
          {!finish ? (
            <div className="tour-actions">
              <button
                type="button"
                className="btn quiet sm"
                aria-label="Previous chapter"
                title="Previous chapter"
                disabled={index === 0}
                onClick={() => setTour({ index: index - 1 })}
              >
                ←
              </button>
              <button
                type="button"
                className="btn quiet sm"
                data-testid="tour-advance"
                onClick={() => setTour({ index: index + 1 })}
              >
                Next chapter
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn primary sm"
              data-testid="tour-next"
              onClick={() => setTour({ active: false, index: 0, completed: true })}
            >
              Finish
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
