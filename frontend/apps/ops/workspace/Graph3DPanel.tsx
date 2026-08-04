import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { opsScenarioExternalStore } from '../data/ops-scenario-store';
import type { OpsPanelProps } from './dockview-react-lifecycle';

type Resource = Readonly<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; geometries: readonly THREE.BufferGeometry[]; materials: readonly THREE.Material[] }>;
const dispose = (resource: Resource): void => { resource.geometries.forEach(item => item.dispose()); resource.materials.forEach(item => item.dispose()); resource.renderer.dispose(); resource.renderer.domElement.remove(); };

export const Graph3DPanel = ({ active }: OpsPanelProps) => {
  const host = useRef<HTMLDivElement>(null); const state = useExternalStore(opsScenarioExternalStore); const [fps, setFps] = useState(0);
  useEffect(() => {
    const container = host.current; const graph = state.graph; if (!container || !graph || !active) return;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x090a0c); const camera = new THREE.PerspectiveCamera(48, 1, .1, 1000); camera.position.set(0, 0, 24);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); container.append(renderer.domElement);
    const geometries: THREE.BufferGeometry[] = []; const materials: THREE.Material[] = [];
    const nodeGeometry = new THREE.SphereGeometry(.6, 20, 16); geometries.push(nodeGeometry);
    for (const node of graph.nodes) { const material = new THREE.MeshBasicMaterial({ color: node.disputed ? 0xff5b71 : node.hub ? 0xc8ff3d : 0x7b83ff }); materials.push(material); const mesh = new THREE.Mesh(nodeGeometry, material); mesh.position.set((node.x - 50) / 4, (32 - node.y) / 4, 0); scene.add(mesh); }
    const positions = new Map(graph.nodes.map(node => [node.id, new THREE.Vector3((node.x - 50) / 4, (32 - node.y) / 4, 0)]));
    for (const edge of graph.edges) { const from = positions.get(edge.from); const to = positions.get(edge.to); if (!from || !to) continue; const geometry = new THREE.BufferGeometry().setFromPoints([from, to]); const material = new THREE.LineBasicMaterial({ color: edge.disputed ? 0xff5b71 : 0x50535c }); geometries.push(geometry); materials.push(material); scene.add(new THREE.Line(geometry, material)); }
    const resource: Resource = { renderer, scene, camera, geometries, materials }; let frame = 0; let frames = 0; let started = performance.now(); let stopped = false;
    const resize = (): void => { const width = Math.max(1, container.clientWidth); const height = Math.max(1, container.clientHeight); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    const render = (now: number): void => { if (stopped) return; frames += 1; scene.rotation.y += .0015; renderer.render(scene, camera); if (now - started >= 1_000) { setFps(Math.round(frames * 1_000 / (now - started))); frames = 0; started = now; } frame = requestAnimationFrame(render); };
    frame = requestAnimationFrame(render);
    return () => { stopped = true; cancelAnimationFrame(frame); observer.disconnect(); dispose(resource); };
  }, [active, state.graph]);
  return <section className="ops-3d-panel" data-testid="ops-graph-3d" data-render-loop={active && state.graph ? 'active' : 'stopped'}><div ref={host}/><output>{active ? `${fps} FPS` : 'render loop suspended'}</output></section>;
};
