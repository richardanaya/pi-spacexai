# pi-spacexai

Grok Imagine, speech generation and transcription, F12 mic voice input, and a harness that can speak its responses aloud — layered on top of **pi’s built-in xAI provider**.

This extension no longer registers its own chat provider or OAuth flow. Authenticate with pi (`/login xai`), then install this package for media tools and voice UX.

## Why pi-spacexai is cool

### 1. Uses your existing xAI login

Sign in with pi’s native **xAI (Grok/X subscription)** OAuth or an xAI API key. Credentials live in `~/.pi/agent/auth.json` under the `xai` key. If that entry is missing, this extension stays inactive (no tools, commands, or shortcuts).

At request time, tokens come from pi’s model registry (`getApiKeyForProvider("xai")`), so OAuth refresh stays pi’s job.

### 2. Full Grok Imagine support with detailed control

Generate and edit images, or create, edit, and extend videos without leaving the coding harness. Requests expose the documented Grok Imagine controls rather than hiding them behind simplified presets:

- Text-to-image and image editing with up to three source images
- 1–10 image variations, every supported aspect ratio, and 1K/2K resolution
- Image-to-video and reference-to-video workflows (separate tools, matching Grok Build names)
- Exact video duration control in seconds, aspect ratio, and 480p/720p/1080p resolution
- Video editing and 2–10 second extensions
- Automatic job polling, output downloading, and explicit destination paths

### 3. Generate and transcribe audio with TTS/STT

Create production-ready speech files with full control over voice, language, speed, codec, sample rate, MP3 bit rate, streaming-latency optimization, text normalization, and character-level timestamps. Transcribe local files or URLs with formatting, word timing, speaker diarization, multichannel audio, keyterm biasing, and filler-word controls.

### 4. Let the harness speak—and shape how it sounds

Use `/listen` to hear the latest assistant response or `/auto-listen-on` to make pi speak every completed response automatically. Choose a voice and persist a speaking style so the assistant writes naturally for spoken delivery, including supported xAI speech tags when appropriate.

### 5. Talk back with Ctrl+Space push-to-talk

**Hold Ctrl+Space** to stream microphone audio to xAI realtime STT (`wss://api.x.ai/v1/stt`). While held you get:

- A footer **`● REC`** status (plus a toast) as soon as the mic is live
- A bottom overlay with a pulsing REC badge, elapsed time, and live captions
- **Live editor streaming** — interim and final STT text is written into the editor as you speak (appended after any text that was already there)

**Release** to finalize the utterance (stale interim is replaced by the server-final text). Press **Enter** when you are ready to send. **Esc** cancels and restores the editor to its pre-recording contents. If TTS is playing, Ctrl+Space stops playback instead of opening the mic.

Push-to-talk needs a terminal with **Kitty keyboard protocol** key-release events (Kitty, Ghostty, WezTerm, recent iTerm2, etc.). Max hold length is 5 minutes.

### 6. Server-side Grok tools on xAI models

When the active model’s provider is `xai`, every Responses API request also exposes xAI’s server-side `web_search`, `x_search`, and `code_interpreter` tools. Grok decides when to invoke them alongside pi’s normal client-side function tools.

### 7. Realtime voice observer (`/realtime-voice`)

Start a **Grok speech-to-speech** co-pilot bridged to the coding session:

```text
/realtime-voice           # default port 3847 — opens your browser automatically
/realtime-voice 4100      # custom port
/realtime-voice-stop
```

What happens:

1. A local server starts on `http://127.0.0.1:<port>/` and **opens that page in your browser**.
2. The page requests an xAI **ephemeral token**, connects to `wss://api.x.ai/v1/realtime`, and starts the mic/speaker loop (server VAD).
3. The voice agent can call **`send_message_to_coding_harness`** → messages enter the pi session as `{"source":"observer","message":"..."}` and trigger a turn.
4. While the server is running, the coding agent gains two tools (removed again on stop):
   - **`send_message_to_observer`** — SSE inject into the live voice session so Grok can **speak** the update
   - **`set_harness_status`** — SSE push of a short status line shown in the browser HUD (visual only, not spoken)
5. The coding-agent system prompt is extended with observer instructions for the duration of the session.
6. **`GET /api/events`** is the SSE stream used by the browser (and available to other local tools).

Allow microphone access when the browser prompts. Default voice is **leo** (override with `/spacexai-voice <id>`).

Voice-agent tools in the browser session:

- `send_message_to_coding_harness` — drive the pi coding session
- `open_browser_tab` — open an `http(s)` URL in the system browser (and try an in-page tab)
- server-side `web_search`

Coding-agent tools (only while `/realtime-voice` is running):

- `send_message_to_observer` — spoken update / answer for the user via the voice agent
- `set_harness_status` — live “what the harness is doing” text on the observer UI (`POST /api/harness-status` also accepted)

## Load and authenticate

```bash
# 1. Authenticate with pi’s built-in xAI provider
pi
# then: /login xai  → subscription OAuth or API key

# 2. Install / load this extension
pi install /home/wizard/repos/pi-spacexai
pi -e ./index.ts                 # development
```

Credentials must already exist in `~/.pi/agent/auth.json` when the extension loads:

```json
{
  "xai": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1234567890
  }
}
```

API-key shape is also accepted:

```json
{
  "xai": { "type": "api_key", "key": "xai-..." }
}
```

If `xai` is absent, the extension registers nothing. After a first-time `/login xai`, restart pi (or reload extensions) so tools activate.

Select Grok models with `/model` under provider **`xai`** (built into pi).

## REST media tools

- `image_gen`: model, prompt, 1–10 images, every documented aspect ratio, 1k/2k resolution, URL/base64 response, and a required output path.
- `image_edit`: single or up to three source images, all documented edit options, and a required output path.
- `image_to_video`: single source image → video (optional prompt, duration, resolution); polls until completion and downloads to a required output path.
- `reference_to_video`: 2–7 reference images + prompt → video (duration, aspect ratio, resolution); polls until completion and downloads to a required output path.
- `video_edit`: prompt/video, documented (service-ignored) geometry fields, and a required output path. It polls until completion.
- `video_extend`: prompt/video, optional 2–10 second extension duration, and a required output path. It polls until completion.
- `text_to_speech`: text/language, voice, speed, codec, sample rate, MP3 bit rate, latency optimization, normalization, timestamps, and a required `outputPath`. The tool only saves audio and does not play it. Timestamp envelopes can be saved separately.
- `speech_to_text`: file or URL transcription with raw format/sample rate, language/formatting, multichannel/channels, diarization, repeatable keyterms, and filler-word options.
- `list_speech_voices`: list available built-in and custom voices.

Media inputs accept HTTP(S) URLs, data URIs, Files API IDs, or local paths (an optional leading `@` is stripped). Relative paths resolve from pi's current working directory. Local image/video inputs are encoded as data URIs. Output directories are created automatically. Temporary image/video URLs should be downloaded promptly using `outputPath`.

## Speech slash commands and Ctrl+Space PTT

```text
Ctrl+Space (hold)        # stream mic → live STT into editor + ● REC footer; release to finalize (also stops TTS if playing)
Esc                      # cancel push-to-talk and restore the editor
/listen
/listen-stop
/auto-listen-on
/auto-listen-off
/spacexai-voice eve
/set-speaking-style warm, measured, and conversational
/remove-speaking-style
```

Playback requires `ffplay` from FFmpeg. TTS text is limited to 15,000 characters. `/set-speaking-style` stores a persistent style description and injects it into the system prompt so responses are written for that delivery; `/remove-speaking-style` clears it. Slash-command configuration is stored at `~/.pi/spacexai.json` with user-only permissions.

Voice input streams raw PCM16 mono @ 16 kHz over `wss://api.x.ai/v1/stt` (`interim_results=true`). On release the client sends `finalize` then `audio.done` and uses the resulting transcript. Local recorder preference: **arecord** (ALSA raw PCM on Linux), then **ffmpeg** (stdout s16le). Auth is the same xAI bearer from pi’s model registry.
