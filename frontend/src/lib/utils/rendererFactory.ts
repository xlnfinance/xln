/**
 * Renderer Factory - Switch between WebGL and WebGPU
 * WebGPU is faster but has limited VR support (Quest browser doesn't support WebXR+WebGPU yet)
 */

import * as THREE from 'three';

export type RendererMode = 'webgl' | 'webgpu';

export interface RendererOptions {
  antialias?: boolean;
  xrEnabled?: boolean;
}

/**
 * Create Three.js renderer (WebGL or WebGPU)
 * Falls back to WebGL if WebGPU unavailable
 */
export async function createRenderer(
  mode: RendererMode = 'webgl',
  options: RendererOptions = {}
): Promise<THREE.WebGLRenderer | any> {
  const { antialias = true, xrEnabled = true } = options;

  if (mode === 'webgpu') {
    // Check WebGPU availability
    if (!('gpu' in navigator)) {
      console.warn('[Renderer] WebGPU not available, falling back to WebGL');
      return createWebGLRenderer(antialias, xrEnabled);
    }

    try {
      // Import WebGPU renderer (tree-shakeable)
      const { WebGPURenderer } = await import('three/webgpu');

      const renderer = new WebGPURenderer({ antialias });

      // WebXR + WebGPU is broken on Quest - warn user
      if (xrEnabled) {
        console.warn('[Renderer] WebGPU + WebXR may not work on Meta Quest browser');
        // Still enable it - will fallback if needed
        renderer.xr.enabled = true;
      }

      console.log('[Renderer] ✅ WebGPU renderer created');
      return renderer as any; // Type assertion for compatibility
    } catch (error) {
      console.error('[Renderer] WebGPU initialization failed:', error);
      console.log('[Renderer] Falling back to WebGL');
      return createWebGLRenderer(antialias, xrEnabled);
    }
  }

  return createWebGLRenderer(antialias, xrEnabled);
}

function createWebGLRenderer(antialias: boolean, xrEnabled: boolean): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias });

  if (xrEnabled) {
    renderer.xr.enabled = true;
  }

  console.log('[Renderer] ✅ WebGL renderer created');
  return renderer;
}

/**
 * Get current renderer capabilities
 */
export function getRendererInfo(renderer: THREE.WebGLRenderer | any): {
  mode: RendererMode;
  webgpuAvailable: boolean;
  webxrAvailable: boolean;
} {
  const isWebGPU = renderer.constructor.name.includes('WebGPU');

  return {
    mode: isWebGPU ? 'webgpu' : 'webgl',
    webgpuAvailable: 'gpu' in navigator,
    webxrAvailable: 'xr' in navigator,
  };
}

/**
 * Switch renderer at runtime (requires scene rebuild)
 */
export async function switchRenderer(
  currentRenderer: THREE.WebGLRenderer | any,
  newMode: RendererMode,
  options: RendererOptions = {}
): Promise<THREE.WebGLRenderer | any> {
  // Dispose old renderer
  currentRenderer.dispose();
  currentRenderer.domElement.remove();

  // Create new renderer
  return createRenderer(newMode, options);
}
