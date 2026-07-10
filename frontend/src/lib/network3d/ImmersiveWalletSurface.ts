import * as THREE from 'three';
import type { EntityOpenAction } from '$lib/view/utils/panelBridge';

export type ImmersiveWalletSurfaceAction = EntityOpenAction | 'close';

type WalletIdentity = {
  entityId: string;
  entityName: string;
  signerId: string;
};

const BUTTONS: Array<{ action: ImmersiveWalletSurfaceAction; label: string; x: number; y: number; width: number; height: number; color: string }> = [
  { action: 'pay', label: 'PAY', x: 70, y: 480, width: 205, height: 92, color: '#22c55e' },
  { action: 'swap', label: 'SWAP', x: 300, y: 480, width: 205, height: 92, color: '#38bdf8' },
  { action: 'dispute', label: 'DISPUTE', x: 530, y: 480, width: 250, height: 92, color: '#fb7185' },
  { action: 'close', label: 'CLOSE', x: 805, y: 480, width: 150, height: 92, color: '#94a3b8' },
];

export const immersiveWalletActionAt = (x: number, y: number): ImmersiveWalletSurfaceAction | null =>
  BUTTONS.find((button) => x >= button.x && x <= button.x + button.width && y >= button.y && y <= button.y + button.height)?.action ?? null;

export class ImmersiveWalletSurface {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private identity: WalletIdentity | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly onAction: (identity: WalletIdentity, action: EntityOpenAction) => void,
  ) {
    this.canvas.width = 1024;
    this.canvas.height = 640;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('IMMERSIVE_WALLET_CANVAS_UNAVAILABLE');
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide, depthTest: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), this.material);
    this.mesh.name = 'xln-immersive-wallet';
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  open(identity: WalletIdentity): void {
    this.identity = identity;
    this.render();
    const position = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    this.camera.getWorldPosition(position);
    this.camera.getWorldQuaternion(orientation);
    const offset = new THREE.Vector3(0.55, -0.05, -0.95).applyQuaternion(orientation);
    this.mesh.position.copy(position.add(offset));
    this.mesh.quaternion.copy(orientation);
    this.mesh.visible = true;
  }

  select(raycaster: THREE.Raycaster): boolean {
    if (!this.mesh.visible || !this.identity) return false;
    const hit = raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv) return false;
    const action = immersiveWalletActionAt(hit.uv.x * this.canvas.width, (1 - hit.uv.y) * this.canvas.height);
    if (!action) return true;
    if (action === 'close') this.close();
    else this.onAction(this.identity, action);
    return true;
  }

  close(): void {
    this.mesh.visible = false;
    this.identity = null;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  private render(): void {
    const ctx = this.context;
    const identity = this.identity;
    if (!identity) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const gradient = ctx.createLinearGradient(0, 0, 1024, 640);
    gradient.addColorStop(0, '#071018');
    gradient.addColorStop(1, '#101b28');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1024, 640);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 5;
    ctx.strokeRect(3, 3, 1018, 634);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '600 28px ui-monospace, monospace';
    ctx.fillText('RCPAN WALLET', 70, 82);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '700 52px system-ui, sans-serif';
    ctx.fillText(identity.entityName || 'Entity', 70, 160);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '24px ui-monospace, monospace';
    ctx.fillText(identity.entityId, 70, 215);
    ctx.fillText(`signer ${identity.signerId}`, 70, 260);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillText('Choose an operation. Confirmation stays in the pinned wallet.', 70, 360);
    for (const button of BUTTONS) {
      ctx.fillStyle = `${button.color}22`;
      ctx.strokeStyle = button.color;
      ctx.lineWidth = 3;
      ctx.fillRect(button.x, button.y, button.width, button.height);
      ctx.strokeRect(button.x, button.y, button.width, button.height);
      ctx.fillStyle = button.color;
      ctx.font = '700 28px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(button.label, button.x + button.width / 2, button.y + 57);
    }
    ctx.textAlign = 'left';
    this.texture.needsUpdate = true;
  }
}

