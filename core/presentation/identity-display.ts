import { toSvg } from 'jdenticon';

import { extractNumberFromEntityId } from '../entity/factory';
import { Buffer } from '../support/platform-crypto';

const DEMO_SIGNERS = {
  alice: {
    name: 'alice.eth',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
  bob: {
    name: 'bob.eth',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  },
  carol: {
    name: 'carol.eth',
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
  david: {
    name: 'david.eth',
    address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  },
  eve: {
    name: 'eve.eth',
    address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  },
} as const;

const getSignerAddress = (signerId: string): string =>
  DEMO_SIGNERS[signerId as keyof typeof DEMO_SIGNERS]?.address ?? signerId;

const generateSeedAvatar = (seed: string, size: number): string => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) & 0xffffffff;
  }
  const radius = Math.floor(size / 2);
  const hue = Math.abs(hash) % 360;
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${radius}" cy="${radius}" r="${radius}" fill="hsl(${hue}, 70%, 50%)"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

export const hashToAvatar = (seed: string, size = 40): string => {
  try {
    const svg = toSvg(String(seed || '').trim().toLowerCase(), size);
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    return generateSeedAvatar(seed, size);
  }
};

export const generateEntityAvatar = (entityId: string): string =>
  hashToAvatar(entityId, 40);

export const generateSignerAvatar = (signerId: string): string =>
  hashToAvatar(getSignerAddress(signerId).trim().toLowerCase(), 32);

export const getEntityDisplayInfo = (
  entityId: string,
): { name: string; avatar: string; type: 'numbered' | 'lazy' } => {
  if (!entityId) return { name: 'Entity (undefined)', avatar: '❓', type: 'numbered' };
  return {
    name: `Entity #${extractNumberFromEntityId(entityId)}`,
    avatar: generateEntityAvatar(entityId),
    type: 'numbered',
  };
};

export const getSignerDisplayInfo = (
  signerId: string,
): { name: string; address: string; avatar: string } => {
  const signer = DEMO_SIGNERS[signerId as keyof typeof DEMO_SIGNERS];
  return {
    name: signer?.name ?? signerId,
    address: signer?.address ?? signerId,
    avatar: generateSignerAvatar(signerId),
  };
};

export const getEntityShortId = (entityId: string): string => {
  if (!entityId || entityId === '0x' || entityId === '0x0') return '0';
  const hex = entityId.startsWith('0x') ? entityId.slice(2) : entityId;
  try {
    const value = BigInt(`0x${hex}`);
    if (value >= 0n && value < BigInt(256 ** 6)) return value.toString();
  } catch {
    // Non-hex identifiers use the same compact fingerprint as hash entities.
  }
  return hex.slice(0, 4).toUpperCase();
};
