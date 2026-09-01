import { useEffect, useState } from 'react';

import type { AiSavedChat, AiVoiceConfig } from './ops-ai-decode';
import { AI_STT_MODELS, AI_TTS_MODELS, AI_VOICE_HOTKEYS, AI_VOICE_MODELS } from './ops-ai-decode';
import { sortAiChatGroups, truncateAiChatTitle } from './ops-ai-model';
import type { OpsAiSnapshot } from './ops-ai-source';

export function OpsAiSidebar({ snapshot, voiceLabel, voiceActive, cameraActive, onNewChat, onLoadChat, onDeleteChat, onTogglePin, onSaveVoiceConfig }: Readonly<{
  snapshot: OpsAiSnapshot;
  voiceLabel: string;
  voiceActive: boolean;
  cameraActive: boolean;
  onNewChat: () => void;
  onLoadChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onTogglePin: (id: string) => void;
  onSaveVoiceConfig: (config: AiVoiceConfig) => void;
}>) {
  const [stt, setStt] = useState<string>(AI_STT_MODELS[0].id);
  const [tts, setTts] = useState<string>(AI_TTS_MODELS[0].id);
  const [draft, setDraft] = useState(snapshot.voiceConfig);
  // The server config loads after mount; the draft must follow it like the
  // canonical bound selects did, while the Save button still posts explicitly.
  useEffect(() => { setDraft(snapshot.voiceConfig); }, [snapshot.voiceConfig]);
  const groups = sortAiChatGroups(snapshot.savedChats);
  const notice = snapshot.voiceConfigNotice === 'saved'
    ? 'Voice config saved — restart voice-paste if running.'
    : snapshot.voiceConfigNotice === 'failed' ? 'Failed to save voice config.' : '';

  return <aside className="ops-ai-sidebar">
    <button className="ops-ai-new-chat" onClick={onNewChat} type="button">+ New Chat</button>
    <div className="ops-ai-chat-list" data-testid="ai-chat-list">
      {groups.pinned.length > 0 ? (
        <>
          <div className="ops-ai-section-header">Pinned</div>
          {groups.pinned.map(chat => (
            <OpsAiChatRow chat={chat} active={chat.id === snapshot.chatId} key={chat.id}
              onDelete={onDeleteChat} onLoad={onLoadChat} onTogglePin={onTogglePin} pinLabel="Unpin" pinSymbol="-" />
          ))}
        </>
      ) : null}
      {groups.recent.length > 0 ? (
        <>
          <div className="ops-ai-section-header">Recent</div>
          {groups.recent.map(chat => (
            <OpsAiChatRow chat={chat} active={chat.id === snapshot.chatId} key={chat.id}
              onDelete={onDeleteChat} onLoad={onLoadChat} onTogglePin={onTogglePin} pinLabel="Pin" pinSymbol="+" />
          ))}
        </>
      ) : null}
      {snapshot.savedChats.length === 0 ? <p className="ops-ai-chats-empty">No saved chats.</p> : null}
    </div>

    <div className="ops-ai-sidebar-footer">
      <label>STT<select onChange={event => setStt(event.currentTarget.value)} value={stt}>
        {AI_STT_MODELS.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      <label>TTS<select onChange={event => setTts(event.currentTarget.value)} value={tts}>
        {AI_TTS_MODELS.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>

      <div className="ops-ai-voice-paste">
        <div className="ops-ai-voice-paste-header">
          <span>Voice-Paste (Global)</span>
          <span className="ops-ai-status" data-active={snapshot.voicePasteRunning}>
            {snapshot.voicePasteRunning ? '🎤 Running' : '⭕ Stopped'}
          </span>
        </div>
        <label>Hotkey<select onChange={event => setDraft({ ...draft, hotkey: event.currentTarget.value })} value={draft.hotkey}>
          {AI_VOICE_HOTKEYS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label>Model<select onChange={event => setDraft({ ...draft, model: event.currentTarget.value })} value={draft.model}>
          {AI_VOICE_MODELS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <button onClick={() => onSaveVoiceConfig(draft)} type="button">Save Config</button>
        {notice ? <p className="ops-ai-voice-notice" data-notice={snapshot.voiceConfigNotice} role="status">{notice}</p> : null}
        <div className="ops-ai-voice-instructions">
          <p>Start: <code>bun run ai/voice-paste.ts</code></p>
          <p>Recordings: <code>~/records/</code></p>
        </div>
      </div>

      <span className="ops-ai-status" data-active={voiceActive} data-testid="ai-voice-status">{voiceLabel}</span>
      <span className="ops-ai-status" data-active={cameraActive}>{cameraActive ? 'Camera on' : 'Camera off'}</span>
    </div>
  </aside>;
}

function OpsAiChatRow({ chat, active, pinLabel, pinSymbol, onLoad, onTogglePin, onDelete }: Readonly<{
  chat: AiSavedChat;
  active: boolean;
  pinLabel: string;
  pinSymbol: string;
  onLoad: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
}>) {
  return <div className={`ops-ai-chat-item${active ? ' is-active' : ''}`}>
    <button className="ops-ai-chat-title" onClick={() => onLoad(chat.id)} type="button">
      {truncateAiChatTitle(chat.title)}
    </button>
    <div className="ops-ai-chat-actions">
      <button aria-label={pinLabel} onClick={() => onTogglePin(chat.id)} title={pinLabel} type="button">{pinSymbol}</button>
      <button aria-label="Delete" className="ops-ai-delete" onClick={() => onDelete(chat.id)} title="Delete" type="button">x</button>
    </div>
  </div>;
}
