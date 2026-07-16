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
- Text-to-video, image-to-video, and reference-to-video workflows
- Exact video duration control in seconds, aspect ratio, and 480p/720p/1080p resolution
- Video editing and 2–10 second extensions
- Automatic job polling, output downloading, and explicit destination paths

### 3. Generate and transcribe audio with TTS/STT

Create production-ready speech files with full control over voice, language, speed, codec, sample rate, MP3 bit rate, streaming-latency optimization, text normalization, and character-level timestamps. Transcribe local files or URLs with formatting, word timing, speaker diarization, multichannel audio, keyterm biasing, and filler-word controls.

### 4. Let the harness speak—and shape how it sounds

Use `/listen` to hear the latest assistant response or `/auto-listen-on` to make pi speak every completed response automatically. Choose a voice and persist a speaking style so the assistant writes naturally for spoken delivery, including supported xAI speech tags when appropriate.

### 5. Talk back with F12 voice input

Press **F12** to start recording from the microphone (widget above the editor). Press **F12** again to stop, transcribe with xAI STT (`/v1/stt`), and send the transcript as your next user message. If TTS is currently playing, the first F12 stops playback instead. Max recording length is 5 minutes (longer takes are discarded).

### 6. Server-side Grok tools on xAI models

When the active model’s provider is `xai`, every Responses API request also exposes xAI’s server-side `web_search`, `x_search`, and `code_interpreter` tools. Grok decides when to invoke them alongside pi’s normal client-side function tools.

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

- `spacexai_grok_image_generate`: model, prompt, 1–10 images, every documented aspect ratio, 1k/2k resolution, URL/base64 response, and a required output path.
- `spacexai_grok_image_edit`: single or up to three source images, all documented edit options, and a required output path.
- `spacexai_grok_video_generate`: text-, image-, or reference-to-video; model, prompt, duration, aspect ratio, resolution, and a required output path. It polls until completion and downloads the video.
- `spacexai_grok_video_edit`: prompt/video, documented (service-ignored) geometry fields, and a required output path. It polls until completion.
- `spacexai_grok_video_extend`: prompt/video, optional 2–10 second extension duration, and a required output path. It polls until completion.
- `spacexai_grok_video_status`: poll by request ID and download completed video to a required output path.
- `spacexai_tts`: text/language, voice, speed, codec, sample rate, MP3 bit rate, latency optimization, normalization, timestamps, and a required `outputPath`. The tool only saves audio and does not play it. Timestamp envelopes can be saved separately.
- `spacexai_stt`: file or URL transcription with raw format/sample rate, language/formatting, multichannel/channels, diarization, repeatable keyterms, and filler-word options.
- `spacexai_voices`: list available built-in and custom voices.

Media inputs accept HTTP(S) URLs, data URIs, Files API IDs, or local paths (an optional leading `@` is stripped). Relative paths resolve from pi's current working directory. Local image/video inputs are encoded as data URIs. Output directories are created automatically. Temporary image/video URLs should be downloaded promptly using `outputPath`.

## Speech slash commands and F12 input

```text
F12                      # toggle mic → STT → send (also stops TTS if playing)
/listen
/listen-stop
/auto-listen-on
/auto-listen-off
/spacexai-voice eve
/set-speaking-style warm, measured, and conversational
/remove-speaking-style
```

Playback requires `ffplay` from FFmpeg. TTS text is limited to 15,000 characters. `/set-speaking-style` stores a persistent style description and injects it into the system prompt so responses are written for that delivery; `/remove-speaking-style` clears it. Slash-command configuration is stored at `~/.pi/spacexai.json` with user-only permissions.

Voice input needs a local recorder. Preference order: **arecord** (ALSA, Linux), **ffmpeg**, then **sox** (`rec`). Sox is last because some builds leave an empty/invalid WAV when stopped. Capture is re-muxed through ffmpeg when available so STT always sees a valid PCM WAV. Transcription uses the same xAI auth via REST `POST /v1/stt`. There is no streaming WebSocket STT.
