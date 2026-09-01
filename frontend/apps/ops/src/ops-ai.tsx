// React /ai console page. Owns the browser effect boundary — Web Speech wake
// word, microphone visualizer, camera vision loop, TTS playback, clipboard
// paste, and image drag/drop — exactly as the canonical Svelte page did. All
// server exchange and session state live in ops-ai-source; all decisions that
// can be pure live in ops-ai-model / ops-ai-decode.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { AI_CAMERA_INTERVAL_MS, AI_WAKE_WORD } from './ops-ai-decode';
import { OpsAiHeader } from './ops-ai-header';
import { OpsAiMessages } from './ops-ai-messages';
import { opsAiSource } from './ops-ai-runtime';
import { OpsAiSidebar } from './ops-ai-sidebar';
import { OpsShell } from './ops-shell';
import { aiSpeakSlice } from './ops-ai-model';
import './styles/ops-ai.css';

interface SpeechRecognitionAlternative { transcript: string; confidence?: number }
interface SpeechRecognitionResult { readonly isFinal: boolean; readonly length: number; [index: number]: SpeechRecognitionAlternative }
interface SpeechRecognitionResultList { readonly length: number; [index: number]: SpeechRecognitionResult }
interface SpeechRecognitionResultEvent extends Event { readonly resultIndex: number; readonly results: SpeechRecognitionResultList }
interface SpeechRecognitionErrorEvent extends Event { readonly error: string }
interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;
interface SpeechWindow extends Window { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }

const speechConstructor = (): SpeechRecognitionConstructor | null => {
  const scope = window as SpeechWindow;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
};

const readImageFile = (file: File, onImage: (base64: string) => void): void => {
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = (reader.result as string).split(',')[1] ?? '';
    if (base64) onImage(base64);
  };
  reader.readAsDataURL(file);
};

export function OpsAiPage() {
  const snapshot = useSyncExternalStore(opsAiSource.subscribe, opsAiSource.getSnapshot, opsAiSource.getSnapshot);
  const [inputText, setInputText] = useState('');
  const [pendingImages, setPendingImages] = useState<readonly string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [lastTranscript, setLastTranscript] = useState('');
  const [voiceNotice, setVoiceNotice] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraTimerRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  const cameraActiveRef = useRef(false);

  const speakText = useCallback(async (text: string): Promise<void> => {
    if (!text) return;
    const blob = await opsAiSource.synthesize(text);
    if (!blob) return;
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    const settle = (): void => { setIsSpeaking(false); URL.revokeObjectURL(audioUrl); };
    audio.onended = settle;
    audio.onerror = settle;
    setIsSpeaking(true);
    audio.play().catch(settle);
  }, []);

  const send = useCallback(async (content: string, images: readonly string[]): Promise<void> => {
    const reply = await opsAiSource.send(content, images);
    if (listeningRef.current && reply) await speakText(aiSpeakSlice(reply));
  }, [speakText]);

  const stopListening = useCallback((): void => {
    listeningRef.current = false;
    setIsListening(false);
    setLastTranscript('');
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    micStreamRef.current?.getTracks().forEach(track => track.stop());
    micStreamRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setAnalyser(null);
  }, []);

  const startListening = useCallback(async (): Promise<void> => {
    const Recognition = speechConstructor();
    if (!Recognition) {
      setVoiceNotice('Web Speech API unavailable in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const context = new AudioContext();
      audioContextRef.current = context;
      const node = context.createAnalyser();
      node.fftSize = 32;
      node.smoothingTimeConstant = 0.7;
      context.createMediaStreamSource(stream).connect(node);
      setAnalyser(node);
    } catch {
      // The visualizer is optional; recognition can still run.
    }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = event => {
      let transcript = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        transcript += event.results[index]?.[0]?.transcript ?? '';
      }
      setLastTranscript(transcript);
      const lower = transcript.toLowerCase();
      if (!lower.includes(AI_WAKE_WORD)) return;
      const command = transcript.slice(lower.indexOf(AI_WAKE_WORD) + AI_WAKE_WORD.length).trim();
      const finalResult = event.results[event.results.length - 1];
      if (command.length > 2 && finalResult?.isFinal) void send(command, []);
    };
    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'audio-capture') {
        setVoiceNotice('Microphone access required — enable it for the browser in system privacy settings, then retry.');
        stopListening();
      }
    };
    recognition.onend = () => {
      if (!listeningRef.current || !recognitionRef.current) return;
      // The browser can end and re-enter recognition between our checks, so
      // restart defensively instead of letting the throw escape the handler.
      try { recognitionRef.current.start(); } catch { /* already started */ }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      listeningRef.current = true;
      setIsListening(true);
      setVoiceNotice('');
    } catch {
      recognitionRef.current = null;
    }
  }, [send, stopListening]);

  const captureAndAnalyze = useCallback(async (): Promise<void> => {
    const video = videoRef.current;
    if (!video || !cameraActiveRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (!blob) return;
    const description = await opsAiSource.describeImage(blob);
    if (description) opsAiSource.recordVision(description);
  }, []);

  const stopCamera = useCallback((): void => {
    cameraActiveRef.current = false;
    setCameraActive(false);
    if (cameraTimerRef.current !== null) {
      window.clearInterval(cameraTimerRef.current);
      cameraTimerRef.current = null;
    }
    cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 640, height: 480 },
      });
      cameraStreamRef.current = stream;
      cameraActiveRef.current = true;
      setCameraActive(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      cameraTimerRef.current = window.setInterval(() => { void captureAndAnalyze(); }, AI_CAMERA_INTERVAL_MS);
    } catch {
      stopCamera();
    }
  }, [captureAndAnalyze, stopCamera]);

  // Canonical behavior: listening starts on mount and survives until the
  // microphone is denied or the operator stops it.
  useEffect(() => {
    void startListening();
    return () => {
      stopListening();
      stopCamera();
    };
  }, [startListening, stopCamera, stopListening]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) readImageFile(file, base64 => setPendingImages(current => [...current, base64]));
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const submit = (): void => {
    const content = inputText;
    const images = pendingImages;
    setInputText('');
    setPendingImages([]);
    void send(content, images);
  };

  return <OpsShell activePath="/ai">
    <div
      className={`ops-ai${isDragging ? ' is-dragging' : ''}`}
      onDragOver={event => { event.preventDefault(); setIsDragging(true); }}
      onDragLeave={event => { event.preventDefault(); setIsDragging(false); }}
      onDrop={event => {
        event.preventDefault();
        setIsDragging(false);
        for (const file of Array.from(event.dataTransfer?.files ?? [])) {
          if (file.type.startsWith('image/')) readImageFile(file, base64 => setPendingImages(current => [...current, base64]));
        }
      }}
      role="application"
    >
      <h1 className="ops-ai-heading">AI Console</h1>
      {snapshot.error ? (
        <section className="ops-ai-error" data-testid="ai-service-error" role="alert">
          <span>LOCAL AI SERVICE</span>
          <strong>{snapshot.error}</strong>
          <button onClick={() => void opsAiSource.refresh()} type="button">Retry</button>
        </section>
      ) : null}
      {voiceNotice ? <p className="ops-ai-voice-notice" role="status">{voiceNotice}</p> : null}
      <div className="ops-ai-layout">
        <OpsAiSidebar
          cameraActive={cameraActive} onDeleteChat={id => { void opsAiSource.deleteChat(id); }}
          onLoadChat={id => { void opsAiSource.loadChat(id); }} onNewChat={() => opsAiSource.newChat()}
          onSaveVoiceConfig={config => { void opsAiSource.saveVoiceConfig(config); }}
          onTogglePin={id => opsAiSource.togglePinChat(id)} snapshot={snapshot}
          voiceActive={isListening} voiceLabel={isListening ? 'Listening...' : 'Voice off'}
        />
        <main className="ops-ai-main">
          <OpsAiHeader
            analyser={analyser} cameraActive={cameraActive} isListening={isListening} isSpeaking={isSpeaking}
            onEjectMlxModel={() => { void opsAiSource.ejectMlxModel(); }}
            onLoadMlxModel={modelId => { void opsAiSource.loadMlxModel(modelId); }}
            onSelectModel={modelId => opsAiSource.selectModel(modelId)}
            onSetAgentMode={next => opsAiSource.setAgentMode(next)}
            onSetCouncilMode={next => opsAiSource.setCouncilMode(next)}
            onToggleCamera={() => { if (cameraActive) stopCamera(); else void startCamera(); }}
            onToggleListening={() => { if (isListening) stopListening(); else void startListening(); }}
            snapshot={snapshot}
          />
          <OpsAiMessages
            isLoading={snapshot.isLoading} messages={snapshot.messages}
            streamingContent={snapshot.streamingContent}
            streamingLabel={snapshot.councilMode ? 'Council thinking...' : snapshot.selectedModel}
          />
          {cameraActive ? (
            <div className="ops-ai-camera-preview" data-testid="ai-camera-preview">
              <video autoPlay muted playsInline ref={videoRef} />
              {snapshot.lastVisionDescription ? <p className="ops-ai-vision-description">{snapshot.lastVisionDescription}</p> : null}
            </div>
          ) : null}
          <div className="ops-ai-input-area">
            {isListening && lastTranscript ? <div className="ops-ai-live-transcript">{lastTranscript}</div> : null}
            {pendingImages.length > 0 ? (
              <div className="ops-ai-pending-images">
                {pendingImages.map((image, index) => (
                  <div className="ops-ai-pending-image" key={`${index}-${image.slice(0, 12)}`}>
                    <img alt="pending" src={`data:image/jpeg;base64,${image}`} />
                    <button aria-label="Remove image" onClick={() => setPendingImages(current => current.filter((_, i) => i !== index))} type="button">x</button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="ops-ai-input-row">
              <textarea
                onChange={event => setInputText(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={snapshot.councilMode
                  ? 'Ask the Council...'
                  : `Message ${snapshot.selectedModel}... (say "${AI_WAKE_WORD}" to activate voice)`}
                rows={1}
                value={inputText}
              />
              <button className="ops-ai-send" disabled={snapshot.isLoading} onClick={submit} type="button">
                {snapshot.isLoading ? '...' : 'Send'}
              </button>
            </div>
          </div>
        </main>
      </div>
      {isDragging ? <div className="ops-ai-drop-overlay">Drop images here</div> : null}
    </div>
  </OpsShell>;
}
