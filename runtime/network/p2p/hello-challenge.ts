import { serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';

type ChallengeSocket = { send(data: Uint8Array): unknown };

const createChallenge = (): string => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const createHelloChallengeRegistry = () => {
  const challenges = new Map<object, string>();
  return {
    issue(ws: ChallengeSocket): string {
      const challenge = createChallenge();
      challenges.set(ws, challenge);
      ws.send(serializeWsMessage({ type: 'hello_challenge', challenge } satisfies RuntimeWsMessage));
      return challenge;
    },
    consume(ws: object, challenge: unknown): boolean {
      const expected = challenges.get(ws);
      challenges.delete(ws);
      return typeof challenge === 'string' && challenge === expected;
    },
    forget(ws: object): void {
      challenges.delete(ws);
    },
  };
};
