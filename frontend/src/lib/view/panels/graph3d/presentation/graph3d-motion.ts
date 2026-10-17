/**
 * Payment motion in the 3D graph: packets that travel an account, rings that pulse on an
 * entity, blocks that rise out of the J-machine. Every effect is transient — it renders what
 * one network step did and then disposes itself. Nothing here derives state.
 */

import * as THREE from 'three';
import type { NetworkMotionKind, NetworkMotionPulseKind } from '#lib/network3d/timeline/networkStepMotion.ts';

export type MotionStyle = { color: number; label: string; radius: number };

export const MOTION_KIND_STYLE: Record<NetworkMotionKind | 'j_submit' | 'j_finality', MotionStyle> = {
  payment: { color: 0x34f5c5, label: 'Payment', radius: 1.15 },
  htlc_lock: { color: 0x38bdf8, label: 'Hash lock', radius: 1.1 },
  htlc_resolve: { color: 0x4ade80, label: 'Lock released', radius: 1.1 },
  swap: { color: 0xe879f9, label: 'Swap', radius: 1.1 },
  settlement: { color: 0xfbbf24, label: 'Settlement', radius: 1.1 },
  j_claim: { color: 0x93c5fd, label: 'On-chain result', radius: 0.9 },
  credit: { color: 0xfb923c, label: 'Credit limit', radius: 0.95 },
  account: { color: 0x94a3b8, label: 'New currency', radius: 0.8 },
  frame: { color: 0x94a3b8, label: 'Account update', radius: 0.8 },
  ack: { color: 0xe2e8f0, label: 'Signed', radius: 0.45 },
  j_submit: { color: 0xfacc15, label: 'To Depository (on-chain)', radius: 0.95 },
  j_finality: { color: 0x44ffaa, label: 'Block final', radius: 0.8 },
};

export const PULSE_COLOR: Record<NetworkMotionPulseKind | 'finality', number> = {
  reserve: 0x22d3ee,
  collateral: 0x4ade80,
  dispute: 0xf87171,
  finality: 0x44ffaa,
};

export type MotionEndpoint = { kind: 'entity'; entityId: string } | { kind: 'jmachine' };

export type MotionPacketEffect = {
  type: 'packet';
  group: THREE.Group;
  tail: THREE.Line;
  from: MotionEndpoint;
  to: MotionEndpoint;
  startMs: number;
  durationMs: number;
};

export type MotionRippleEffect = {
  type: 'ripple';
  mesh: THREE.Mesh;
  at: MotionEndpoint;
  startMs: number;
  durationMs: number;
  maxScale: number;
};

export type MotionBlockEffect = {
  type: 'block';
  group: THREE.Group;
  startMs: number;
  durationMs: number;
  rise: number;
};

export type MotionEffect = MotionPacketEffect | MotionRippleEffect | MotionBlockEffect;

/** Where an endpoint is and how big it is: packets launch and land on its surface. */
export type MotionAnchor = { position: THREE.Vector3; radius: number };

export type MotionEndpointResolver = (endpoint: MotionEndpoint) => MotionAnchor | null;

const haloTexture = (() => {
  let cached: THREE.CanvasTexture | null = null;
  return (): THREE.CanvasTexture => {
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('GRAPH_MOTION_HALO_CONTEXT_UNAVAILABLE');
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    cached = new THREE.CanvasTexture(canvas);
    return cached;
  };
})();

/** A pill label that reads on a projector: dark plate, bright text, colored edge. */
export function createMotionLabel(text: string, color: number, worldHeight: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_MOTION_LABEL_CONTEXT_UNAVAILABLE');
  const font = '600 44px Inter, "Helvetica Neue", Arial, sans-serif';
  context.font = font;
  const width = Math.ceil(context.measureText(text).width) + 56;
  canvas.width = width;
  canvas.height = 76;
  context.font = font;
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  context.fillStyle = 'rgba(6, 10, 18, 0.88)';
  context.strokeStyle = hex;
  context.lineWidth = 4;
  context.beginPath();
  context.roundRect(2, 2, width - 4, 72, 34);
  context.fill();
  context.stroke();
  context.fillStyle = '#f8fafc';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, width / 2, 39);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(worldHeight * (width / 76), worldHeight, 1);
  sprite.renderOrder = 20;
  return sprite;
}

export function createMotionPacket(style: MotionStyle, label: string | null, labelHeight: number): { group: THREE.Group; tail: THREE.Line } {
  const group = new THREE.Group();
  group.name = 'xln-motion-packet';
  group.userData['label'] = label ?? '';
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(style.radius, 24, 24),
    new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity: 1, depthWrite: false }),
  );
  group.add(core);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(),
    color: style.color,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(style.radius * 6);
  group.add(halo);
  if (label) {
    const sprite = createMotionLabel(label, style.color, labelHeight);
    // Below the packet: entity labels sit above their spheres, so the amount never covers a name.
    sprite.position.set(0, -(style.radius + labelHeight * 0.85), 0);
    group.add(sprite);
  }
  const tail = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: style.color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  return { group, tail };
}

export function createMotionRipple(kind: NetworkMotionPulseKind | 'finality'): THREE.Mesh {
  const ripple = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.08, 12, 48),
    new THREE.MeshBasicMaterial({ color: PULSE_COLOR[kind], transparent: true, opacity: 0.9, depthWrite: false }),
  );
  ripple.rotation.x = Math.PI / 2;
  ripple.name = 'xln-motion-ripple';
  return ripple;
}

export function createMotionBlock(label: string): THREE.Group {
  const group = new THREE.Group();
  group.name = 'xln-motion-block';
  const geometry = new THREE.BoxGeometry(7, 7, 7);
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x44ffaa, transparent: true, opacity: 0.18, depthWrite: false })));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x86efac, transparent: true, opacity: 1 })));
  const sprite = createMotionLabel(label, 0x44ffaa, 2.6);
  sprite.position.set(0, 6, 0);
  group.add(sprite);
  return group;
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const setOpacity = (object: THREE.Object3D, factor: number): void => {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      const base = typeof entry.userData['motionBaseOpacity'] === 'number'
        ? entry.userData['motionBaseOpacity'] as number
        : (entry.userData['motionBaseOpacity'] = entry.opacity);
      entry.opacity = base * factor;
    }
  });
};

/** Packets lift slightly over the account line so they never hide inside a capacity bar. */
const packetPosition = (from: THREE.Vector3, to: THREE.Vector3, t: number): THREE.Vector3 => {
  const point = from.clone().lerp(to, t);
  point.y += Math.sin(Math.PI * t) * Math.min(8, from.distanceTo(to) * 0.12);
  return point;
};

/** Surface-to-surface path: a packet inside a sphere is a packet nobody sees. */
const surfacePath = (from: MotionAnchor, to: MotionAnchor): [THREE.Vector3, THREE.Vector3] => {
  const direction = to.position.clone().sub(from.position);
  const length = direction.length();
  if (length <= from.radius + to.radius) return [from.position.clone(), to.position.clone()];
  direction.divideScalar(length);
  return [
    from.position.clone().addScaledVector(direction, from.radius),
    to.position.clone().addScaledVector(direction, -to.radius),
  ];
};

function advancePacket(effect: MotionPacketEffect, nowMs: number, resolve: MotionEndpointResolver): boolean {
  const fromAnchor = resolve(effect.from);
  const toAnchor = resolve(effect.to);
  const raw = (nowMs - effect.startMs) / effect.durationMs;
  if (!fromAnchor || !toAnchor || raw >= 1) return false;
  const [from, to] = surfacePath(fromAnchor, toAnchor);
  const t = easeInOut(Math.max(0, raw));
  effect.group.position.copy(packetPosition(from, to, t));
  const tailStart = packetPosition(from, to, easeInOut(Math.max(0, raw - 0.22)));
  const positions = effect.tail.geometry.getAttribute('position') as THREE.BufferAttribute;
  positions.setXYZ(0, tailStart.x, tailStart.y, tailStart.z);
  positions.setXYZ(1, effect.group.position.x, effect.group.position.y, effect.group.position.z);
  positions.needsUpdate = true;
  const fade = Math.max(0, Math.min(1, raw < 0.12 ? raw / 0.12 : raw > 0.86 ? (1 - raw) / 0.14 : 1));
  setOpacity(effect.group, fade);
  setOpacity(effect.tail, fade);
  return true;
}

function advanceRipple(effect: MotionRippleEffect, nowMs: number, resolve: MotionEndpointResolver): boolean {
  const anchor = resolve(effect.at);
  const raw = (nowMs - effect.startMs) / effect.durationMs;
  if (!anchor || raw >= 1) return false;
  const t = Math.max(0, raw);
  effect.mesh.position.copy(anchor.position);
  const radius = 1 + t * effect.maxScale;
  // Grow the ring, not its tube: a wave front, not an inflating doughnut.
  effect.mesh.scale.set(radius, radius, 1 + t * 2);
  setOpacity(effect.mesh, 1 - t);
  return true;
}

function advanceBlock(effect: MotionBlockEffect, nowMs: number, resolve: MotionEndpointResolver): boolean {
  const anchor = resolve({ kind: 'jmachine' });
  const raw = (nowMs - effect.startMs) / effect.durationMs;
  if (!anchor || raw >= 1) return false;
  const t = Math.max(0, raw);
  const origin = anchor.position;
  effect.group.position.set(origin.x, origin.y + easeInOut(t) * effect.rise, origin.z);
  setOpacity(effect.group, t > 0.7 ? (1 - t) / 0.3 : 1);
  return true;
}

/** Moves one effect to `nowMs`. Returns false once the effect has finished or lost an endpoint. */
export function advanceMotionEffect(effect: MotionEffect, nowMs: number, resolve: MotionEndpointResolver): boolean {
  if (effect.type === 'packet') return advancePacket(effect, nowMs, resolve);
  if (effect.type === 'ripple') return advanceRipple(effect, nowMs, resolve);
  return advanceBlock(effect, nowMs, resolve);
}

export function motionEffectObjects(effect: MotionEffect): THREE.Object3D[] {
  if (effect.type === 'packet') return [effect.group, effect.tail];
  if (effect.type === 'ripple') return [effect.mesh];
  return [effect.group];
}
