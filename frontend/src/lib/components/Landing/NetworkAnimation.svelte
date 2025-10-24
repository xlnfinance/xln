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

    const opacity = (blackAndWhiteMode ? 0.4 : 0.3) * fadeMultiplier;

    // Create gradient from blue to cyan (or white in B&W mode)
    const gradient = ctx.createLinearGradient(from.x, from.y, currentX, currentY);
    if (blackAndWhiteMode) {
      gradient.addColorStop(0, 'rgba(255, 255, 255, ' + opacity + ')');
      gradient.addColorStop(1, 'rgba(255, 255, 255, ' + (opacity * 1.5) + ')');
    } else {
      gradient.addColorStop(0, 'rgba(0, 122, 204, ' + opacity + ')'); // Blue
      gradient.addColorStop(1, 'rgba(0, 255, 255, ' + (opacity * 1.5) + ')'); // Cyan
    }

    // Glow effect
    ctx.shadowBlur = 8;
    ctx.shadowColor = blackAndWhiteMode ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 200, 255, 0.6)';

    ctx.strokeStyle = gradient;
    ctx.globalAlpha = 1; // Let gradient handle opacity
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(currentX, currentY);
    ctx.stroke();

    // Draw glowing dot at current position with particle trail
    const dotColor = blackAndWhiteMode ? '#ffffff' : '#00ffff';
    ctx.shadowBlur = 12;
    ctx.shadowColor = dotColor;

    ctx.fillStyle = dotColor;
    ctx.globalAlpha = opacity * 1.8;
    ctx.beginPath();
    ctx.arc(currentX, currentY, 3, 0, Math.PI * 2);
    ctx.fill();

    // Particle trail (3 small fading dots behind)
    for (let i = 1; i <= 3; i++) {
      const trailProgress = Math.max(0, progress - (i * 0.05));
      const trailX = from.x + (to.x - from.x) * trailProgress;
      const trailY = from.y + (to.y - from.y) * trailProgress;
      const trailOpacity = opacity * (1 - i * 0.3);

      ctx.globalAlpha = trailOpacity;
      ctx.beginPath();
      ctx.arc(trailX, trailY, 2 - i * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Reset shadow
    ctx.shadowBlur = 0;
  }

  function drawRipple(ripple: BroadcastRipple) {
    if (!ctx) return;

    const color = blackAndWhiteMode ? '#ffffff' : '#ff8888';
    const baseOpacity = blackAndWhiteMode ? 0.4 : 0.3;
    const opacity = baseOpacity * (1 - ripple.radius / ripple.maxRadius);

    // Heavy glow to emphasize expense
    ctx.shadowBlur = 15;
    ctx.shadowColor = color;

    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 4; // Thicker to emphasize heaviness

    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.stroke();

    // Reset shadow for other drawings
    ctx.shadowBlur = 0;
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

    // Spawn unicast paths EXTREMELY frequently (every 20-30ms) - WOW factor!
    const unicastInterval = setInterval(() => {
      createUnicastPath();
    }, 20 + Math.random() * 10);

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
