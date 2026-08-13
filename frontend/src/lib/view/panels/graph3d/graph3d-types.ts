import type * as THREE from 'three';
import type { XLNModule } from '@xln/runtime/api/public/runtime-module';

export type GraphJBlockHistoryEntry = {
  blockNumber: bigint;
  container: THREE.Group;
  txCubes: THREE.Object3D[];
  yOffset: number;
};

export type GraphXLNRuntime = Pick<
  XLNModule,
  'deriveDelta' | 'getTokenInfo' | 'getEntityShortId' | 'classifyBilateralState' | 'getAccountBarVisual'
>;

export type GraphRendererMode = 'webgl' | 'webgpu';

export type GraphEntityData = {
  id: string;
  position: THREE.Vector3;
  mesh: THREE.Mesh;
  label?: THREE.Sprite;
  profile?: GraphEntityProfile;
  isHub?: boolean;
  lastActivity?: number;
  isPinned?: boolean;
  isHovered?: boolean;
  isDragging?: boolean;
  activityRing?: THREE.Mesh | null;
  mempoolIndicator?: THREE.Sprite;
};

export type GraphEntityProfile = {
  entityId: string;
  metadata?: {
    name?: string;
    isHub?: boolean;
    position?: { x: number; y: number; z: number } | undefined;
    provenance?: string[];
    desynchronized?: boolean;
  };
};

export type GraphTransactionLike = {
  type?: string;
  kind?: string;
  entityId?: string;
  from?: string;
  to?: string;
  tokenId?: number;
  amount?: string | bigint | number;
  targetEntityId?: string;
  data?: {
    amount?: bigint | number | string;
    tokenId?: number;
    targetEntityId?: string;
    fromEntityId?: string;
    toEntityId?: string;
    accountTx?: GraphTransactionLike;
    batch?: {
      reserveToReserve?: unknown[];
      reserveToCollateral?: unknown[];
      settlements?: Array<{ diffs?: Array<{ collateralDiff: bigint | number }> }>;
    };
  };
};

export type GraphFrameActivity = {
  activeEntities: Set<string>;
  incomingFlows: Map<string, string[]>;
  outgoingFlows: Map<string, string[]>;
};

export type GraphConnectionData = {
  from: string;
  to: string;
  line: THREE.Line;
  progressBars?: THREE.Group | undefined;
  /** One entry per observed account side (0..2). See createAccountMempoolBoxes. */
  mempoolBoxes: THREE.Group[];
};

export type GraphPaymentJob = {
  id: string;
  from: string;
  to: string;
  tokenId: number;
  amount: string;
  tps: number;
  sentCount: number;
  startedAt: number;
  intervalId?: number;
};

export type GraphRipple = {
  mesh: THREE.Mesh;
  startTime: number;
  duration: number;
  maxRadius: number;
};
