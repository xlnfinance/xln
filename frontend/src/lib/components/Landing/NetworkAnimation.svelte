<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  import { locale, LOCALES, type Locale } from '$lib/i18n';

  export let darkMode = true; // Prop from parent

  let langDropdownOpen = false;

  function selectLocale(loc: Locale) {
    locale.set(loc);
    langDropdownOpen = false;
  }
  export let onToggleDarkMode: () => void; // Callback to parent

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null;
  let animationFrame: number;

  // Controls
  let animationEnabled = false; // OFF by default - less annoying

  interface Point {
    x: number;
    y: number;
  }

  interface UnicastPath {
    hops: Point[];
    currentHop: number;
    progress: number;
    speed: number;
  }

  interface BroadcastRipple {
    x: number;
    y: number;
    radius: number;
    maxRadius: number;
    speed: number;
  }

  let unicastPaths: UnicastPath[] = [];
  let broadcastRipples: BroadcastRipple[] = [];

  function resizeCanvas() {
    if (!canvas || !browser) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function randomPoint(): Point {
    return {
      x: Math.random() * (canvas?.width || window.innerWidth),
      y: Math.random() * (canvas?.height || window.innerHeight)
    };
  }

  function createUnicastPath() {
    if (!animationEnabled) return;

    // 2-10 zig-zags = 3-11 total points
    const numPoints = 3 + Math.floor(Math.random() * 9);
    const hops: Point[] = [];

    // Start and end points
    const start = randomPoint();
    const end = randomPoint();

    hops.push(start);

    // Generate zig-zag waypoints between start and end
    for (let i = 1; i < numPoints - 1; i++) {
      const t = i / (numPoints - 1); // Progress from 0 to 1

      // Interpolate between start and end
      const baseX = start.x + (end.x - start.x) * t;
      const baseY = start.y + (end.y - start.y) * t;

      // Add random offset for zig-zag (perpendicular to main direction)
      const maxOffset = Math.min(
        canvas?.width || window.innerWidth,
        canvas?.height || window.innerHeight
      ) * 0.2; // 20% of screen size

      const offsetX = (Math.random() - 0.5) * maxOffset;
      const offsetY = (Math.random() - 0.5) * maxOffset;

      hops.push({
        x: Math.max(0, Math.min((canvas?.width || window.innerWidth), baseX + offsetX)),
        y: Math.max(0, Math.min((canvas?.height || window.innerHeight), baseY + offsetY))
      });
    }

    hops.push(end);


    unicastPaths.push({
      hops,
      currentHop: 0,
      progress: 0,
      speed: 0.01 + Math.random() * 0.06 // More dramatic speed variation (slow to fast)
    });
  }

  function createBroadcastRipple() {
    if (!animationEnabled) return;

    const center = randomPoint();
    const screenDiagonal = Math.sqrt(
      Math.pow(canvas?.width || window.innerWidth, 2) +
      Math.pow(canvas?.height || window.innerHeight, 2)
    );
    broadcastRipples.push({
      x: center.x,
      y: center.y,
      radius: 0,
      maxRadius: screenDiagonal * 0.8, // Cover 80% of screen diagonal
      speed: 2 // Slower to emphasize heaviness
    });
  }

  function drawLine(from: Point, to: Point, progress: number, fadeMultiplier: number = 1) {
    if (!ctx) return;

    const currentX = from.x + (to.x - from.x) * progress;
    const currentY = from.y + (to.y - from.y) * progress;

    const opacity = (darkMode ? 0.4 : 0.5) * fadeMultiplier;

    // Simpler solid color - no gradient (performance)
    const color = darkMode ? `rgba(0, 200, 255, ${opacity})` : `rgba(0, 100, 200, ${opacity})`;

    ctx.strokeStyle = color;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(currentX, currentY);
    ctx.stroke();

    // Simple bright dot at current position (no shadow blur)
    const dotColor = darkMode ? `rgba(0, 255, 255, ${opacity * 1.8})` : `rgba(0, 100, 200, ${opacity * 1.8})`;

    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(currentX, currentY, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRipple(ripple: BroadcastRipple) {
    if (!ctx) return;

    const color = darkMode ? '#ff8888' : '#cc5555';
    const baseOpacity = darkMode ? 0.3 : 0.4;
    const opacity = baseOpacity * (1 - ripple.radius / ripple.maxRadius);

    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 4; // Thicker to emphasize heaviness

    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  function animate() {
    if (!ctx || !canvas) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update and draw unicast paths
    unicastPaths = unicastPaths.filter(path => {
      path.progress += path.speed;

      // Draw all completed hops
      for (let i = 0; i < path.currentHop; i++) {
        const from = path.hops[i];
        const to = path.hops[i + 1];
        if (from && to) {
          drawLine(from, to, 1, 0.3);
        }
      }

      // Draw current hop
      if (path.currentHop < path.hops.length - 1) {
        const from = path.hops[path.currentHop];
        const to = path.hops[path.currentHop + 1];
        if (from && to) {
          drawLine(from, to, path.progress, 1);
        }

        if (path.progress >= 1) {
          path.currentHop++;
          path.progress = 0;
        }
      }

      // Keep path alive until all hops complete
      return path.currentHop < path.hops.length - 1 || path.progress < 1;
    });

    // Update and draw broadcast ripples
    broadcastRipples = broadcastRipples.filter(ripple => {
      ripple.radius += ripple.speed;
      drawRipple(ripple);
      return ripple.radius < ripple.maxRadius;
    });

    animationFrame = requestAnimationFrame(animate);
  }

  onMount(() => {
    if (!browser) return;

    ctx = canvas.getContext('2d');
    resizeCanvas();

    window.addEventListener('resize', resizeCanvas);

    // Start animation loop
    animate();

    // Spawn unicast paths frequently but not crazy (every 150-250ms) - performance balanced!
    const unicastInterval = setInterval(() => {
      createUnicastPath();
    }, 150 + Math.random() * 100);

    // Spawn broadcast ripples rarely (every 9-15 seconds) - they're expensive!
    const broadcastInterval = setInterval(() => {
      createBroadcastRipple();
    }, 9000 + Math.random() * 6000);

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      clearInterval(unicastInterval);
      clearInterval(broadcastInterval);
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
  <button on:click={() => animationEnabled = !animationEnabled} class="control-btn">
    {animationEnabled ? '⏸ Pause Animation' : '▶ Play Animation'}
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
