import { deserializeWsMessage, type RuntimeWsMessage } from '../../../network/p2p/ws-protocol';
import { decodeMarketWireRequest, type MarketWireRequest } from '../../../network/relay/market/wire';

export type RelaySocketFrame =
  | Readonly<{ kind: 'peer'; message: RuntimeWsMessage }>
  | Readonly<{ kind: 'market'; message: MarketWireRequest }>;

/**
 * A relay socket carries peer frames and text market requests. A binary frame
 * that is not a peer message is invalid as is: decoding it to text let one
 * unauthenticated 256 MiB frame cost about 1.5 GB of transient memory.
 */
export const decodeRelaySocketFrame = (
  message: string | Uint8Array | ArrayBuffer,
  authenticated: boolean,
): RelaySocketFrame => {
  try {
    return { kind: 'peer', message: deserializeWsMessage(message, { authenticated }) };
  } catch (peerError) {
    if (typeof message !== 'string') throw peerError;
    try {
      return { kind: 'market', message: decodeMarketWireRequest(message) };
    } catch {
      throw peerError;
    }
  }
};
