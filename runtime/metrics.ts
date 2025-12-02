/**
 * XLN Runtime Metrics Collector
 *
 * Tracks performance metrics for the runtime system:
 * - Frame processing time (ms per frame)
 * - Entity count
 * - Transaction count
 * - Memory estimates
 *
 * Uses rolling averages over last 100 frames for stable metrics.
 */

export interface MetricsSummary {
  avgFrameTime: number;      // ms - average frame processing time
  maxFrameTime: number;      // ms - maximum frame processing time observed
  totalTransactions: number; // total transactions processed
  entitiesTracked: number;   // number of entities being tracked
  uptimeMs: number;          // total uptime in milliseconds
}

interface FrameMetrics {
  processingTime: number;    // ms
  entityCount: number;
  transactionCount: number;
  memoryEstimate: number;    // bytes
  timestamp: number;         // when this frame was recorded
}

export class MetricsCollector {
  private frameHistory: FrameMetrics[] = [];
  private currentFrameStart: number | null = null;
  private totalTransactions = 0;
  private maxFrameTime = 0;
  private startTime: number;
  private currentEntityCount = 0;
  private currentTransactionCount = 0;

  private readonly MAX_HISTORY = 100;

  constructor() {
    this.startTime = performance.now();
  }

  /**
   * Start timing a new frame
   */
  startFrame(): void {
    this.currentFrameStart = performance.now();
    this.currentTransactionCount = 0;
  }

  /**
   * End frame timing and record metrics
   * @param entityCount Number of entities in this frame
   * @param memoryEstimate Estimated memory usage in bytes
   */
  endFrame(entityCount: number, memoryEstimate: number): void {
    if (this.currentFrameStart === null) {
      throw new Error('endFrame called without startFrame');
    }

    const processingTime = performance.now() - this.currentFrameStart;

    // Update max frame time
    if (processingTime > this.maxFrameTime) {
      this.maxFrameTime = processingTime;
    }

    // Record frame metrics
    const frameMetrics: FrameMetrics = {
      processingTime,
      entityCount,
      transactionCount: this.currentTransactionCount,
      memoryEstimate,
      timestamp: performance.now(),
    };

    this.frameHistory.push(frameMetrics);

    // Keep only last 100 frames
    if (this.frameHistory.length > this.MAX_HISTORY) {
      this.frameHistory.shift();
    }

    // Update totals
    this.totalTransactions += this.currentTransactionCount;
    this.currentEntityCount = entityCount;

    // Reset frame start
    this.currentFrameStart = null;
  }

  /**
   * Record a transaction being processed in current frame
   */
  recordTransaction(): void {
    this.currentTransactionCount++;
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): {
    currentFrameTime: number | null;
    avgFrameTime: number;
    maxFrameTime: number;
    totalTransactions: number;
    entitiesTracked: number;
    uptimeMs: number;
    frameHistorySize: number;
  } {
    const avgFrameTime = this.calculateAvgFrameTime();
    const uptimeMs = performance.now() - this.startTime;
    const currentFrameTime = this.currentFrameStart !== null
      ? performance.now() - this.currentFrameStart
      : null;

    return {
      currentFrameTime,
      avgFrameTime,
      maxFrameTime: this.maxFrameTime,
      totalTransactions: this.totalTransactions,
      entitiesTracked: this.currentEntityCount,
      uptimeMs,
      frameHistorySize: this.frameHistory.length,
    };
  }

  /**
   * Get metrics summary (simplified interface)
   */
  getMetricsSummary(): MetricsSummary {
    const avgFrameTime = this.calculateAvgFrameTime();
    const uptimeMs = performance.now() - this.startTime;

    return {
      avgFrameTime,
      maxFrameTime: this.maxFrameTime,
      totalTransactions: this.totalTransactions,
      entitiesTracked: this.currentEntityCount,
      uptimeMs,
    };
  }

  /**
   * Calculate rolling average frame time over last 100 frames
   */
  private calculateAvgFrameTime(): number {
    if (this.frameHistory.length === 0) {
      return 0;
    }

    const sum = this.frameHistory.reduce(
      (acc, frame) => acc + frame.processingTime,
      0
    );
    return sum / this.frameHistory.length;
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.frameHistory = [];
    this.currentFrameStart = null;
    this.totalTransactions = 0;
    this.maxFrameTime = 0;
    this.startTime = performance.now();
    this.currentEntityCount = 0;
    this.currentTransactionCount = 0;
  }

  /**
   * Get detailed frame history (for debugging)
   */
  getFrameHistory(): ReadonlyArray<Readonly<FrameMetrics>> {
    return this.frameHistory;
  }

  /**
   * Get memory statistics from frame history
   */
  getMemoryStats(): {
    avgMemory: number;
    maxMemory: number;
    minMemory: number;
  } {
    if (this.frameHistory.length === 0) {
      return { avgMemory: 0, maxMemory: 0, minMemory: 0 };
    }

    let sum = 0;
    let max = 0;
    let min = Infinity;

    for (const frame of this.frameHistory) {
      sum += frame.memoryEstimate;
      if (frame.memoryEstimate > max) max = frame.memoryEstimate;
      if (frame.memoryEstimate < min) min = frame.memoryEstimate;
    }

    return {
      avgMemory: sum / this.frameHistory.length,
      maxMemory: max,
      minMemory: min === Infinity ? 0 : min,
    };
  }
}

/**
 * Export convenience function for creating metrics summary
 */
export function getMetricsSummary(collector: MetricsCollector): MetricsSummary {
  return collector.getMetricsSummary();
}
