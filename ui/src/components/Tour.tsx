import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from './Icons';
import { useApp } from '../runtime/store';
import { useWallet } from '../runtime/views';
import { TOUR_STEPS, WAYPOINTS, type TourContext, type TourStep } from '../tour/steps';

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 8;
const CARD_W = 420;
const CARD_H = 340;

const nodeFor = (testId: string): HTMLElement | null => {
	const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
	return (
		nodes.find(candidate => {
			const rect = candidate.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && getComputedStyle(candidate).visibility !== 'hidden';
		}) ?? null
	);
};

function measure(testId: string | undefined): Rect | null {
	if (!testId) return null;
	const node = nodeFor(testId);
	if (!node) return null;
	const rect = node.getBoundingClientRect();
	return { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
}

const dom: TourContext['dom'] = {
	has: testId => nodeFor(testId) !== null,
	active: testId => nodeFor(testId)?.classList.contains('active') ?? false,
	value: testId => {
		const node = nodeFor(testId);
		return node && 'value' in node ? String((node as HTMLInputElement).value ?? '') : '';
	},
};

/**
 * The guided tour. Nothing is dimmed, blocked, navigated or pressed for the
 * user: a ring marks the next control wherever they are, a card says why, and
 * a step releases only when the runtime shows the effect of what they did.
 * The only control the tour owns is the way out.
 */
export function Tour() {
	const tour = useApp(s => s.tour);
	const setTour = useApp(s => s.setTour);
	const toast = useApp(s => s.toast);
	const entityId = useApp(s => s.activeEntityId);
	const height = useApp(s => s.height);
	const wallet = useWallet(entityId);
	const { pathname } = useLocation();
	const [rect, setRect] = useState<Rect | null>(null);
	const [targetId, setTargetId] = useState<string | undefined>(undefined);
	const [more, setMore] = useState(false);
	const [picked, setPicked] = useState<number | null>(null);
	const [tick, setTick] = useState(0);
	const baseline = useRef(new Map<string, number>());
	const entered = useRef<string | null>(null);
	const reacted = useRef<string | null>(null);
	const ctx = useMemo<TourContext>(() => ({ wallet, pathname, baseline: baseline.current, dom }), [wallet, pathname]);

	const steps = TOUR_STEPS;
	const index = Math.min(tour.index, steps.length - 1);
	const step: TourStep | undefined = tour.active ? steps[index] : undefined;

	const go = useCallback(
		(next: number) => {
			if (next >= steps.length) {
				setTour({ active: false, index: 0, completed: true });
				return;
			}
			setTour({ index: Math.max(0, next) });
		},
		[setTour, steps.length],
	);

	// Enter: skip what the sandbox cannot show, record baselines, reset the card.
	useEffect(() => {
		if (!step || !wallet.entityId) return;
		if (entered.current === step.id) return;
		if (step.skipWhen?.(ctx)) {
			go(index + 1);
			return;
		}
		entered.current = step.id;
		setMore(false);
		setPicked(null);
		// Never show the previous step's ring while the new target resolves.
		setTargetId(undefined);
		setRect(null);
		step.enter?.(ctx);
	}, [step, ctx, index, go, wallet.entityId]);

	// Release: the runtime shows the effect of what the user did.
	useEffect(() => {
		if (!step || step.mode !== 'do' || entered.current !== step.id || !step.done) return;
		if (step.done(ctx)) {
			toast('Done. Your runtime confirmed it.');
			go(index + 1);
		}
	}, [step, ctx, index, go, toast, height, tick]);

	// Counterparty reaction, once: the shop pays the bill the user wrote.
	useEffect(() => {
		if (!step || !step.trigger || !step.react || entered.current !== step.id || reacted.current === step.id) return;
		if (!step.trigger(ctx)) return;
		reacted.current = step.id;
		void step.react(wallet).catch(error => toast(error instanceof Error ? error.message : String(error), 'danger'));
	}, [step, ctx, wallet, toast, tick]);

	// Target and ring follow the user through the page.
	useEffect(() => {
		if (!step) return;
		let frame = 0;
		let last = 0;
		const loop = (now: number): void => {
			// A receipt that popped up over the page comes first: close it, then follow the step.
			const resolved = step.id !== 'receipt' && dom.has('receipt-done') ? 'receipt-done' : step.target?.(ctx) || undefined;
			setTargetId(previous => (previous === resolved ? previous : resolved));
			const next = measure(resolved);
			setRect(previous =>
				previous && next && Math.abs(previous.top - next.top) < 1 && Math.abs(previous.left - next.left) < 1 && Math.abs(previous.width - next.width) < 1 && Math.abs(previous.height - next.height) < 1
					? previous
					: next,
			);
			if (now - last > 500) {
				last = now;
				setTick(value => value + 1);
			}
			frame = window.requestAnimationFrame(loop);
		};
		frame = window.requestAnimationFrame(loop);
		return () => window.cancelAnimationFrame(frame);
	}, [step, ctx]);

	// Bring a new target into view.
	useEffect(() => {
		if (!targetId) return;
		const timer = setTimeout(() => nodeFor(targetId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
		return () => clearTimeout(timer);
	}, [targetId]);

	useEffect(() => {
		if (!step) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') setTour({ active: false });
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [step, setTour]);

	if (!step) return null;

	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const wide = vw >= 841;
	// Wide screens: the card lives in a corner and never covers the control it points at.
	const corners: React.CSSProperties[] = [
		{ right: 24, bottom: 24 },
		{ right: 24, top: 24 },
		{ left: 96, bottom: 24 },
		{ left: 96, top: 24 },
	];
	const cornerRect = (corner: React.CSSProperties): Rect => ({
		left: corner.left !== undefined ? Number(corner.left) : vw - CARD_W - Number(corner.right ?? 0),
		top: corner.top !== undefined ? Number(corner.top) : vh - CARD_H - Number(corner.bottom ?? 0),
		width: CARD_W,
		height: CARD_H,
	});
	const overlaps = (a: Rect, b: Rect): boolean => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
	const cardStyle: React.CSSProperties = wide ? (corners.find(corner => !rect || !overlaps(cornerRect(corner), rect)) ?? corners[0]!) : {};

	const chapters = Array.from(new Set(steps.map(entry => entry.chapter)));
	const chapterIndex = chapters.indexOf(step.chapter);
	const hint = targetId === 'receipt-done' && step.id !== 'receipt' ? 'Close the receipt first.' : step.hint?.(ctx);
	const progress = step.progress?.(ctx);
	const pickedOption = picked !== null ? step.options?.[picked] : undefined;
	// A read step turns its page only once the user stands where it points, not on a waypoint towards it.
	const ready = step.mode === 'read' && (!step.target || (targetId !== undefined && rect !== null && !WAYPOINTS.has(targetId)));

	return (
		<div className="tour" data-testid="tour" data-step={step.id} data-target={targetId ?? ''}>
			{rect ? <div className="tour-ring" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} /> : null}
			<div className={`tour-card${wide ? ' anchored' : ''}`} style={cardStyle} role="dialog" aria-live="polite">
				<div className="tour-progress">
					{chapters.map((chapter, position) => (
						<i key={chapter} className={position === chapterIndex ? 'on' : position < chapterIndex ? 'past' : ''} title={chapter} />
					))}
				</div>
				<div className="tour-head">
					<span className="tour-kicker">
						{step.chapter} · {index + 1} / {steps.length}
						{progress ? (
							<span className="tour-count" data-testid="tour-count">
								{' '}
								· {progress.done} / {progress.total}
							</span>
						) : null}
					</span>
					<button type="button" className="icon-btn tour-close" onClick={() => setTour({ active: false })} aria-label="Exit the tour" data-testid="tour-exit">
						<Icon name="close" size={14} />
					</button>
				</div>
				<h2 className="tour-title">{step.title}</h2>
				<p className="tour-body">{step.body}</p>
				{step.mode === 'quiz' && step.options ? (
					<div className="tour-quiz">
						{step.options.map((option, position) => (
							<button
								key={option.label}
								type="button"
								className={`tour-option${picked === position ? (option.correct ? ' right' : ' wrong') : ''}`}
								onClick={() => setPicked(position)}
								data-testid="tour-quiz-option"
							>
								{option.label}
							</button>
						))}
						{pickedOption ? (
							<p className={`tour-why fade-in ${pickedOption.correct ? 'right' : 'wrong'}`} data-testid="tour-quiz-why">
								{pickedOption.why}
							</p>
						) : null}
					</div>
				) : null}
				{hint ? (
					<p className="tour-hint" data-testid="tour-hint">
						<Icon name="arrow" size={12} /> {hint}
					</p>
				) : null}
				{step.more ? (
					<div className="tour-more">
						<button type="button" className="tour-more-toggle" onClick={() => setMore(value => !value)} aria-expanded={more} data-testid="tour-more">
							<Icon name={more ? 'chevronDown' : 'chevronRight'} size={12} /> Under the hood
						</button>
						{more ? <p className="tour-more-body fade-in">{step.more}</p> : null}
					</div>
				) : null}
				<div className="tour-actions">
					{step.mode === 'do' ? (
						<span className="tour-wait">
							<span className="tour-dot" /> your move
						</span>
					) : step.mode === 'quiz' ? (
						<button type="button" className="btn primary sm" disabled={!pickedOption?.correct} onClick={() => go(index + 1)} data-testid="tour-next">
							Continue
							<Icon name="chevronRight" size={14} />
						</button>
					) : (
						<button type="button" className="btn primary sm" disabled={!ready} onClick={() => go(index + 1)} data-testid="tour-next" title={ready ? undefined : 'Go where the ring points first'}>
							{index === steps.length - 1 ? 'Finish' : 'Got it'}
							<Icon name="chevronRight" size={14} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
