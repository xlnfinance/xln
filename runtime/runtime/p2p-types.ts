/**
 * Runtime-owned transport controls.
 *
 * These interfaces describe the local P2P capability attached to a Runtime
 * replica. They are infrastructure and must never enter RuntimeState roots.
 */
export type RuntimeP2PConfigLike = {
  relayUrls?: string[];
  wsUrl?: string | null;
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  isHub?: boolean;
  gossipPollMs?: number;
};
