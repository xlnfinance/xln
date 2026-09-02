import * as THREE from 'three';

export type GraphEntityVisualProfile = Readonly<{
  entityId: string;
  metadata?: Readonly<{
    name?: string;
    isHub?: boolean;
    position?: { x: number; y: number; z: number } | undefined;
    provenance?: string[];
    desynchronized?: boolean;
  }>;
}>;

type GraphEntityVisualReplica = Readonly<{
  signerId?: string | null;
  position?: { x: number; y: number; z: number; jurisdiction?: string } | null;
}>;

export type GraphEntityVisualData = {
  id: string;
  position: THREE.Vector3;
  mesh: THREE.Mesh;
  label?: THREE.Sprite;
  profile?: GraphEntityVisualProfile;
  isHub?: boolean;
  lastActivity?: number;
  isPinned?: boolean;
  isHovered?: boolean;
  isDragging?: boolean;
  activityRing?: THREE.Mesh | null;
  mempoolIndicator?: THREE.Sprite;
};

export function positionEntityLabel(label: THREE.Sprite, entitySize: number): void {
  const worldHeight = Number(label.userData['worldHeight']);
  if (!Number.isFinite(entitySize) || entitySize <= 0) throw new Error(`GRAPH_ENTITY_SIZE_INVALID:${entitySize}`);
  if (!Number.isFinite(worldHeight) || worldHeight <= 0) throw new Error(`GRAPH_LABEL_HEIGHT_INVALID:${worldHeight}`);
  label.scale.set((worldHeight * 4) / entitySize, worldHeight / entitySize, 1);
  label.position.set(0, (entitySize + worldHeight / 2 + 1) / entitySize, 0);
}

export function createEntityLabel(
  content: { flag: string; labelText: string; key: string },
  labelScale: number,
  isVrActive: boolean,
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_ENTITY_LABEL_CONTEXT_UNAVAILABLE');
  canvas.width = 512;
  canvas.height = 128;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.strokeStyle = '#000000';
  context.lineWidth = 5;
  if (content.flag) {
    context.font = '56px sans-serif';
    context.fillStyle = '#ffffff';
    context.fillText(content.flag, 256, 32);
    context.font = 'bold 32px sans-serif';
    context.strokeText(content.labelText, 256, 90);
    context.fillStyle = '#FFD700';
    context.fillText(content.labelText, 256, 90);
  } else {
    context.font = 'bold 64px sans-serif';
    context.strokeText(content.labelText, 256, 64);
    context.fillStyle = '#00ff88';
    context.fillText(content.labelText, 256, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: true }),
  );
  sprite.userData['worldHeight'] = 2.2 * labelScale * (isVrActive ? 3 : 1);
  sprite.userData['contentKey'] = content.key;
  return sprite;
}

export function createMempoolIndicator(entityId: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_MEMPOOL_INDICATOR_CONTEXT_UNAVAILABLE');
  canvas.width = 128;
  canvas.height = 64;
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: true }),
  );
  sprite.scale.set(1, 0.5, 1);
  sprite.userData['entityId'] = entityId;
  sprite.userData['canvas'] = canvas;
  sprite.userData['context'] = context;
  return sprite;
}

export function positionMempoolIndicator(indicator: THREE.Sprite, entitySize: number): void {
  if (!Number.isFinite(entitySize) || entitySize <= 0) throw new Error(`GRAPH_ENTITY_SIZE_INVALID:${entitySize}`);
  indicator.scale.set(2.4 / entitySize, 1.2 / entitySize, 1);
  indicator.position.set((entitySize + 1.7) / entitySize, 0, 0);
}

export function createGraphEntityNode(options: {
  profile: GraphEntityVisualProfile;
  index: number;
  total: number;
  forceLayoutPosition: THREE.Vector3 | undefined;
  forceLayoutEnabled: boolean;
  isHub: boolean;
  replica: GraphEntityVisualReplica | null | undefined;
  userPosition: { x: number; y: number; z: number } | undefined;
  persistedPosition: { x: number; y: number; z: number; jurisdiction: string } | undefined;
  defaultJurisdiction: string;
  resolveJMachinePosition(jurisdiction: string): { x: number; y: number; z: number } | null;
  selectedTokenId: number;
  getEntitySize(entityId: string, tokenId: number): number;
  labelContent: { flag: string; labelText: string; key: string };
  labelScale: number;
  isVrActive: boolean;
}): GraphEntityVisualData {
  const position = (() => {
    if (options.userPosition) return options.userPosition;
    if (options.persistedPosition) {
      const jurisdiction = options.resolveJMachinePosition(options.persistedPosition.jurisdiction);
      return jurisdiction
        ? {
            x: jurisdiction.x + options.persistedPosition.x,
            y: jurisdiction.y + options.persistedPosition.y,
            z: jurisdiction.z + options.persistedPosition.z,
          }
        : options.persistedPosition;
    }
    if (options.replica?.position) {
      const jurisdictionName =
        options.replica.position.jurisdiction ||
        options.defaultJurisdiction ||
        'default';
      const jurisdiction = options.resolveJMachinePosition(jurisdictionName);
      return jurisdiction
        ? {
            x: jurisdiction.x + options.replica.position.x,
            y: jurisdiction.y + options.replica.position.y,
            z: jurisdiction.z + options.replica.position.z,
          }
        : options.replica.position;
    }
    if (options.profile.metadata?.position) return options.profile.metadata.position;
    if (options.forceLayoutPosition && options.forceLayoutEnabled) return options.forceLayoutPosition;
    const angle = (options.index / options.total) * Math.PI * 2;
    return { x: Math.cos(angle) * 30, y: Math.sin(angle) * 30, z: 0 };
  })();
  const isFed = options.replica?.signerId?.includes('_fed') || false;
  const material = new THREE.MeshLambertMaterial({
    color: isFed ? 0x8b7fb8 : 0x0077cc,
    emissive: isFed ? 0x9a8ac4 : 0x003366,
    emissiveIntensity: isFed ? 2 : options.isHub ? 1.5 : 0.3,
    transparent: true,
    opacity: isFed ? 1 : 0.9,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 32), material);
  mesh.position.set(position.x, position.y, position.z);
  const entitySize = options.getEntitySize(options.profile.entityId, options.selectedTokenId);
  mesh.scale.setScalar(entitySize);
  if (isFed) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x8b7fb8, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    );
    ring.rotation.x = Math.PI / 2;
    mesh.add(ring);
  }
  mesh.userData['isHub'] = options.isHub;
  mesh.userData['isFed'] = isFed;
  mesh.userData['baseMaterial'] = material;
  const label = createEntityLabel(options.labelContent, options.labelScale, options.isVrActive);
  positionEntityLabel(label, entitySize);
  mesh.add(label);
  return {
    id: options.profile.entityId,
    position: new THREE.Vector3(position.x, position.y, position.z),
    mesh,
    label,
    profile: options.profile,
    isHub: options.isHub,
    lastActivity: 0,
  };
}
