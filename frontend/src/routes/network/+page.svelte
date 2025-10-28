<script lang="ts">
  import { onMount } from 'svelte';

  // Network topology: X-shaped (1 hub + 4 spokes)
  const SERVERS = [
    { id: 'hub', x: 50, y: 50, label: 'Hub Entity' },
    { id: 'n', x: 50, y: 15, label: 'North' },
    { id: 'e', x: 85, y: 50, label: 'East' },
    { id: 's', x: 50, y: 85, label: 'South' },
    { id: 'w', x: 15, y: 50, label: 'West' }
  ];

  let selectedServer = 'hub';
</script>

<div class="network-page">
  <div class="header">
    <h1>Network Topology: Bird's Eye View</h1>
    <p class="subtitle">5 physical servers. X-shaped formation. Geology of settlement.</p>
  </div>

  <div class="network-canvas">
    <svg class="topology-svg" viewBox="0 0 100 100">
      <!-- Connection lines (unicast) -->
      <line x1="50" y1="50" x2="50" y2="15" stroke="rgba(0,209,255,0.3)" stroke-width="0.3" />
      <line x1="50" y1="50" x2="85" y2="50" stroke="rgba(0,209,255,0.3)" stroke-width="0.3" />
      <line x1="50" y1="50" x2="50" y2="85" stroke="rgba(0,209,255,0.3)" stroke-width="0.3" />
      <line x1="50" y1="50" x2="15" y2="50" stroke="rgba(0,209,255,0.3)" stroke-width="0.3" />

      <!-- Server nodes -->
      {#each SERVERS as server}
        <g
          class="server-node"
          class:selected={selectedServer === server.id}
          on:click={() => selectedServer = server.id}
          style="cursor: pointer;"
        >
          <circle cx={server.x} cy={server.y} r="3" fill="rgba(79,209,139,0.2)" stroke="#4fd18b" stroke-width="0.2" />
          <text x={server.x} y={server.y - 4} text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="2">{server.label}</text>
        </g>
      {/each}
    </svg>
  </div>

  <!-- Detailed Server View (Geological Layers) -->
  <div class="server-detail">
    <h2>Server: {SERVERS.find(s => s.id === selectedServer)?.label}</h2>

    <div class="layers-stack">
      <!-- Bottom: Runtime Machine -->
      <div class="layer layer-runtime">
        <div class="layer-label">Runtime Machine</div>
        <div class="layer-desc">100ms tick coordinator. R→E→A routing. Pure functions.</div>
      </div>

      <!-- Middle: J-Machine (Broadcast / Radio Tower) -->
      <div class="layer layer-j">
        <div class="layer-icon">📡</div>
        <div class="layer-label">J-Machine (Broadcast)</div>
        <div class="layer-desc">Jurisdiction monitor. Watches blockchain. O(n) when settling.</div>
        <div class="broadcast-viz">
          {#each [0,1,2,3,4,5,6,7] as i}
            <div class="broadcast-ray" style="transform: rotate({i * 45}deg)"></div>
          {/each}
        </div>
      </div>

      <!-- Upper Middle: E-Machine (Entity Consensus) -->
      <div class="layer layer-e">
        <div class="layer-label">E-Machine (BFT Consensus)</div>
        <div class="layer-desc">ADD_TX → PROPOSE → SIGN → COMMIT. Threshold signatures.</div>
        <div class="consensus-nodes">
          {#each [1,2,3] as n}
            <div class="validator-dot"></div>
          {/each}
        </div>
      </div>

      <!-- Top: A-Machines (Bilateral Accounts) -->
      <div class="layer layer-a">
        <div class="layer-label">A-Machines (Unicast Accounts)</div>
        <div class="accounts-viz">
          {#if selectedServer === 'hub'}
            <div class="account-line">Hub ←→ North</div>
            <div class="account-line">Hub ←→ East</div>
            <div class="account-line">Hub ←→ South</div>
            <div class="account-line">Hub ←→ West</div>
          {:else}
            <div class="account-line">{SERVERS.find(s => s.id === selectedServer)?.label} ←→ Hub</div>
          {/if}
        </div>
        <div class="layer-desc">Instant bilateral settlement. O(1) updates.</div>
      </div>
    </div>
  </div>

  <div class="legend">
    <div class="legend-item">
      <div class="legend-box legend-runtime"></div>
      <span>Runtime (foundation)</span>
    </div>
    <div class="legend-item">
      <div class="legend-box legend-j"></div>
      <span>J-Machine (broadcast, O(n))</span>
    </div>
    <div class="legend-item">
      <div class="legend-box legend-e"></div>
      <span>E-Machine (BFT consensus)</span>
    </div>
    <div class="legend-item">
      <div class="legend-box legend-a"></div>
      <span>A-Machines (unicast, O(1))</span>
    </div>
  </div>
</div>

<style>
  .network-page {
    min-height: 100vh;
    background: #000;
    color: #fff;
    padding: 4rem 2rem;
  }

  .header {
    text-align: center;
    margin-bottom: 4rem;
  }

  .header h1 {
    font-size: 3rem;
    font-weight: 700;
    color: #4fd18b;
  }

  .subtitle {
    font-size: 1.2rem;
    color: rgba(255,255,255,0.7);
    margin-top: 1rem;
  }

  .network-canvas {
    max-width: 1200px;
    margin: 0 auto 4rem;
    background: rgba(0,0,0,0.3);
    border-radius: 16px;
    padding: 3rem;
  }

  .topology-svg {
    width: 100%;
    height: 600px;
  }

  .server-node circle:hover {
    fill: rgba(79,209,139,0.4);
  }

  .server-node.selected circle {
    r: 4;
    fill: rgba(79,209,139,0.5);
    stroke-width: 0.4;
  }

  /* Server Detail - Premium Stripe-style Layers */
  .server-detail {
    max-width: 1100px;
    margin: 0 auto;
    perspective: 1000px;
  }

  .server-detail h2 {
    text-align: center;
    color: #00d1ff;
    font-size: 2.5rem;
    margin-bottom: 3rem;
    font-weight: 700;
  }

  .layers-stack {
    display: flex;
    flex-direction: column;
    gap: 0;
    position: relative;
  }

  .layer {
    padding: 3.5rem 4rem;
    position: relative;
    transform-style: preserve-3d;
    transition: transform 0.3s ease;
  }

  .layer:hover {
    transform: translateZ(20px);
  }

  /* Runtime - Dark Foundation */
  .layer-runtime {
    background:
      linear-gradient(135deg, rgba(20,20,25,0.95) 0%, rgba(30,30,35,0.9) 100%),
      radial-gradient(circle at top left, rgba(100,100,120,0.15), transparent 50%);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 20px 20px 0 0;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.05),
      0 4px 20px rgba(0,0,0,0.3);
  }

  /* J-Machine - Orange Broadcast Glow */
  .layer-j {
    background:
      linear-gradient(135deg, rgba(255,130,0,0.12) 0%, rgba(255,100,0,0.08) 100%),
      radial-gradient(circle at center, rgba(255,165,0,0.15), transparent 70%);
    border-left: 3px solid rgba(255,140,0,0.4);
    border-right: 3px solid rgba(255,140,0,0.4);
    box-shadow:
      inset 0 2px 0 rgba(255,165,0,0.1),
      0 8px 32px rgba(255,140,0,0.15),
      0 -4px 20px rgba(0,0,0,0.2);
    position: relative;
    overflow: hidden;
    transform: translateZ(10px);
  }

  .layer-j::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(255,165,0,0.5), transparent);
  }

  /* E-Machine - Blue Consensus */
  .layer-e {
    background:
      linear-gradient(135deg, rgba(0,120,255,0.12) 0%, rgba(0,90,200,0.08) 100%),
      radial-gradient(circle at center, rgba(0,150,255,0.15), transparent 70%);
    border-left: 3px solid rgba(0,150,255,0.4);
    border-right: 3px solid rgba(0,150,255,0.4);
    box-shadow:
      inset 0 2px 0 rgba(0,150,255,0.1),
      0 12px 40px rgba(0,120,255,0.2),
      0 -4px 20px rgba(0,0,0,0.25);
    transform: translateZ(20px);
  }

  /* A-Machines - Green Unicast (Top Layer) */
  .layer-a {
    background:
      linear-gradient(135deg, rgba(79,209,139,0.18) 0%, rgba(79,209,139,0.12) 100%),
      radial-gradient(circle at top center, rgba(79,255,180,0.2), transparent 60%);
    border: 2px solid rgba(79,209,139,0.5);
    border-radius: 0 0 20px 20px;
    box-shadow:
      inset 0 3px 0 rgba(79,209,139,0.15),
      0 16px 48px rgba(79,209,139,0.3),
      0 8px 24px rgba(0,0,0,0.3);
    transform: translateZ(30px);
  }

  .layer-a::before {
    content: '';
    position: absolute;
    top: -2px;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, transparent, rgba(79,209,139,0.7), transparent);
    filter: blur(2px);
  }

  .layer-label {
    font-size: 1.8rem;
    font-weight: 700;
    color: rgba(255,255,255,0.98);
    margin-bottom: 1rem;
    letter-spacing: -0.02em;
  }

  .layer-runtime .layer-label {
    color: rgba(200,200,210,0.9);
  }

  .layer-j .layer-label {
    color: rgba(255,180,80,0.95);
  }

  .layer-e .layer-label {
    color: rgba(100,180,255,0.95);
  }

  .layer-a .layer-label {
    color: rgba(79,255,180,0.98);
  }

  .layer-desc {
    font-size: 1.05rem;
    color: rgba(255,255,255,0.75);
    line-height: 1.8;
    max-width: 600px;
  }

  .layer-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
    filter: drop-shadow(0 4px 12px rgba(255,165,0,0.4));
  }

  /* J-Machine Broadcast Visualization */
  .broadcast-viz {
    position: absolute;
    top: 50%;
    right: 2rem;
    width: 60px;
    height: 60px;
    transform: translateY(-50%);
  }

  .broadcast-ray {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 30px;
    height: 2px;
    background: linear-gradient(to right, rgba(255,165,0,0.8), transparent);
    transform-origin: left center;
    animation: pulse-ray 2s ease-in-out infinite;
  }

  @keyframes pulse-ray {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.8; }
  }

  .consensus-nodes {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .validator-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: rgba(0,100,200,0.6);
    border: 2px solid rgba(0,150,255,0.8);
  }

  .accounts-viz {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .account-line {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    color: rgba(79,209,139,0.9);
    padding: 0.5rem;
    background: rgba(79,209,139,0.05);
    border-radius: 4px;
  }

  .legend {
    display: flex;
    justify-content: center;
    gap: 2rem;
    margin-top: 4rem;
    flex-wrap: wrap;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .legend-box {
    width: 30px;
    height: 20px;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.2);
  }

  .legend-runtime { background: rgba(100,100,100,0.4); }
  .legend-j { background: rgba(255,165,0,0.3); }
  .legend-e { background: rgba(0,100,200,0.3); }
  .legend-a { background: rgba(79,209,139,0.3); }

  .legend-item span {
    font-size: 0.85rem;
    color: rgba(255,255,255,0.7);
  }
</style>
