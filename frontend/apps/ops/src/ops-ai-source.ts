// External store for the React /ai console. Owns every server exchange with
// the local AI service (ai/server.ts) and the chat session state; browser
// effects (Web Speech, camera, audio) stay in the view. Generation counters
// discard results that resolve after stop() so pagehide teardown is quiet.

import {
  AI_ENTITY_CONTEXT_KEY,
  AI_PINNED_CHATS_KEY,
  AI_SERVER_URL,
  AI_STATS_INTERVAL_MS,
  AI_VISION_MODEL,
  AI_VISION_PROMPT,
  type AiMessage,
  type AiModel,
  type AiSavedChat,
  type AiSystemStats,
  type AiToolCall,
  type AiToolDefinition,
  type AiVoiceConfig,
  decodeAiAgentChatResponse,
  decodeAiChatsPayload,
  decodeAiChatSession,
  decodeAiCouncilResponse,
  decodeAiEntityContext,
  decodeAiModelsPayload,
  decodeAiPinnedChats,
  decodeAiSystemStats,
  decodeAiToolsPayload,
  decodeAiVoiceConfig,
  decodeAiVoiceStatus,
} from './ops-ai-decode';
import {
  aiAgentStatusMessage,
  aiDefaultSelectedModel,
  aiToolResultMessage,
  aiVisionMessage,
  buildAiChatRequest,
  buildAiEntitySystemMessage,
  generateAiChatTitle,
  nextAiChatId,
  readAiStreamChunk,
  resolveAiChatId,
} from './ops-ai-model';

export type OpsAiSnapshot = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  models: readonly AiModel[];
  councilModels: readonly string[];
  selectedModel: string;
  agentModeEnabled: boolean;
  mlxLoading: boolean;
  mlxLoadProgress: string;
  mlxActiveModel: string | null;
  availableTools: readonly AiToolDefinition[];
  systemStats: AiSystemStats | null;
  savedChats: readonly AiSavedChat[];
  chatId: string;
  chatTitle: string;
  messages: readonly AiMessage[];
  councilMode: boolean;
  isLoading: boolean;
  streamingContent: string;
  voiceConfig: AiVoiceConfig;
  voicePasteRunning: boolean;
  voiceConfigNotice: 'idle' | 'saved' | 'failed';
  lastVisionDescription: string;
}>;

export type OpsAiDependencies = Readonly<{
  get: <T>(path: string, decode: (payload: unknown) => T) => Promise<T>;
  post: <T>(path: string, body: string, decode: (payload: unknown) => T) => Promise<T>;
  postVoid: (path: string, body: string) => Promise<void>;
  del: (path: string) => Promise<void>;
  streamChat: (body: string, onChunk: (chunk: string) => void, signal: AbortSignal) => Promise<void>;
  synthesize: (text: string) => Promise<Blob | null>;
  describeImage: (blob: Blob) => Promise<string | null>;
  executeTool: (call: AiToolCall) => Promise<string>;
  currentUrl: () => URL;
  replaceUrl: (url: URL) => void;
  readStorage: (key: string) => string | null;
  writeStorage: (key: string, value: string) => void;
  removeStorage: (key: string) => void;
  now: () => number;
  scheduleInterval: (handler: () => void, ms: number) => number;
  cancelInterval: (id: number) => void;
}>;

export type OpsAiSource = Readonly<{
  getSnapshot: () => OpsAiSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
  selectModel: (modelId: string) => void;
  setCouncilMode: (next: boolean) => void;
  setAgentMode: (next: boolean) => void;
  newChat: () => void;
  loadChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  togglePinChat: (id: string) => void;
  send: (content: string, images: readonly string[]) => Promise<string>;
  recordVision: (description: string) => void;
  synthesize: (text: string) => Promise<Blob | null>;
  describeImage: (blob: Blob) => Promise<string | null>;
  saveVoiceConfig: (config: AiVoiceConfig) => Promise<void>;
  loadMlxModel: (modelId: string) => Promise<void>;
  ejectMlxModel: () => Promise<void>;
}>;

const json = async (response: Response): Promise<unknown> => {
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(`AI_HTTP_${response.status}`);
  return payload;
};

const dependencies = (): OpsAiDependencies => ({
  get: async (path, decode) => decode(await json(await fetch(`${AI_SERVER_URL}${path}`))),
  post: async (path, body, decode) =>
    decode(await json(await fetch(`${AI_SERVER_URL}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }))),
  postVoid: async (path, body) => {
    const response = await fetch(`${AI_SERVER_URL}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    if (!response.ok) throw new Error(`AI_HTTP_${response.status}`);
  },
  del: async path => {
    const response = await fetch(`${AI_SERVER_URL}${path}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`AI_HTTP_${response.status}`);
  },
  streamChat: async (body, onChunk, signal) => {
    const response = await fetch(`${AI_SERVER_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal,
    });
    if (!response.ok) throw new Error(`AI_HTTP_${response.status}`);
    if (!response.body) throw new Error('AI_STREAM_BODY_MISSING');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value));
    }
  },
  synthesize: async text => {
    const response = await fetch(`${AI_SERVER_URL}/api/synthesize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!response.ok) return null;
    return response.blob();
  },
  describeImage: async blob => {
    const formData = new FormData();
    formData.append('image', blob, 'capture.jpg');
    formData.append('model', AI_VISION_MODEL);
    formData.append('prompt', AI_VISION_PROMPT);
    const response = await fetch(`${AI_SERVER_URL}/api/vision`, { method: 'POST', body: formData });
    const payload = response.json() as Promise<{ content?: unknown }>;
    const data = await payload.catch(() => null);
    return typeof data?.content === 'string' ? data.content : null;
  },
  // Canonical tool execution: a rejected call becomes tool-result JSON, never
  // a thrown error — the agent loop continues with the failure as evidence.
  executeTool: async call => {
    try {
      const args = JSON.parse(call.function.arguments) as unknown;
      const response = await fetch(`${AI_SERVER_URL}/api/xln/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: call.function.name, args }),
      });
      const data = await response.json() as { result?: unknown; error?: unknown };
      return JSON.stringify(data.error !== undefined && data.error !== null
        ? { error: data.error }
        : { result: data.result });
    } catch (error: unknown) {
      return JSON.stringify({ error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
  currentUrl: () => new URL(window.location.href),
  replaceUrl: url => window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`),
  readStorage: key => localStorage.getItem(key),
  writeStorage: (key, value) => localStorage.setItem(key, value),
  removeStorage: key => localStorage.removeItem(key),
  now: () => Date.now(),
  scheduleInterval: (handler, ms) => window.setInterval(handler, ms),
  cancelInterval: id => window.clearInterval(id),
});

const initialSnapshot = (): OpsAiSnapshot => ({
  status: 'idle', error: '', models: [], councilModels: [], selectedModel: 'qwen3-coder:latest',
  agentModeEnabled: false, mlxLoading: false, mlxLoadProgress: '', mlxActiveModel: null,
  availableTools: [], systemStats: null, savedChats: [], chatId: '', chatTitle: 'New Chat',
  messages: [], councilMode: false, isLoading: false, streamingContent: '',
  voiceConfig: { hotkey: 'LEFT CTRL', model: 'large-v3', pasteDelay: 100 },
  voicePasteRunning: false, voiceConfigNotice: 'idle', lastVisionDescription: '',
});

export const createOpsAiSource = (deps: OpsAiDependencies = dependencies()): OpsAiSource => {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot();
  let started = false;
  let generation = 0;
  let statsTimer: number | null = null;
  let sendController: AbortController | null = null;
  let sending = false;

  const publish = (patch: Partial<OpsAiSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const timestamp = (): string => new Date(deps.now()).toISOString();

  const appendMessage = (message: AiMessage): void => {
    publish({ messages: [...snapshot.messages, message] });
  };

  const fetchStats = async (): Promise<void> => {
    const owned = generation;
    try {
      const stats = await deps.get('/api/system/stats', decodeAiSystemStats);
      if (!started || owned !== generation) return;
      publish({
        systemStats: stats,
        mlxLoading: stats.mlx.loading, mlxLoadProgress: stats.mlx.loadProgress, mlxActiveModel: stats.mlx.activeModel,
      });
    } catch {
      // Stats are optional health evidence; the canonical page also ignores failures.
    }
  };

  const loadModels = async (): Promise<void> => {
    const payload = await deps.get('/api/models', decodeAiModelsPayload);
    publish({
      models: payload.models, councilModels: payload.councilModels,
      selectedModel: aiDefaultSelectedModel(payload.models, payload.defaultModel ?? snapshot.selectedModel),
      ...(payload.mlx ? { mlxLoading: payload.mlx.loading, mlxLoadProgress: payload.mlx.loadProgress ?? '', mlxActiveModel: payload.mlx.activeModel } : {}),
    });
  };

  const loadChats = async (): Promise<void> => {
    const chats = await deps.get('/api/chats', decodeAiChatsPayload);
    const pins = decodeAiPinnedChats(deps.readStorage(AI_PINNED_CHATS_KEY));
    publish({ savedChats: chats.map(chat => ({ ...chat, pinned: pins.includes(chat.id) })) });
  };

  const runLoads = async (): Promise<string> => {
    publish({ status: snapshot.models.length === 0 && snapshot.savedChats.length === 0 ? 'loading' : snapshot.status, error: '' });
    const failures: string[] = [];
    for (const load of [loadModels, loadChats, async () => { publish({ availableTools: await deps.get('/api/xln/tools', decodeAiToolsPayload) }); }]) {
      try { await load(); } catch (error: unknown) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    try {
      publish({ voiceConfig: await deps.get('/api/voice/config', decodeAiVoiceConfig) });
    } catch (error: unknown) { failures.push(error instanceof Error ? error.message : String(error)); }
    try {
      publish({ voicePasteRunning: (await deps.get('/api/voice/status', decodeAiVoiceStatus)).running });
    } catch (error: unknown) { failures.push(error instanceof Error ? error.message : String(error)); }
    await fetchStats();
    return failures[0] ?? '';
  };

  const consumeEntityContext = (): void => {
    const url = deps.currentUrl();
    if (url.searchParams.get('context') !== 'entity') return;
    const stored = deps.readStorage(AI_ENTITY_CONTEXT_KEY);
    if (!stored) return;
    try {
      const context = decodeAiEntityContext(stored);
      publish({
        chatId: nextAiChatId(deps.now(), context.entityId),
        chatTitle: `Entity ${context.entityId.slice(0, 8)}...`,
        messages: [{ role: 'system', content: buildAiEntitySystemMessage(context), timestamp: timestamp() }],
      });
      const clean = new URL(url.toString());
      clean.searchParams.delete('context');
      clean.pathname = '/ai';
      deps.replaceUrl(clean);
      deps.removeStorage(AI_ENTITY_CONTEXT_KEY);
    } catch (error: unknown) {
      publish({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  const saveChat = async (): Promise<void> => {
    const title = snapshot.chatTitle === 'New Chat' && snapshot.messages.length > 0
      ? generateAiChatTitle(snapshot.messages)
      : snapshot.chatTitle;
    publish({ chatTitle: title });
    await deps.postVoid('/api/chats', JSON.stringify({
      id: snapshot.chatId, title, messages: snapshot.messages,
      council_mode: snapshot.councilMode, created_at: timestamp(), updated_at: timestamp(),
    }));
    await loadChats().catch(() => undefined);
  };

  const send = async (content: string, images: readonly string[]): Promise<string> => {
    if (sending || (!content.trim() && images.length === 0)) return '';
    const owned = generation;
    sending = true;
    sendController = new AbortController();
    const userMessage: AiMessage = {
      role: 'user', content, timestamp: timestamp(),
      ...(images.length > 0 ? { images: [...images] } : {}),
    };
    publish({ messages: [...snapshot.messages, userMessage], isLoading: true });
    let finalContent = '';
    try {
      if (snapshot.councilMode) {
        const council = await deps.post('/api/council', JSON.stringify({ query: content, models: snapshot.councilModels }), decodeAiCouncilResponse);
        if (!started || owned !== generation) return '';
        finalContent = council.stage3;
        appendMessage({
          role: 'assistant', content: council.stage3,
          model: `Council (Chairman: ${council.chairman})`, timestamp: timestamp(),
          council: { stage1: council.stage1, stage2: council.stage2, stage3: council.stage3 },
        });
      } else {
        const request = buildAiChatRequest({
          model: snapshot.selectedModel,
          messages: snapshot.messages.map(message => ({ role: message.role, content: message.content })),
          stream: !snapshot.agentModeEnabled,
          ...(userMessage.images ? { images: userMessage.images } : {}),
          ...(snapshot.agentModeEnabled && snapshot.availableTools.length > 0 ? { tools: snapshot.availableTools } : {}),
        });
        if (snapshot.agentModeEnabled) {
          const data = await deps.post('/api/chat', request, decodeAiAgentChatResponse);
          if (!started || owned !== generation) return '';
          if (data.toolCalls.length > 0) {
            appendMessage({ role: 'system', content: aiAgentStatusMessage(data.toolCalls), timestamp: timestamp() });
            for (const call of data.toolCalls) {
              const result = await deps.executeTool(call);
              if (!started || owned !== generation) return '';
              appendMessage({ role: 'system', content: aiToolResultMessage(call.function.name, result), timestamp: timestamp() });
            }
          }
          if (data.content) {
            finalContent = data.content;
            appendMessage({ role: 'assistant', content: data.content, model: snapshot.selectedModel, timestamp: timestamp() });
          }
        } else {
          publish({ streamingContent: '' });
          await deps.streamChat(request, chunk => {
            if (!started || owned !== generation) return;
            publish({ streamingContent: snapshot.streamingContent + readAiStreamChunk(chunk) });
          }, sendController.signal);
          if (!started || owned !== generation) return '';
          finalContent = snapshot.streamingContent;
          appendMessage({ role: 'assistant', content: snapshot.streamingContent, model: snapshot.selectedModel, timestamp: timestamp() });
          publish({ streamingContent: '' });
        }
      }
      await saveChat();
      return finalContent;
    } catch (error: unknown) {
      if (!started || owned !== generation) return '';
      appendMessage({ role: 'system', content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`, timestamp: timestamp() });
      return '';
    } finally {
      sending = false;
      sendController = null;
      publish({ isLoading: false, streamingContent: '' });
    }
  };

  const source: OpsAiSource = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => {
      if (started) return;
      started = true;
      generation += 1;
      publish({ chatId: nextAiChatId(deps.now()) });
      const error = await runLoads();
      consumeEntityContext();
      const urlChatId = resolveAiChatId(deps.currentUrl().pathname);
      if (urlChatId) await source.loadChat(urlChatId).catch(() => undefined);
      publish({ status: error ? 'error' : 'ready', error });
      if (statsTimer === null) statsTimer = deps.scheduleInterval(() => { void fetchStats(); }, AI_STATS_INTERVAL_MS);
    },
    stop: () => {
      if (!started) return;
      started = false;
      generation += 1;
      sendController?.abort();
      if (statsTimer !== null) { deps.cancelInterval(statsTimer); statsTimer = null; }
      publish(initialSnapshot());
    },
    refresh: async () => {
      if (!started) return;
      const error = await runLoads();
      publish({ status: error ? 'error' : 'ready', error });
    },
    selectModel: modelId => publish({ selectedModel: modelId }),
    setCouncilMode: next => publish({ councilMode: next }),
    setAgentMode: next => publish({ agentModeEnabled: next }),
    newChat: () => {
      publish({ chatId: nextAiChatId(deps.now()), chatTitle: 'New Chat', messages: [] });
      const url = deps.currentUrl();
      url.pathname = '/ai';
      deps.replaceUrl(url);
    },
    loadChat: async id => {
      try {
        const session = await deps.get(`/api/chats/${id}`, decodeAiChatSession);
        publish({ chatId: session.id, chatTitle: session.title, messages: session.messages, councilMode: session.councilMode });
        const url = deps.currentUrl();
        url.pathname = `/ai/${id}`;
        deps.replaceUrl(url);
      } catch (error: unknown) {
        publish({ error: error instanceof Error ? error.message : String(error) });
      }
    },
    deleteChat: async id => {
      try {
        await deps.del(`/api/chats/${id}`);
        publish({ savedChats: snapshot.savedChats.filter(chat => chat.id !== id) });
        if (snapshot.chatId === id) source.newChat();
      } catch (error: unknown) {
        publish({ error: error instanceof Error ? error.message : String(error) });
      }
    },
    togglePinChat: id => {
      const savedChats = snapshot.savedChats.map(chat => chat.id === id ? { ...chat, pinned: !chat.pinned } : chat);
      publish({ savedChats });
      deps.writeStorage(AI_PINNED_CHATS_KEY, JSON.stringify(savedChats.filter(chat => chat.pinned).map(chat => chat.id)));
    },
    send,
    recordVision: description => {
      if (description === snapshot.lastVisionDescription) return;
      publish({ lastVisionDescription: description });
      appendMessage({ role: 'system', content: aiVisionMessage(description), timestamp: timestamp() });
    },
    synthesize: text => deps.synthesize(text),
    describeImage: blob => deps.describeImage(blob),
    saveVoiceConfig: async config => {
      publish({ voiceConfig: config, voiceConfigNotice: 'idle' });
      try {
        await deps.post('/api/voice/config', JSON.stringify(config), payload => {
          if (typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === true) return true;
          throw new Error('AI_VOICE_SAVE_INVALID');
        });
        publish({ voiceConfigNotice: 'saved' });
      } catch {
        publish({ voiceConfigNotice: 'failed' });
      }
    },
    loadMlxModel: async modelId => {
      publish({ mlxLoading: true });
      try {
        await deps.post('/api/models/load', JSON.stringify({ model: modelId }), payload => {
          if (typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === true) return true;
          throw new Error('AI_MLX_LOAD_FAILED');
        });
        publish({ mlxActiveModel: modelId, mlxLoading: false });
        await fetchStats();
        await loadModels().catch(() => undefined);
      } catch (error: unknown) {
        publish({ mlxLoading: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    ejectMlxModel: async () => {
      try {
        await deps.post('/api/mlx/unload', '', payload => {
          if (typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === true) return true;
          throw new Error('AI_MLX_UNLOAD_FAILED');
        });
        publish({ mlxActiveModel: null });
        await fetchStats();
        await loadModels().catch(() => undefined);
      } catch (error: unknown) {
        publish({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
  return source;
};
