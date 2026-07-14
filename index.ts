import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";

const PROVIDER = "spacexai";
const API_BASE = "https://api.x.ai/v1";
const AUTH_BASE = "https://auth.x.ai/oauth2";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPES = "openid profile email offline_access grok-cli:access api:access";
const CONFIG_PATH = join(homedir(), ".pi", "spacexai.json");
const AUDIO_PATH = join(homedir(), ".pi", "spacexai-tts.mp3");
const EXPIRY_SKEW_MS = 120_000;

interface Config {
  voice?: string;
  language?: string;
  speed?: number;
  autoListen?: boolean;
  speakingStyle?: string;
}

const MODELS = [
  { id: "grok-4.5", name: "Grok 4.5", reasoning: true, contextWindow: 500_000, maxTokens: 131_072 },
  { id: "grok-4.3", name: "Grok 4.3", reasoning: true, contextWindow: 256_000, maxTokens: 65_536 },
  { id: "grok-build", name: "Grok Build", reasoning: true, contextWindow: 256_000, maxTokens: 65_536 },
  { id: "grok-build-0.1", name: "Grok Build 0.1", reasoning: true, contextWindow: 256_000, maxTokens: 65_536 },
  { id: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast", reasoning: true, contextWindow: 256_000, maxTokens: 65_536 },
].map((model) => ({
  ...model,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsReasoningEffort: true, supportsStore: true },
}));

async function readConfig(): Promise<Config> {
  try { return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config; } catch { return {}; }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function parseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { error?: string | { message?: string }; error_description?: string };
    return typeof data.error === "string" ? `${data.error}: ${data.error_description ?? ""}`.trim() : data.error?.message ?? text;
  } catch { return text; }
}

async function tokenRequest(body: URLSearchParams): Promise<any> {
  const response = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`SpaceXAI token request failed: ${data.error_description ?? data.error ?? response.status}`);
  return data;
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const response = await fetch(`${AUTH_BASE}/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }),
  });
  if (!response.ok) throw new Error(`SpaceXAI device authorization failed: ${await parseError(response)}`);
  const device = await response.json() as {
    device_code: string; user_code: string; verification_uri: string;
    verification_uri_complete?: string; expires_in: number; interval?: number;
  };
  callbacks.onAuth({ url: device.verification_uri_complete ?? device.verification_uri });
  callbacks.onDeviceCode({
    userCode: device.user_code,
    verificationUri: device.verification_uri_complete ?? device.verification_uri,
    intervalSeconds: device.interval ?? 5,
    expiresInSeconds: device.expires_in,
  });

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval ?? 5;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    try {
      const token = await tokenRequest(new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: CLIENT_ID,
      }));
      return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // xAI sometimes returns the OAuth code and sometimes only a human-readable
      // description while device authorization is still pending.
      if (/authorization_pending|not yet authorized|authorization is pending/i.test(message)) continue;
      if (/slow_down|slow down/i.test(message)) { interval += 5; continue; }
      throw error;
    }
  }
  throw new Error("SpaceXAI device authorization expired");
}

async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const token = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: CLIENT_ID,
  }));
  return {
    access: token.access_token,
    refresh: token.refresh_token ?? credentials.refresh,
    expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
  };
}

function assistantText(message: any): string | undefined {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
  const text = message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim();
  return text || undefined;
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "message") {
      const text = assistantText(entry.message);
      if (text) return text;
    }
  }
}

async function bearer(ctx: ExtensionContext): Promise<string> {
  const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
  if (!token) throw new Error("Not authenticated. Run /login spacexai or set SPACEXAI_API_KEY.");
  return token;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/opus", ".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/mp4", ".mkv": "video/x-matroska" };
function localPath(ctx: ExtensionContext, value: string): string { return resolve(ctx.cwd, value.replace(/^@/, "")); }
async function mediaRef(ctx: ExtensionContext, value: string): Promise<string> {
  if (/^(https?:|data:|file_)/i.test(value)) return value;
  const path = localPath(ctx, value);
  const data = await readFile(path);
  const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${data.toString("base64")}`;
}
async function api(ctx: ExtensionContext, path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new Error("Cancelled");
  const response = await fetch(`${API_BASE}${path}`, { ...init, signal, headers: { Authorization: `Bearer ${await bearer(ctx)}`, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`SpaceXAI request failed (${response.status}): ${await parseError(response)}`);
  return response;
}
async function jsonPost(ctx: ExtensionContext, path: string, body: any, signal?: AbortSignal): Promise<any> {
  return api(ctx, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, signal).then((r) => r.json());
}
async function saveRemote(url: string, path: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Media download failed (${response.status}): ${await response.text()}`);
  const data = Buffer.from(await response.arrayBuffer()); await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); return data.length;
}
async function imageResult(ctx: ExtensionContext, data: any, outputPath: string, signal?: AbortSignal) {
  const items = data.data ?? [];
  const saved: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const base = localPath(ctx, outputPath); const path = items.length === 1 ? base : join(dirname(base), `${base.slice(base.lastIndexOf("/") + 1, base.lastIndexOf(".")) || "image"}-${i + 1}${extname(base) || ".png"}`);
    await mkdir(dirname(path), { recursive: true });
    if (items[i].b64_json) await writeFile(path, Buffer.from(items[i].b64_json, "base64")); else if (items[i].url) await saveRemote(items[i].url, path, signal); else throw new Error(`Image ${i + 1} contained no downloadable content`);
    saved.push(path);
  }
  const summary = `Saved ${saved.length} image(s): ${saved.join(", ")}`;
  return { content: [{ type: "text", text: summary || "No images returned" }], details: { ...data, saved } };
}

async function saveVideoJob(ctx: ExtensionContext, requestId: string, outputPath: string, signal?: AbortSignal): Promise<any> {
  while (true) {
    if (signal?.aborted) throw new Error("Cancelled");
    const data: any = await api(ctx, `/videos/${encodeURIComponent(requestId)}`, {}, signal).then((response) => response.json());
    if (data.status === "done") {
      if (!data.video?.url) throw new Error("Completed video job returned no download URL");
      const saved = localPath(ctx, outputPath);
      const bytes = await saveRemote(data.video.url, saved, signal);
      return { content: [{ type: "text", text: `Video done; saved to ${saved}` }], details: { ...data, saved, bytes } };
    }
    if (data.status === "failed" || data.status === "expired") {
      throw new Error(`Video ${data.status}: ${data.error?.code ?? "error"}: ${data.error?.message ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function synthesize(ctx: ExtensionContext, text: string, overrides: Partial<Config> = {}): Promise<Buffer> {
  if (!text.trim()) throw new Error("Text must not be empty");
  if (text.length > 15_000) throw new Error("SpaceXAI TTS accepts at most 15,000 characters");
  const config = { ...(await readConfig()), ...overrides };
  const response = await fetch(`${API_BASE}/tts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await bearer(ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_id: config.voice ?? "eve",
      language: config.language ?? "en",
      speed: config.speed ?? 1,
      output_format: { codec: "mp3", sample_rate: 24_000, bit_rate: 128_000 },
    }),
  });
  if (!response.ok) throw new Error(`SpaceXAI TTS failed (${response.status}): ${await parseError(response)}`);
  return Buffer.from(await response.arrayBuffer());
}

let player: ChildProcess | undefined;
async function play(audio: Buffer): Promise<void> {
  await mkdir(dirname(AUDIO_PATH), { recursive: true });
  await writeFile(AUDIO_PATH, audio, { mode: 0o600 });
  player?.kill("SIGTERM");
  player = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", AUDIO_PATH], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    player!.once("error", reject);
    player!.once("exit", (code) => code === 0 || code === null ? resolve() : reject(new Error(`ffplay exited with code ${code}`)));
  });
  player = undefined;
  await unlink(AUDIO_PATH).catch(() => {});
}

export default function spacexai(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER, {
    name: "SpaceXAI (Grok subscription)",
    baseUrl: API_BASE,
    apiKey: "$SPACEXAI_API_KEY",
    authHeader: true,
    api: "openai-responses",
    models: MODELS,
    oauth: { name: "SpaceXAI / SuperGrok", login, refreshToken, getApiKey: (credentials) => credentials.access },
  });

  // xAI Responses executes these tools server-side. They are distinct from pi's
  // client-side function tools and can coexist in the same request.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    if (!event.payload || typeof event.payload !== "object") return;
    const payload = event.payload as Record<string, unknown>;
    const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
    const existingTypes = new Set(
      tools
        .filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === "object")
        .map((tool) => tool.type)
        .filter((type): type is string => typeof type === "string"),
    );
    for (const type of ["web_search", "x_search", "code_interpreter"]) {
      if (!existingTypes.has(type)) tools.push({ type });
    }
    return { ...payload, tools };
  });

  const aspectImage = Type.Union(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"].map(Type.Literal));
  const aspectVideo = Type.Union(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].map(Type.Literal));
  const imageCommon = { model: Type.String({ description: "grok-imagine-image or grok-imagine-image-quality" }), prompt: Type.String(), aspect_ratio: Type.Optional(aspectImage), resolution: Type.Optional(Type.Union([Type.Literal("1k"), Type.Literal("2k")])), response_format: Type.Optional(Type.Union([Type.Literal("url"), Type.Literal("b64_json")])), outputPath: Type.String({ description: "Required destination filename; numbered when n > 1" }) };
  pi.registerTool({ name: "spacexai_grok_image_generate", label: "Grok Imagine Image Generation", description: "Grok Imagine: generate images with all REST options.", parameters: Type.Object({ ...imageCommon, n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), async execute(_id, p, signal, _u, ctx) { const { outputPath, ...body } = p; return imageResult(ctx, await jsonPost(ctx, "/images/generations", body, signal), outputPath, signal); } });
  pi.registerTool({ name: "spacexai_grok_image_edit", label: "Grok Imagine Image Edit", description: "Grok Imagine: edit one or up to three images. Inputs may be URLs, file IDs, data URIs, or local paths.", parameters: Type.Object({ ...imageCommon, image: Type.Optional(Type.String()), images: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 3 })) }), async execute(_id, p, signal, _u, ctx) { if (!!p.image === !!p.images) throw new Error("Provide exactly one of image or images"); const { outputPath, image, images, ...body } = p; if (image) body.image = { url: await mediaRef(ctx, image), type: "image_url" }; if (images) body.images = await Promise.all(images.map(async (x: string) => ({ url: await mediaRef(ctx, x), type: "image_url" }))); return imageResult(ctx, await jsonPost(ctx, "/images/edits", body, signal), outputPath, signal); } });

  const videoCommon = { model: Type.String({ description: "grok-imagine-video" }), prompt: Type.String(), duration: Type.Optional(Type.Number()), aspect_ratio: Type.Optional(aspectVideo), resolution: Type.Optional(Type.Union([Type.Literal("480p"), Type.Literal("720p"), Type.Literal("1080p")])) };
  pi.registerTool({ name: "spacexai_grok_video_generate", label: "Grok Imagine Video Generation", description: "Grok Imagine: start text-, image-, or reference-to-video generation. Local media is converted to data URIs.", parameters: Type.Object({ ...videoCommon, duration: Type.Optional(Type.Number({ minimum: 1, maximum: 15 })), image: Type.Optional(Type.String()), reference_images: Type.Optional(Type.Array(Type.String(), { minItems: 1 })), outputPath: Type.String({ description: "Required destination video filename" }) }), async execute(_id, p, signal, _u, ctx) { if (p.image && p.reference_images) throw new Error("image and reference_images cannot be combined"); const { image, reference_images, outputPath, ...body } = p; if (image) body.image = { url: await mediaRef(ctx, image) }; if (reference_images) body.reference_images = await Promise.all(reference_images.map(async (x: string) => ({ url: await mediaRef(ctx, x) }))); const data = await jsonPost(ctx, "/videos/generations", body, signal); return saveVideoJob(ctx, data.request_id, outputPath, signal); } });
  pi.registerTool({ name: "spacexai_grok_video_edit", label: "Grok Imagine Video Edit", description: "Grok Imagine: edit a video. Geometry options are accepted by REST but ignored by the service.", parameters: Type.Object({ ...videoCommon, video: Type.String(), outputPath: Type.String({ description: "Required destination video filename" }) }), async execute(_id, p, signal, _u, ctx) { const { outputPath, ...body } = p; const data = await jsonPost(ctx, "/videos/edits", { ...body, video: { url: await mediaRef(ctx, p.video) } }, signal); return saveVideoJob(ctx, data.request_id, outputPath, signal); } });
  pi.registerTool({ name: "spacexai_grok_video_extend", label: "Grok Imagine Video Extension", description: "Grok Imagine: extend a video by 2–10 seconds.", parameters: Type.Object({ model: Type.String({ description: "grok-imagine-video" }), prompt: Type.String(), video: Type.String(), duration: Type.Optional(Type.Number({ minimum: 2, maximum: 10 })), outputPath: Type.String({ description: "Required destination video filename" }) }), async execute(_id, p, signal, _u, ctx) { const { outputPath, ...body } = p; const data = await jsonPost(ctx, "/videos/extensions", { ...body, video: { url: await mediaRef(ctx, p.video) } }, signal); return saveVideoJob(ctx, data.request_id, outputPath, signal); } });
  pi.registerTool({ name: "spacexai_grok_video_status", label: "Grok Imagine Video Status", description: "Grok Imagine: poll a video job and download completed output to the required outputPath.", parameters: Type.Object({ request_id: Type.String(), outputPath: Type.String({ description: "Required destination video filename" }) }), async execute(_id, p, signal, _u, ctx) { const data: any = await api(ctx, `/videos/${encodeURIComponent(p.request_id)}`, {}, signal).then(r => r.json()); let saved; if (data.status === "done" && p.outputPath && data.video?.url) { saved = localPath(ctx, p.outputPath); await saveRemote(data.video.url, saved, signal); } const text = data.status === "done" ? (saved ? `Video done; saved to ${saved}` : `Video done: ${data.video?.url}`) : data.status === "failed" ? `Video failed: ${data.error?.code ?? "error"}: ${data.error?.message ?? "unknown error"}` : `Video status: ${data.status}`; return { content: [{ type: "text", text }], details: { ...data, saved } }; } });

  pi.registerTool({
    name: "spacexai_tts",
    label: "SpaceXAI TTS",
    description: "Synthesize speech with every REST option and save it to the required outputPath. This tool does not play audio.",
    promptSnippet: "Synthesize speech with SpaceXAI TTS",
    promptGuidelines: ["Use spacexai_tts when the user asks to speak, narrate, or synthesize text with SpaceXAI."],
    parameters: Type.Object({ text: Type.String({ maxLength: 15000 }), language: Type.String({ description: "BCP-47 code or auto" }), voice_id: Type.Optional(Type.String()), speed: Type.Optional(Type.Number({ minimum: 0.7, maximum: 1.5 })), codec: Type.Optional(Type.Union(["mp3", "wav", "pcm", "mulaw", "alaw"].map(Type.Literal))), sample_rate: Type.Optional(Type.Union([8000, 16000, 22050, 24000, 44100, 48000].map(Type.Literal))), bit_rate: Type.Optional(Type.Union([32000, 64000, 96000, 128000, 192000].map(Type.Literal))), optimize_streaming_latency: Type.Optional(Type.Union([0, 1, 2].map(Type.Literal))), text_normalization: Type.Optional(Type.Boolean()), with_timestamps: Type.Optional(Type.Boolean()), outputPath: Type.String({ description: "Required audio destination path, including filename" }), timestampsPath: Type.Optional(Type.String({ description: "Save the timestamp JSON envelope here" })) }),
    async execute(_id, p, signal, _update, ctx) {
      const { outputPath, timestampsPath, codec, sample_rate, bit_rate, ...fields } = p;
      const body: any = { ...fields, output_format: { ...(codec === undefined ? {} : { codec }), ...(sample_rate === undefined ? {} : { sample_rate }), ...(bit_rate === undefined ? {} : { bit_rate }) } };
      const response = await api(ctx, "/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, signal);
      let audio: Buffer; let envelope: any;
      if (p.with_timestamps) { envelope = await response.json(); audio = Buffer.from(envelope.audio, "base64"); } else audio = Buffer.from(await response.arrayBuffer());
      const path = localPath(ctx, outputPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, audio);
      if (timestampsPath && envelope) { const tp = localPath(ctx, timestampsPath); await mkdir(dirname(tp), { recursive: true }); await writeFile(tp, JSON.stringify(envelope, null, 2)); }
      return { content: [{ type: "text", text: `Saved speech to ${path}${envelope ? ` (${envelope.duration}s, timestamps included)` : ""}` }], details: { path, bytes: audio.length, ...(envelope ? { duration: envelope.duration, content_type: envelope.content_type, audio_timestamps: envelope.audio_timestamps } : {}) } };
    },
  });

  pi.registerTool({ name: "spacexai_stt", label: "SpaceXAI File STT", description: "Transcribe a local audio file or URL with every documented multipart REST option.", parameters: Type.Object({ file: Type.Optional(Type.String()), url: Type.Optional(Type.String()), audio_format: Type.Optional(Type.Union(["pcm", "mulaw", "alaw"].map(Type.Literal))), sample_rate: Type.Optional(Type.Integer()), language: Type.Optional(Type.String()), format: Type.Optional(Type.Boolean()), multichannel: Type.Optional(Type.Boolean()), channels: Type.Optional(Type.Integer({ minimum: 2, maximum: 8 })), diarize: Type.Optional(Type.Boolean()), keyterm: Type.Optional(Type.Array(Type.String({ maxLength: 50 }), { maxItems: 100 })), filler_words: Type.Optional(Type.Boolean()), outputPath: Type.Optional(Type.String({ description: "Save full transcript JSON" })) }), async execute(_id, p, signal, _u, ctx) { if (!!p.file === !!p.url) throw new Error("Provide exactly one of file or url"); const form = new FormData(); for (const [key, value] of Object.entries(p)) { if (key === "file" || key === "outputPath" || value === undefined) continue; if (key === "keyterm") for (const term of value as string[]) form.append("keyterm", term); else form.append(key, String(value)); } if (p.file) { const path = localPath(ctx, p.file); const bytes = await readFile(path); form.append("file", new Blob([bytes], { type: MIME[extname(path).toLowerCase()] ?? "application/octet-stream" }), path.slice(path.lastIndexOf("/") + 1)); } const data: any = await api(ctx, "/stt", { method: "POST", body: form }, signal).then(r => r.json()); let saved; if (p.outputPath) { saved = localPath(ctx, p.outputPath); await mkdir(dirname(saved), { recursive: true }); await writeFile(saved, JSON.stringify(data, null, 2)); } return { content: [{ type: "text", text: `${data.text ?? "Transcription complete"}${saved ? `\nSaved full result to ${saved}` : ""}` }], details: { ...data, saved } }; } });

  pi.registerTool({
    name: "spacexai_voices",
    label: "SpaceXAI Voices",
    description: "List voices available from SpaceXAI/xAI TTS.",
    promptSnippet: "List available SpaceXAI TTS voices",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const response = await fetch(`${API_BASE}/tts/voices`, { headers: { Authorization: `Bearer ${await bearer(ctx)}` }, signal });
      if (!response.ok) throw new Error(`Could not list SpaceXAI voices (${response.status}): ${await parseError(response)}`);
      const data = await response.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
    },
  });

  pi.registerCommand("listen", {
    description: "Read the last assistant response with SpaceXAI TTS",
    handler: async (_args, ctx) => {
      try {
        const text = lastAssistantText(ctx);
        if (!text) return void ctx.ui.notify("No assistant response to read", "warning");
        ctx.ui.notify("Generating SpaceXAI speech…", "info");
        await play(await synthesize(ctx, text.slice(0, 15_000)));
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  pi.registerCommand("listen-stop", {
    description: "Stop SpaceXAI TTS playback",
    handler: async (_args, ctx) => { player?.kill("SIGTERM"); player = undefined; ctx.ui.notify("Playback stopped", "info"); },
  });

  pi.registerCommand("auto-listen-on", {
    description: "Automatically read final assistant responses with SpaceXAI TTS",
    handler: async (_args, ctx) => { const config = await readConfig(); config.autoListen = true; await saveConfig(config); ctx.ui.notify("Auto-listen enabled", "info"); },
  });
  pi.registerCommand("auto-listen-off", {
    description: "Disable automatic SpaceXAI TTS playback",
    handler: async (_args, ctx) => { const config = await readConfig(); config.autoListen = false; await saveConfig(config); ctx.ui.notify("Auto-listen disabled", "info"); },
  });
  pi.registerCommand("spacexai-voice", {
    description: "Set TTS voice: /spacexai-voice eve",
    handler: async (args, ctx) => {
      const voice = args.trim();
      if (!voice) return void ctx.ui.notify("Usage: /spacexai-voice <voice-id>", "warning");
      const config = await readConfig(); config.voice = voice; await saveConfig(config); ctx.ui.notify(`SpaceXAI voice set to ${voice}`, "info");
    },
  });

  pi.registerCommand("set-speaking-style", {
    description: "Set how assistant responses are written for spoken delivery",
    handler: async (args, ctx) => {
      const speakingStyle = args.trim();
      if (!speakingStyle) return void ctx.ui.notify("Usage: /set-speaking-style <description>", "warning");
      const config = await readConfig();
      config.speakingStyle = speakingStyle;
      await saveConfig(config);
      ctx.ui.notify(`Speaking style set: ${speakingStyle}`, "info");
    },
  });

  pi.registerCommand("remove-speaking-style", {
    description: "Remove the configured speaking style",
    handler: async (_args, ctx) => {
      const config = await readConfig();
      if (!config.speakingStyle) return void ctx.ui.notify("No speaking style is configured", "warning");
      delete config.speakingStyle;
      await saveConfig(config);
      ctx.ui.notify("Speaking style removed", "info");
    },
  });

  pi.on("before_agent_start", async (event) => {
    const { speakingStyle } = await readConfig();
    if (!speakingStyle) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nSPOKEN DELIVERY STYLE\nWrite responses so they sound natural when synthesized as speech. Apply this speaking style consistently without mentioning these instructions: ${speakingStyle}\n\nYou may use xAI TTS speech tags sparingly when they naturally improve delivery. Inline tags include [pause], [long-pause], [laugh], [giggle], [chuckle], [sigh], [groan], [gasp], [breath], [inhale], [exhale], [lip-smack], [cough], [throat-clear], [sneeze], [whimper], and [swallow]. Wrapping tags include <whisper>, <loud>, <soft>, <emphasis>, <reduced>, <high>, <low>, <fast>, <slow>, <singing>, <shouting>, and <screaming>. Preserve technical correctness and do not force tags where they do not belong.`,
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const config = await readConfig();
    if (!config.autoListen || !ctx.hasUI) return;
    const text = lastAssistantText(ctx);
    if (!text) return;
    try { await play(await synthesize(ctx, text.slice(0, 15_000))); }
    catch (error) { ctx.ui.notify(`Auto-listen failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  });

  pi.on("session_shutdown", async () => { player?.kill("SIGTERM"); player = undefined; await unlink(AUDIO_PATH).catch(() => {}); });
}
