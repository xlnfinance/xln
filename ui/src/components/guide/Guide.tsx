import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useLocation } from 'react-router-dom';
import {
  clampMascotPoint,
  moveMascotDock,
  resolveMascotPanelRect,
  resolveMascotPoint,
  resolveMascotViewport,
  snapMascotToEdge,
  type MascotPoint,
} from '@xln/frontend/lib/components/XlnMascot/mascot-geometry';
import type { MascotPresence } from '@xln/frontend/lib/components/XlnMascot/mascot-types';
import type { XlnAssistantMessage } from '@xln/frontend/lib/ai/xln-assistant-client';
import { useApp } from '../../runtime/store';
import { Logo } from '../Logo';
import { GuideChat } from './Chat';
import './guide.css';

function readViewport() {
  const visual = window.visualViewport;
  const viewport = resolveMascotViewport(
    window.innerWidth,
    window.innerHeight,
    visual
      ? {
          width: visual.width,
          height: visual.height,
          offsetTop: visual.offsetTop,
          offsetLeft: visual.offsetLeft,
        }
      : null,
  );
  // The floating guide stays above the actual mobile navigation, including its safe area.
  const tabbar = document.querySelector<HTMLElement>('.tabbar');
  const rect = tabbar?.getBoundingClientRect();
  return rect && rect.height > 0 && rect.top < window.innerHeight
    ? { ...viewport, insetBottom: Math.max(viewport.insetBottom ?? 0, window.innerHeight - rect.top) }
    : viewport;
}

export function Guide() {
  const { pathname } = useLocation();
  const visible = useApp(s => s.showXlnMascot);
  const dock = useApp(s => s.xlnMascotDock);
  const setDock = useApp(s => s.setXlnMascotDock);
  const [viewport, setViewport] = useState(readViewport);
  const [expanded, setExpanded] = useState(false);
  const [presence, setPresence] = useState<MascotPresence>('idle');
  const [messages, setMessages] = useState<XlnAssistantMessage[]>([]);
  const [dragPoint, setDragPoint] = useState<MascotPoint | null>(null);
  const drag = useRef<{
    id: number;
    start: MascotPoint;
    origin: MascotPoint;
    moved: boolean;
    point: MascotPoint;
  } | null>(null);
  const suppressClick = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const point = dragPoint ?? resolveMascotPoint(dock, viewport);
  const displayedPresence = dragPoint ? 'dragging' : presence;
  const panel = resolveMascotPanelRect(dock, point, viewport);

  useEffect(() => {
    const resize = () => {
      const next = readViewport();
      setViewport(next);
      setDragPoint(current => (current ? clampMascotPoint(current, next) : null));
    };
    resize();
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, [pathname]);

  useEffect(() => {
    if (!visible) {
      setExpanded(false);
      setPresence('idle');
      drag.current = null;
      setDragPoint(null);
    }
  }, [visible]);

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current) return;
    drag.current = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: point,
      point,
      moved: false,
    };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.start.x,
      dy = event.clientY - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < 5) return;
    current.moved = true;
    current.point = clampMascotPoint({ x: current.origin.x + dx, y: current.origin.y + dy }, viewport);
    setDragPoint(current.point);
  }

  function finish(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    if (current.moved) {
      if (!cancelled) setDock(snapMascotToEdge(current.point, viewport));
      suppressClick.current = !cancelled;
    }
    drag.current = null;
    setDragPoint(null);
  }

  function close() {
    setExpanded(false);
    setPresence('idle');
    requestAnimationFrame(() => button.current?.focus());
  }

  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      close();
      return;
    }
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    setDock(moveMascotDock(dock, event.key, event.altKey));
  }

  if (!visible) return null;
  return (
    <div className="guide-layer" data-testid="xln-mascot-layer">
      <div
        className="guide-root"
        data-testid="xln-mascot-root"
        data-dock-side={dock.side}
        data-offset={dock.offsetRatio.toFixed(4)}
        data-presence-state={displayedPresence}
        style={{ left: point.x, top: point.y }}
      >
        <button
          ref={button}
          className="guide-toggle"
          type="button"
          data-testid="xln-mascot-toggle"
          data-drag-handle="xln-mascot"
          data-presence={displayedPresence}
          aria-expanded={expanded}
          aria-label={expanded ? 'Close xln assistant. Drag to move.' : 'Ask xln. Drag to move.'}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={event => finish(event)}
          onPointerCancel={event => finish(event, true)}
          onKeyDown={keyboard}
          onClick={event => {
            if (suppressClick.current) {
              event.preventDefault();
              suppressClick.current = false;
              return;
            }
            if (expanded) close();
            else setExpanded(true);
          }}
        >
          <span className="logo-stage" aria-hidden>
            <Logo size={34} />
          </span>
          <span className="guide-presence" aria-hidden />
        </button>
      </div>
      {expanded && (
        <div
          className="guide-chat-position"
          style={{ left: panel.x, top: panel.y, width: panel.width, height: panel.height }}
        >
          <GuideChat
            pathname={pathname}
            messages={messages}
            setMessages={setMessages}
            onClose={close}
            onPresence={setPresence}
          />
        </div>
      )}
    </div>
  );
}
