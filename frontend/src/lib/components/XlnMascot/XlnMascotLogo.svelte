<script lang="ts">
  import type { MascotPresence } from './mascot-types';

  export let presence: MascotPresence = 'idle';
  export let expanded = false;
  export let onToggle: (event: MouseEvent) => void = () => {};
  export let onPointerStart: (event: PointerEvent) => void = () => {};
  export let onKeyboard: (event: KeyboardEvent) => void = () => {};
</script>

<button
  type="button"
  class="mascot-button"
  class:expanded
  data-testid="xln-mascot-toggle"
  data-drag-handle="xln-mascot"
  data-presence={presence}
  aria-label={expanded ? 'Close xln assistant. Drag to move.' : 'Ask xln. Drag to move.'}
  aria-expanded={expanded}
  on:click={onToggle}
  on:pointerdown={onPointerStart}
  on:keydown={onKeyboard}
>
  <span class="logo-stage" aria-hidden="true">
    <span class="logo-mark"></span>
    <span class="logo-glint"></span>
  </span>
  <span class="presence-dot" aria-hidden="true"></span>
</button>

<style>
  .mascot-button {
    position: relative;
    display: grid;
    width: 64px;
    height: 64px;
    padding: 0;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--theme-text-primary, #f4f4f5) 16%, transparent);
    border-radius: 19px;
    background:
      radial-gradient(circle at 28% 18%, rgba(255, 255, 255, 0.14), transparent 34%),
      color-mix(in srgb, var(--theme-card-bg, #101114) 94%, #07141a 6%);
    box-shadow:
      0 16px 42px rgba(0, 0, 0, 0.28),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .mascot-button:hover {
    border-color: color-mix(in srgb, var(--theme-accent, #22d3aa) 42%, transparent);
  }

  .mascot-button:active,
  .mascot-button[data-presence='dragging'] {
    cursor: grabbing;
  }

  .mascot-button:focus-visible {
    outline: 2px solid var(--theme-accent, #22d3aa);
    outline-offset: 4px;
  }

  .logo-stage {
    position: relative;
    width: 43px;
    height: 39px;
    filter: drop-shadow(0 0 12px color-mix(in srgb, var(--theme-accent, #22d3aa) 38%, transparent));
    animation: mascot-float 5.4s ease-in-out infinite;
    transform-style: preserve-3d;
  }

  .logo-mark,
  .logo-glint {
    position: absolute;
    inset: 0;
    -webkit-mask: url('/img/l.png') center / contain no-repeat;
    mask: url('/img/l.png') center / contain no-repeat;
  }

  .logo-mark {
    background: linear-gradient(145deg, #ffffff 8%, #a8b8c8 40%, #ffffff 62%, #8af4d3 100%);
  }

  .logo-glint {
    background: linear-gradient(105deg, transparent 30%, rgba(255, 255, 255, 0.95) 47%, transparent 62%);
    transform: translateX(-125%);
    animation: mascot-glint 4.8s ease-in-out infinite;
  }

  .presence-dot {
    position: absolute;
    right: 7px;
    bottom: 7px;
    width: 8px;
    height: 8px;
    border: 2px solid color-mix(in srgb, var(--theme-card-bg, #101114) 92%, #000);
    border-radius: 50%;
    background: #8a93a0;
  }

  [data-presence='ready'] .presence-dot { background: #3ddc97; box-shadow: 0 0 10px rgba(61, 220, 151, 0.72); }
  [data-presence='offline'] .presence-dot { background: #f2b84b; }
  [data-presence='thinking'] .presence-dot { background: #63d9ff; box-shadow: 0 0 12px rgba(99, 217, 255, 0.8); }

  [data-presence='thinking'] .logo-stage {
    animation: mascot-think 1.1s cubic-bezier(0.55, 0.08, 0.45, 0.92) infinite;
  }

  [data-presence='dragging'] .logo-stage { transform: scale(0.92) rotate(-4deg); }
  .expanded { border-color: color-mix(in srgb, var(--theme-accent, #22d3aa) 54%, transparent); }

  @keyframes mascot-float {
    0%, 100% { transform: translateY(0) rotateY(-5deg) rotateZ(-0.5deg); }
    50% { transform: translateY(-4px) rotateY(7deg) rotateZ(0.8deg); }
  }

  @keyframes mascot-glint {
    0%, 60% { transform: translateX(-125%); opacity: 0; }
    70% { opacity: 0.9; }
    88%, 100% { transform: translateX(125%); opacity: 0; }
  }

  @keyframes mascot-think {
    0% { transform: rotateY(0deg) translateY(0); }
    50% { transform: rotateY(180deg) translateY(-2px); }
    100% { transform: rotateY(360deg) translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .logo-stage,
    .logo-glint { animation: none; }
  }
</style>
