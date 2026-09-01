import { describe, expect, test } from 'bun:test';

import { opsPageMetadata, resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';
import {
  decodeAiMessage,
  decodeAiModelsPayload,
  type AiMessage,
} from '../../../frontend/apps/ops/src/ops-ai-decode';
import {
  aiModelOptionLabel,
  aiRamBarState,
  buildAiChatRequest,
  buildAiEntitySystemMessage,
  generateAiChatTitle,
  readAiStreamChunk,
  resolveAiChatId,
  shouldOfferAiMlxLoad,
  sortAiChatGroups,
} from '../../../frontend/apps/ops/src/ops-ai-model';
import { createOpsAiSource, type OpsAiDependencies } from '../../../frontend/apps/ops/src/ops-ai-source';

const modelsPayload = {
  models: [{ id: 'qwen3-coder:latest', name: 'Qwen Coder', vision: false, available: true, backend: 'ollama' },
    { id: 'qwen3-vl:4b', name: 'Qwen VL', vision: true, available: true, backend: 'mlx_vision' }],
  council_models: ['chair', 'reviewer'],
  default_model: 'qwen3-coder:latest',
};

const statsPayload = {
  memory: { totalGB: '64', usedGB: '10.5', usedPercent: 16 },
  gpu: { utilization: 4, active: false },
  mlx: { activeModel: null, activeModelName: null, activeModelParams: null, loading: false, loadProgress: '' },
};

const sessionFixture = {
  id: 'chat-9', title: 'Saved chat', council_mode: true,
  messages: [{ role: 'user', content: 'hello there' }],
};

const makeDeps = (): {
  deps: OpsAiDependencies;
  posts: Array<{ path: string; body: string }>;
  storage: Map<string, string>;
  failModels: boolean;
  setUrl: (url: URL) => void;
  getUrl: () => URL;
  intervalRunning: () => boolean;
} => {
  let url = new URL('https://xln.test/ai');
  const storage = new Map<string, string>();
  const posts: Array<{ path: string; body: string }> = [];
  const state = { failModels: false };
  let intervalId: number | null = null;
  const deps: OpsAiDependencies = {
    get: async (path, decode) => {
      if (path === '/api/models') {
        if (state.failModels) throw new Error('AI_HTTP_503');
        return decode(modelsPayload);
      }
      if (path === '/api/chats') return decode({ chats: [{ id: 'c1', title: 'First chat', updated: '2026-08-01T10:00:00Z' },
        { id: 'c2', title: 'Second chat', updated: '2026-08-02T10:00:00Z' }] });
      if (path === '/api/chats/chat-9') return decode(sessionFixture);
      if (path === '/api/xln/tools') return decode({ tools: [{ type: 'function', function: { name: 'xln_state', description: 'xln state', parameters: {} } }] });
      if (path === '/api/voice/config') return decode({ hotkey: 'LEFT CTRL', model: 'large-v3', pasteDelay: 100 });
      if (path === '/api/voice/status') return decode({ running: true });
      if (path === '/api/system/stats') return decode(statsPayload);
      throw new Error(`AI_TEST_UNEXPECTED_GET_${path}`);
    },
    post: async (path, body, decode) => {
      posts.push({ path, body });
      if (path === '/api/council') return decode({ chairman: 'chair', stage1: { chair: 'draft' },
        stage2: { chair: { rankings: {}, reasoning: 'looks right' } }, stage3: 'final answer' });
      if (path === '/api/chat') return decode({ content: '', tool_calls: [{ id: 't1', function: { name: 'xln_state', arguments: '{}' } }] });
      if (path === '/api/voice/config') return decode({ success: true });
      if (path === '/api/models/load' || path === '/api/mlx/unload') return decode({ success: true });
      throw new Error(`AI_TEST_UNEXPECTED_POST_${path}`);
    },
    postVoid: async (path, body) => { posts.push({ path, body }); },
    del: async path => { posts.push({ path, body: '' }); },
    streamChat: async (body, onChunk) => {
      posts.push({ path: '/api/chat:stream', body });
      onChunk('data: {"content":"Hel"}\n\n');
      onChunk('data: {"content":"lo"}\n\ndata: [DONE]\n\n');
    },
    synthesize: async () => null,
    describeImage: async () => null,
    executeTool: async () => JSON.stringify({ result: 'tool-evidence' }),
    currentUrl: () => new URL(url.toString()),
    replaceUrl: next => { url = new URL(next.toString()); },
    readStorage: key => storage.get(key) ?? null,
    writeStorage: (key, value) => { storage.set(key, value); },
    removeStorage: key => { storage.delete(key); },
    now: () => 1_700_000_000_000,
    scheduleInterval: () => { intervalId = 1; return 1; },
    cancelInterval: () => { intervalId = null; },
  };
  return {
    deps, posts, storage,
    get failModels() { return state.failModels; },
    set failModels(value: boolean) { state.failModels = value; },
    setUrl: next => { url = new URL(next.toString()); },
    getUrl: () => new URL(url.toString()),
    intervalRunning: () => intervalId !== null,
  } as ReturnType<typeof makeDeps>;
};

describe('React ops ai model', () => {
  test('parses the canonical data-line stream and skips noise', () => {
    expect(readAiStreamChunk('data: {"content":"Hi"}\ndata: [DONE]\nkeep-alive\n{"no":"tag"}\n')).toBe('Hi');
    expect(readAiStreamChunk('data: not-json\n')).toBe('');
  });

  test('derives chat titles, routing, ordering, and MLX labels deterministically', () => {
    expect(generateAiChatTitle([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'one two three four five six seven eight' }])).toBe('one two three four five six seven');
    expect(generateAiChatTitle([{ role: 'assistant', content: 'x' }])).toBe('New Chat');
    expect(resolveAiChatId('/ai')).toBe(null);
    expect(resolveAiChatId('/ai/chat-123')).toBe('chat-123');
    const groups = sortAiChatGroups([
      { id: 'a', title: 'a', updated: '2026-01-01T00:00:00Z', pinned: true },
      { id: 'b', title: 'b', updated: '2026-02-01T00:00:00Z', pinned: true },
      { id: 'c', title: 'c', updated: '2026-03-01T00:00:00Z' },
    ]);
    expect(groups.pinned.map(chat => chat.id)).toEqual(['b', 'a']);
    expect(groups.recent.map(chat => chat.id)).toEqual(['c']);
    expect(aiModelOptionLabel({ id: 'm', name: 'M', vision: false, available: true, backend: 'mlx' }, 'other')).toBe('[ ] M');
    expect(aiModelOptionLabel({ id: 'm', name: 'M', vision: false, available: true, backend: 'mlx' }, 'm')).toBe('[*] M');
    expect(shouldOfferAiMlxLoad('m', [{ id: 'm', name: 'M', vision: false, available: true, backend: 'mlx' }], null)).toBe(true);
    expect(shouldOfferAiMlxLoad('m', [{ id: 'm', name: 'M', vision: false, available: true, backend: 'ollama' }], null)).toBe(false);
    expect(aiRamBarState(71)).toBe('warning');
    expect(aiRamBarState(86)).toBe('danger');
    expect(aiRamBarState(10)).toBe('ok');
  });

  test('builds the canonical chat request with tools only in agent mode', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    expect(JSON.parse(buildAiChatRequest({ model: 'm', messages, stream: true }))).toEqual({ model: 'm', messages, stream: true });
    const agent = JSON.parse(buildAiChatRequest({ model: 'm', messages, stream: false, tools: [{ type: 'function', function: { name: 't' } }] }));
    expect(agent.tool_choice).toBe('auto');
    expect(agent.tools).toEqual([{ type: 'function', function: { name: 't' } }]);
  });

  test('builds the entity context system prompt from the stored handoff', () => {
    const prompt = buildAiEntitySystemMessage({ entityId: '0xabc123456789def', signerId: 'signer-1', jurisdiction: 'reg-test', reserves: { T1: '5' }, accountCount: 2, timestamp: 1 });
    expect(prompt).toContain('xln Entity 0xabc123456789def');
    expect(prompt).toContain('Token T1: 5');
    expect(prompt).toContain('Jurisdiction: reg-test');
  });

  test('decodes models strictly and rejects malformed payloads loudly', () => {
    const payload = decodeAiModelsPayload(modelsPayload);
    expect(payload.models).toHaveLength(2);
    expect(payload.defaultModel).toBe('qwen3-coder:latest');
    expect(payload.councilModels).toEqual(['chair', 'reviewer']);
    expect(() => decodeAiModelsPayload({ models: 'nope' })).toThrow('AI_MODELS_LIST_INVALID');
    expect(() => decodeAiMessage({ role: 'root', content: 'x' })).toThrow('AI_MESSAGE_ROLE_INVALID');
    const message: AiMessage = decodeAiMessage({ role: 'user', content: 'x', images: ['a'], timestamp: 't', model: 'm' });
    expect(message.images).toEqual(['a']);
  });
});

describe('React ops ai source', () => {
  test('starts with service state, tools, voice, stats polling, and URL chat selection', async () => {
    const harness = makeDeps();
    harness.setUrl(new URL('https://xln.test/ai/chat-9'));
    const source = createOpsAiSource(harness.deps);
    await source.start();
    const snapshot = source.getSnapshot();
    expect(snapshot.status).toBe('ready');
    expect(snapshot.selectedModel).toBe('qwen3-coder:latest');
    expect(snapshot.availableTools).toHaveLength(1);
    expect(snapshot.voicePasteRunning).toBe(true);
    expect(snapshot.systemStats?.memory.usedPercent).toBe(16);
    expect(snapshot.chatId).toBe('chat-9');
    expect(snapshot.chatTitle).toBe('Saved chat');
    expect(snapshot.councilMode).toBe(true);
    expect(harness.intervalRunning()).toBe(true);
    expect(harness.getUrl().pathname).toBe('/ai/chat-9');
    source.stop();
    expect(source.getSnapshot().status).toBe('idle');
    expect(harness.intervalRunning()).toBe(false);
  });

  test('surfaces an unavailable AI service instead of failing silently', async () => {
    const harness = makeDeps();
    harness.failModels = true;
    const source = createOpsAiSource(harness.deps);
    await source.start();
    expect(source.getSnapshot().status).toBe('error');
    expect(source.getSnapshot().error).toBe('AI_HTTP_503');
    source.stop();
  });

  test('consumes the entity context handoff and cleans URL plus storage', async () => {
    const harness = makeDeps();
    harness.setUrl(new URL('https://xln.test/ai?context=entity'));
    harness.storage.set('xln-entity-context', JSON.stringify({ entityId: '0xabc123456789def', signerId: 's', jurisdiction: 'reg-test', reserves: {}, accountCount: 1, timestamp: 1 }));
    const source = createOpsAiSource(harness.deps);
    await source.start();
    const snapshot = source.getSnapshot();
    expect(snapshot.messages[0]?.role).toBe('system');
    expect(snapshot.messages[0]?.content).toContain('0xabc123456789def');
    expect(snapshot.chatTitle).toBe('Entity 0xabc123...');
    expect(harness.getUrl().pathname).toBe('/ai');
    expect(harness.getUrl().search).toBe('');
    expect(harness.storage.has('xln-entity-context')).toBe(false);
    source.stop();
  });

  test('streams a single-model exchange and journals the saved session', async () => {
    const harness = makeDeps();
    const source = createOpsAiSource(harness.deps);
    await source.start();
    const reply = await source.send('hello world', []);
    expect(reply).toBe('Hello');
    const snapshot = source.getSnapshot();
    expect(snapshot.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(snapshot.messages[1]?.content).toBe('Hello');
    expect(snapshot.streamingContent).toBe('');
    expect(snapshot.isLoading).toBe(false);
    const saved = harness.posts.find(post => post.path === '/api/chats' && post.body.includes('"council_mode"'));
    expect(saved?.body).toContain('hello world');
    expect(source.getSnapshot().chatTitle).toBe('hello world');
    source.stop();
  });

  test('runs council deliberation through the chairman-labeled message', async () => {
    const harness = makeDeps();
    const source = createOpsAiSource(harness.deps);
    await source.start();
    source.setCouncilMode(true);
    const reply = await source.send('council question', []);
    expect(reply).toBe('final answer');
    const last = source.getSnapshot().messages.at(-1);
    expect(last?.model).toBe('Council (Chairman: chair)');
    expect(last?.council?.stage1).toEqual({ chair: 'draft' });
    source.stop();
  });

  test('executes agent tool calls as visible evidence messages', async () => {
    const harness = makeDeps();
    const source = createOpsAiSource(harness.deps);
    await source.start();
    source.setAgentMode(true);
    const reply = await source.send('agent question', []);
    expect(reply).toBe('');
    const systemMessages = source.getSnapshot().messages.filter(message => message.role === 'system').map(message => message.content);
    expect(systemMessages[0]).toBe('[Agent] Calling 1 tool(s): xln_state');
    expect(systemMessages[1]).toBe('[Tool: xln_state] {"result":"tool-evidence"}');
    const chatPost = harness.posts.find(post => post.path === '/api/chat' && !post.path.includes('stream'));
    expect(chatPost?.body).toContain('"tool_choice":"auto"');
    source.stop();
  });

  test('pins chats into durable storage and reports vision only on change', async () => {
    const harness = makeDeps();
    const source = createOpsAiSource(harness.deps);
    await source.start();
    source.togglePinChat('c1');
    expect(harness.storage.get('pinnedChats')).toBe('["c1"]');
    expect(source.getSnapshot().savedChats.find(chat => chat.id === 'c1')?.pinned).toBe(true);
    source.recordVision('a desk');
    source.recordVision('a desk');
    expect(source.getSnapshot().messages.filter(message => message.content === '[Vision] a desk')).toHaveLength(1);
    source.stop();
  });

  test('owns /ai routes, metadata, and lazy runtime wiring', async () => {
    expect(resolveOpsPage('/ai')).toEqual({ kind: 'ai', pathname: '/ai' });
    expect(resolveOpsPage('/ai/chat-9')).toEqual({ kind: 'ai', pathname: '/ai/chat-9' });
    expect(resolveOpsPage('/embed')).toEqual({ kind: 'pending', pathname: '/embed' });
    expect(opsPageMetadata(resolveOpsPage('/ai')).title).toBe('xln AI Console');
    const [app, main, runtime] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-app.tsx').text(),
      Bun.file('frontend/apps/ops/src/main.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-ai-runtime.ts').text(),
    ]);
    expect(app).toContain("import('./ops-ai')");
    expect(main).toContain("import('./ops-ai-runtime')");
    expect(runtime).toContain("addEventListener('pagehide'");
    expect(runtime).toContain('opsAiSource.stop()');
  });
});
