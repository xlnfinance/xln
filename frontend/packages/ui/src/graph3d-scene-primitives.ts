import * as THREE from 'three';

type GraphLayoutProfile = Readonly<{ entityId: string }>;

export function createGraphGrid(
  color: THREE.ColorRepresentation,
  opacity: number,
  size: number,
  divisions: number,
): THREE.GridHelper {
  const grid = new THREE.GridHelper(size, Math.max(1, Math.floor(divisions)), color, color);
  grid.material.opacity = opacity;
  grid.material.transparent = true;
  grid.position.set(0, -50, 0);
  return grid;
}

export function createGraphJMachine(
  size = 25,
  position = { x: 0, y: 200, z: 0 },
  name = 'J-MACHINE',
  jHeight = 0,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(position.x, position.y, position.z);
  group.userData = { type: 'jMachine', jurisdictionName: name, position };
  const geometry = new THREE.BoxGeometry(size, size, size);
  group.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({
        color: 0x4488aa,
        emissive: 0x224455,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
        shininess: 100,
        depthWrite: false,
      }),
    ),
  );
  group.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x66ccff, linewidth: 2 }),
    ),
  );
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_J_MACHINE_LABEL_CONTEXT_UNAVAILABLE');
  canvas.width = 256;
  canvas.height = 64;
  context.fillStyle = '#66ccff';
  context.font = 'bold 28px monospace';
  context.textAlign = 'center';
  context.fillText(`${(name.split(' ')[0] || 'J').substring(0, 8)} (#${jHeight})`, 128, 40);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
  label.scale.set(25, 6, 1);
  label.position.set(0, -size / 2 - 8, 0);
  group.add(label);
  return group;
}

export function startProportionalBroadcast(options: {
  graphWorld: THREE.Group;
  position: THREE.Vector3;
  transactionCount: number;
  onComplete(sphere: THREE.Mesh): void;
}): { sphere: THREE.Mesh; animationId: number } | null {
  if (options.transactionCount === 0) return null;
  const intensity = Math.min(options.transactionCount / 5, 1);
  const maxScale = 30 + intensity * 70;
  const duration = 800 + intensity * 700;
  const geometry = new THREE.SphereGeometry(1, 32, 32);
  const material = new THREE.MeshBasicMaterial({
    color: 0x44ffaa,
    transparent: true,
    opacity: 0.3 + intensity * 0.3,
    side: THREE.DoubleSide,
  });
  const sphere = new THREE.Mesh(geometry, material);
  sphere.position.copy(options.position);
  options.graphWorld.add(sphere);
  const startTime = performance.now();
  let animationId = 0;
  const animate = () => {
    const progress = Math.min((performance.now() - startTime) / duration, 1);
    const scale = 1 + (1 - Math.pow(1 - progress, 2)) * maxScale;
    sphere.scale.set(scale, scale, scale);
    material.opacity = (0.3 + intensity * 0.3) * (1 - progress);
    if (progress < 1) {
      animationId = requestAnimationFrame(animate);
      return;
    }
    options.graphWorld.remove(sphere);
    geometry.dispose();
    material.dispose();
    options.onComplete(sphere);
  };
  animationId = requestAnimationFrame(animate);
  return { sphere, animationId };
}

export function buildSimpleRadialLayout(
  profiles: readonly GraphLayoutProfile[],
  connectionMap: ReadonlyMap<string, ReadonlySet<string>>,
  compareIds: (left: string, right: string) => number,
): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();
  const connectionCounts = new Map(
    profiles.map(profile => [profile.entityId, connectionMap.get(profile.entityId)?.size || 0]),
  );
  const sorted = [...profiles].sort((left, right) => {
    const countDifference = (connectionCounts.get(right.entityId) || 0) - (connectionCounts.get(left.entityId) || 0);
    return countDifference || compareIds(left.entityId, right.entityId);
  });
  const angleStep = (Math.PI * 2) / profiles.length;
  sorted.forEach((profile, index) => {
    const degree = connectionCounts.get(profile.entityId) || 0;
    const radius = degree > 0 ? Math.max(5, 50 / (degree + 1)) : 50;
    positions.set(
      profile.entityId,
      new THREE.Vector3(Math.cos(index * angleStep) * radius, Math.sin(index * angleStep) * radius, 0),
    );
  });
  return positions;
}
