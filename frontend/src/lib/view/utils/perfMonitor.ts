/**
 * Performance Monitor - Real-time FPS and frame time tracking
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

export interface PerfMetrics {
  fps: number;
  frameTime: number; // ms per frame
  minFps: number;
  maxFps: number;
  avgFps: number;
  frameCount: number;
  slowFrames: number; // frames > 33ms (< 30fps)
  timestamp: number;
}

export class PerformanceMonitor {
  private frameCount = 0;
  private lastTime = performance.now();
  private fps = 60;
  private frameTime = 16.67;
  private frameTimes: number[] = [];
  private maxSamples = 60; // Track last 60 frames
  private slowFrameCount = 0;
  private minFps = 60;
  private maxFps = 60;

  // Callbacks
  private onUpdate: ((metrics: PerfMetrics) => void) | undefined;

  constructor(onUpdate?: (metrics: PerfMetrics) => void) {
    this.onUpdate = onUpdate;
  }

  /**
   * Call this at the start of each animation frame
   */
  begin() {
    this.lastTime = performance.now();
  }

  /**
   * Call this at the end of each animation frame
   */
  end() {
    const now = performance.now();
    const frameTime = now - this.lastTime;

    this.frameCount++;
    this.frameTimes.push(frameTime);

    // Keep only last N frames
    if (this.frameTimes.length > this.maxSamples) {
      this.frameTimes.shift();
    }

    // Track slow frames (< 30fps = > 33ms)
    if (frameTime > 33) {
      this.slowFrameCount++;
    }

    // Calculate FPS
    this.fps = 1000 / frameTime;
    this.frameTime = frameTime;

    // Update min/max
    if (this.fps < this.minFps) this.minFps = this.fps;
    if (this.fps > this.maxFps) this.maxFps = this.fps;

    // Calculate average FPS from recent frames
    const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const avgFps = 1000 / avgFrameTime;

    // Emit metrics every 10 frames (avoid spamming)
    if (this.frameCount % 10 === 0 && this.onUpdate) {
      this.onUpdate({
        fps: Math.round(this.fps),
        frameTime: Math.round(frameTime * 100) / 100,
        minFps: Math.round(this.minFps),
        maxFps: Math.round(this.maxFps),
        avgFps: Math.round(avgFps),
        frameCount: this.frameCount,
        slowFrames: this.slowFrameCount,
        timestamp: now
      });
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): PerfMetrics {
    const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    const avgFps = 1000 / avgFrameTime;

    return {
      fps: Math.round(this.fps),
      frameTime: Math.round(this.frameTime * 100) / 100,
      minFps: Math.round(this.minFps),
      maxFps: Math.round(this.maxFps),
      avgFps: Math.round(avgFps),
      frameCount: this.frameCount,
      slowFrames: this.slowFrameCount,
      timestamp: performance.now()
    };
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.frameCount = 0;
    this.frameTimes = [];
    this.slowFrameCount = 0;
    this.minFps = 60;
    this.maxFps = 60;
    this.fps = 60;
    this.frameTime = 16.67;
  }

  /**
   * Check if WebGPU is supported
   */
  static async checkWebGPUSupport(): Promise<boolean> {
    if (!navigator.gpu) return false;

    try {
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch (e) {
      return false;
    }
  }
}

/**
 * Singleton instance for global access
 */
export const perfMonitor = new PerformanceMonitor();
