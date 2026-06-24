import * as THREE from 'three';

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
): Promise<THREE.WebGLRenderer | null> {
  if (mode === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const { default: WebGPURenderer } = await import('three/src/renderers/webgpu/WebGPURenderer.js');
      const renderer = new WebGPURenderer({ antialias: options.antialias });
      await renderer.init();
      return renderer as unknown as THREE.WebGLRenderer;
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

export function disposeGraphObject3D(obj: THREE.Object3D): void {
  obj.traverse((child: THREE.Object3D & { geometry?: { dispose?: () => void }; material?: unknown }) => {
    child.geometry?.dispose?.();
    if (!child.material) return;
    const material = child.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry?.dispose?.();
      return;
    }
    (material as { dispose?: () => void }).dispose?.();
  });
}
