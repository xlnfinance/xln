import type * as THREE from 'three';

export type GraphJBlockHistoryEntry = {
  blockNumber: bigint;
  container: THREE.Group;
  txCubes: THREE.Object3D[];
  yOffset: number;
};

export type GraphDerivedAccountData = {
  delta: number;
  totalCapacity: number;
  ownCreditLimit: number;
  peerCreditLimit: number;
  inCapacity: number;
  outCapacity: number;
  collateral: number;
  outOwnCredit: number;
  inCollateral: number;
  outPeerCredit: number;
  inOwnCredit: number;
  outCollateral: number;
  inPeerCredit: number;
};

export type GraphXLNRuntime = {
  deriveDelta: (delta: { [tokenId: number]: bigint }, isLeft: boolean) => GraphDerivedAccountData;
  getTokenInfo: (tokenId: number) => { symbol: string; decimals: number } | undefined;
  getEntityShortId: (entityId: string) => string;
  isLeft: (myEntityId: string, counterpartyEntityId: string) => boolean;
  executeScenario: (env: unknown, scenario: unknown) => Promise<{ success: boolean; framesGenerated: number; errors?: string[] }>;
  process: (env: unknown, inputs: unknown[]) => Promise<void>;
  parseScenario: (text: string) => { errors: unknown[]; scenario: unknown };
  classifyBilateralState: (
    myAccount: unknown,
    peerCurrentHeight: number | undefined,
    isLeft: boolean,
  ) => { state: string; isLeftEntity: boolean; shouldRollback: boolean; pendingHeight: number | null; mempoolCount: number };
  getAccountBarVisual: (
    leftState: unknown,
    rightState: unknown,
  ) => { glowColor: string | null; glowSide: string | null; glowIntensity: number; isDashed: boolean; pulseSpeed: number };
};

export type GraphRendererMode = 'webgl' | 'webgpu';

export type GraphEntityData = {
  id: string;
  position: THREE.Vector3;
  mesh: THREE.Mesh;
  label?: THREE.Sprite;
  profile?: any;
  isHub?: boolean;
  lastActivity?: number;
  isPinned?: boolean;
  isHovered?: boolean;
  isDragging?: boolean;
  activityRing?: THREE.Mesh | null;
  mempoolIndicator?: THREE.Sprite;
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
  mempoolBoxes?: { leftBox: THREE.Group; rightBox: THREE.Group } | null | undefined;
};

export type GraphPaymentJob = {
  id: string;
  from: string;
  to: string;
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
