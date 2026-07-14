# pi-spacexai

A pi extension providing the `spacexai` model provider, xAI subscription OAuth/API-key authentication, xAI server-side search/code tools, and the complete documented xAI REST media tools.

## Load and authenticate

```bash
pi install /home/wizard/repos/pi-spacexai
pi -e ./index.ts                 # development
```

Run `/login spacexai` for xAI device OAuth (eligible SuperGrok/X subscription), or set `SPACEXAI_API_KEY=xai-...` for metered API-key access. Credentials are refreshed by pi. Select bundled Grok models using `/model` under provider `spacexai` (`grok-4.5`, `grok-4.3`, `grok-build`, `grok-build-0.1`, and `grok-composer-2.5-fast`).

Every `spacexai` Responses API request also exposes xAI's server-side `web_search`, `x_search`, and `code_interpreter` tools to Grok. Grok decides when to invoke them alongside pi's normal client-side function tools.

## REST media tools

- `spacexai_image_generate`: model, prompt, 1–10 images, every documented aspect ratio, 1k/2k resolution, URL/base64 response, and a required output path.
- `spacexai_image_edit`: single or up to three source images, all documented edit options, and a required output path.
- `spacexai_video_generate`: text-, image-, or reference-to-video; model, prompt, duration, aspect ratio, resolution, and a required output path. It polls until completion and downloads the video.
- `spacexai_video_edit`: prompt/video, documented (service-ignored) geometry fields, and a required output path. It polls until completion.
- `spacexai_video_extend`: prompt/video, optional 2–10 second extension duration, and a required output path. It polls until completion.
- `spacexai_video_status`: poll by request ID and download completed video to a required output path.
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
