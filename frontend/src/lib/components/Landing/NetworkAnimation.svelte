<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  import { locale, LOCALES, type Locale } from '$lib/i18n';

  export let darkMode = true;

  let langDropdownOpen = false;

  function selectLocale(loc: Locale) {
    locale.set(loc);
    langDropdownOpen = false;
  }
  export let onToggleDarkMode: () => void;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null;
  let animationFrame: number;

  // Animation mode: 'off' | 'constellation' | 'grid' | 'noise'
  let animationMode: 'off' | 'constellation' | 'grid' | 'noise' = 'constellation';

  const MODES = ['off', 'constellation', 'grid', 'noise'] as const;
  const MODE_LABELS = {
    off: '⏹ Off',
    constellation: '✦ Constellation',
    grid: '▦ Grid Flow',
    noise: '◐ Noise Field'
  };

  function cycleMode() {
    const idx = MODES.indexOf(animationMode);
    animationMode = MODES[(idx + 1) % MODES.length] as typeof animationMode;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTELLATION - Static nodes with subtle pulse connections
  // ═══════════════════════════════════════════════════════════════════════════

  interface Star {
    x: number;
    y: number;
    size: number;
    brightness: number;
    phase: number;
  }

  interface Pulse {
    fromIdx: number;
    toIdx: number;
    progress: number;
    speed: number;
  }

  let stars: Star[] = [];
  let pulses: Pulse[] = [];

  function initConstellation() {
    stars = [];
    const count = Math.floor((canvas.width * canvas.height) / 25000); // ~50-80 stars
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: 1 + Math.random() * 2,
        brightness: 0.3 + Math.random() * 0.7,
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  function drawConstellation(time: number) {
    if (!ctx) return;

    // Draw stars with subtle twinkle
    stars.forEach((star, i) => {
      const twinkle = 0.5 + 0.5 * Math.sin(time * 0.001 + star.phase);
      const alpha = star.brightness * twinkle * 0.6;
      const color = darkMode
        ? `rgba(120, 180, 255, ${alpha})`
        : `rgba(60, 100, 180, ${alpha * 0.7})`;

      ctx!.fillStyle = color;
      ctx!.beginPath();
      ctx!.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx!.fill();
    });

    // Occasionally spawn a pulse between nearby stars
    if (Math.random() < 0.005 && pulses.length < 3) {
      const fromIdx = Math.floor(Math.random() * stars.length);
      const from = stars[fromIdx];

      // Find a nearby star
      let bestIdx = -1;
      let bestDist = Infinity;
      stars.forEach((s, i) => {
        if (i === fromIdx || !from) return;
        const dist = Math.hypot(s.x - from.x, s.y - from.y);
        if (dist < 200 && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      });

      if (bestIdx >= 0) {
        pulses.push({
          fromIdx,
          toIdx: bestIdx,
          progress: 0,
          speed: 0.008 + Math.random() * 0.012
        });
      }
    }

    // Draw and update pulses
    pulses = pulses.filter(pulse => {
      const from = stars[pulse.fromIdx];
      const to = stars[pulse.toIdx];
      if (!from || !to) return false;

      pulse.progress += pulse.speed;

      const alpha = Math.sin(pulse.progress * Math.PI) * 0.4;
      const color = darkMode
        ? `rgba(0, 200, 255, ${alpha})`
        : `rgba(0, 120, 200, ${alpha})`;

      // Draw line
      ctx!.strokeStyle = color;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.moveTo(from.x, from.y);
      ctx!.lineTo(to.x, to.y);
      ctx!.stroke();

      // Draw traveling dot
      const dotX = from.x + (to.x - from.x) * pulse.progress;
      const dotY = from.y + (to.y - from.y) * pulse.progress;
      ctx!.fillStyle = darkMode
        ? `rgba(0, 255, 255, ${alpha * 2})`
        : `rgba(0, 150, 255, ${alpha * 2})`;
      ctx!.beginPath();
      ctx!.arc(dotX, dotY, 2, 0, Math.PI * 2);
      ctx!.fill();

      return pulse.progress < 1;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GRID FLOW - Minimal grid with directional flow
  // ═══════════════════════════════════════════════════════════════════════════

  let gridOffset = 0;

  function drawGrid(time: number) {
    if (!ctx) return;

    const spacing = 60;
    const flowSpeed = 0.3;
    gridOffset = (gridOffset + flowSpeed) % spacing;

    const baseAlpha = darkMode ? 0.08 : 0.06;
    const accentAlpha = darkMode ? 0.15 : 0.12;

    // Vertical lines with flow
    for (let x = -spacing + gridOffset; x < canvas.width + spacing; x += spacing) {
      const wave = Math.sin(x * 0.01 + time * 0.0005) * 0.5 + 0.5;
      const alpha = baseAlpha + wave * 0.03;

      ctx.strokeStyle = darkMode
        ? `rgba(100, 150, 255, ${alpha})`
        : `rgba(50, 100, 200, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }

    // Horizontal lines (static)
    for (let y = 0; y < canvas.height; y += spacing) {
      const wave = Math.sin(y * 0.02 + time * 0.0003) * 0.5 + 0.5;
      const alpha = baseAlpha * 0.7 + wave * 0.02;

      ctx.strokeStyle = darkMode
        ? `rgba(100, 150, 255, ${alpha})`
        : `rgba(50, 100, 200, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Accent dots at intersections with subtle pulse
    for (let x = gridOffset; x < canvas.width; x += spacing) {
      for (let y = 0; y < canvas.height; y += spacing) {
        const pulse = Math.sin(time * 0.002 + x * 0.01 + y * 0.01) * 0.5 + 0.5;
        const alpha = accentAlpha * pulse;

        if (alpha > 0.05) {
          ctx.fillStyle = darkMode
            ? `rgba(0, 200, 255, ${alpha})`
            : `rgba(0, 120, 200, ${alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOISE FIELD - Perlin-like gradient shifts (aurora effect)
  // ═══════════════════════════════════════════════════════════════════════════

  // Simple noise implementation
  function noise2D(x: number, y: number, seed: number = 0): number {
    const n = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
    return n - Math.floor(n);
  }

  function smoothNoise(x: number, y: number, scale: number, time: number): number {
    const sx = x / scale;
    const sy = y / scale;
    const t = time * 0.0001;

    // Multi-octave noise
    let value = 0;
    value += noise2D(sx + t, sy + t * 0.7, 1) * 0.5;
    value += noise2D(sx * 2 + t * 1.3, sy * 2 + t, 2) * 0.25;
    value += noise2D(sx * 4 + t * 0.8, sy * 4 + t * 1.2, 3) * 0.125;

    return value;
  }

  function drawNoise(time: number) {
    if (!ctx) return;

    const imageData = ctx.createImageData(canvas.width, canvas.height);
    const data = imageData.data;
    const scale = 200;

    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        const n = smoothNoise(x, y, scale, time);

        // Color gradient based on noise
        let r, g, b, a;
        if (darkMode) {
          // Dark mode: deep blue to cyan gradient
          r = Math.floor(n * 30);
          g = Math.floor(50 + n * 80);
          b = Math.floor(100 + n * 100);
          a = Math.floor(n * 40);
        } else {
          // Light mode: subtle blue tints
          r = Math.floor(n * 20);
          g = Math.floor(40 + n * 60);
          b = Math.floor(80 + n * 80);
          a = Math.floor(n * 25);
        }

        // Fill 4x4 block for performance
        for (let dy = 0; dy < 4 && y + dy < canvas.height; dy++) {
          for (let dx = 0; dx < 4 && x + dx < canvas.width; dx++) {
            const idx = ((y + dy) * canvas.width + (x + dx)) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = a;
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN ANIMATION LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  function resizeCanvas() {
    if (!canvas || !browser) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (animationMode === 'constellation') {
      initConstellation();
    }
  }

  function animate(time: number) {
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    switch (animationMode) {
      case 'constellation':
        drawConstellation(time);
        break;
      case 'grid':
        drawGrid(time);
        break;
      case 'noise':
        drawNoise(time);
        break;
      case 'off':
      default:
        // Nothing
        break;
    }

    animationFrame = requestAnimationFrame(animate);
  }

  onMount(() => {
    if (!browser) return;

    ctx = canvas.getContext('2d');
    resizeCanvas();

    window.addEventListener('resize', resizeCanvas);

    animationFrame = requestAnimationFrame(animate);

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resizeCanvas);
    };
  });
</script>

<canvas bind:this={canvas} class="network-canvas"></canvas>

<div class="animation-controls">
  <!-- Language Switcher -->
  <div class="lang-dropdown-container">
    <button on:click={() => langDropdownOpen = !langDropdownOpen} class="control-btn lang-btn">
      <span class="lang-flag">{LOCALES[$locale].flag}</span>
      <span class="lang-code">{$locale.toUpperCase()}</span>
      <svg class="lang-chevron" class:open={langDropdownOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" width="12" height="12">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
      </svg>
    </button>
    {#if langDropdownOpen}
      <div class="lang-dropdown">
        {#each Object.entries(LOCALES) as [code, info]}
          <button
            class="lang-option"
            class:active={code === $locale}
            on:click={() => selectLocale(code as Locale)}
          >
            <span class="lang-flag">{info.flag}</span>
            <span class="lang-name">{info.name}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <button on:click={cycleMode} class="control-btn">
    {MODE_LABELS[animationMode]}
  </button>
  <button on:click={onToggleDarkMode} class="control-btn">
    {darkMode ? '☀️ Light Mode' : '🌙 Dark Mode'}
  </button>
</div>

<!-- Click outside to close lang dropdown -->
{#if langDropdownOpen}
  <div class="lang-backdrop" on:click={() => langDropdownOpen = false} on:keydown={() => {}} role="presentation"></div>
{/if}

<style>
  .network-canvas {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 0;
  }

  .animation-controls {
    position: fixed;
    bottom: 20px;
    right: 20px;
    display: flex;
    gap: 8px;
    z-index: 100;
  }

  .control-btn {
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
    font-family: inherit;
  }

  .control-btn:hover {
    background: rgba(0, 0, 0, 0.9);
    border-color: #007acc;
  }

  /* Light mode button styling */
  :global(.light-mode) .control-btn {
    background: rgba(255, 255, 255, 0.9);
    color: #000;
    border-color: rgba(0, 0, 0, 0.2);
  }

  :global(.light-mode) .control-btn:hover {
    background: rgba(255, 255, 255, 1);
    border-color: #007acc;
  }

  /* Language Dropdown */
  .lang-dropdown-container {
    position: relative;
  }

  .lang-btn {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .lang-flag {
    font-size: 16px;
  }

  .lang-code {
    font-weight: 600;
    font-size: 11px;
  }

  .lang-chevron {
    transition: transform 0.2s;
    opacity: 0.6;
  }

  .lang-chevron.open {
    transform: rotate(180deg);
  }

  .lang-dropdown {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    min-width: 160px;
    background: rgba(20, 20, 30, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 10px;
    padding: 4px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .lang-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
  }

  .lang-option:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .lang-option.active {
    background: rgba(0, 122, 204, 0.3);
    color: white;
  }

  .lang-name {
    flex: 1;
  }

  .lang-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  :global(.light-mode) .lang-dropdown {
    background: rgba(255, 255, 255, 0.98);
    border-color: rgba(0, 0, 0, 0.1);
  }

  :global(.light-mode) .lang-option {
    color: rgba(0, 0, 0, 0.8);
  }

  :global(.light-mode) .lang-option:hover {
    background: rgba(0, 0, 0, 0.05);
    color: black;
  }

  :global(.light-mode) .lang-option.active {
    background: rgba(0, 122, 204, 0.2);
    color: black;
  }
</style>
