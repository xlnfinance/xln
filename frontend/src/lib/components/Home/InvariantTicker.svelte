<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  export let label: string;
  export let description: string;
  export let pattern: string; // e.g. "[---.===---]"
  export let speed = 6; // units per second along the invariant

  const chars = pattern.slice(1, -1).split('');
  const charCount = chars.length || 1;
  const zeroIndex = chars.indexOf('.');

  let pointer = 0; // moves from 0 (left bound) to charCount (right bound)
  let direction = 1;
  let lastTime = 0;
  let rafId: number | null = null;

  function charClass(ch: string) {
    switch (ch) {
      case '-':
        return 'credit';
      case '*':
        return 'used';
      case '=':
        return 'collateral';
      case '.':
        return 'zero';
      default:
        return 'other';
    }
  }

  function deriveChar(base: string, idx: number): string {
    if (base === '-' && zeroIndex !== -1 && idx < zeroIndex) {
      if (pointer > idx && pointer <= zeroIndex) {
        return '*';
      }
      return '-';
    }
    return base;
  }

  $: displayChars = chars.map((base, idx) => deriveChar(base, idx));
  $: deltaOffset = `calc(${pointer} * var(--char-width))`;

  function step(timestamp: number) {
    if (!lastTime) lastTime = timestamp;
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;

    pointer += direction * speed * dt;

    if (pointer >= charCount) {
      pointer = charCount;
      direction = -1;
    } else if (pointer <= 0) {
      pointer = 0;
      direction = 1;
    }

    rafId = requestAnimationFrame(step);
  }

  onMount(() => {
    rafId = requestAnimationFrame(step);
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
</script>

<div class="ticker">
  <div class="header">
    <strong>{label}</strong>
    <span>{description}</span>
  </div>
  <div class="pattern">
    <span class="bracket">[</span>
    <span class="char-track">
      {#each displayChars as ch}
        <span class={`char ${charClass(ch)}`}>{ch}</span>
      {/each}
      <span class="delta" style={`left: ${deltaOffset}`}>Δ</span>
    </span>
    <span class="bracket">]</span>
  </div>
</div>

<style>
  .ticker {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.95rem;
  }

  .header span {
    font-size: 0.8rem;
    color: #9aa0a6;
  }

  .pattern {
    font-family: 'Courier New', monospace;
    font-size: 1.05rem;
    display: inline-flex;
    align-items: center;
    gap: 0;
  }

  .bracket {
    color: #00d1ff;
  }

  .char-track {
    position: relative;
    display: inline-flex;
    --char-width: 1ch;
  }

  .char {
    width: var(--char-width);
    text-align: center;
  }

  .char.credit {
    color: #ff6fa9;
  }

  .char.used {
    color: #ffd1f0;
  }

  .char.collateral {
    color: #4fd18b;
  }

  .char.zero {
    color: #c0cad6;
  }

  .delta {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    color: #0b1a2b;
    background: radial-gradient(circle, #ffffff 0%, #00d1ff 60%, rgba(0, 156, 255, 0.2) 100%);
    border-radius: 50%;
    width: calc(var(--char-width) * 0.85);
    height: calc(var(--char-width) * 0.85);
    display: grid;
    place-items: center;
    box-shadow: 0 0 8px rgba(0, 209, 255, 0.5);
    pointer-events: none;
  }
</style>
