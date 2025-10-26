<script lang="ts">
  import InvariantTicker from '../Home/InvariantTicker.svelte';
  import { onMount, onDestroy } from 'svelte';

  export let version: 1 | 2 | 3 = 1;

  // Particle system for version 2
  let particles: Array<{x: number, y: number, speed: number, active: boolean}> = [];
  let animationId: number | null = null;

  function initParticles() {
    if (version !== 2) return;
    particles = Array.from({length: 20}, () => ({
      x: Math.random() * 100,
      y: 50 + (Math.random() - 0.5) * 20,
      speed: 0.1 + Math.random() * 0.2,
      active: true
    }));
    animateParticles();
  }

  function animateParticles() {
    particles = particles.map(p => ({
      ...p,
      x: p.x + p.speed,
      active: p.x < 100
    }));

    // Respawn particles
    particles = particles.map(p =>
      p.x >= 100 ? {x: 0, y: 50 + (Math.random() - 0.5) * 20, speed: p.speed, active: true} : p
    );

    if (version === 2) {
      animationId = requestAnimationFrame(animateParticles);
    }
  }

  $: if (version === 2) {
    initParticles();
  } else if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  onDestroy(() => {
    if (animationId) cancelAnimationFrame(animationId);
  });
</script>

<div class="evolution-wrapper" class:version-2={version === 2} class:version-3={version === 3}>
  <div class="evo-continuous">
    <!-- Continuous baseline -->
    <div class="timeline-baseline">
      <!-- Big Bang (dramatic) -->
      <div class="bang-origin">
        <div class="bang-circle">
          <div class="bang-core"></div>
          <div class="bang-ring"></div>
          <div class="bang-ring-2"></div>
        </div>
        <div class="bang-label">Big Bang</div>
      </div>

      <!-- Continuous line with embedded milestones -->
      <div class="timeline-flow">
        <!-- Banking era (thick gray) -->
        <div class="flow-segment flow-banking">
          <div class="segment-line"></div>
          <div class="milestone">
            <div class="milestone-date">~5000 BC</div>
            <img src="/bikes/fcuan.svg" alt="FCUAN" class="milestone-bike" />
            <div class="milestone-title">FCUAN</div>
            <div class="milestone-subtitle">Full-Credit Unprovable Account Networks</div>
            <InvariantTicker label="" description="−leftCredit ≤ Δ ≤ rightCredit" pattern="[---.---]" speed={4} />
            <div class="milestone-text">Banking. Pure credit, 7000 years.</div>
          </div>
        </div>

        <!-- Lightning branch (thin green dashed) -->
        <div class="flow-segment flow-lightning">
          <div class="segment-line"></div>
          <div class="lightning-branch"></div>
          <div class="milestone milestone-branch">
            <div class="milestone-date">2015</div>
            <img src="/bikes/frpap.svg" alt="FRPAP" class="milestone-bike milestone-bike-dim" />
            <div class="milestone-title">FRPAP</div>
            <div class="milestone-subtitle">Full-Reserve Provable Account Primitives</div>
            <InvariantTicker label="" description="0 ≤ Δ ≤ collateral" pattern="[.===]" speed={4} />
            <div class="milestone-text">Lightning. Failed.</div>
          </div>
        </div>

        <!-- MERGE point -->
        <div class="merge-zone">
          <div class="merge-badge">⊃ MERGE</div>
        </div>

        <!-- RCPAN future (THICK bright green) -->
        <div class="flow-segment flow-finale">
          <div class="segment-line"></div>
          <div class="milestone milestone-finale">
            <div class="milestone-date">2026 →</div>
            <img src="/bikes/rcpan.svg" alt="RCPAN" class="milestone-bike milestone-bike-finale" />
            <div class="milestone-title milestone-title-finale">RCPAN</div>
            <div class="milestone-subtitle">Reserve-Credit Provable Account Network</div>
            <InvariantTicker label="" description="−leftCredit ≤ Δ ≤ collateral + rightCredit" pattern="[---.===---]" speed={4} />
            <div class="milestone-text milestone-text-finale"><strong>xln:</strong> Banking + Lightning = RCPAN.</div>
          </div>
        </div>

        <!-- Future continuation -->
        <div class="future-arrow">→ ∞</div>
      </div>
    </div>

    {#if version === 2}
      <!-- Animated particles overlay -->
      <svg class="particles-layer" viewBox="0 0 100 100" preserveAspectRatio="none">
        {#each particles.filter(p => p.active) as particle}
          <circle cx={particle.x} cy={particle.y} r="0.3" fill="#4fd18b" opacity="0.6" />
        {/each}
      </svg>
    {/if}
  </div>

  <!-- Color Legend -->
  <div class="color-legend">
    <div class="legend-item">
      <span class="legend-box legend-credit">−</span>
      <span class="legend-text">Credit (Red)</span>
    </div>
    <div class="legend-item">
      <span class="legend-box legend-reserve">=</span>
      <span class="legend-text">Reserve (Green)</span>
    </div>
    <div class="legend-item">
      <span class="legend-box legend-both">−.=</span>
      <span class="legend-text">RCPAN = Both United</span>
    </div>
  </div>
</div>

<style>
  .evolution-wrapper {
    margin: 3rem 0;
    padding: 3rem 2rem;
    background: linear-gradient(135deg, rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.15));
    border-radius: 16px;
    position: relative;
  }

  .evo-continuous {
    position: relative;
  }

  .timeline-baseline {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  /* Big Bang - Dramatic */
  .bang-origin {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .bang-circle {
    position: relative;
    width: 80px;
    height: 80px;
  }

  .bang-core {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 24px;
    height: 24px;
    background: radial-gradient(circle, #fff 0%, #ffd700 50%, #ff6b6b 100%);
    border-radius: 50%;
    box-shadow: 0 0 40px rgba(255, 255, 255, 0.9), 0 0 80px rgba(255, 215, 0, 0.6);
    animation: pulse-bang 2s ease-in-out infinite;
  }

  .bang-ring {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 50px;
    height: 50px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-radius: 50%;
    animation: expand-ring 3s ease-out infinite;
  }

  .bang-ring-2 {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 70px;
    height: 70px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 50%;
    animation: expand-ring 3s ease-out infinite 1.5s;
  }

  @keyframes pulse-bang {
    0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    50% { transform: translate(-50%, -50%) scale(1.1); opacity: 0.9; }
  }

  @keyframes expand-ring {
    0% { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
    50% { opacity: 0.4; }
    100% { transform: translate(-50%, -50%) scale(1.5); opacity: 0; }
  }

  .bang-label {
    font-size: 1.1rem;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.9);
  }

  /* Timeline Flow - Truly Continuous */
  .timeline-flow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: relative;
  }

  .flow-segment {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .flow-finale {
    flex: 1.5;
  }

  .segment-line {
    position: absolute;
    top: 120px;
    left: 0;
    right: 0;
    height: 8px;
    z-index: 0;
  }

  .flow-banking .segment-line {
    background: linear-gradient(to right, rgba(200,200,200,0.7), rgba(200,200,200,0.5));
    height: 12px;
  }

  .flow-lightning .segment-line {
    background: rgba(200,200,200,0.4);
    height: 10px;
  }

  .lightning-branch {
    position: absolute;
    top: 140px;
    left: 0;
    right: 0;
    height: 3px;
    background: linear-gradient(to right, transparent, rgba(79,209,139,0.5));
    border-top: 2px dashed rgba(79,209,139,0.4);
  }

  .flow-finale .segment-line {
    background: linear-gradient(to right, rgba(79,209,139,0.7), rgba(79,209,139,0.95));
    height: 24px;
    box-shadow: 0 0 32px rgba(79,209,139,0.6);
    animation: pulse-future 3s ease-in-out infinite;
  }

  @keyframes pulse-future {
    0%, 100% { box-shadow: 0 0 32px rgba(79,209,139,0.6); }
    50% { box-shadow: 0 0 48px rgba(79,209,139,0.8); }
  }

  .merge-zone {
    position: relative;
    z-index: 5;
  }

  .merge-badge {
    background: rgba(79, 209, 139, 0.2);
    border: 2px solid rgba(79, 209, 139, 0.6);
    color: #4fd18b;
    padding: 0.6rem 1.2rem;
    border-radius: 16px;
    font-size: 0.95rem;
    font-weight: 700;
    box-shadow: 0 0 24px rgba(79, 209, 139, 0.4);
  }

  .future-arrow {
    font-size: 2rem;
    font-weight: 700;
    color: #4fd18b;
    filter: drop-shadow(0 0 16px rgba(79,209,139,0.8));
  }

  /* Milestones */
  .milestone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    position: relative;
    z-index: 2;
    padding: 1rem 0;
  }

  .milestone-date {
    font-size: 1rem;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.8);
    margin-bottom: 0.5rem;
  }

  .milestone-bike {
    width: 140px;
    height: auto;
    filter: brightness(1.1) drop-shadow(0 4px 12px rgba(0,0,0,0.4));
    transition: transform 0.3s ease;
  }

  .milestone-bike-dim {
    width: 110px;
    opacity: 0.65;
  }

  .milestone-bike-finale {
    width: 220px;
    filter: brightness(1.25) drop-shadow(0 8px 24px rgba(79,209,139,0.5));
  }

  .version-3 .milestone:hover .milestone-bike {
    transform: scale(1.1);
  }

  .milestone-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.95);
  }

  .milestone-title-finale {
    font-size: 2rem;
    color: #4fd18b;
    text-shadow: 0 0 20px rgba(79,209,139,0.7);
  }

  .milestone-subtitle {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
    font-style: italic;
    text-align: center;
    max-width: 200px;
    line-height: 1.3;
  }

  .milestone-text {
    font-size: 0.8rem;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.7);
    text-align: center;
    max-width: 200px;
    margin-top: 0.5rem;
  }

  .milestone-text-finale {
    max-width: 280px;
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.9);
    font-weight: 600;
  }

  /* Particles overlay */
  .particles-layer {
    position: absolute;
    top: 200px;
    left: 0;
    width: 100%;
    height: 50px;
    pointer-events: none;
    z-index: 1;
  }

  /* Color Legend */
  .color-legend {
    display: flex;
    justify-content: center;
    gap: 3rem;
    margin-top: 3rem;
    padding-top: 2rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .legend-box {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.2rem;
    font-weight: 700;
    padding: 0.5rem 0.8rem;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .legend-credit {
    color: #ff4d6a;
  }

  .legend-reserve {
    color: #4fd18b;
  }

  .legend-both {
    background: linear-gradient(135deg, rgba(255,77,106,0.2), rgba(79,209,139,0.2));
    border-color: rgba(79, 209, 139, 0.3);
  }

  .legend-text {
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.7);
    font-weight: 500;
  }
</style>
