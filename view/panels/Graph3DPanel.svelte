<script lang="ts">
  /**
   * Graph3DPanel - Pure 3D network visualization
   * Extracted from NetworkTopology.svelte (essential rendering only)
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { panelBridge } from '../utils/panelBridge';

  // Props (data comes from parent)
  export let entities: any[] = [];
  export let accounts: any[] = [];
  export let layoutMode: 'force' | 'grid' | 'ring' = 'force';
  export let rendererMode: 'webgl' | 'webgpu' = 'webgl';

  let container: HTMLDivElement;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer;
  let animationId: number;

  // Entity meshes
  let entityMeshes = new Map<string, THREE.Mesh>();

  onMount(async () => {
    await initScene();
    animate();
  });

  onDestroy(() => {
    if (animationId) cancelAnimationFrame(animationId);
    if (renderer) {
      renderer.dispose();
      container.innerHTML = '';
    }
  });

  async function initScene() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    // Camera
    camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    camera.position.set(0, 0, 50);

    // Renderer (WebGL for now, WebGPU support coming)
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404040);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 10, 10);
    scene.add(directionalLight);

    // Add grid helper
    const gridHelper = new THREE.GridHelper(100, 20, 0x3e3e3e, 0x2d2d30);
    scene.add(gridHelper);

    // Mouse interaction
    container.addEventListener('click', onCanvasClick);
    window.addEventListener('resize', onWindowResize);
  }

  function animate() {
    animationId = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }

  function onCanvasClick(event: MouseEvent) {
    // Raycasting for entity selection (simplified)
    const mouse = new THREE.Vector2(
      (event.clientX / container.clientWidth) * 2 - 1,
      -(event.clientY / container.clientHeight) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(Array.from(entityMeshes.values()));
    if (intersects.length > 0) {
      const mesh = intersects[0].object as THREE.Mesh;
      const entityId = [...entityMeshes.entries()].find(([_, m]) => m === mesh)?.[0];
      if (entityId) {
        panelBridge.emit('entity:selected', { entityId });
      }
    }
  }

  function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }

  // Update entities when data changes
  $: updateEntities(entities);

  function updateEntities(entities: any[]) {
    if (!scene) return;

    // Clear existing
    entityMeshes.forEach(mesh => scene.remove(mesh));
    entityMeshes.clear();

    // Create entity spheres
    entities.forEach((entity, index) => {
      const geometry = new THREE.SphereGeometry(2, 32, 32);
      const material = new THREE.MeshStandardMaterial({
        color: 0x007acc,
        metalness: 0.3,
        roughness: 0.7,
      });
      const mesh = new THREE.Mesh(geometry, material);

      // Simple grid layout for now
      const gridSize = Math.ceil(Math.sqrt(entities.length));
      const x = (index % gridSize) * 10 - (gridSize * 5);
      const y = Math.floor(index / gridSize) * 10 - (gridSize * 5);
      mesh.position.set(x, y, 0);

      scene.add(mesh);
      entityMeshes.set(entity.id, mesh);
    });
  }
</script>

<div class="graph3d-panel" bind:this={container}></div>

<style>
  .graph3d-panel {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
    background: #000;
  }
</style>
