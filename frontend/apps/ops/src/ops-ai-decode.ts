// Strict decoders for the React /ai console against the local operator AI
// service (ai/server.ts). Unlike the xln QA boundary these decoders validate
// every consumed field loudly but tolerate unknown extra keys: the AI server
// is a standalone local tool that evolves independently, and rejecting its
// unrelated additions would take the operator console down for no financial
// or protocol reason.

import {
  isUnknownRecord,
  optionalBoolean,
  optionalFiniteNumber,
  optionalString,
  requireFiniteNumber,
  requireString,
  requireUnknownRecord,
} from '../../../packages/runtime-client/src/boundary';

export const AI_SERVER_URL = 'http://localhost:3031';
export const AI_WAKE_WORD = 'hello';
export const AI_CAMERA_INTERVAL_MS = 5000;
export const AI_STATS_INTERVAL_MS = 2000;
export const AI_VISION_MODEL = 'qwen3-vl:4b';
export const AI_VISION_PROMPT =
  'Briefly describe what you see. Focus on people, objects, and activities. Be concise.';
export const AI_DEFAULT_SELECTED_MODEL = 'qwen3-coder:latest';
export const AI_ENTITY_CONTEXT_KEY = 'xln-entity-context';
export const AI_PINNED_CHATS_KEY = 'pinnedChats';
export const AI_SPEAK_SLICE = 500;

export type AiMessage = Readonly<{
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  timestamp?: string;
  images?: readonly string[];
  council?: {
    stage1: Record<string, string>;
    stage2: Record<string, { rankings: Record<string, number>; reasoning: string }>;
    stage3: string;
  };
}>;

export type AiModel = Readonly<{
  id: string;
  name: string;
  vision: boolean;
  available: boolean;
  backend?: string;
  loaded?: boolean;
}>;

export type AiMlxState = Readonly<{ loading: boolean; loadProgress?: string; activeModel: string | null }>;

export type AiSystemStats = Readonly<{
  memory: Readonly<{ totalGB: string; usedGB: string; usedPercent: number }>;
  gpu?: Readonly<{ utilization: number; active: boolean }>;
  mlx: Readonly<{
    activeModel: string | null;
    activeModelName: string | null;
    activeModelParams: string | null;
    loading: boolean;
    loadProgress: string;
  }>;
}>;

export type AiToolCall = Readonly<{ id: string; function: Readonly<{ name: string; arguments: string }> }>;

export type AiToolDefinition = Readonly<{
  type?: string;
  function?: Readonly<{ name: string; description?: string; parameters?: unknown }>;
}>;

export type AiVoiceConfig = Readonly<{ hotkey: string; model: string; pasteDelay: number }>;

export type AiSavedChat = Readonly<{ id: string; title: string; updated: string; pinned?: boolean }>;

export type AiEntityContext = Readonly<{
  entityId: string;
  signerId: string;
  jurisdiction: string;
  reserves: Record<string, string>;
  accountCount: number;
  timestamp: number;
}>;

export type AiChatSession = Readonly<{
  id: string;
  title: string;
  messages: readonly AiMessage[];
  councilMode: boolean;
}>;

export const AI_STT_MODELS = [
  { id: 'whisper-large-v3', name: 'Whisper Large v3 (MLX)' },
  { id: 'faster-whisper', name: 'Faster Whisper' },
  { id: 'web-speech', name: 'Browser Speech API' },
] as const;

export const AI_TTS_MODELS = [
  { id: 'piper', name: 'Piper (fast)' },
  { id: 'coqui', name: 'Coqui TTS' },
  { id: 'browser', name: 'Browser TTS' },
] as const;

export const AI_VOICE_HOTKEYS = [
  { value: 'LEFT CTRL', label: 'Left Ctrl' },
  { value: 'RIGHT CTRL', label: 'Right Ctrl' },
  { value: 'LEFT ALT', label: 'Left Alt' },
  { value: 'RIGHT ALT', label: 'Right Alt' },
  { value: 'LEFT SHIFT', label: 'Left Shift' },
  { value: 'RIGHT SHIFT', label: 'Right Shift' },
] as const;

export const AI_VOICE_MODELS = [
  { value: 'large-v3', label: 'Large v3' },
  { value: 'medium', label: 'Medium' },
  { value: 'small', label: 'Small' },
  { value: 'base', label: 'Base' },
] as const;

const isAiRole = (value: unknown): value is AiMessage['role'] =>
  value === 'user' || value === 'assistant' || value === 'system';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string');

// The AI server reports inactive MLX slots as JSON null, not as an absent key.
const nullableString = (value: unknown, code: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new Error(code);
};

export const decodeAiMessage = (value: unknown): AiMessage => {
  const record = requireUnknownRecord(value, 'AI_MESSAGE_INVALID');
  if (!isAiRole(record['role'])) throw new Error('AI_MESSAGE_ROLE_INVALID');
  return {
    role: record['role'],
    content: requireString(record['content'], 'AI_MESSAGE_CONTENT_INVALID'),
    ...(record['model'] === undefined ? {} : { model: requireString(record['model'], 'AI_MESSAGE_MODEL_INVALID') }),
    ...(record['timestamp'] === undefined ? {} : { timestamp: requireString(record['timestamp'], 'AI_MESSAGE_TIMESTAMP_INVALID') }),
    ...(record['images'] === undefined ? {} : {
      images: isStringArray(record['images']) ? record['images'] : (() => { throw new Error('AI_MESSAGE_IMAGES_INVALID'); })(),
    }),
  };
};

const decodeAiModel = (value: unknown): AiModel => {
  const record = requireUnknownRecord(value, 'AI_MODEL_INVALID');
  return {
    id: requireString(record['id'], 'AI_MODEL_ID_INVALID'),
    name: requireString(record['name'], 'AI_MODEL_NAME_INVALID'),
    vision: record['vision'] === true,
    available: record['available'] === true,
    ...(record['backend'] === undefined ? {} : { backend: requireString(record['backend'], 'AI_MODEL_BACKEND_INVALID') }),
    ...(record['loaded'] === undefined ? {} : { loaded: optionalBoolean(record['loaded'], 'AI_MODEL_LOADED_INVALID') === true }),
  };
};

export const decodeAiModelsPayload = (value: unknown): Readonly<{
  models: AiModel[];
  councilModels: string[];
  defaultModel?: string;
  mlx?: AiMlxState;
}> => {
  const record = requireUnknownRecord(value, 'AI_MODELS_RESPONSE_INVALID');
  if (!Array.isArray(record['models'])) throw new Error('AI_MODELS_LIST_INVALID');
  const mlxState = record['mlx_state'] === undefined ? undefined : requireUnknownRecord(record['mlx_state'], 'AI_MLX_STATE_INVALID');
  const mlx = mlxState === undefined ? undefined : {
    loading: mlxState['loading'] === true,
    ...(mlxState['loadProgress'] === undefined ? {} : { loadProgress: requireString(mlxState['loadProgress'], 'AI_MLX_PROGRESS_INVALID') }),
    activeModel: nullableString(mlxState['activeModel'], 'AI_MLX_MODEL_INVALID'),
  };
  return {
    models: record['models'].map(decodeAiModel),
    councilModels: record['council_models'] === undefined
      ? []
      : isStringArray(record['council_models']) ? record['council_models'] : (() => { throw new Error('AI_COUNCIL_MODELS_INVALID'); })(),
    ...(record['default_model'] === undefined ? {} : { defaultModel: requireString(record['default_model'], 'AI_DEFAULT_MODEL_INVALID') }),
    ...(mlx === undefined ? {} : { mlx }),
  };
};

export const decodeAiChatsPayload = (value: unknown): readonly AiSavedChat[] => {
  const record = requireUnknownRecord(value, 'AI_CHATS_RESPONSE_INVALID');
  if (!Array.isArray(record['chats'])) throw new Error('AI_CHATS_LIST_INVALID');
  return record['chats'].map((chat: unknown) => {
    const entry = requireUnknownRecord(chat, 'AI_CHAT_ENTRY_INVALID');
    return {
      id: requireString(entry['id'], 'AI_CHAT_ID_INVALID'),
      title: requireString(entry['title'], 'AI_CHAT_TITLE_INVALID'),
      updated: requireString(entry['updated'], 'AI_CHAT_UPDATED_INVALID'),
    };
  });
};

export const decodeAiChatSession = (value: unknown): AiChatSession => {
  const record = requireUnknownRecord(value, 'AI_CHAT_SESSION_INVALID');
  if (!Array.isArray(record['messages'])) throw new Error('AI_CHAT_SESSION_MESSAGES_INVALID');
  return {
    id: requireString(record['id'], 'AI_CHAT_SESSION_ID_INVALID'),
    title: requireString(record['title'], 'AI_CHAT_SESSION_TITLE_INVALID'),
    messages: record['messages'].map(decodeAiMessage),
    councilMode: record['council_mode'] === true,
  };
};

export const decodeAiToolsPayload = (value: unknown): readonly AiToolDefinition[] => {
  const record = requireUnknownRecord(value, 'AI_TOOLS_RESPONSE_INVALID');
  if (!Array.isArray(record['tools'])) throw new Error('AI_TOOLS_LIST_INVALID');
  return record['tools'].map((tool: unknown) => {
    const entry = requireUnknownRecord(tool, 'AI_TOOL_DEFINITION_INVALID');
    const fn = entry['function'] === undefined ? undefined : requireUnknownRecord(entry['function'], 'AI_TOOL_FUNCTION_INVALID');
    return {
      ...(entry['type'] === undefined ? {} : { type: requireString(entry['type'], 'AI_TOOL_TYPE_INVALID') }),
      ...(fn === undefined ? {} : {
        function: {
          name: requireString(fn['name'], 'AI_TOOL_NAME_INVALID'),
          ...(fn['description'] === undefined ? {} : { description: requireString(fn['description'], 'AI_TOOL_DESCRIPTION_INVALID') }),
          ...(fn['parameters'] === undefined ? {} : { parameters: fn['parameters'] }),
        },
      }),
    };
  });
};

export const decodeAiSystemStats = (value: unknown): AiSystemStats => {
  const record = requireUnknownRecord(value, 'AI_STATS_RESPONSE_INVALID');
  const memory = requireUnknownRecord(record['memory'], 'AI_STATS_MEMORY_INVALID');
  const gpuRecord = record['gpu'] === undefined ? undefined : requireUnknownRecord(record['gpu'], 'AI_STATS_GPU_INVALID');
  const mlx = requireUnknownRecord(record['mlx'], 'AI_STATS_MLX_INVALID');
  return {
    memory: {
      totalGB: requireString(memory['totalGB'], 'AI_STATS_MEMORY_FIELD_INVALID'),
      usedGB: requireString(memory['usedGB'], 'AI_STATS_MEMORY_FIELD_INVALID'),
      usedPercent: optionalFiniteNumber(memory['usedPercent'], 'AI_STATS_MEMORY_FIELD_INVALID') ?? 0,
    },
    ...(gpuRecord === undefined ? {} : {
      gpu: {
        utilization: optionalFiniteNumber(gpuRecord['utilization'], 'AI_STATS_GPU_FIELD_INVALID') ?? 0,
        active: gpuRecord['active'] === true,
      },
    }),
    mlx: {
      activeModel: nullableString(mlx['activeModel'], 'AI_STATS_MLX_FIELD_INVALID'),
      activeModelName: nullableString(mlx['activeModelName'], 'AI_STATS_MLX_FIELD_INVALID'),
      activeModelParams: nullableString(mlx['activeModelParams'], 'AI_STATS_MLX_FIELD_INVALID'),
      loading: mlx['loading'] === true,
      loadProgress: optionalString(mlx['loadProgress'], 'AI_STATS_MLX_FIELD_INVALID') ?? '',
    },
  };
};

export const decodeAiVoiceConfig = (value: unknown): AiVoiceConfig => {
  const record = requireUnknownRecord(value, 'AI_VOICE_CONFIG_INVALID');
  return {
    hotkey: requireString(record['hotkey'], 'AI_VOICE_CONFIG_FIELD_INVALID'),
    model: requireString(record['model'], 'AI_VOICE_CONFIG_FIELD_INVALID'),
    pasteDelay: requireFiniteNumber(record['pasteDelay'], 'AI_VOICE_CONFIG_FIELD_INVALID'),
  };
};

export const decodeAiVoiceStatus = (value: unknown): Readonly<{ running: boolean }> => {
  const record = requireUnknownRecord(value, 'AI_VOICE_STATUS_INVALID');
  return { running: record['running'] === true };
};

export const decodeAiCouncilResponse = (payload: unknown): Readonly<{
  chairman: string;
  stage1: Record<string, string>;
  stage2: Record<string, { rankings: Record<string, number>; reasoning: string }>;
  stage3: string;
}> => {
  const record = requireUnknownRecord(payload, 'AI_COUNCIL_RESPONSE_INVALID');
  const stage1Record = requireUnknownRecord(record['stage1'], 'AI_COUNCIL_STAGE1_INVALID');
  const stage2Record = requireUnknownRecord(record['stage2'], 'AI_COUNCIL_STAGE2_INVALID');
  const stage1: Record<string, string> = {};
  for (const [model, response] of Object.entries(stage1Record)) {
    if (typeof response !== 'string') throw new Error('AI_COUNCIL_STAGE1_RESPONSE_INVALID');
    stage1[model] = response;
  }
  const stage2: Record<string, { rankings: Record<string, number>; reasoning: string }> = {};
  for (const [model, review] of Object.entries(stage2Record)) {
    const entry = requireUnknownRecord(review, 'AI_COUNCIL_REVIEW_INVALID');
    const rankings = requireUnknownRecord(entry['rankings'] ?? {}, 'AI_COUNCIL_RANKINGS_INVALID');
    for (const ranking of Object.values(rankings)) {
      if (typeof ranking !== 'number') throw new Error('AI_COUNCIL_RANKINGS_INVALID');
    }
    stage2[model] = {
      rankings: rankings as Record<string, number>,
      reasoning: requireString(entry['reasoning'], 'AI_COUNCIL_REASONING_INVALID'),
    };
  }
  return {
    chairman: requireString(record['chairman'], 'AI_COUNCIL_CHAIRMAN_INVALID'),
    stage1,
    stage2,
    stage3: requireString(record['stage3'], 'AI_COUNCIL_STAGE3_INVALID'),
  };
};

export const decodeAiAgentChatResponse = (payload: unknown): Readonly<{
  content: string;
  toolCalls: readonly AiToolCall[];
}> => {
  const record = requireUnknownRecord(payload, 'AI_AGENT_RESPONSE_INVALID');
  const calls = record['tool_calls'] === undefined ? [] : record['tool_calls'];
  if (!Array.isArray(calls)) throw new Error('AI_AGENT_TOOL_CALLS_INVALID');
  return {
    content: optionalString(record['content'], 'AI_AGENT_CONTENT_INVALID') ?? '',
    toolCalls: calls.map(call => {
      const entry = requireUnknownRecord(call, 'AI_TOOL_CALL_INVALID');
      const fn = requireUnknownRecord(entry['function'], 'AI_TOOL_CALL_FUNCTION_INVALID');
      return {
        id: requireString(entry['id'], 'AI_TOOL_CALL_ID_INVALID'),
        function: {
          name: requireString(fn['name'], 'AI_TOOL_CALL_NAME_INVALID'),
          arguments: requireString(fn['arguments'], 'AI_TOOL_CALL_ARGUMENTS_INVALID'),
        },
      };
    }),
  };
};

export const decodeAiSuccessResponse = (payload: unknown, code: string): true => {
  const record = requireUnknownRecord(payload, code);
  if (record['success'] !== true) throw new Error(code);
  return true;
};

export const decodeAiPinnedChats = (stored: string | null): readonly string[] =>
  stored === null ? [] : (() => {
    const parsed: unknown = JSON.parse(stored);
    return isStringArray(parsed) ? parsed : (() => { throw new Error('AI_PINNED_CHATS_INVALID'); })();
  })();

export const decodeAiEntityContext = (stored: string): AiEntityContext => {
  const record = requireUnknownRecord(JSON.parse(stored), 'AI_ENTITY_CONTEXT_INVALID');
  const reservesRecord = requireUnknownRecord(record['reserves'], 'AI_ENTITY_CONTEXT_RESERVES_INVALID');
  const reserves: Record<string, string> = {};
  for (const [tokenId, amount] of Object.entries(reservesRecord)) {
    if (typeof amount !== 'string') throw new Error('AI_ENTITY_CONTEXT_RESERVES_INVALID');
    reserves[tokenId] = amount;
  }
  if (!isUnknownRecord(record)) throw new Error('AI_ENTITY_CONTEXT_INVALID');
  return {
    entityId: requireString(record['entityId'], 'AI_ENTITY_CONTEXT_FIELD_INVALID'),
    signerId: requireString(record['signerId'], 'AI_ENTITY_CONTEXT_FIELD_INVALID'),
    jurisdiction: requireString(record['jurisdiction'], 'AI_ENTITY_CONTEXT_FIELD_INVALID'),
    reserves,
    accountCount: requireFiniteNumber(record['accountCount'], 'AI_ENTITY_CONTEXT_FIELD_INVALID'),
    timestamp: requireFiniteNumber(record['timestamp'], 'AI_ENTITY_CONTEXT_FIELD_INVALID'),
  };
};
