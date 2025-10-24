<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null;
  let animationFrame: number;

  // Controls
  let animationEnabled = true;
  let blackAndWhiteMode = false;

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

    const numHops = 3 + Math.floor(Math.random() * 3); // 3-5 hops
    const hops: Point[] = [];

    // Generate path points across the screen
    for (let i = 0; i < numHops; i++) {
      hops.push(randomPoint());
    }

    unicastPaths.push({
      hops,
      currentHop: 0,
      progress: 0,
      speed: 0.02 + Math.random() * 0.03 // Vary speed slightly
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
      speed: 3
    });
  }

  function drawLine(from: Point, to: Point, progress: number, fadeMultiplier: number = 1) {
    if (!ctx) return;

    const currentX = from.x + (to.x - from.x) * progress;
    const currentY = from.y + (to.y - from.y) * progress;

    const color = blackAndWhiteMode ? '#ffffff' : '#007acc';
    const opacity = (blackAndWhiteMode ? 0.4 : 0.3) * fadeMultiplier;

    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(currentX, currentY);
    ctx.stroke();

    // Draw small dot at current position
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity * 1.5;
    ctx.beginPath();
    ctx.arc(currentX, currentY, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRipple(ripple: BroadcastRipple) {
    if (!ctx) return;

    const color = blackAndWhiteMode ? '#ffffff' : '#ffcccc';
    const baseOpacity = blackAndWhiteMode ? 0.3 : 0.2;
    const opacity = baseOpacity * (1 - ripple.radius / ripple.maxRadius);

    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 2.5;

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
        drawLine(path.hops[i], path.hops[i + 1], 1, 0.3);
      }

      // Draw current hop
      if (path.currentHop < path.hops.length - 1) {
        drawLine(
          path.hops[path.currentHop],
          path.hops[path.currentHop + 1],
          path.progress,
          1
        );

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

    // Spawn unicast paths very frequently (every 200-300ms) - emphasize scaling!
    const unicastInterval = setInterval(() => {
      createUnicastPath();
    }, 200 + Math.random() * 100);

    // Spawn broadcast ripples every 3-5 seconds
    const broadcastInterval = setInterval(() => {
      createBroadcastRipple();
    }, 3000 + Math.random() * 2000);

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
  <button on:click={() => animationEnabled = !animationEnabled} class="control-btn">
    {animationEnabled ? '⏸ Pause Unicast Dance' : '▶ Play Unicast Dance'}
  </button>
  <button on:click={() => blackAndWhiteMode = !blackAndWhiteMode} class="control-btn">
    {blackAndWhiteMode ? '🎨 Color' : '⚫ B&W'}
  </button>
</div>

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
</style>
