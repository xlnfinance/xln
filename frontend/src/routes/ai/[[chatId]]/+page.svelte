<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  const API_URL = 'http://localhost:3031';
  const WAKE_WORD = 'hello';
  const CAMERA_INTERVAL_MS = 5000; // Capture every 5 seconds
  const VISION_MODEL = 'qwen3-vl:4b';

  // ============================================================================
  // STATE
  // ============================================================================

  interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    model?: string | undefined;
    timestamp?: string | undefined;
    images?: string[] | undefined;
    council?: {
      stage1: Record<string, string>;
      stage2: Record<string, { rankings: Record<string, number>; reasoning: string }>;
      stage3: string;
    } | undefined;
  }

  interface Model {
    id: string;
    name: string;
    vision: boolean;
    available: boolean;
    backend?: string;
    loaded?: boolean;
  }

  interface SystemStats {
    memory: {
      total: number;
      used: number;
      free: number;
      cached: number;
      totalGB: string;
      usedGB: string;
      freeGB: string;
      cachedGB: string;
      usedPercent: number;
    };
    gpu: {
      model: string;
      cores: number;
      utilization: number;
      rendererUtil: number;
      tilerUtil: number;
      memoryAllocatedGB: string;
      memoryInUseGB: string;
      active: boolean;
    };
    mlx: {
      activeModel: string | null;
      activeModelName: string | null;
      activeModelParams: string | null;
      loading: boolean;
      loadProgress: string;
      lastError: string | null;
    };
  }

  let messages: Message[] = [];
  let inputText = '';
  let selectedModel = 'qwen3-coder:latest'; // gemma3:27b downloading
  let councilMode = false;
  let models: Model[] = [];
  let councilModels: string[] = [];
  let isLoading = false;
  let streamingContent = '';

  // Voice state
  let isListening = false;
  let speechRecognition: any = null; // Web Speech API for instant wake word
  let mediaRecorder: MediaRecorder | null = null;
  let audioContext: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let isRecordingCommand = false; // Recording after wake word
  let audioChunks: Blob[] = [];
  let lastTranscript = '';

  // Camera state
  let cameraActive = false;
  let cameraInterval: ReturnType<typeof setInterval> | null = null;
  let videoElement: HTMLVideoElement | null = null;
  let cameraStream: MediaStream | null = null;
  let lastVisionDescription = '';

  // Chat persistence
  let chatId = `chat-${Date.now()}`;
  let chatTitle = 'New Chat';
  let savedChats: { id: string; title: string; updated: string; pinned?: boolean }[] = [];

  // Entity context from xln frontend
  interface EntityContext {
    entityId: string;
    signerId: string;
    jurisdiction: string;
    reserves: Record<string, string>;
    accountCount: number;
    timestamp: number;
  }
  let entityContext: EntityContext | null = null;

  // Tool call state for agent mode
  interface ToolCall {
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }
  let availableTools: any[] = [];
  let agentModeEnabled = false;

  // TTS/STT model selection
  let selectedSTT = 'whisper-large-v3';
  let selectedTTS = 'piper';
  const sttModels = [
    { id: 'whisper-large-v3', name: 'Whisper Large v3 (MLX)' },
    { id: 'faster-whisper', name: 'Faster Whisper' },
    { id: 'web-speech', name: 'Browser Speech API' },
  ];
  const ttsModels = [
    { id: 'piper', name: 'Piper (fast)' },
    { id: 'coqui', name: 'Coqui TTS' },
    { id: 'browser', name: 'Browser TTS' },
  ];

  // Drag-drop state
  let isDragging = false;
  let pendingImages: string[] = [];

  // Audio visualizer state
  let analyser: AnalyserNode | null = null;
  let audioLevels: number[] = new Array(16).fill(0);
  let visualizerFrame: number | null = null;
  let isSpeaking = false; // TTS is playing

  // System stats / MLX state
  let systemStats: SystemStats | null = null;
  let mlxLoading = false;
  let mlxLoadProgress = '';
  let mlxActiveModel: string | null = null;
  let statsInterval: ReturnType<typeof setInterval> | null = null;

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  onMount(async () => {
    await loadModels();
    await loadSavedChats();
    await fetchSystemStats();
    await loadXlnTools();
    startContinuousListening();
    // Poll system stats every 2 seconds
    statsInterval = setInterval(fetchSystemStats, 2000);

    // Check for entity context from xln frontend
    checkEntityContext();

    // Check for chat ID in URL path (e.g., /ai/chat-123456)
    const pathMatch = window.location.pathname.match(/^\/ai\/(.+)$/);
    if (pathMatch && pathMatch[1]) {
      const urlChatId = pathMatch[1];
      // Try to load this chat
      await loadChatById(urlChatId, false);
    }
  });

  async function loadXlnTools() {
    try {
      const res = await fetch(`${API_URL}/api/xln/tools`);
      const data = await res.json();
      availableTools = data.tools || [];
      console.log(`Loaded ${availableTools.length} xln tools for agent mode`);
    } catch (e) {
      console.warn('Failed to load xln tools:', e);
    }
  }

  async function executeToolCall(toolCall: ToolCall): Promise<string> {
    try {
      const args = JSON.parse(toolCall.function.arguments);
      const res = await fetch(`${API_URL}/api/xln/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: toolCall.function.name, args }),
      });
      const data = await res.json();
      if (data.error) {
        return JSON.stringify({ error: data.error });
      }
      return JSON.stringify(data.result);
    } catch (e) {
      return JSON.stringify({ error: `Tool execution failed: ${e}` });
    }
  }

  function checkEntityContext() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('context') === 'entity') {
      const stored = localStorage.getItem('xln-entity-context');
      if (stored) {
        try {
          entityContext = JSON.parse(stored);
          // Create a new chat with entity context
          chatId = `entity-${entityContext!.entityId}-${Date.now()}`;
          chatTitle = `Entity ${entityContext!.entityId.slice(0, 8)}...`;

          // Build context message for AI
          const reservesList = Object.entries(entityContext!.reserves)
            .map(([tokenId, amount]) => `  Token ${tokenId}: ${amount}`)
            .join('\n');

          const systemMessage = `You are assisting with xln Entity ${entityContext!.entityId}.

Entity Context:
- Entity ID: ${entityContext!.entityId}
- Signer ID: ${entityContext!.signerId}
- Jurisdiction: ${entityContext!.jurisdiction}
- Number of accounts: ${entityContext!.accountCount}
- Reserves:
${reservesList || '  (none)'}

Help the user understand this entity's state, suggest actions, or answer questions about xln operations.`;

          // Add system message to start the chat
          messages = [{
            role: 'system',
            content: systemMessage,
            timestamp: new Date().toISOString()
          }];

          // Clear the URL param and localStorage
          window.history.replaceState({}, '', '/ai');
          localStorage.removeItem('xln-entity-context');
        } catch (e) {
          console.error('Failed to parse entity context:', e);
        }
      }
    }
  }

  onDestroy(() => {
    stopListening();
    stopCamera();
    if (statsInterval) clearInterval(statsInterval);
  });

  // ============================================================================
  // API CALLS
  // ============================================================================

  async function loadModels() {
    try {
      const res = await fetch(`${API_URL}/api/models`);
      const data = await res.json();
      models = data.models || [];
      councilModels = data.council_models || [];
      if (data.default_model) selectedModel = data.default_model;
      // Update MLX state from models response
      if (data.mlx_state) {
        mlxLoading = data.mlx_state.loading;
        mlxLoadProgress = data.mlx_state.loadProgress || '';
        mlxActiveModel = data.mlx_state.activeModel;
      }
    } catch (e) {
      console.error('Failed to load models:', e);
    }
  }

  async function fetchSystemStats() {
    try {
      const res = await fetch(`${API_URL}/api/system/stats`);
      const data = await res.json();
      systemStats = data;
      mlxLoading = data.mlx?.loading || false;
      mlxLoadProgress = data.mlx?.loadProgress || '';
      mlxActiveModel = data.mlx?.activeModel || null;
    } catch (e) {
      // Silently fail - stats are optional
    }
  }

  async function ejectMLXModel() {
    try {
      const res = await fetch(`${API_URL}/api/mlx/unload`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        mlxActiveModel = null;
        await fetchSystemStats();
        await loadModels();
      }
    } catch (e) {
      console.error('Failed to eject model:', e);
    }
  }

  async function loadMLXModel(modelId: string) {
    try {
      mlxLoading = true;
      const res = await fetch(`${API_URL}/api/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      const data = await res.json();
      mlxLoading = false;
      if (data.success) {
        mlxActiveModel = modelId;
        await fetchSystemStats();
        await loadModels();
      }
    } catch (e) {
      mlxLoading = false;
      console.error('Failed to load model:', e);
    }
  }

  async function loadSavedChats() {
    try {
      const res = await fetch(`${API_URL}/api/chats`);
      const data = await res.json();
      savedChats = data.chats || [];
      // Restore pinned state from localStorage
      const pins = JSON.parse(localStorage.getItem('pinnedChats') || '[]');
      savedChats = savedChats.map(c => ({ ...c, pinned: pins.includes(c.id) }));
    } catch (e) {
      console.error('Failed to load chats:', e);
    }
  }

  function generateChatTitle(msgs: Message[]): string {
    const firstUserMsg = msgs.find(m => m.role === 'user');
    if (!firstUserMsg) return 'New Chat';
    // Take first 30 chars, trim at word boundary if possible
    let title = firstUserMsg.content.slice(0, 35);
    const lastSpace = title.lastIndexOf(' ');
    if (lastSpace > 20) title = title.slice(0, lastSpace);
    return title.trim() || 'New Chat';
  }

  async function saveChat() {
    // Auto-generate title from first message if still "New Chat"
    if (chatTitle === 'New Chat' && messages.length > 0) {
      chatTitle = generateChatTitle(messages);
    }

    const session = {
      id: chatId,
      title: chatTitle,
      messages,
      council_mode: councilMode,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      await fetch(`${API_URL}/api/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      await loadSavedChats();
    } catch (e) {
      console.error('Failed to save chat:', e);
    }
  }

  async function deleteChat(id: string) {
    try {
      await fetch(`${API_URL}/api/chats/${id}`, { method: 'DELETE' });
      savedChats = savedChats.filter(c => c.id !== id);
      if (chatId === id) newChat();
    } catch (e) {
      console.error('Failed to delete chat:', e);
    }
  }

  function togglePinChat(id: string) {
    const idx = savedChats.findIndex(c => c.id === id);
    if (idx >= 0 && savedChats[idx]) {
      savedChats[idx]!.pinned = !savedChats[idx]!.pinned;
      savedChats = [...savedChats]; // trigger reactivity
      // Save pin state to localStorage
      const pins = savedChats.filter(c => c.pinned).map(c => c.id);
      localStorage.setItem('pinnedChats', JSON.stringify(pins));
    }
  }

  async function sendMessage() {
    if (!inputText.trim() && !pendingImages.length) return;

    const userMessage: Message = {
      role: 'user',
      content: inputText,
      timestamp: new Date().toISOString(),
      images: pendingImages.length ? [...pendingImages] : undefined,
    };

    messages = [...messages, userMessage];
    const query = inputText;
    inputText = '';
    pendingImages = [];
    isLoading = true;

    try {
      if (councilMode) {
        // Council mode: 3-stage deliberation
        const res = await fetch(`${API_URL}/api/council`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, models: councilModels }),
        });

        const council = await res.json();

        const assistantMessage: Message = {
          role: 'assistant',
          content: council.stage3,
          model: `Council (Chairman: ${council.chairman})`,
          timestamp: new Date().toISOString(),
          council: {
            stage1: council.stage1,
            stage2: council.stage2,
            stage3: council.stage3,
          },
        };

        messages = [...messages, assistantMessage];
      } else {
        // Single model chat (with optional agent mode)
        const allMessages = messages.map(m => ({
          role: m.role,
          content: m.content,
        }));

        const requestBody: Record<string, any> = {
          model: selectedModel,
          messages: allMessages,
          stream: !agentModeEnabled, // Disable streaming for agent mode (tool calls need full response)
          images: userMessage.images,
        };

        // Add tools if agent mode is enabled
        if (agentModeEnabled && availableTools.length > 0) {
          requestBody['tools'] = availableTools;
          requestBody['tool_choice'] = 'auto';
        }

        const res = await fetch(`${API_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (agentModeEnabled) {
          // Agent mode: non-streaming response, may contain tool calls
          const data = await res.json();

          // Check if response contains tool calls
          if (data.tool_calls && data.tool_calls.length > 0) {
            // Show tool calling status
            messages = [...messages, {
              role: 'system',
              content: `[Agent] Calling ${data.tool_calls.length} tool(s): ${data.tool_calls.map((tc: ToolCall) => tc.function.name).join(', ')}`,
              timestamp: new Date().toISOString(),
            }];

            // Execute tool calls
            for (const toolCall of data.tool_calls) {
              const result = await executeToolCall(toolCall);

              // Add tool result to messages
              messages = [...messages, {
                role: 'system',
                content: `[Tool: ${toolCall.function.name}] ${result}`,
                timestamp: new Date().toISOString(),
              }];
            }

            // Get final response with tool results - this would need another API call
            // For now, show the partial content if available
            if (data.content) {
              messages = [...messages, {
                role: 'assistant',
                content: data.content,
                model: selectedModel,
                timestamp: new Date().toISOString(),
              }];
            }
          } else {
            // Normal response without tool calls
            const assistantMessage: Message = {
              role: 'assistant',
              content: data.content || '',
              model: selectedModel,
              timestamp: new Date().toISOString(),
            };
            messages = [...messages, assistantMessage];
          }
        } else {
          // Streaming mode
          if (!res.body) throw new Error('No response body');

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          streamingContent = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

            for (const line of lines) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                if (parsed.content) {
                  streamingContent += parsed.content;
                }
              } catch {}
            }
          }

          const assistantMessage: Message = {
            role: 'assistant',
            content: streamingContent,
            model: selectedModel,
            timestamp: new Date().toISOString(),
          };

          messages = [...messages, assistantMessage];
          streamingContent = '';
        }
      }

      // Auto-save after each exchange
      await saveChat();

      // Auto-speak response if voice is active
      if (isListening && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          await speakText(lastMsg.content.slice(0, 500));
        }
      }
    } catch (e) {
      console.error('Chat error:', e);
      messages = [...messages, {
        role: 'system',
        content: `Error: ${e instanceof Error ? e.message : 'Unknown error'}`,
        timestamp: new Date().toISOString(),
      }];
    } finally {
      isLoading = false;
    }
  }

  // ============================================================================
  // VOICE: Web Speech API for instant wake word detection
  // ============================================================================

  // Audio visualizer - updates audioLevels array for UI
  function startAudioVisualizer(stream: MediaStream) {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 32; // 16 frequency bins
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function updateLevels() {
      if (!analyser || !isListening) {
        audioLevels = new Array(16).fill(0);
        return;
      }
      analyser.getByteFrequencyData(dataArray);
      audioLevels = Array.from(dataArray).map(v => v / 255);
      visualizerFrame = requestAnimationFrame(updateLevels);
    }
    updateLevels();
  }

  function stopAudioVisualizer() {
    if (visualizerFrame) {
      cancelAnimationFrame(visualizerFrame);
      visualizerFrame = null;
    }
    audioLevels = new Array(16).fill(0);
  }

  async function startContinuousListening() {
    // Use Web Speech API for instant wake word detection (browser-native, no latency)
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.error('Web Speech API not supported');
      // Fallback: Try to request microphone permission to trigger browser dialog
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('Microphone available but Web Speech API not supported');
      } catch (e) {
        console.error('Microphone also unavailable:', e);
      }
      return;
    }

    // Get microphone for visualizer
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startAudioVisualizer(micStream);
    } catch (e) {
      console.warn('Could not get mic for visualizer:', e);
    }

    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'en-US';

    speechRecognition.onresult = async (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }

      const lowerTranscript = transcript.toLowerCase();
      lastTranscript = transcript;

      // Instant wake word detection
      if (lowerTranscript.includes(WAKE_WORD)) {
        const idx = lowerTranscript.indexOf(WAKE_WORD);
        const command = transcript.slice(idx + WAKE_WORD.length).trim();

        // If command follows wake word immediately, send it
        if (command.length > 2 && event.results[event.results.length - 1].isFinal) {
          inputText = command;
          await sendMessage();
        }
      }
    };

    speechRecognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'audio-capture') {
        isListening = false;
        stopAudioVisualizer();
        // Show user-friendly message
        console.warn('🎤 Microphone access required. Check:\n' +
          '  1. macOS System Settings → Privacy & Security → Microphone → Enable for browser\n' +
          '  2. Restart browser after granting permission\n' +
          '  3. Make sure a microphone is connected');
      }
    };

    speechRecognition.onend = () => {
      // Auto-restart if still listening
      if (isListening && speechRecognition) {
        speechRecognition.start();
      }
    };

    try {
      speechRecognition.start();
      isListening = true;
      console.log('Voice activated - say "hello" followed by your command');
    } catch (e) {
      console.error('Failed to start speech recognition:', e);
    }
  }

  function stopListening() {
    isListening = false;
    stopAudioVisualizer();

    if (speechRecognition) {
      speechRecognition.stop();
      speechRecognition = null;
    }

    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }

    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
  }

  async function speakText(text: string) {
    try {
      const res = await fetch(`${API_URL}/api/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) return;

      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      // Show speaking state in visualizer
      isSpeaking = true;
      audio.onended = () => {
        isSpeaking = false;
        URL.revokeObjectURL(audioUrl);
      };
      audio.onerror = () => {
        isSpeaking = false;
        URL.revokeObjectURL(audioUrl);
      };

      audio.play();
    } catch (e) {
      console.error('TTS error:', e);
      isSpeaking = false;
    }
  }

  // ============================================================================
  // CAMERA: Continuous vision analysis
  // ============================================================================

  async function startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 640, height: 480 },
      });

      // Set active first so video element renders
      cameraActive = true;

      // Wait for next tick so video element is available
      await new Promise(resolve => setTimeout(resolve, 50));

      if (videoElement) {
        videoElement.srcObject = cameraStream;
        await videoElement.play();
      }

      // Start periodic capture
      cameraInterval = setInterval(captureAndAnalyze, CAMERA_INTERVAL_MS);

    } catch (e) {
      console.error('Camera access denied:', e);
      cameraActive = false;
    }
  }

  function stopCamera() {
    cameraActive = false;

    if (cameraInterval) {
      clearInterval(cameraInterval);
      cameraInterval = null;
    }

    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }

    if (videoElement) {
      videoElement.srcObject = null;
    }
  }

  async function captureAndAnalyze() {
    if (!videoElement || !cameraActive) return;

    // Capture frame to canvas
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth || 640;
    canvas.height = videoElement.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(videoElement, 0, 0);

    // Convert to blob
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.8);
    });

    if (!blob) return;

    // Send to vision API
    const formData = new FormData();
    formData.append('image', blob, 'capture.jpg');
    formData.append('model', VISION_MODEL);
    formData.append('prompt', 'Briefly describe what you see. Focus on people, objects, and activities. Be concise.');

    try {
      const res = await fetch(`${API_URL}/api/vision`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (data.content && data.content !== lastVisionDescription) {
        lastVisionDescription = data.content;

        // Add as system message (visual context)
        messages = [...messages, {
          role: 'system',
          content: `[Vision] ${data.content}`,
          timestamp: new Date().toISOString(),
        }];
      }
    } catch (e) {
      console.error('Vision error:', e);
    }
  }

  // ============================================================================
  // DRAG & DROP
  // ============================================================================

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    isDragging = true;
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;

    const files = e.dataTransfer?.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1] ?? '';
          if (base64) {
            pendingImages = [...pendingImages, base64];
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1] ?? '';
          if (base64) {
            pendingImages = [...pendingImages, base64];
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }

  function removeImage(index: number) {
    pendingImages = pendingImages.filter((_, i) => i !== index);
  }

  // ============================================================================
  // UI HELPERS
  // ============================================================================

  function newChat() {
    chatId = `chat-${Date.now()}`;
    chatTitle = 'New Chat';
    messages = [];
    // Update URL without reload
    window.history.replaceState({}, '', `/ai`);
  }

  async function loadChatById(id: string, updateUrl = true) {
    try {
      const res = await fetch(`${API_URL}/api/chats/${id}`);
      const data = await res.json();
      chatId = data.id;
      chatTitle = data.title;
      messages = data.messages;
      councilMode = data.council_mode;
      // Update URL to reflect current chat
      if (updateUrl) {
        window.history.replaceState({}, '', `/ai/${id}`);
      }
    } catch (e) {
      console.error('Failed to load chat:', e);
    }
  }

  function formatTime(timestamp?: string) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleTimeString() + '.' + d.getMilliseconds().toString().padStart(3, '0');
  }
</script>

<svelte:window on:paste={handlePaste} />

<div
  class="ai-container"
  class:dragging={isDragging}
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
  role="application"
>
  <!-- Sidebar -->
  <aside class="sidebar">
    <button class="new-chat-btn" on:click={newChat}>+ New Chat</button>

    <div class="chat-list">
      {#if savedChats.some(c => c.pinned)}
        <div class="section-header">Pinned</div>
        {#each savedChats.filter(c => c.pinned).sort((a, b) => b.updated.localeCompare(a.updated)) as chat}
          <div class="chat-item" class:active={chat.id === chatId} class:pinned={true}>
            <button class="chat-title" on:click={() => loadChatById(chat.id)}>
              {chat.title.slice(0, 25)}{chat.title.length > 25 ? '...' : ''}
            </button>
            <div class="chat-actions">
              <button class="chat-action-btn" title="Unpin" on:click|stopPropagation={() => togglePinChat(chat.id)}>-</button>
              <button class="chat-action-btn delete" title="Delete" on:click|stopPropagation={() => deleteChat(chat.id)}>x</button>
            </div>
          </div>
        {/each}
      {/if}

      {#if savedChats.some(c => !c.pinned)}
        <div class="section-header">Recent</div>
        {#each savedChats.filter(c => !c.pinned).sort((a, b) => b.updated.localeCompare(a.updated)) as chat}
          <div class="chat-item" class:active={chat.id === chatId}>
            <button class="chat-title" on:click={() => loadChatById(chat.id)}>
              {chat.title.slice(0, 25)}{chat.title.length > 25 ? '...' : ''}
            </button>
            <div class="chat-actions">
              <button class="chat-action-btn" title="Pin" on:click|stopPropagation={() => togglePinChat(chat.id)}>+</button>
              <button class="chat-action-btn delete" title="Delete" on:click|stopPropagation={() => deleteChat(chat.id)}>x</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="sidebar-footer">
      <div class="model-select-group">
        <label>STT</label>
        <select bind:value={selectedSTT}>
          {#each sttModels as m}
            <option value={m.id}>{m.name}</option>
          {/each}
        </select>
      </div>
      <div class="model-select-group">
        <label>TTS</label>
        <select bind:value={selectedTTS}>
          {#each ttsModels as m}
            <option value={m.id}>{m.name}</option>
          {/each}
        </select>
      </div>
      <div class="status-indicator" class:active={isListening}>
        {isListening ? 'Listening...' : 'Voice off'}
      </div>
      <div class="status-indicator" class:active={cameraActive}>
        {cameraActive ? 'Camera on' : 'Camera off'}
      </div>
    </div>
  </aside>

  <!-- Main chat area -->
  <main class="chat-main">
    <!-- System Health Bar -->
    {#if systemStats}
      <div class="system-health-bar">
        <div class="health-item ram">
          <span class="health-label">RAM</span>
          <div class="health-bar-container">
            <div
              class="health-bar-fill"
              class:warning={systemStats.memory.usedPercent > 70}
              class:danger={systemStats.memory.usedPercent > 85}
              style="width: {systemStats.memory.usedPercent}%"
            ></div>
          </div>
          <span class="health-value">{systemStats.memory.usedGB}/{systemStats.memory.totalGB}GB</span>
        </div>

        <!-- GPU Utilization -->
        {#if systemStats.gpu}
          <div class="health-item gpu" class:gpu-active={systemStats.gpu.active}>
            <span class="health-label">GPU</span>
            <div class="health-bar-container">
              <div
                class="health-bar-fill gpu-fill"
                class:inferencing={systemStats.gpu.active}
                style="width: {systemStats.gpu.utilization}%"
              ></div>
            </div>
            <span class="health-value">{systemStats.gpu.utilization}%</span>
            {#if systemStats.gpu.active}
              <span class="inference-indicator" title="Model is actively inferencing">
                <span class="pulse-dot"></span>
              </span>
            {/if}
          </div>
        {/if}

        {#if mlxActiveModel}
          <div class="health-item mlx-active">
            <span class="mlx-badge loaded">MLX</span>
            <span class="mlx-model-name">{systemStats.mlx?.activeModelName || mlxActiveModel}</span>
            {#if systemStats.mlx?.activeModelParams}
              <span class="mlx-params">{systemStats.mlx.activeModelParams}</span>
            {/if}
            <button class="eject-btn" on:click={ejectMLXModel} title="Eject model from memory">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 9L15 15M15 9L9 15M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </button>
          </div>
        {:else}
          <div class="health-item mlx-inactive">
            <span class="mlx-badge idle">MLX</span>
            <span class="mlx-status">No model loaded</span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- MLX Loading Toast (unobtrusive) -->
    {#if mlxLoading}
      <div class="mlx-loading-toast">
        <div class="toast-spinner"></div>
        <div class="toast-content">
          <span class="toast-text">Loading model...</span>
          {#if mlxLoadProgress}
            <span class="toast-progress">{mlxLoadProgress}</span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Header -->
    <header class="chat-header">
      <div class="model-selector">
        <select bind:value={selectedModel} disabled={councilMode || mlxLoading}>
          {#each models as model}
            <option value={model.id}>
              {#if model.backend?.includes('mlx')}
                {model.id === mlxActiveModel ? '[*] ' : '[ ] '}
              {/if}
              {model.name || model.id}
            </option>
          {/each}
        </select>
        {#if selectedModel && models.find(m => m.id === selectedModel)?.backend?.includes('mlx') && selectedModel !== mlxActiveModel}
          <button class="load-model-btn" on:click={() => loadMLXModel(selectedModel)} disabled={mlxLoading}>
            Load
          </button>
        {/if}
      </div>

      <label class="council-toggle">
        <input type="checkbox" bind:checked={councilMode} />
        Council Mode
      </label>

      <label class="agent-toggle" class:active={agentModeEnabled}>
        <input type="checkbox" bind:checked={agentModeEnabled} disabled={availableTools.length === 0} />
        Agent Mode
        {#if availableTools.length > 0}
          <span class="tool-count">({availableTools.length} tools)</span>
        {/if}
      </label>

      <div class="header-actions">
        <!-- Audio Visualizer -->
        {#if isListening || isSpeaking}
          <div class="audio-visualizer" class:speaking={isSpeaking}>
            {#each audioLevels as level, i}
              <div class="bar" style="height: {Math.max(4, level * 24)}px; opacity: {0.4 + level * 0.6}"></div>
            {/each}
          </div>
        {/if}

        <button
          class="icon-btn"
          class:active={isListening}
          on:click={() => isListening ? stopListening() : startContinuousListening()}
          title="Voice ({WAKE_WORD})"
        >
          {isListening ? '...' : 'MIC'}
        </button>

        <button
          class="icon-btn"
          class:active={cameraActive}
          on:click={() => cameraActive ? stopCamera() : startCamera()}
          title="Camera vision"
        >
          {cameraActive ? 'CAM ON' : 'CAM'}
        </button>
      </div>

    </header>

    <!-- Messages -->
    <div class="messages">
      {#each messages as msg}
        <div class="message {msg.role}">
          <div class="message-header">
            <span class="role">{msg.role === 'user' ? 'You' : msg.model || 'Assistant'}</span>
            <span class="time">{formatTime(msg.timestamp)}</span>
          </div>

          {#if msg.images?.length}
            <div class="message-images">
              {#each msg.images as img}
                <img src="data:image/jpeg;base64,{img}" alt="attached" class="attached-image" />
              {/each}
            </div>
          {/if}

          <div class="message-content">
            {msg.content}
          </div>

          {#if msg.council}
            <details class="council-details">
              <summary>View Council Deliberation</summary>
              <div class="council-stages">
                <div class="stage">
                  <h4>Stage 1: Individual Responses</h4>
                  {#each Object.entries(msg.council.stage1) as [model, response]}
                    <details>
                      <summary>{model}</summary>
                      <pre>{response}</pre>
                    </details>
                  {/each}
                </div>
                <div class="stage">
                  <h4>Stage 2: Peer Reviews</h4>
                  {#each Object.entries(msg.council.stage2) as [model, review]}
                    <details>
                      <summary>{model}</summary>
                      <pre>{review.reasoning}</pre>
                    </details>
                  {/each}
                </div>
              </div>
            </details>
          {/if}
        </div>
      {/each}

      {#if isLoading || streamingContent}
        <div class="message assistant">
          <div class="message-header">
            <span class="role">{councilMode ? 'Council thinking...' : selectedModel}</span>
          </div>
          <div class="message-content">
            {streamingContent || 'Thinking...'}
          </div>
        </div>
      {/if}
    </div>

    <!-- Camera preview -->
    {#if cameraActive}
      <div class="camera-preview">
        <video bind:this={videoElement} autoplay muted playsinline></video>
        {#if lastVisionDescription}
          <div class="vision-description">{lastVisionDescription}</div>
        {/if}
      </div>
    {/if}

    <!-- Input area -->
    <div class="input-area">
      <!-- Live transcript above input -->
      {#if isListening && lastTranscript}
        <div class="live-transcript">{lastTranscript}</div>
      {/if}

      {#if pendingImages.length > 0}
        <div class="pending-images">
          {#each pendingImages as img, i}
            <div class="pending-image">
              <img src="data:image/jpeg;base64,{img}" alt="pending" />
              <button class="remove-btn" on:click={() => removeImage(i)}>x</button>
            </div>
          {/each}
        </div>
      {/if}

      <div class="input-row">
        <textarea
          bind:value={inputText}
          placeholder={councilMode ? 'Ask the Council...' : `Message ${selectedModel}... (say "${WAKE_WORD}" to activate voice)`}
          on:keydown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
          rows="1"
        ></textarea>
        <button class="send-btn" on:click={sendMessage} disabled={isLoading}>
          {isLoading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  </main>

  <!-- Drop overlay -->
  {#if isDragging}
    <div class="drop-overlay">
      Drop images here
    </div>
  {/if}
</div>

<style>
  .ai-container {
    display: flex;
    height: 100vh;
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    position: relative;
  }

  .ai-container.dragging {
    outline: 2px dashed #00ff88;
  }

  /* Sidebar */
  .sidebar {
    width: 260px;
    background: #111;
    border-right: 1px solid #222;
    display: flex;
    flex-direction: column;
    padding: 12px;
  }

  .new-chat-btn {
    width: 100%;
    padding: 12px;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 8px;
    color: #fff;
    cursor: pointer;
    margin-bottom: 12px;
  }

  .new-chat-btn:hover {
    background: #222;
  }

  .chat-list {
    flex: 1;
    overflow-y: auto;
  }

  .chat-item {
    width: 100%;
    padding: 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #aaa;
    text-align: left;
    cursor: pointer;
    margin-bottom: 4px;
    font-size: 13px;
  }

  .chat-item:hover, .chat-item.active {
    background: #1a1a1a;
    color: #fff;
  }

  .sidebar-footer {
    padding-top: 12px;
    border-top: 1px solid #222;
  }

  .model-select-group {
    margin-bottom: 8px;
  }

  .model-select-group label {
    display: block;
    font-size: 10px;
    color: #666;
    margin-bottom: 2px;
  }

  .model-select-group select {
    width: 100%;
    padding: 4px 6px;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    color: #ccc;
    font-size: 11px;
  }

  .status-indicator {
    font-size: 11px;
    color: #666;
    padding: 4px 0;
  }

  .status-indicator.active {
    color: #00ff88;
  }

  /* Main area */
  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .chat-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    background: #111;
    border-bottom: 1px solid #222;
  }

  .model-selector select {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 6px;
    color: #fff;
    padding: 8px 12px;
    font-size: 14px;
  }

  .council-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #888;
    font-size: 13px;
    cursor: pointer;
  }

  .council-toggle input:checked + * {
    color: #00ff88;
  }

  .agent-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #888;
    font-size: 13px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: all 0.2s;
  }

  .agent-toggle.active {
    background: rgba(0, 136, 255, 0.1);
    border: 1px solid rgba(0, 136, 255, 0.3);
  }

  .agent-toggle input:checked + * {
    color: #0088ff;
  }

  .tool-count {
    font-size: 11px;
    color: #666;
  }

  .header-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  .icon-btn {
    padding: 8px 12px;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 6px;
    color: #888;
    cursor: pointer;
    font-size: 11px;
    font-weight: bold;
  }

  .icon-btn:hover {
    background: #222;
  }

  .icon-btn.active {
    background: #003322;
    border-color: #00ff88;
    color: #00ff88;
  }

  /* Audio Visualizer */
  .audio-visualizer {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 24px;
    padding: 0 8px;
  }

  .audio-visualizer .bar {
    width: 3px;
    background: #00ff88;
    border-radius: 1px;
    transition: height 0.05s ease-out;
  }

  .audio-visualizer.speaking .bar {
    background: #ff8800;
  }

  .live-transcript {
    font-size: 12px;
    color: #00ff88;
    padding: 8px 0;
    margin-bottom: 8px;
    border-bottom: 1px solid #222;
    font-style: italic;
  }

  /* Messages */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .message {
    margin-bottom: 20px;
    max-width: 800px;
  }

  .message.user {
    margin-left: auto;
  }

  .message-header {
    display: flex;
    gap: 12px;
    margin-bottom: 6px;
    font-size: 12px;
  }

  .message-header .role {
    font-weight: 600;
    color: #888;
  }

  .message.user .role {
    color: #00aaff;
  }

  .message.assistant .role {
    color: #00ff88;
  }

  .message.system .role {
    color: #ff8800;
  }

  .message-header .time {
    color: #555;
  }

  .message-content {
    background: #1a1a1a;
    padding: 14px 18px;
    border-radius: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .message.user .message-content {
    background: #003344;
  }

  .message.system .message-content {
    background: #331100;
    font-size: 13px;
  }

  .message-images {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .attached-image {
    max-width: 200px;
    max-height: 150px;
    border-radius: 8px;
    border: 1px solid #333;
  }

  /* Council details */
  .council-details {
    margin-top: 12px;
    font-size: 13px;
  }

  .council-details summary {
    cursor: pointer;
    color: #00ff88;
  }

  .council-stages {
    margin-top: 12px;
    padding: 12px;
    background: #111;
    border-radius: 8px;
  }

  .stage {
    margin-bottom: 16px;
  }

  .stage h4 {
    color: #888;
    margin-bottom: 8px;
    font-size: 12px;
  }

  .stage details {
    margin-bottom: 8px;
  }

  .stage pre {
    background: #0a0a0a;
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 12px;
    white-space: pre-wrap;
  }

  /* Camera preview */
  .camera-preview {
    position: absolute;
    bottom: 100px;
    right: 20px;
    width: 200px;
    background: #111;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid #333;
  }

  .camera-preview video {
    width: 100%;
    display: block;
  }

  .vision-description {
    padding: 8px;
    font-size: 11px;
    color: #888;
    max-height: 60px;
    overflow-y: auto;
  }

  /* Input area */
  .input-area {
    padding: 16px 20px;
    background: #111;
    border-top: 1px solid #222;
  }

  .pending-images {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .pending-image {
    position: relative;
    width: 60px;
    height: 60px;
  }

  .pending-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid #333;
  }

  .pending-image .remove-btn {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ff4444;
    border: none;
    color: #fff;
    font-size: 11px;
    cursor: pointer;
  }

  .input-row {
    display: flex;
    gap: 12px;
  }

  .input-row textarea {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 14px 18px;
    color: #fff;
    font-size: 15px;
    resize: none;
    min-height: 24px;
    max-height: 150px;
    line-height: 1.5;
  }

  .input-row textarea:focus {
    outline: none;
    border-color: #00ff88;
  }

  .send-btn {
    padding: 14px 24px;
    background: #00ff88;
    border: none;
    border-radius: 12px;
    color: #000;
    font-weight: 600;
    cursor: pointer;
  }

  .send-btn:hover {
    background: #00dd77;
  }

  .send-btn:disabled {
    background: #333;
    color: #666;
    cursor: not-allowed;
  }

  /* Drop overlay */
  .drop-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 255, 136, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    color: #00ff88;
    pointer-events: none;
  }

  /* System Health Bar */
  .system-health-bar {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 8px 16px;
    background: linear-gradient(180deg, #0d0d0d 0%, #111 100%);
    border-bottom: 1px solid #222;
    font-size: 12px;
  }

  .health-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .health-label {
    color: #666;
    font-weight: 500;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
  }

  .health-bar-container {
    width: 80px;
    height: 6px;
    background: #222;
    border-radius: 3px;
    overflow: hidden;
  }

  .health-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #00ff88 0%, #00cc6a 100%);
    border-radius: 3px;
    transition: width 0.3s ease, background 0.3s ease;
  }

  .health-bar-fill.warning {
    background: linear-gradient(90deg, #ffaa00 0%, #ff8800 100%);
  }

  .health-bar-fill.danger {
    background: linear-gradient(90deg, #ff4444 0%, #cc0000 100%);
  }

  /* GPU specific styles */
  .health-item.gpu {
    position: relative;
  }

  .health-item.gpu-active .health-label {
    color: #00ccff;
  }

  .health-bar-fill.gpu-fill {
    background: linear-gradient(90deg, #0088ff 0%, #00ccff 100%);
  }

  .health-bar-fill.gpu-fill.inferencing {
    background: linear-gradient(90deg, #00ff88 0%, #00ffcc 100%);
    animation: gpu-pulse 1s ease-in-out infinite;
  }

  @keyframes gpu-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }

  .inference-indicator {
    display: flex;
    align-items: center;
    margin-left: 4px;
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    background: #00ff88;
    border-radius: 50%;
    animation: pulse-glow 1s ease-in-out infinite;
    box-shadow: 0 0 8px #00ff88;
  }

  @keyframes pulse-glow {
    0%, 100% {
      transform: scale(1);
      box-shadow: 0 0 8px #00ff88;
    }
    50% {
      transform: scale(1.2);
      box-shadow: 0 0 16px #00ff88, 0 0 24px #00ff88;
    }
  }

  .health-value {
    color: #888;
    font-family: monospace;
    font-size: 11px;
  }

  .mlx-badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .mlx-badge.loaded {
    background: rgba(0, 255, 136, 0.2);
    color: #00ff88;
    border: 1px solid rgba(0, 255, 136, 0.3);
  }

  .mlx-badge.idle {
    background: rgba(102, 102, 102, 0.2);
    color: #666;
    border: 1px solid rgba(102, 102, 102, 0.3);
  }

  .mlx-model-name {
    color: #00ff88;
    font-weight: 500;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mlx-params {
    color: #666;
    font-size: 10px;
  }

  .mlx-status {
    color: #555;
    font-style: italic;
  }

  .eject-btn {
    background: rgba(255, 68, 68, 0.1);
    border: 1px solid rgba(255, 68, 68, 0.3);
    border-radius: 4px;
    padding: 4px 6px;
    cursor: pointer;
    color: #ff4444;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .eject-btn:hover {
    background: rgba(255, 68, 68, 0.2);
    border-color: #ff4444;
  }

  .load-model-btn {
    padding: 6px 12px;
    background: rgba(0, 255, 136, 0.1);
    border: 1px solid rgba(0, 255, 136, 0.3);
    border-radius: 6px;
    color: #00ff88;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .load-model-btn:hover:not(:disabled) {
    background: rgba(0, 255, 136, 0.2);
    border-color: #00ff88;
  }

  .load-model-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Loading Overlay */
  .loading-overlay {
    position: absolute;
    inset: 0;
    background: rgba(10, 10, 10, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    backdrop-filter: blur(8px);
  }

  .loading-content {
    text-align: center;
    padding: 40px;
  }

  .loading-spinner {
    position: relative;
    width: 80px;
    height: 80px;
    margin: 0 auto 24px;
  }

  .spinner-ring {
    position: absolute;
    inset: 0;
    border: 3px solid transparent;
    border-radius: 50%;
    animation: spin 1.5s linear infinite;
  }

  .spinner-ring:nth-child(1) {
    border-top-color: #00ff88;
    animation-delay: 0s;
  }

  .spinner-ring:nth-child(2) {
    inset: 8px;
    border-right-color: #00aaff;
    animation-delay: -0.3s;
    animation-direction: reverse;
  }

  .spinner-ring:nth-child(3) {
    inset: 16px;
    border-bottom-color: #ff8800;
    animation-delay: -0.6s;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading-text {
    font-size: 18px;
    font-weight: 500;
    color: #fff;
    margin-bottom: 8px;
  }

  .loading-progress {
    font-size: 14px;
    color: #00ff88;
    font-family: monospace;
    margin-bottom: 16px;
  }

  .loading-hint {
    font-size: 12px;
    color: #666;
  }

  /* MLX Loading Toast - unobtrusive notification */
  .mlx-loading-toast {
    position: fixed;
    top: 16px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: rgba(0, 0, 0, 0.9);
    border: 1px solid #333;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    z-index: 1000;
    animation: slideIn 0.3s ease;
  }

  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  .toast-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid #333;
    border-top-color: #00ff88;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .toast-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .toast-text {
    font-size: 13px;
    color: #fff;
  }

  .toast-progress {
    font-size: 11px;
    color: #00ff88;
    font-family: monospace;
  }

  /* Chat item with actions */
  .chat-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #aaa;
    cursor: pointer;
    margin-bottom: 2px;
    font-size: 13px;
    transition: background 0.15s;
  }

  .chat-item:hover, .chat-item.active {
    background: #1a1a1a;
    color: #fff;
  }

  .chat-item.pinned {
    border-left: 2px solid #00ff88;
    background: rgba(0, 255, 136, 0.05);
  }

  .section-header {
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 8px 12px 4px;
    margin-top: 8px;
  }

  .section-header:first-child {
    margin-top: 0;
  }

  .chat-title {
    flex: 1;
    background: none;
    border: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0;
    font-size: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pin-icon {
    color: #00ff88;
    margin-right: 4px;
    font-size: 11px;
  }

  .chat-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .chat-item:hover .chat-actions {
    opacity: 1;
  }

  .chat-action-btn {
    width: 22px;
    height: 22px;
    padding: 0;
    background: #222;
    border: 1px solid #333;
    border-radius: 4px;
    color: #888;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .chat-action-btn:hover {
    background: #333;
    color: #fff;
  }

  .chat-action-btn.delete:hover {
    background: #ff4444;
    border-color: #ff4444;
    color: #fff;
  }
</style>
