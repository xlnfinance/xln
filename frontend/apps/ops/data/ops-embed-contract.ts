export type EmbedCommand = Readonly<{ type: 'xln:embed:command'; version: 1; command: 'play' | 'pause' | 'seek'; frame?: number }>;
export const parseEmbedCommand = (value: unknown): EmbedCommand => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OPS_EMBED_MESSAGE_INVALID');
  const raw = value as Record<string, unknown>;
  if (raw['type'] !== 'xln:embed:command' || raw['version'] !== 1) throw new Error('OPS_EMBED_MESSAGE_PROTOCOL_INVALID');
  const command = raw['command']; if (command !== 'play' && command !== 'pause' && command !== 'seek') throw new Error('OPS_EMBED_COMMAND_INVALID');
  if (command === 'seek') { const frame = raw['frame']; if (typeof frame !== 'number' || !Number.isSafeInteger(frame) || frame < 0) throw new Error('OPS_EMBED_FRAME_INVALID'); return Object.freeze({ type: 'xln:embed:command', version: 1, command, frame }); }
  if (raw['frame'] !== undefined) throw new Error('OPS_EMBED_FRAME_UNEXPECTED');
  return Object.freeze({ type: 'xln:embed:command', version: 1, command });
};
export const postEmbedState = (state: Readonly<{ status: string; scenarioId: string; frame: number; frames: number; playing: boolean }>): void => {
  if (window.parent === window) return;
  window.parent.postMessage(Object.freeze({ type: 'xln:embed:state', version: 1, ...state }), window.location.origin);
};
