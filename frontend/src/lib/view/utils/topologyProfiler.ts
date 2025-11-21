import { readable, type Readable } from 'svelte/store';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface SectionStats {
  name: string;
  last: number;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  lines: number;
  points: number;
  geometries: number;
  textures: number;
}

export interface WorkerStats {
  lastLatency: number;
  pendingMessages: number;
  lastMessageAt: number;
  queueDepth?: number;
  roundTripMs?: number;
  queueMs?: number;
  processedMs?: number;
  lastMessageType?: string;
}

export interface GCStats {
  timestamp: number;
  reclaimedBytes: number;
  heapAfter: number;
}

export interface ObjectStats {
  meshes: number;
  lines: number;
  lineSegments: number;
  sprites: number;
  groups: number;
}

export interface DeliveryStats {
  deliveredAt?: number;
  diffTimestamp?: number;
  latencyMs?: number;
  totalMs?: number;
  queueMs?: number;
  source?: string;
}

export interface ProfilerSnapshot {
  sections: Record<string, SectionStats>;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  renderStats: RenderStats | null;
  workerStats: WorkerStats | null;
  lastGc: GCStats | null;
  heapUsage: number | null;
  objectStats: ObjectStats | null;
  deliveryStats: DeliveryStats | null;
  updatedAt: number;
}

type SectionMap = Map<string, SectionStats>;
type CounterMap = Map<string, number>;
type GaugeMap = Map<string, number>;

export class TopologyProfiler {
  private sections: SectionMap = new Map();
  private counters: CounterMap = new Map();
  private gauges: GaugeMap = new Map();
  private activeSections = new Map<string, number>();
  private renderStats: RenderStats | null = null;
  private workerStats: WorkerStats | null = null;
  private lastGc: GCStats | null = null;
  private lastHeapSample: number | null = null;
  private gcEvents = 0;
  private objectStats: ObjectStats | null = null;
  private deliveryStats: DeliveryStats | null = null;

  startSection(name: string): () => number {
    const startTime = now();
    this.activeSections.set(name, startTime);
    return () => {
      const start = this.activeSections.get(name) ?? startTime;
      const duration = now() - start;
      this.activeSections.delete(name);
      this.recordSection(name, duration);
      return duration;
    };
  }

  timeSection<T>(name: string, fn: () => T): T {
    const end = this.startSection(name);
    try {
      return fn();
    } finally {
      end();
    }
  }

  recordSection(name: string, duration: number) {
    if (!Number.isFinite(duration)) return;
    const existing = this.sections.get(name);
    if (!existing) {
      this.sections.set(name, {
        name,
        last: duration,
        avg: duration,
        min: duration,
        max: duration,
        samples: 1
      });
      return;
    }

    existing.samples += 1;
    existing.last = duration;
    existing.max = Math.max(existing.max, duration);
    existing.min = Math.min(existing.min, duration);
    existing.avg += (duration - existing.avg) / existing.samples;
    this.sections.set(name, existing);
  }

  incrementCounter(name: string, value = 1) {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + value);
  }

  resetCounter(name: string) {
    this.counters.delete(name);
  }

  setGauge(name: string, value: number) {
    if (!Number.isFinite(value)) return;
    this.gauges.set(name, value);
  }

  clearGauge(name: string) {
    this.gauges.delete(name);
  }

  recordRendererStats(stats: RenderStats) {
    this.renderStats = stats;
  }

  recordWorkerLatency(latencyMs: number, pendingMessages: number) {
    this.workerStats = {
      lastLatency: latencyMs,
      pendingMessages,
      lastMessageAt: now()
    };
  }

  recordWorkerMessage(options: {
    latencyMs?: number;
    pendingMessages?: number;
    queueDepth?: number;
    roundTripMs?: number;
    queueMs?: number;
    processedMs?: number;
    type?: string;
  }) {
    const {
      latencyMs = 0,
      pendingMessages = 0,
      queueDepth,
      roundTripMs,
      queueMs,
      processedMs,
      type
    } = options;

    this.workerStats = {
      lastLatency: latencyMs,
      pendingMessages,
      lastMessageAt: now(),
      queueDepth,
      roundTripMs,
      queueMs,
      processedMs,
      lastMessageType: type
    };
  }

  recordDeliveryStats(stats: DeliveryStats) {
    this.deliveryStats = {
      ...stats,
      deliveredAt: stats.deliveredAt ?? now()
    };

    if (stats.latencyMs !== undefined) {
      this.setGauge('delivery:latencyMs', stats.latencyMs);
    }
    if (stats.totalMs !== undefined) {
      this.setGauge('delivery:totalMs', stats.totalMs);
    }
    if (stats.queueMs !== undefined) {
      this.setGauge('delivery:queueMs', stats.queueMs);
    }
  }

  recordObjectStats(stats: ObjectStats) {
    this.objectStats = stats;
    this.setGauge('objects:meshes', stats.meshes);
    this.setGauge('objects:lines', stats.lines + stats.lineSegments);
    this.setGauge('objects:sprites', stats.sprites);
  }

  trackHeapSample() {
    if (typeof performance === 'undefined' || !(performance as Performance & { memory?: PerformanceMemoryInfo }).memory) {
      return;
    }

    const memoryInfo = (performance as Performance & { memory: PerformanceMemoryInfo }).memory;
    const used = memoryInfo.usedJSHeapSize;

    if (this.lastHeapSample !== null && used < this.lastHeapSample * 0.9) {
      this.lastGc = {
        timestamp: now(),
        reclaimedBytes: this.lastHeapSample - used,
        heapAfter: used
      };
      this.gcEvents += 1;
      this.setGauge('gc:events', this.gcEvents);
    }

    this.lastHeapSample = used;
    this.setGauge('heap:usedBytes', used);
  }

  getCurrentHeapUsage(): number | null {
    if (typeof performance === 'undefined' || !(performance as Performance & { memory?: PerformanceMemoryInfo }).memory) {
      return null;
    }
    const memoryInfo = (performance as Performance & { memory: PerformanceMemoryInfo }).memory;
    return memoryInfo.usedJSHeapSize ?? null;
  }

  recordHeapDelta(label: string, before: number | null, after: number | null) {
    if (before === null || after === null) return;
    this.setGauge(`heapDelta:${label}`, after - before);
  }

  getSnapshot(): ProfilerSnapshot {
    const sections = Object.fromEntries(this.sections.entries());
    const counters = Object.fromEntries(this.counters.entries());
    const gauges = Object.fromEntries(this.gauges.entries());

    return {
      sections,
      counters,
      gauges,
      renderStats: this.renderStats,
      workerStats: this.workerStats,
      lastGc: this.lastGc,
      heapUsage: this.gauges.get('heap:usedBytes') ?? null,
      objectStats: this.objectStats,
      deliveryStats: this.deliveryStats,
      updatedAt: now()
    };
  }
}

interface PerformanceMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export const topologyProfiler = new TopologyProfiler();

export const topologyProfilerStore: Readable<ProfilerSnapshot> = readable(topologyProfiler.getSnapshot(), (set) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const interval = window.setInterval(() => {
    set(topologyProfiler.getSnapshot());
  }, 500);

  return () => {
    window.clearInterval(interval);
  };
});
