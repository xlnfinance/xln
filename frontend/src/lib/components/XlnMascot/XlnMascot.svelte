<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import XlnMascotChat from './XlnMascotChat.svelte';
  import XlnMascotLogo from './XlnMascotLogo.svelte';
  import type { MascotPresence } from './mascot-types';
  import {
    clampMascotPoint,
    moveMascotDock,
    normalizeXlnMascotDock,
    resolveMascotPanelRect,
    resolveMascotPoint,
    snapMascotToEdge,
    type MascotPoint,
    type MascotViewport,
  } from './mascot-geometry';
  import type { XlnAssistantMessage } from '$lib/ai/xln-assistant-client';

  let mounted = false;
  let expanded = false;
  let presence: MascotPresence = 'idle';
  let viewport: MascotViewport = { width: 1280, height: 720 };
  let dragPoint: MascotPoint | null = null;
  let activePointerId: number | null = null;
  let pointerStart: MascotPoint = { x: 0, y: 0 };
  let mascotStart: MascotPoint = { x: 0, y: 0 };
  let dragged = false;
  let suppressClick = false;
  let messages: XlnAssistantMessage[] = [];
  let presenceBeforeDrag: MascotPresence = 'idle';
  const handlePointerCancel = (event: PointerEvent): void => finishPointer(event, true);

  $: dock = normalizeXlnMascotDock($settings.xlnMascotDock);
  $: anchoredPoint = resolveMascotPoint(dock, viewport);
  $: mascotPoint = dragPoint ?? anchoredPoint;
  $: panelRect = resolveMascotPanelRect(dock, mascotPoint, viewport);
  $: if (!$settings.showXlnMascot) expanded = false;

  function readViewport(): MascotViewport {
    const visual = window.visualViewport;
    const width = window.innerWidth;
    const height = window.innerHeight;
    return {
      width,
      height,
      insetTop: visual?.offsetTop ?? 0,
      insetLeft: visual?.offsetLeft ?? 0,
      insetRight: visual ? Math.max(0, width - visual.offsetLeft - visual.width) : 0,
      insetBottom: visual ? Math.max(0, height - visual.offsetTop - visual.height) : 0,
    };
  }

  function updateViewport(): void {
    viewport = readViewport();
    if (dragPoint) dragPoint = clampMascotPoint(dragPoint, viewport);
  }

  function handlePointerStart(event: PointerEvent): void {
    if (event.button !== 0 || activePointerId !== null) return;
    activePointerId = event.pointerId;
    pointerStart = { x: event.clientX, y: event.clientY };
    mascotStart = mascotPoint;
    dragged = false;
    suppressClick = false;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    if (!dragged && Math.hypot(dx, dy) < 5) return;
    if (!dragged) presenceBeforeDrag = presence;
    dragged = true;
    presence = 'dragging';
    dragPoint = clampMascotPoint({ x: mascotStart.x + dx, y: mascotStart.y + dy }, viewport);
  }

  function finishPointer(event: PointerEvent, cancelled = false): void {
    if (event.pointerId !== activePointerId) return;
    if (dragged && dragPoint && !cancelled) {
      settingsOperations.setXlnMascotDock(snapMascotToEdge(dragPoint, viewport));
      suppressClick = true;
    }
    activePointerId = null;
    dragPoint = null;
    dragged = false;
    presence = presenceBeforeDrag;
  }

  function toggle(event: MouseEvent): void {
    if (suppressClick) {
      event.preventDefault();
      suppressClick = false;
      return;
    }
    expanded = !expanded;
    if (!expanded) presence = 'idle';
  }

  function close(): void {
    expanded = false;
    presence = 'idle';
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="xln-mascot-toggle"]')?.focus();
    });
  }

  function handleKeyboard(event: KeyboardEvent): void {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      close();
      return;
    }
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    settingsOperations.setXlnMascotDock(moveMascotDock(dock, event.key, event.altKey));
  }

  function handlePresence(next: 'idle' | 'ready' | 'offline' | 'thinking'): void {
    presence = next;
  }

  onMount(() => {
    settingsOperations.loadFromStorage();
    updateViewport();
    mounted = true;
    window.addEventListener('resize', updateViewport);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.visualViewport?.addEventListener('resize', updateViewport);
  });

  onDestroy(() => {
    window.removeEventListener('resize', updateViewport);
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', finishPointer);
    window.removeEventListener('pointercancel', handlePointerCancel);
    window.visualViewport?.removeEventListener('resize', updateViewport);
  });
</script>

{#if mounted && $settings.showXlnMascot}
  <div class="mascot-layer" data-testid="xln-mascot-layer">
    <div
      class="mascot-root"
      data-testid="xln-mascot-root"
      data-dock-side={dock.side}
      data-offset={dock.offsetRatio.toFixed(4)}
      data-presence-state={presence}
      style={`left:${mascotPoint.x}px;top:${mascotPoint.y}px;`}
    >
      <XlnMascotLogo
        {presence}
        {expanded}
        onToggle={toggle}
        onPointerStart={handlePointerStart}
        onKeyboard={handleKeyboard}
      />
    </div>
    {#if expanded}
      <div
        class="chat-position"
        style={`left:${panelRect.x}px;top:${panelRect.y}px;width:${panelRect.width}px;height:${panelRect.height}px;`}
      >
        <XlnMascotChat
          pathname={$page.url.pathname}
          bind:messages
          onClose={close}
          onPresence={handlePresence}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  .mascot-layer {
    position: fixed;
    inset: 0;
    z-index: 9000;
    pointer-events: none;
  }

  .mascot-root,
  .chat-position {
    position: fixed;
    pointer-events: auto;
  }

  .mascot-root { width: 64px; height: 64px; }
  .chat-position { display: grid; }

  @media (max-width: 520px) {
    .mascot-layer { z-index: 9000; }
  }
</style>
