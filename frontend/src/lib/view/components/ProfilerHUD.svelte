<script lang="ts">
  import type { ProfilerSnapshot, SectionStats } from '../utils/topologyProfiler';

  export let metrics: ProfilerSnapshot | null = null;

  const sectionOrder = [
    'network:update',
    'network:parse',
    'network:diff',
    'network:connections',
    'network:layout',
    'network:geometry',
    'animate:frame',
    'animate:effects',
    'animate:vr',
    'animate:physics',
    'animate:labels',
    'animate:particles',
    'animate:pulses',
    'animate:grid',
    'animate:events',
    'animate:render'
  ];

  const sectionLabels: Record<string, string> = {
    'network:update': 'Update Network',
    'network:parse': 'Parse Replicas',
    'network:diff': 'Diff / Changes',
    'network:connections': 'Connections Scan',
    'network:layout': 'Force Layout',
    'network:geometry': 'Geometry Build',
    'animate:frame': 'Animate (total)',
    'animate:effects': 'Effects Queue',
    'animate:vr': 'VR / Gestures',
    'animate:physics': 'Collision / Physics',
    'animate:labels': 'Label Updates',
    'animate:particles': 'Particle Pass',
    'animate:pulses': 'Pulse Animation',
    'animate:grid': 'Grid Pulse',
    'animate:events': 'Events / Ripples',
    'animate:render': 'Renderer'
  };

  const formatMs = (value?: number) => (value || value === 0 ? `${value.toFixed(1)} ms` : '—');
  const formatDuration = (stat?: SectionStats) => formatMs(stat?.last);
  const formatAvg = (stat?: SectionStats) => (stat ? `${stat.avg.toFixed(1)} avg` : '—');
  const formatMax = (stat?: SectionStats) => (stat ? `${stat.max.toFixed(1)} max` : '');

  const formatBytes = (value?: number | null) => {
    if (!value && value !== 0) return '—';
    if (value > 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
    if (value > 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
    if (value > 1_000) return `${(value / 1_000).toFixed(1)} KB`;
    return `${value.toFixed(0)} B`;
  };

  const labelFor = (key: string) => sectionLabels[key] ?? key;

  $: sections = metrics?.sections ?? {};
  $: renderStats = metrics?.renderStats;
  $: workerStats = metrics?.workerStats;
  $: objectStats = metrics?.objectStats;
  $: deliveryStats = metrics?.deliveryStats;
  $: gcStats = metrics?.lastGc;
  $: gauges = metrics?.gauges ?? {};
</script>

{#if metrics}
  <div class="profiler-hud">
    <div class="hud-header">
      <span>Profiler</span>
      <span class="timestamp">{new Date(metrics.updatedAt).toLocaleTimeString()}</span>
    </div>

    <div class="section-grid">
      {#each sectionOrder as key}
        {#if sections[key]}
          <div class="section-row">
            <div class="section-label">{labelFor(key)}</div>
            <div class="section-value">
              <span class="primary">{formatDuration(sections[key])}</span>
              <span class="secondary">{formatAvg(sections[key])}</span>
              <span class="secondary">{formatMax(sections[key])}</span>
            </div>
          </div>
        {/if}
      {/each}
    </div>

    <div class="stat-grid">
      <div>
        <span class="stat-label">Entities</span>
        <span class="stat-value">{gauges['objects:entities'] ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Connections</span>
        <span class="stat-value">{gauges['objects:connections'] ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Particles</span>
        <span class="stat-value">{gauges['objects:particles'] ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Meshes</span>
        <span class="stat-value">{objectStats?.meshes ?? gauges['objects:meshes'] ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Lines</span>
        <span class="stat-value">
          {#if objectStats}
            {objectStats.lines + objectStats.lineSegments}
          {:else}
            {gauges['objects:lines'] ?? '—'}
          {/if}
        </span>
      </div>
      <div>
        <span class="stat-label">Sprites</span>
        <span class="stat-value">{objectStats?.sprites ?? gauges['objects:sprites'] ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Draw Calls</span>
        <span class="stat-value">{renderStats?.drawCalls ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Triangles</span>
        <span class="stat-value">{renderStats?.triangles ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Geometries</span>
        <span class="stat-value">{renderStats?.geometries ?? '—'}</span>
      </div>
      <div>
        <span class="stat-label">Heap Δ (geom)</span>
        <span class="stat-value">{formatBytes(gauges['heapDelta:network:geometry'])}</span>
      </div>
      <div>
        <span class="stat-label">Heap Δ (update)</span>
        <span class="stat-value">{formatBytes(gauges['heapDelta:network:update'])}</span>
      </div>
      <div>
        <span class="stat-label">Heap Used</span>
        <span class="stat-value">{formatBytes(metrics.heapUsage)}</span>
      </div>
      <div>
        <span class="stat-label">GC</span>
        <span class="stat-value">
          {#if gcStats}
            -{formatBytes(gcStats.reclaimedBytes)} @ {new Date(gcStats.timestamp).toLocaleTimeString()}
          {:else if gauges['gc:events']}
            {gauges['gc:events']} events
          {:else}
            —
          {/if}
        </span>
      </div>
      <div>
        <span class="stat-label">Diff Δ (add/remove)</span>
        <span class="stat-value">
          {(gauges['diff:entities:add'] ?? '—')} / {(gauges['diff:entities:remove'] ?? '—')}
        </span>
      </div>
      <div>
        <span class="stat-label">Worker Latency</span>
        <span class="stat-value">
          {#if workerStats}
            {workerStats.lastLatency.toFixed(1)} ms ({workerStats.pendingMessages} pending{workerStats.queueDepth ? `, q=${workerStats.queueDepth}` : ''}{workerStats.lastMessageType ? `, ${workerStats.lastMessageType}` : ''})
          {:else}
            —
          {/if}
        </span>
      </div>
      <div>
        <span class="stat-label">Diff Delivery</span>
        <span class="stat-value">
          {#if deliveryStats}
            {deliveryStats.latencyMs ? `${deliveryStats.latencyMs.toFixed(1)} ms` : '—'}{deliveryStats.source ? ` (${deliveryStats.source})` : ''}
          {:else}
            —
          {/if}
        </span>
      </div>
    </div>
  </div>
{/if}

<style>
  .profiler-hud {
    position: absolute;
    bottom: 12px;
    right: 12px;
    width: 320px;
    max-height: 50%;
    overflow-y: auto;
    background: rgba(8, 12, 16, 0.85);
    border: 1px solid rgba(0, 255, 136, 0.25);
    border-radius: 8px;
    backdrop-filter: blur(8px);
    padding: 12px;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
    color: #d0f5e0;
    z-index: 120;
  }

  .hud-header {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8cf2b2;
    margin-bottom: 8px;
  }

  .timestamp {
    color: #6bbf8d;
  }

  .section-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 10px;
  }

  .section-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(140, 242, 178, 0.1);
  }

  .section-label {
    color: #86d89e;
  }

  .section-value {
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .primary {
    font-weight: 600;
    color: #f5fffa;
  }

  .secondary {
    font-size: 10px;
    color: rgba(213, 255, 230, 0.7);
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px 12px;
    font-size: 11px;
  }

  .stat-label {
    display: block;
    color: rgba(213, 255, 230, 0.65);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }

  .stat-value {
    font-weight: 600;
    color: #f5fffa;
  }
</style>
