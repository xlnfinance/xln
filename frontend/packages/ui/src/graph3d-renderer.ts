import * as THREE from 'three';
import type WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';

export type GraphRenderer = THREE.WebGLRenderer | WebGPURenderer;

export function getGraphThemeColors(_theme: string) {
  return {
    background: 0x222222,
    entity: 0x007acc,
    connection: 0x444444,
    entityColor: '#007acc',
    entityEmissive: '#003366',
    connectionColor: '#444444',
  };
}

export async function createGraphRenderer(
  mode: string,
  options: THREE.WebGLRendererParameters,
): Promise<GraphRenderer | null> {
  if (mode === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const { default: WebGPURenderer } = await import('three/src/renderers/webgpu/WebGPURenderer.js');
      const renderer = new WebGPURenderer({ antialias: options.antialias });
      await renderer.init();
      return renderer;
    } catch (error) {
      console.warn('[Graph3D] WebGPU renderer unavailable, falling back to WebGL:', error);
    }
  }

  try {
    return new THREE.WebGLRenderer(options);
  } catch (error) {
    console.error('[Graph3D] Renderer init failed:', error);
    return null;
  }
}

type DisposableMaterial = { dispose?: () => void; map?: { dispose?: () => void } | null };

/**
 * Frees geometry, materials AND their textures. Label/mempool sprites carry a CanvasTexture
 * per instance, so skipping `material.map` leaks one texture per rebuild.
 */
export function disposeGraphObject3D(obj: THREE.Object3D): void {
  obj.traverse((child: THREE.Object3D & { geometry?: { dispose?: () => void }; material?: unknown }) => {
    child.geometry?.dispose?.();
    if (!child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const entry of materials as DisposableMaterial[]) {
      entry?.map?.dispose?.();
      entry?.dispose?.();
    }
  });
}

/** Detach from `parent` and free every GPU resource underneath. Safe on null/undefined. */
export function detachGraphObject3D(parent: THREE.Object3D | null, child: THREE.Object3D | null | undefined): void {
  if (!child) return;
  parent?.remove(child);
  disposeGraphObject3D(child);
}
