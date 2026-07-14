# pi-spacexai

Bring the full Grok ecosystem into pi: subscription-backed models, Grok Imagine, speech generation and transcription, and a harness that can speak its responses aloud.

## Why pi-spacexai is cool

### 1. Use your Grok subscription

Sign in through xAI's device OAuth flow and use an eligible **SuperGrok or X subscription** directly inside pi—no separate metered API key required. The extension refreshes OAuth credentials automatically and registers Grok chat and coding models as a native `spacexai` provider. API-key authentication remains available as an optional fallback.

Grok also receives xAI's server-side `web_search`, `x_search`, and `code_interpreter` tools alongside pi's normal local tools.

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

## Load and authenticate

```bash
pi install /home/wizard/repos/pi-spacexai
pi -e ./index.ts                 # development
```

Run `/login spacexai` for xAI device OAuth (eligible SuperGrok/X subscription), or set `SPACEXAI_API_KEY=xai-...` for metered API-key access. Credentials are refreshed by pi. Select bundled Grok models using `/model` under provider `spacexai` (`grok-4.5`, `grok-4.3`, `grok-build`, `grok-build-0.1`, and `grok-composer-2.5-fast`).

Every `spacexai` Responses API request also exposes xAI's server-side `web_search`, `x_search`, and `code_interpreter` tools to Grok. Grok decides when to invoke them alongside pi's normal client-side function tools.

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

## Speech slash commands

Existing commands remain available:

```text
/listen
/listen-stop
/auto-listen-on
/auto-listen-off
/spacexai-voice eve
/set-speaking-style warm, measured, and conversational
/remove-speaking-style
```

Playback requires `ffplay` from FFmpeg. TTS text is limited to 15,000 characters. `/set-speaking-style` stores a persistent style description and injects it into the system prompt so responses are written for that delivery; `/remove-speaking-style` clears it. Slash-command configuration is stored at `~/.pi/spacexai.json` with user-only permissions. This extension intentionally provides file-based REST STT and no WebSocket tools.
