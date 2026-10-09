# pi-spacexai

Grok Imagine, speech generation and transcription, F12 mic voice input, and a harness that can speak its responses aloud — layered on top of **pi’s built-in xAI provider**.

This extension no longer registers its own chat provider or OAuth flow. Authenticate with pi (`/login xai`), then install this package for media tools and voice UX.

## Why pi-spacexai is cool

### 1. Uses your existing xAI login

Sign in with pi’s native **xAI (Grok/X subscription)** OAuth or an xAI API key. Credentials live in `~/.pi/agent/auth.json` under the `xai` key. If that entry is missing, this extension stays inactive (no tools, commands, or shortcuts).

At request time, tokens come from pi’s model registry (`getApiKeyForProvider("xai")`), so OAuth refresh stays pi’s job.

### 2. Full Grok Imagine support with detailed control

Generate and edit images, or create, edit, and extend videos without leaving the coding harness. Requests expose the documented Grok Imagine controls rather than hiding them behind simplified presets:

- Text-to-image and image editing with up to five source images (grok-imagine-image-2.0 supports up to 5; older models may reject >3)
- Full support for **grok-imagine-image-2.0** with `quality` (`low`, `medium`, or `auto`), `1k` / `1.5k` / `2k`, and aspect ratios through `21:9` and `5:2`. Retired slugs `grok-imagine-image-quality` and `grok-imagine-image-pro` are rewritten to 2.0.
- Optional `storage_options` for server-side file storage with custom filenames, expiry times, and public URLs
- 1–10 image variations, every supported aspect ratio, and 1K/2K resolution
- Correct Files API `file_id` handling for image edits
- Text-to-video, image-to-video, and reference-to-video (separate tools, matching Grok Build names)
- On **grok-imagine-video-1.5**: native 1080p for text-to-video and image-to-video, up to 14 reference images, preset voices (`reference_audios`), a pinned `last_frame`, and up to four interior `keyframes`. **1.5-lite** reaches 1080p by upscaling 720p and does not take references or pinned frames
- Exact video duration control in seconds, aspect ratios through `21:9` and `5:2`, 480p/720p/1080p resolution, and optional `generate_audio`
- Video editing and 2–10 second extensions, including Files API `file_id` inputs and optional `storage_options`
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

Pi’s built-in xAI provider uses **Chat Completions**. Hosted Agent Tools (`{ type: "web_search" }`) and Live Search both fail on that wire (422 / 410). This extension does not switch the chat transport.

Instead it registers client-side function tools that call those Agent Tools on `/v1/responses` (pi’s chat turn is still Completions). When the session is not already on an xAI model, the fallback is **`grok-4.7`**. Requests set `reasoning.effort` to `low` so the default high effort does not stall the tool, and they set `temperature` without `top_p`.

- `web_search` — public web only (`{ type: "web_search" }`). Optional `allowed_domains` or `excluded_domains` (max 5, not both), `enable_image_understanding`, `enable_image_search`, and `max_turns`.
- `x_search` — X/Twitter only (`{ type: "x_search" }`). `from_date` is inclusive from 00:00 UTC. `to_date` is exclusive (posts before that date; set it to the next day to cover one day). Optional `allowed_x_handles` or `excluded_x_handles` (max 20, not both), `enable_image_understanding`, `enable_video_understanding`, and `max_turns`.

### 7. Realtime voice (`/realtime-voice-start`)

Start a **Grok speech-to-speech** co-pilot in this terminal. There is no browser page. The extension opens `wss://api.x.ai/v1/realtime`, records the microphone, and plays replies with `ffplay`.

```text
/realtime-voice-start
/realtime-voice-select eve   # no argument prints the current voice
/realtime-voice-stop
```

What happens:

1. The extension mints an ephemeral token and connects to `grok-voice-latest` with server VAD.
2. The microphone is raw PCM from **arecord** (Linux) or **ffmpeg**. Replies play through **aplay**, **paplay**, or **ffplay**. Spoken words are not written into the chat.
3. The voice agent calls **`send_task`**. The job is steered into the current pi turn. The tool returns a receipt. The outcome comes back later as `work_landed`.
4. While the session is running, the coding agent gains two tools (removed again on stop):
   - **`send_message_to_observer`** — queues a `work_landed` update. The session then calls `read_background_updates` so the voice agent can speak it
   - **`set_harness_status`** — short status line in the voice sidebar (not spoken)
5. The coding-agent system prompt is extended with observer instructions for the duration of the session.
6. Five minutes of silence disconnects the socket. Speaking resets that timer.
7. Voice state is drawn in a **right-hand sidebar** (connection, voice name, microphone level, harness status, and the you/voice transcript). The chat column narrows to make room. This follows the [pi-sidebar-tui](https://github.com/bi0h4z4rd88/pi-sidebar-tui) compositor: `terminal.columns` is reduced, and the panel is painted into the rightmost columns after each TUI frame inside one synchronized update. Rows are rewritten only when their text changes.

```text
/realtime-voice-sidebar width 40
```

Width is 10–120 columns and is remembered in `~/.pi/agent/spacexai-voice-sidebar.json`. Before the sidebar is mounted, a one-line footer shows `realtime · voice`, the mic meter, and harness status.

Default voice is **leo**. `/realtime-voice-select` and `/spacexai-voice` write the same `~/.pi/spacexai.json` voice. Selecting a voice during a live session applies it immediately.

Voice-agent tools:

- `send_task` — request a job of at most 2000 characters. Returns a receipt. Overlong requests are rejected.
- `search_conversations` — up to 6 earlier or current chats, best first. `scope` is `this-chat`, `earlier`, or `everything`. `id` reads one hit in full. `if_missing` is `say-no-record` or `send-task`.
- `end_the_call` — hang up after a spoken goodbye. A tone plays on start and on stop.
- `read_background_updates` — background mail, including `work_landed`. The session calls this. The voice agent does not.

Coding-agent tools (only while realtime voice is running):

- `send_message_to_observer` — spoken update / answer for the user via the voice agent
- `set_harness_status` — live “what the harness is doing” text in the voice sidebar

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

- `image_gen`: model (`grok-imagine-image` or `grok-imagine-image-2.0`), prompt, 1–10 images, every documented aspect ratio (including `21:9` and `5:2`), `1k`/`1.5k`/`2k` resolution, optional `quality` (`low`/`medium`/`auto`, 2.0 only; omit or `auto` lets the service choose), optional `deferred` polling of `GET /v1/images/{request_id}` (URL responses only), optional `storage_options` (filename, expiry, public_url), URL/base64 response, and a required output path. `grok-imagine-image-quality` and `grok-imagine-image-pro` are accepted and rewritten to `grok-imagine-image-2.0` with `quality: "low"` when `quality` is omitted.
- `image_edit`: single or up to five source images (grok-imagine-image-2.0 supports up to 5; older models may reject >3), the same model rewrite, `quality`, `n` (1–10), `deferred`, and `storage_options`, correct `file_id` handling for Files API inputs, and a required output path.
- `text_to_video`: prompt → video (`grok-imagine-video`, `grok-imagine-video-1.5`, or `grok-imagine-video-1.5-lite`), duration 1–15s, aspect ratio (including `21:9` and `5:2`), 480p/720p/1080p, optional `generate_audio` (default on). 1080p is native on 1.5 and upscaled from 720p on 1.5-lite. `grok-imagine-video` stops at 720p. Optional `storage_options`. Polls until completion and downloads to a required output path.
- `image_to_video`: single source image → video (optional prompt, duration, resolution, optional `generate_audio`, optional `last_frame` on 1.5). `aspect_ratio` is ignored; the clip matches the still. `last_frame` turns the request into reference-to-video with a pinned first frame. `file_id` inputs use the Files API shape. Polls until completion and downloads to a required output path.
- `reference_to_video`: up to 14 reference images on 1.5 (7 on `grok-imagine-video`), up to 3 preset voices (`reference_audios[].voice_id`, tag `<AUDIO_0>`), optional first-frame `image`, `last_frame`, up to 4 `keyframes` (`timestamp_s` strictly inside the clip), and optional `generate_audio`. At least one reference or pin is required. Prompt is required unless a frame is pinned. Resolution cap for this mode is 720p. `grok-imagine-video` reference clips are capped at 10 seconds. 1.5-lite does not support this mode. Partner-only custom audio clips can be passed as `reference_audios[].audio`.
- `video_edit`: prompt and an mp4 (`url` or `file_id`) on `grok-imagine-video`. 1.5 and 1.5-lite do not edit. Optional `storage_options`. It polls until completion. Output duration and resolution follow the source, capped at 8.7 seconds and 720p.
- `video_extend`: prompt and an mp4 on `grok-imagine-video`, optional 2–10 second extension duration (default 6), optional `storage_options`. The source video must be 2–15 seconds. It polls until completion.
- `text_to_speech`: text up to 60,000 characters, language, voice, speed, codec, sample rate, MP3 bit rate, latency optimization (`0`, `1`, or `2`), an optional `replace` pronunciation map, normalization, timestamps, and a required `outputPath`. The tool only saves audio and does not play it. Timestamp envelopes can be saved separately.
- `speech_to_text`: file or URL transcription with raw format/sample rate, language/formatting, multichannel/channels, diarization, repeatable keyterms, filler words, `vad_threshold` (0–1), and `model` (default `grok-voice-transcribe-2.0`; `grok-voice-transcribe-1.0` is rewritten to 2.0).
- `list_speech_voices`: list built-in voices from `GET /v1/tts/voices` and this team's custom voices from `GET /v1/custom-voices`.

Media inputs accept HTTP(S) URLs, data URIs, Files API IDs (`file_...` → correct `file_id` shape), or local paths (an optional leading `@` is stripped). Relative paths resolve from pi's current working directory. Local image/video inputs are encoded as data URIs. Output directories are created automatically. Temporary image/video URLs should be downloaded promptly using `outputPath`.

### storage_options (optional)

When provided, instructs the xAI API to store generated images server-side:

- `filename` (required): custom filename for the stored file
- `expires_after` (optional): seconds until the stored file expires (maximum 2592000 / 30 days). Omit it and the file does not expire.
- `public_url` (optional): boolean or `{ expires_after?: number }` for public URL generation

The response may include `file_output` and/or `public_url` fields; these are included in the tool's `details` return value. The tool still downloads and saves files locally to `outputPath` as usual.

## Speech slash commands and Ctrl+Space PTT

```text
Ctrl+Space (hold)        # stream mic → live STT into editor + ● REC footer; release to finalize (also stops TTS if playing)
Esc                      # cancel push-to-talk and restore the editor
/listen
/listen-stop
/auto-listen-on
/auto-listen-off
/spacexai-voice eve
/realtime-voice-start
/realtime-voice-select eve
/realtime-voice-sidebar width 40
/realtime-voice-stop
/set-speaking-style warm, measured, and conversational
/remove-speaking-style
```

Playback requires `ffplay` from FFmpeg. TTS text is limited to 60,000 characters. `/set-speaking-style` stores a persistent style description and injects it into the system prompt so responses are written for that delivery; `/remove-speaking-style` clears it. Slash-command configuration is stored at `~/.pi/spacexai.json` with user-only permissions.

Voice input streams raw PCM16 mono @ 16 kHz over `wss://api.x.ai/v1/stt` (`model=grok-voice-transcribe-2.0`, `interim_results=true`). On release the client sends `finalize` then `audio.done` and uses the resulting transcript. Local recorder preference: **arecord** (ALSA raw PCM on Linux), then **ffmpeg** (stdout s16le). Auth is the same xAI bearer from pi’s model registry.
