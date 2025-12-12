# iPhone Voice Paste - Без глючного Apple Dictate

## Метод 1: Shortcuts с прямой записью аудио

### Создание Shortcut:

1. Открой **Shortcuts** app
2. Tap **+** (новый shortcut)
3. Название: **"Voice Paste"**

### Добавь действия (по порядку):

```
1. Record Audio
   - Show: OFF (не показывать UI)
   - Start Recording: Immediately
   - Finish Recording: On Tap
   - Audio Quality: Normal
   - Store as: [Audio]

2. Set Variable
   - Variable Name: "RecordedAudio"
   - Value: [Audio]

3. Get Contents of URL
   - URL: http://ВАШ-MAC-TAILSCALE-IP:5001/transcribe
   - Method: POST
   - Headers:
     (оставь пустым, Form автоматом добавит Content-Type)
   - Request Body: Form
     - file: [RecordedAudio]
     - task: transcribe
   - Store as: [Response]

4. Get Dictionary from Input
   - Input: [Response]
   - Store as: [Dict]

5. Get Dictionary Value
   - Key: text
   - Dictionary: [Dict]
   - Store as: [Text]

6. Copy to Clipboard
   - Input: [Text]

7. Show Notification
   - Title: ✅ Voice Paste
   - Body: [Text]
   - Sound: Default
```

### Быстрый доступ:

**Вариант 1: Back Tap**
- Settings → Accessibility → Touch → Back Tap
- Double Tap → Voice Paste
- Triple Tap → (что-то еще)

**Вариант 2: Action Button (iPhone 15/16 Pro)**
- Settings → Action Button → Shortcut → Voice Paste

**Вариант 3: Виджет на Home Screen**
- Добавь Shortcuts widget
- Выбери Voice Paste

---

## Метод 2: Voice Memos → Auto-transcribe

### Автоматизация через Shortcuts Automation:

```
Trigger: When Voice Memo is recorded
Actions:
  1. Get Latest Voice Memo
  2. Convert to WAV (если нужно)
  3. Post to http://MAC-IP:5001/transcribe
  4. Get text from response
  5. Copy to clipboard
  6. Delete Voice Memo (optional)
```

Плюс: можно говорить долго, редактировать запись
Минус: не real-time

---

## Метод 3: Простое iOS приложение (если Shortcuts глючит)

### Создать SwiftUI app (5 минут):

```swift
import SwiftUI
import AVFoundation

struct ContentView: View {
    @State private var isRecording = false
    @State private var transcription = ""

    var body: some View {
        VStack {
            Button(action: {
                if isRecording {
                    stopRecording()
                } else {
                    startRecording()
                }
                isRecording.toggle()
            }) {
                Image(systemName: isRecording ? "stop.circle" : "mic.circle")
                    .font(.system(size: 80))
            }

            Text(transcription)
                .padding()
        }
    }

    func startRecording() {
        // AVAudioRecorder
    }

    func stopRecording() {
        // Upload to whisper server
        // Parse response
        // Copy to clipboard
    }
}
```

Могу создать полный Xcode проект если хочешь.

---

## Какой метод лучше?

**Для быстроты:** Shortcuts Method 1 (Back Tap)
**Для качества:** Voice Memos + Automation
**Для надежности:** SwiftUI app (кастомный)

**Проблема Universal Clipboard:**
- Работает через iCloud
- Иногда лагает (5-10 сек задержка)
- Не всегда синхронизирует

**Решение: Прямая вставка через Shortcuts**
Shortcuts может вставить текст прямо в активное приложение:

```
After copying to clipboard:
→ Use "Paste" action (симулирует Cmd+V)
```

---

## Тест Tailscale доступности:

Сначала проверь что iPhone видит твой Mac:

```bash
# На Mac Studio
tailscale ip -4
# Запомни IP: 100.64.x.x

# На iPhone (в Safari)
http://100.64.x.x:5001/
# Должно показать: {"status":"ok"...}
```

Если не работает → нужно настроить Tailscale на iPhone.

---

## Что делаем?

1. Пробуешь Shortcuts Method 1?
2. Или создаю полноценное iOS приложение?
3. Или комбо: Shortcuts + Voice Memos automation?

Скажи какой путь и накатим.
