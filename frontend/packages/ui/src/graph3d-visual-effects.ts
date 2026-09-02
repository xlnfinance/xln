import * as THREE from 'three';

type GraphEffectConnection = Readonly<{ line: THREE.Line }>;
type GraphEffectTransaction = Readonly<{
  data?: Readonly<{ amount?: string | number | bigint }>;
}>;

export function createDirectionalLightningMesh(
  connection: GraphEffectConnection,
  accountTx: GraphEffectTransaction | null | undefined,
): THREE.Mesh {
  const positions = connection.line.geometry.getAttribute('position');
  const start = new THREE.Vector3().fromBufferAttribute(positions, 0);
  const end = new THREE.Vector3().fromBufferAttribute(positions, 1);
  const amountUsd = accountTx?.data?.amount ? Number(accountTx.data.amount) / 1e18 : 0;
  const radius = amountUsd > 0 ? Math.max(0.05, Math.min(Math.log10(amountUsd) * 0.08, 0.8)) : 0.08;
  const color =
    amountUsd <= 0
      ? 0x00ccff
      : amountUsd < 1_000
        ? 0x0088ff
        : amountUsd < 100_000
          ? 0x00ccff
          : amountUsd < 1_000_000
            ? 0x00ff88
            : amountUsd < 10_000_000
              ? 0xffff00
              : 0xff4444;
  const bolt = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, start.distanceTo(end), 16),
    new THREE.MeshLambertMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      emissive: color,
      emissiveIntensity: 2,
    }),
  );
  bolt.position.copy(start.clone().lerp(end, 0.5));
  bolt.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3().subVectors(end, start).normalize(),
  );
  return bolt;
}

export function createBroadcastRippleMesh(position: THREE.Vector3, txType: string): THREE.Mesh {
  const colors: Record<string, number> = {
    r2c: 0x00ff88,
    reserve_to_collateral: 0x00ff88,
    deposit_reserve: 0x00ff00,
    withdraw_reserve: 0xff0000,
    credit_from_reserve: 0xffaa00,
    debit_to_reserve: 0xff44ff,
  };
  const ripple = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.05, 16, 32),
    new THREE.MeshBasicMaterial({
      color: colors[txType] ?? 0x00ffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    }),
  );
  ripple.position.copy(position);
  ripple.rotation.x = Math.PI / 2;
  return ripple;
}
