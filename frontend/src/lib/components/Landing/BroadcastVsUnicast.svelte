<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import NetworkLegend from './NetworkLegend.svelte';

  let currentTPS = 1;
  let blockNumber = 0;
  let isPlaying = false; // Start paused so user can control
  let animationFrame: number | null = null;
  let lastTimestamp = 0;

  // Blockchain state
  interface Transaction {
    id: number;
    fromNode: number;
    x: number;
    y: number;
    progress: number; // 0-1
  }

  interface Block {
    number: number;
    txs: number[]; // Just tx IDs
    status: 'building' | 'finalized';
  }

  let consensusBlock: Block = { number: 0, txs: [], status: 'building' };
  let finalizedBlocks: Block[] = [];
  let flyingTxs: Transaction[] = [];
  let raycastingBlock: number | null = null; // Block number being synced
  let txCounter = 0;
  let txAccumulator = 0;

  const BLOCK_SIZE = 10;
  const CONSENSUS_BLOCK_X = viewWidth - 100;
  const CONSENSUS_BLOCK_Y = 50;

  // Device health tracking with positions
  interface DeviceState {
    type: 'phone' | 'laptop' | 'server' | 'datacenter';
    health: number; // 0-100
    maxTPS: number;
    status: 'ok' | 'struggling' | 'critical' | 'offline' | 'pruned';
    x: number;
    y: number;
    icon: string;
  }

  let broadcastDevices: DeviceState[] = [];
  let unicastDevices: DeviceState[] = [];

  const viewWidth = 600;
  const viewHeight = 600;
  const centerX = viewWidth / 2;
  const centerY = viewHeight / 2;

  function randomInZone(minRadius: number, maxRadius: number): {x: number, y: number} {
    const angle = Math.random() * 2 * Math.PI;
    const radius = minRadius + Math.random() * (maxRadius - minRadius);
    return {
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle)
    };
  }

  function initializeDevices() {
    broadcastDevices = [];
    unicastDevices = [];

    // 100 nodes total - realistic distribution
    const configs = [
      { type: 'datacenter', count: 1, minR: 20, maxR: 40, maxTPS: 100000, icon: '/img/primitives/datacenter.svg' },
      { type: 'server', count: 5, minR: 80, maxR: 120, maxTPS: 1000, icon: '/img/primitives/server.svg' },
      { type: 'laptop', count: 24, minR: 140, maxR: 200, maxTPS: 100, icon: '/img/primitives/laptop.svg' },
      { type: 'phone', count: 70, minR: 210, maxR: 290, maxTPS: 10, icon: '/img/primitives/phone.svg' },
    ] as const;

    configs.forEach(config => {
      for (let i = 0; i < config.count; i++) {
        const pos = randomInZone(config.minR, config.maxR);

        const device: DeviceState = {
          type: config.type,
          health: 100,
          maxTPS: config.maxTPS,
          status: 'ok',
          x: pos.x,
          y: pos.y,
          icon: config.icon
        };

        // Mirror positions on both sides
        broadcastDevices.push({ ...device });
        unicastDevices.push({ ...device });
      }
    });
  }

  function updateDeviceHealth() {
    // BROADCAST: Devices suffer under load
    broadcastDevices.forEach(device => {
      if (currentTPS > device.maxTPS) {
        const overload = (currentTPS - device.maxTPS) / device.maxTPS;
        device.health = Math.max(0, device.health - overload * 2);

        if (device.health > 60) device.status = 'struggling';
        else if (device.health > 30) device.status = 'critical';
        else if (device.health > 0) device.status = 'offline';
        else {
          // Phones/laptops give up (pruned), servers/datacenters try to sync
          device.status = (device.type === 'phone' || device.type === 'laptop') ? 'pruned' : 'offline';
        }
      } else {
        // Recover slowly if TPS drops
        device.health = Math.min(100, device.health + 1);
        if (device.health > 80) device.status = 'ok';
      }
    });

    // UNICAST: All devices always healthy (L1 constant at 1 TPS)
    unicastDevices.forEach(device => {
      device.health = 100;
      device.status = 'ok';
    });
  }

  function animate(timestamp: number) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    const deltaTime = (timestamp - lastTimestamp) / 1000; // seconds
    lastTimestamp = timestamp;

    if (isPlaying) {
      // Auto-increment TPS (1 to 1000 over 60 seconds)
      currentTPS = Math.min(1000, currentTPS + (1000 / 60) * deltaTime);
    }

    // Accumulate transactions based on current TPS
    txAccumulator += currentTPS * deltaTime;

    // Spawn new transactions
    while (txAccumulator >= 1 && consensusBlock.txs.length < BLOCK_SIZE) {
      txAccumulator -= 1;
      spawnTransaction();
    }

    // Update flying transactions
    flyingTxs.forEach(tx => {
      tx.progress += deltaTime * 2; // 0.5 second flight time
      if (tx.progress >= 1) {
        // Arrived at consensus block
        consensusBlock.txs.push(tx.id);
        flyingTxs = flyingTxs.filter(t => t.id !== tx.id);

        // Block full? Finalize it
        if (consensusBlock.txs.length >= BLOCK_SIZE) {
          finalizeBlock();
        }
      } else {
        // Update position (lerp from node to consensus block)
        const node = broadcastDevices[tx.fromNode];
        if (node) {
          tx.x = node.x + (CONSENSUS_BLOCK_X - node.x) * tx.progress;
          tx.y = node.y + (CONSENSUS_BLOCK_Y - node.y) * tx.progress;
        }
      }
    });

    updateDeviceHealth();

    animationFrame = requestAnimationFrame(animate);
  }

  function spawnTransaction() {
    // Pick random alive node
    const aliveNodes = broadcastDevices
      .map((d, i) => ({ device: d, index: i }))
      .filter(n => n.device.status === 'ok' || n.device.status === 'struggling');

    if (aliveNodes.length === 0) return;

    const { device, index } = aliveNodes[Math.floor(Math.random() * aliveNodes.length)];

    flyingTxs.push({
      id: txCounter++,
      fromNode: index,
      x: device.x,
      y: device.y,
      progress: 0
    });
  }

  function finalizeBlock() {
    const finalized: Block = {
      number: consensusBlock.number,
      txs: [...consensusBlock.txs],
      status: 'finalized'
    };

    finalizedBlocks = [finalized, ...finalizedBlocks].slice(0, 10);

    // Trigger raycast animation
    raycastingBlock = finalized.number;
    setTimeout(() => {
      raycastingBlock = null;
    }, 1000); // 1 second raycast duration

    // Start new block
    consensusBlock = { number: consensusBlock.number + 1, txs: [], status: 'building' };
  }

  onMount(() => {
    initializeDevices();
    animationFrame = requestAnimationFrame(animate);
  });

  onDestroy(() => {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  });

  function togglePlay() {
    isPlaying = !isPlaying;
  }

  function formatTPS(tps: number): string {
    if (tps >= 1000000) return `${(tps / 1000000).toFixed(1)}M`;
    if (tps >= 1000) return `${(tps / 1000).toFixed(0)}K`;
    return tps.toString();
  }

  function deviceColor(status: string): string {
    switch(status) {
      case 'ok': return '#4fd18b';
      case 'struggling': return '#ffd700';
      case 'critical': return '#ff8c00';
      case 'offline': return '#ff6b6b';
      case 'pruned': return '#888888';
      default: return '#ffffff';
    }
  }

  function deviceGlow(status: string): string {
    switch(status) {
      case 'ok': return 'drop-shadow(0 0 8px #4fd18b)';
      case 'struggling': return 'drop-shadow(0 0 8px #ffd700)';
      case 'critical': return 'drop-shadow(0 0 12px #ff8c00)';
      case 'offline': return 'drop-shadow(0 0 6px #ff6b6b)';
      case 'pruned': return 'none';
      default: return 'none';
    }
  }

  $: broadcastAlive = broadcastDevices.filter(d => d.status === 'ok' || d.status === 'struggling').length;
  $: broadcastDead = broadcastDevices.filter(d => d.status === 'pruned' || d.status === 'offline').length;
  $: unicastAlive = unicastDevices.length; // Always all alive
</script>

<div class="comparison-container">
  <div class="comparison-header">
    <h2>Why Broadcast Dies at Scale (Visual Proof)</h2>
    <div class="controls">
      <div class="tps-control">
        <label>
          Network TPS: <span class="tps-value">{Math.round(currentTPS)}</span>
          <input
            type="range"
            min="1"
            max="1000"
            step="1"
            bind:value={currentTPS}
            class="tps-slider"
          />
        </label>
      </div>
      <button on:click={togglePlay} class="play-btn">
        {isPlaying ? '⏸ Stop Auto' : '▶ Auto Ramp'}
      </button>
    </div>
  </div>

  <NetworkLegend />

  <div class="split-screen">
    <!-- LEFT: Broadcast O(n) -->
    <div class="side broadcast">
      <h3>Broadcast O(n)</h3>
      <p class="subtitle">Bitcoin, Ethereum, Solana, Rollups</p>

      <div class="blockchain-layer">
        <!-- Finalized blocks (historical chain on left) -->
        <div class="finalized-blocks">
          {#each finalizedBlocks as blockNum}
            <div class="block finalized" title="Block #{blockNum}">
              #{blockNum}
            </div>
          {/each}
        </div>

        <!-- Current consensus block (building on right) -->
        <div class="consensus-block {consensusBlock.status}">
          <div class="block-label">Consensus</div>
          <div class="tx-count">{consensusBlock.txCount}/{BLOCK_SIZE}</div>
        </div>
      </div>

      <div class="devices-layer">
        <div class="status-bar">
          <span style="color: {deviceColor('ok')}">✓ {broadcastAlive} alive</span>
          <span style="color: {deviceColor('pruned')}">✗ {broadcastDead} dead/pruned</span>
        </div>
        <svg class="device-scene" viewBox="0 0 {viewWidth} {viewHeight}" xmlns="http://www.w3.org/2000/svg">
          <!-- Raycast lines (when block finalizes, ALL nodes download) -->
          {#if raycastingBlock !== null}
            {#each broadcastDevices as device, i}
              {#if device.status === 'ok' || device.status === 'struggling'}
                <line
                  x1={device.x} y1={device.y}
                  x2={CONSENSUS_BLOCK_X} y2={CONSENSUS_BLOCK_Y}
                  stroke="#4fd18b"
                  stroke-width="1"
                  opacity="0.6"
                  class="raycast-line"
                />
              {/if}
            {/each}
          {/if}

          <!-- RPC zombie lines (dead nodes trust datacenters) -->
          {#each broadcastDevices as device, i}
            {#if device.status === 'pruned' || device.status === 'offline'}
              <line
                x1={device.x} y1={device.y}
                x2={centerX} y2={centerY}
                stroke="rgba(255,255,255,0.1)"
                stroke-dasharray="4 4"
                stroke-width="1"
              />
            {/if}
          {/each}

          <!-- Flying transactions -->
          {#each flyingTxs as tx}
            <circle
              cx={tx.x} cy={tx.y}
              r="4"
              fill="#00d1ff"
              opacity="0.8"
              style="filter: drop-shadow(0 0 4px #00d1ff)"
            />
          {/each}

          <!-- Devices -->
          {#each broadcastDevices as device, i}
            <g transform="translate({device.x}, {device.y})">
              <!-- Device icon -->
              <image
                href={device.icon}
                x="-35" y="-35"
                width="70" height="70"
                opacity={device.status === 'pruned' ? 0.3 : device.status === 'offline' ? 0.5 : 1}
                style="filter: {deviceGlow(device.status)}; color: {deviceColor(device.status)}"
              />
              <!-- EVM logo (syncing indicator) -->
              <image
                href="/img/evm.svg"
                x="-8" y="-8"
                width="16" height="16"
                opacity={raycastingBlock !== null && (device.status === 'ok' || device.status === 'struggling') ? 1 : 0.3}
                class:syncing={raycastingBlock !== null}
                style="color: {deviceColor(device.status)}"
              />
            </g>
          {/each}

          <!-- Jail bars over datacenter region at high TPS -->
          {#if currentTPS >= 10000 && broadcastAlive <= 5}
            <defs>
              <pattern id="jail-bars" width="12" height="40" patternUnits="userSpaceOnUse">
                <rect width="4" height="40" fill="#888"/>
              </pattern>
            </defs>
            <rect x={centerX - 80} y={centerY - 80} width="160" height="160"
                  fill="url(#jail-bars)" opacity="0.7" rx="8"/>
          {/if}
        </svg>
      </div>
    </div>

    <!-- DIVIDER -->
    <div class="vertical-divider"></div>

    <!-- RIGHT: Unicast O(1) -->
    <div class="side unicast">
      <h3>Unicast O(1)</h3>
      <p class="subtitle">xln (netting layer)</p>

      <div class="netting-layer">
        <div class="netting-label">Hub-Spoke Netting (L2)</div>
        <div class="netting-visual">
          <div class="hub">HUB</div>
          <div class="spokes">
            {#each Array(8) as _, i}
              <div class="spoke" style="transform: rotate({i * 45}deg)"></div>
            {/each}
          </div>
        </div>
      </div>

      <div class="j-layer">
        <div class="j-label">J-Machine (Settlement Only)</div>
        <div class="block-display">Block #{blockNumber}</div>
        <div class="l1-rate constant">L1 Required: 1 TPS (constant)</div>
      </div>

      <div class="devices-layer">
        <div class="status-bar">
          <span style="color: {deviceColor('ok')}">✓ {unicastAlive} alive</span>
        </div>
        <svg class="device-scene" viewBox="0 0 {viewWidth} {viewHeight}" xmlns="http://www.w3.org/2000/svg">
          {#each unicastDevices as device, i}
            <g transform="translate({device.x}, {device.y})">
              <image
                href={device.icon}
                x="-35" y="-35"
                width="70" height="70"
                style="filter: {deviceGlow(device.status)}; color: {deviceColor(device.status)}"
              />
            </g>
          {/each}
        </svg>
      </div>
    </div>
  </div>

  <div class="insight">
    {#if currentTPS <= 10}
      <p>✓ At low TPS, both architectures work fine</p>
    {:else if currentTPS <= 100}
      <p>⚠ Broadcast: Phones struggling. Unicast: Still perfect.</p>
    {:else if currentTPS <= 1000}
      <p>❌ Broadcast: Only servers survive. Unicast: All devices fine (L1 still 1 TPS)</p>
    {:else if currentTPS <= 100000}
      <p>💥 Broadcast: Datacenter-only (centralization). Unicast: Everyone fine.</p>
    {:else}
      <p>☠️ Broadcast: Complete failure. Unicast: Infinite scalability — L1 never changes.</p>
    {/if}
  </div>
</div>

<style>
  .comparison-container {
    width: 100%;
    max-width: 1400px;
    margin: 3rem 0;
  }

  .comparison-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .comparison-header h2 {
    font-size: 1.5rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
    margin: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 2rem;
    flex-wrap: wrap;
  }

  .tps-control {
    flex: 1;
    min-width: 300px;
  }

  .tps-control label {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .tps-value {
    font-weight: 600;
    color: #4fd18b;
    font-family: 'JetBrains Mono', monospace;
  }

  .tps-slider {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.1);
    outline: none;
    cursor: pointer;
  }

  .tps-slider::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #4fd18b;
    cursor: pointer;
  }

  .tps-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #4fd18b;
    cursor: pointer;
    border: none;
  }

  .play-btn {
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .play-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .split-screen {
    display: grid;
    grid-template-columns: 1fr 2px 1fr;
    gap: 2rem;
    min-height: 500px;
  }

  .vertical-divider {
    background: linear-gradient(to bottom,
      transparent,
      rgba(255, 255, 255, 0.3) 20%,
      rgba(255, 255, 255, 0.3) 80%,
      transparent
    );
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .side h3 {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0;
    color: rgba(255, 255, 255, 0.95);
  }

  .subtitle {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.5);
    margin: -1rem 0 0;
  }

  .blockchain-layer {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
    background: rgba(20, 20, 30, 0.6);
    border-radius: 8px;
    min-height: 80px;
    overflow-x: auto;
  }

  .finalized-blocks {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .block {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    font-weight: 600;
    min-width: 60px;
    text-align: center;
  }

  .block.finalized {
    background: rgba(79, 209, 139, 0.1);
    border: 2px solid #4fd18b;
    color: #4fd18b;
  }

  .consensus-block {
    padding: 1rem;
    border-radius: 6px;
    border: 2px solid #ff8c00;
    background: rgba(255, 140, 0, 0.1);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    min-width: 100px;
  }

  .consensus-block.finalizing {
    border-color: #4fd18b;
    background: rgba(79, 209, 139, 0.15);
    animation: finalize-pulse 0.5s ease;
  }

  @keyframes finalize-pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.05); }
  }

  .block-label {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
  }

  .tx-count {
    font-size: 1.2rem;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    color: rgba(255, 255, 255, 0.9);
  }

  .j-layer {
    background: rgba(100, 100, 255, 0.1);
    border: 2px solid rgba(100, 100, 255, 0.3);
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: center;
  }

  .j-label {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.6);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .block-display {
    font-size: 1.1rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    font-family: 'JetBrains Mono', monospace;
  }

  .l1-rate {
    font-size: 0.85rem;
    color: #ff8c00;
    font-family: 'JetBrains Mono', monospace;
  }

  .l1-rate.constant {
    color: #4fd18b;
  }

  .netting-layer {
    background: rgba(79, 209, 139, 0.1);
    border: 2px solid rgba(79, 209, 139, 0.3);
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: center;
  }

  .netting-label {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.6);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .netting-visual {
    position: relative;
    width: 120px;
    height: 120px;
  }

  .hub {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 40px;
    height: 40px;
    background: #4fd18b;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-weight: 600;
    color: #000;
    z-index: 2;
  }

  .spokes {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .spoke {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 60px;
    height: 2px;
    background: rgba(79, 209, 139, 0.4);
    transform-origin: 0 center;
  }

  .spoke::after {
    content: '';
    position: absolute;
    right: -6px;
    top: -4px;
    width: 8px;
    height: 8px;
    background: rgba(79, 209, 139, 0.6);
    border-radius: 50%;
  }

  .devices-layer {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .status-bar {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    font-family: 'JetBrains Mono', monospace;
  }

  .device-scene {
    width: 100%;
    height: 600px;
    background: rgba(10, 10, 15, 0.8);
    border-radius: 8px;
    border: 1px solid rgba(79, 209, 139, 0.2);
  }

  .device-scene image {
    transition: opacity 0.5s ease;
    filter: brightness(1.3) contrast(1.2);
  }

  .device-scene image.syncing {
    animation: sync-pulse 0.5s ease-in-out;
  }

  @keyframes sync-pulse {
    0%, 100% { opacity: 0.3; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.3); }
  }

  .raycast-line {
    animation: raycast-fade 1s ease-out;
  }

  @keyframes raycast-fade {
    0% { opacity: 0; stroke-width: 2; }
    20% { opacity: 0.8; }
    100% { opacity: 0; stroke-width: 0.5; }
  }

  .insight {
    margin-top: 2rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-left: 3px solid #4fd18b;
    border-radius: 4px;
  }

  .insight p {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.85);
  }

  @media (max-width: 1024px) {
    .split-screen {
      grid-template-columns: 1fr;
      gap: 3rem;
    }

    .vertical-divider {
      display: none;
    }
  }
</style>
