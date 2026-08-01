import { serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';

type ChallengeSocket = { send(data: Uint8Array): unknown };
export type HelloChallengeBinding = { challenge: string; audience: string };

const createChallenge = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const createHelloChallengeRegistry = () => {
  const challenges = new Map<object, HelloChallengeBinding>();
  return {
    issue(ws: ChallengeSocket, audience: string): HelloChallengeBinding {
      if (!audience) throw new Error('WS_HELLO_AUDIENCE_MISSING');
      const binding = { challenge: createChallenge(), audience };
      challenges.set(ws, binding);
      ws.send(serializeWsMessage({ type: 'hello_challenge', ...binding } satisfies RuntimeWsMessage));
      return binding;
    },
    consume(ws: object, claim: unknown): HelloChallengeBinding | null {
      const expected = challenges.get(ws);
      challenges.delete(ws);
      const challenge = (claim as Partial<HelloChallengeBinding> | null)?.challenge;
      const audience = (claim as Partial<HelloChallengeBinding> | null)?.audience;
      return typeof challenge === 'string' && typeof audience === 'string'
        && challenge === expected?.challenge && audience === expected.audience
        ? expected
        : null;
    },
    forget(ws: object): void {
      challenges.delete(ws);
    },
  };
};
