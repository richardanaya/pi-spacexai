import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	isKeyRelease,
	isKittyProtocolActive,
	matchesKey,
	type Component,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { registerRealtimeVoice } from "./realtime-voice.ts";

const execAsync = promisify(exec);
/** Built-in pi provider id for xAI (OAuth subscription or API key). */
const PROVIDER = "xai";
const API_BASE = "https://api.x.ai/v1";
const STT_WS_BASE = "wss://api.x.ai/v1/stt";
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const CONFIG_PATH = join(homedir(), ".pi", "spacexai.json");
const AUDIO_PATH = join(homedir(), ".pi", "spacexai-tts.mp3");
const MAX_RECORDING_MS = 5 * 60 * 1000;
const STT_SAMPLE_RATE = 16_000;
/** 100 ms of mono PCM16 @ 16 kHz — xAI's recommended streaming chunk size. */
const STT_CHUNK_BYTES = (STT_SAMPLE_RATE * 2) / 10;

interface Config {
	voice?: string;
	language?: string;
	speed?: number;
	autoListen?: boolean;
	speakingStyle?: string;
}

interface StoredCredential {
	type?: string;
	access?: string;
	refresh?: string;
	key?: string;
	expires?: number;
}

/** True when pi has xAI OAuth (or API-key) credentials in auth.json. */
function hasXaiCredentials(): boolean {
	try {
		// Sync read at load time: tools only register when auth already exists.
		const data = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
			string,
			StoredCredential
		>;
		const cred = data[PROVIDER];
		if (!cred) return false;
		if (
			cred.type === "oauth" &&
			typeof cred.access === "string" &&
			cred.access.length > 0
		)
			return true;
		if (
			cred.type === "api_key" &&
			typeof cred.key === "string" &&
			cred.key.length > 0
		)
			return true;
		// Legacy / partial shapes
		if (typeof cred.access === "string" && cred.access.length > 0) return true;
		if (typeof cred.key === "string" && cred.key.length > 0) return true;
		return false;
	} catch {
		return false;
	}
}

async function readConfig(): Promise<Config> {
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
	} catch {
		return {};
	}
}

async function saveConfig(config: Config): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
}

async function commandExists(cmd: string): Promise<boolean> {
	try {
		await execAsync(`which ${cmd}`);
		return true;
	} catch {
		return false;
	}
}

async function parseError(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const data = JSON.parse(text) as {
			error?: string | { message?: string };
			error_description?: string;
		};
		return typeof data.error === "string"
			? `${data.error}: ${data.error_description ?? ""}`.trim()
			: (data.error?.message ?? text);
	} catch {
		return text;
	}
}

function assistantText(message: {
	role?: string;
	content?: unknown;
}): string | undefined {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
	const parts: string[] = [];
	for (const part of message.content as Array<{
		type?: string;
		text?: string;
	}>) {
		if (part?.type === "text" && typeof part.text === "string")
			parts.push(part.text);
	}
	const text = parts.join("\n").trim();
	return text || undefined;
}

/** Type.Literal via .map(Type.Literal) loses generics; wrap values explicitly. */
function literalUnion<const T extends readonly (string | number)[]>(values: T) {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

function exactlyOneDefined(a: unknown, b: unknown): boolean {
	return Boolean(a) !== Boolean(b);
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

/** Resolve a live xAI token via pi (refreshes OAuth when needed). */
async function bearer(ctx: ExtensionContext): Promise<string> {
	const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
	if (!token) {
		throw new Error(
			"Not authenticated with xAI. Run /login xai (subscription OAuth or API key).",
		);
	}
	return token;
}

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".opus": "audio/opus",
	".flac": "audio/flac",
	".aac": "audio/aac",
	".m4a": "audio/mp4",
	".mkv": "video/x-matroska",
};
function localPath(ctx: ExtensionContext, value: string): string {
	return resolve(ctx.cwd, value.replace(/^@/, ""));
}
async function mediaRef(ctx: ExtensionContext, value: string): Promise<string> {
	if (/^(https?:|data:|file_)/i.test(value)) return value;
	const path = localPath(ctx, value);
	const data = await readFile(path);
	const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
	return `data:${mime};base64,${data.toString("base64")}`;
}
async function api(
	ctx: ExtensionContext,
	path: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Response> {
	if (signal?.aborted) throw new Error("Cancelled");
	const response = await fetch(`${API_BASE}${path}`, {
		...init,
		signal,
		headers: {
			Authorization: `Bearer ${await bearer(ctx)}`,
			...(init.headers ?? {}),
		},
	});
	if (!response.ok)
		throw new Error(
			`SpaceXAI request failed (${response.status}): ${await parseError(response)}`,
		);
	return response;
}
async function jsonPost(
	ctx: ExtensionContext,
	path: string,
	body: any,
	signal?: AbortSignal,
): Promise<any> {
	return api(
		ctx,
		path,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		signal,
	).then((r) => r.json());
}
async function saveRemote(
	url: string,
	path: string,
	signal?: AbortSignal,
): Promise<number> {
	const response = await fetch(url, { signal });
	if (!response.ok)
		throw new Error(
			`Media download failed (${response.status}): ${await response.text()}`,
		);
	const data = Buffer.from(await response.arrayBuffer());
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, data);
	return data.length;
}
async function imageResult(
	ctx: ExtensionContext,
	data: any,
	outputPath: string,
	signal?: AbortSignal,
) {
	const items = data.data ?? [];
	const base = localPath(ctx, outputPath);
	const saved = await Promise.all(
		items.map(async (item: { b64_json?: string; url?: string }, i: number) => {
			const path =
				items.length === 1
					? base
					: join(
							dirname(base),
							`${base.slice(base.lastIndexOf("/") + 1, base.lastIndexOf(".")) || "image"}-${i + 1}${extname(base) || ".png"}`,
						);
			await mkdir(dirname(path), { recursive: true });
			if (item.b64_json)
				await writeFile(path, Buffer.from(item.b64_json, "base64"));
			else if (item.url) await saveRemote(item.url, path, signal);
			else throw new Error(`Image ${i + 1} contained no downloadable content`);
			return path;
		}),
	);
	const summary = `Saved ${saved.length} image(s): ${saved.join(", ")}`;
	return {
		content: [{ type: "text" as const, text: summary || "No images returned" }],
		details: { ...data, saved },
	};
}

async function saveVideoJob(
	ctx: ExtensionContext,
	requestId: string,
	outputPath: string,
	signal?: AbortSignal,
): Promise<any> {
	const poll = async (): Promise<any> => {
		if (signal?.aborted) throw new Error("Cancelled");
		const data: any = await api(
			ctx,
			`/videos/${encodeURIComponent(requestId)}`,
			{},
			signal,
		).then((response) => response.json());
		if (data.status === "done") {
			if (!data.video?.url)
				throw new Error("Completed video job returned no download URL");
			const saved = localPath(ctx, outputPath);
			const bytes = await saveRemote(data.video.url, saved, signal);
			return {
				content: [
					{ type: "text" as const, text: `Video done; saved to ${saved}` },
				],
				details: { ...data, saved, bytes },
			};
		}
		if (data.status === "failed" || data.status === "expired") {
			throw new Error(
				`Video ${data.status}: ${data.error?.code ?? "error"}: ${data.error?.message ?? "unknown error"}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 5000));
		return poll();
	};
	return poll();
}

async function synthesize(
	ctx: ExtensionContext,
	text: string,
	overrides: Partial<Config> = {},
): Promise<Buffer> {
	if (!text.trim()) throw new Error("Text must not be empty");
	if (text.length > 15_000)
		throw new Error("SpaceXAI TTS accepts at most 15,000 characters");
	const config = { ...(await readConfig()), ...overrides };
	const response = await fetch(`${API_BASE}/tts`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await bearer(ctx)}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			text,
			voice_id: config.voice ?? "leo",
			language: config.language ?? "en",
			speed: config.speed ?? 1,
			output_format: { codec: "mp3", sample_rate: 24_000, bit_rate: 128_000 },
		}),
	});
	if (!response.ok)
		throw new Error(
			`SpaceXAI TTS failed (${response.status}): ${await parseError(response)}`,
		);
	return Buffer.from(await response.arrayBuffer());
}

let player: ChildProcess | undefined;
async function play(audio: Buffer): Promise<void> {
	await mkdir(dirname(AUDIO_PATH), { recursive: true });
	await writeFile(AUDIO_PATH, audio, { mode: 0o600 });
	player?.kill("SIGTERM");
	player = spawn(
		"ffplay",
		["-nodisp", "-autoexit", "-loglevel", "quiet", AUDIO_PATH],
		{ stdio: "ignore" },
	);
	await new Promise<void>((resolve, reject) => {
		player!.once("error", reject);
		player!.once("exit", (code) =>
			code === 0 || code === null
				? resolve()
				: reject(new Error(`ffplay exited with code ${code}`)),
		);
	});
	player = undefined;
	await unlink(AUDIO_PATH).catch(() => {});
}

export default function spacexai(pi: ExtensionAPI) {
	// pi now owns the xAI OAuth provider. This extension only layers media/speech UX
	// on top, and stays inert unless ~/.pi/agent/auth.json already has xai credentials.
	if (!hasXaiCredentials()) {
		return;
	}

	// xAI Responses executes these tools server-side. They are distinct from pi's
	// client-side function tools and can coexist in the same request.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		if (!event.payload || typeof event.payload !== "object") return;
		const payload = event.payload as Record<string, unknown>;
		const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
		const existingTypes = new Set(
			tools
				.filter(
					(tool): tool is Record<string, unknown> =>
						!!tool && typeof tool === "object",
				)
				.map((tool) => tool.type)
				.filter((type): type is string => typeof type === "string"),
		);
		for (const type of ["web_search", "x_search", "code_interpreter"]) {
			if (!existingTypes.has(type)) tools.push({ type });
		}
		return { ...payload, tools };
	});

	const aspectImage = literalUnion([
		"1:1",
		"16:9",
		"9:16",
		"4:3",
		"3:4",
		"3:2",
		"2:3",
		"2:1",
		"1:2",
		"19.5:9",
		"9:19.5",
		"20:9",
		"9:20",
		"auto",
	] as const);
	const aspectVideo = literalUnion([
		"1:1",
		"16:9",
		"9:16",
		"4:3",
		"3:4",
		"3:2",
		"2:3",
	] as const);
	const imageCommon = {
		model: Type.String({
			description:
				"grok-imagine-image, grok-imagine-image-quality (aliases: grok-imagine-image-pro, *-latest), or grok-imagine-image-2.0",
		}),
		prompt: Type.String(),
		aspect_ratio: Type.Optional(aspectImage),
		resolution: Type.Optional(
			Type.Union([Type.Literal("1k"), Type.Literal("2k")]),
		),
		quality: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium")], {
				description:
					"Quality preset; only supported for grok-imagine-image-2.0 (defaults to medium)",
			}),
		),
		response_format: Type.Optional(
			Type.Union([Type.Literal("url"), Type.Literal("b64_json")]),
		),
		storage_options: Type.Optional(
			Type.Object(
				{
					filename: Type.String({
						description: "Required when storage_options is present",
					}),
					expires_after: Type.Optional(
						Type.Integer({
							minimum: 3600,
							maximum: 2592000,
							description: "Expiry in seconds (1 hour to 30 days)",
						}),
					),
					public_url: Type.Optional(
						Type.Union([
							Type.Boolean(),
							Type.Object({
								expires_after: Type.Optional(
									Type.Integer({
										minimum: 3600,
										maximum: 2592000,
									}),
								),
							}),
						]),
					),
				},
				{ description: "Optional storage configuration for generated files" },
			),
		),
		outputPath: Type.String({
			description: "Required destination filename; numbered when n > 1",
		}),
	};
	async function imageInputRef(
		ctx: ExtensionContext,
		value: string,
	): Promise<{ file_id: string } | { url: string; type: string }> {
		if (/^file_/i.test(value)) {
			return { file_id: value };
		}
		return { url: await mediaRef(ctx, value), type: "image_url" };
	}
	pi.registerTool({
		name: "image_gen",
		label: "Grok Imagine Image Generation",
		description: "Grok Imagine: generate images with all REST options.",
		parameters: Type.Object({
			...imageCommon,
			n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const { outputPath, ...body } = p;
			return imageResult(
				ctx,
				await jsonPost(ctx, "/images/generations", body, signal),
				outputPath,
				signal,
			);
		},
	});
	pi.registerTool({
		name: "image_edit",
		label: "Grok Imagine Image Edit",
		description:
			"Grok Imagine: edit one or up to five images (grok-imagine-image-2.0 supports up to 5; older models may reject >3). Inputs may be URLs, file IDs, data URIs, or local paths.",
		parameters: Type.Object({
			...imageCommon,
			image: Type.Optional(Type.String()),
			images: Type.Optional(
				Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
			),
		}),
		async execute(_id, p, signal, _u, ctx) {
			if (!exactlyOneDefined(p.image, p.images))
				throw new Error("Provide exactly one of image or images");
			const { outputPath, image, images, ...rest } = p;
			const body: Record<string, unknown> = { ...rest };
			if (image) body.image = await imageInputRef(ctx, image);
			if (images)
				body.images = await Promise.all(
					images.map(async (x: string) => await imageInputRef(ctx, x)),
				);
			return imageResult(
				ctx,
				await jsonPost(ctx, "/images/edits", body, signal),
				outputPath,
				signal,
			);
		},
	});

	const videoCommon = {
		model: Type.String({ description: "grok-imagine-video" }),
		prompt: Type.String(),
		duration: Type.Optional(Type.Number()),
		aspect_ratio: Type.Optional(aspectVideo),
		resolution: Type.Optional(
			Type.Union([
				Type.Literal("480p"),
				Type.Literal("720p"),
				Type.Literal("1080p"),
			]),
		),
	};
	// Split to match grok-build tool names: image_to_video (single source frame) vs reference_to_video (multi-ref).
	pi.registerTool({
		name: "image_to_video",
		label: "Grok Imagine Image-to-Video",
		description:
			"Grok Imagine: animate a single source image into a video. The image becomes frame 1. Local media is converted to data URIs.",
		parameters: Type.Object({
			model: Type.String({ description: "grok-imagine-video" }),
			image: Type.String({
				description:
					"Source image to animate (URL, data URI, file ID, or local path)",
			}),
			prompt: Type.Optional(
				Type.String({ description: "Optional animation guidance" }),
			),
			duration: Type.Optional(Type.Number({ minimum: 1, maximum: 15 })),
			resolution: Type.Optional(
				Type.Union([
					Type.Literal("480p"),
					Type.Literal("720p"),
					Type.Literal("1080p"),
				]),
			),
			outputPath: Type.String({
				description: "Required destination video filename",
			}),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const { image, outputPath, prompt, ...rest } = p;
			const body: any = {
				...rest,
				prompt: prompt ?? "",
				image: { url: await mediaRef(ctx, image) },
			};
			const data = await jsonPost(ctx, "/videos/generations", body, signal);
			return saveVideoJob(ctx, data.request_id, outputPath, signal);
		},
	});
	pi.registerTool({
		name: "reference_to_video",
		label: "Grok Imagine Reference-to-Video",
		description:
			"Grok Imagine: generate a video from multiple reference images guided by a text prompt. Local media is converted to data URIs.",
		parameters: Type.Object({
			model: Type.String({ description: "grok-imagine-video" }),
			prompt: Type.String(),
			reference_images: Type.Array(Type.String(), { minItems: 2, maxItems: 7 }),
			duration: Type.Optional(Type.Number({ minimum: 1, maximum: 15 })),
			aspect_ratio: Type.Optional(aspectVideo),
			resolution: Type.Optional(
				Type.Union([
					Type.Literal("480p"),
					Type.Literal("720p"),
					Type.Literal("1080p"),
				]),
			),
			outputPath: Type.String({
				description: "Required destination video filename",
			}),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const { reference_images, outputPath, ...rest } = p;
			const body: any = {
				...rest,
				reference_images: await Promise.all(
					reference_images.map(async (x: string) => ({
						url: await mediaRef(ctx, x),
					})),
				),
			};
			const data = await jsonPost(ctx, "/videos/generations", body, signal);
			return saveVideoJob(ctx, data.request_id, outputPath, signal);
		},
	});
	pi.registerTool({
		name: "video_edit",
		label: "Grok Imagine Video Edit",
		description:
			"Grok Imagine: edit a video. Geometry options are accepted by REST but ignored by the service.",
		parameters: Type.Object({
			...videoCommon,
			video: Type.String(),
			outputPath: Type.String({
				description: "Required destination video filename",
			}),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const { outputPath, ...body } = p;
			const data = await jsonPost(
				ctx,
				"/videos/edits",
				{ ...body, video: { url: await mediaRef(ctx, p.video) } },
				signal,
			);
			return saveVideoJob(ctx, data.request_id, outputPath, signal);
		},
	});
	pi.registerTool({
		name: "video_extend",
		label: "Grok Imagine Video Extension",
		description: "Grok Imagine: extend a video by 2–10 seconds.",
		parameters: Type.Object({
			model: Type.String({ description: "grok-imagine-video" }),
			prompt: Type.String(),
			video: Type.String(),
			duration: Type.Optional(Type.Number({ minimum: 2, maximum: 10 })),
			outputPath: Type.String({
				description: "Required destination video filename",
			}),
		}),
		async execute(_id, p, signal, _u, ctx) {
			const { outputPath, ...body } = p;
			const data = await jsonPost(
				ctx,
				"/videos/extensions",
				{ ...body, video: { url: await mediaRef(ctx, p.video) } },
				signal,
			);
			return saveVideoJob(ctx, data.request_id, outputPath, signal);
		},
	});

	pi.registerTool({
		name: "text_to_speech",
		label: "Text to Speech",
		description:
			"Synthesize speech with every REST option and save it to the required outputPath. This tool does not play audio.",
		promptSnippet: "Synthesize speech with text_to_speech",
		promptGuidelines: [
			"Use text_to_speech when the user asks to speak, narrate, or synthesize text.",
		],
		parameters: Type.Object({
			text: Type.String({ maxLength: 15000 }),
			language: Type.String({ description: "BCP-47 code or auto" }),
			voice_id: Type.Optional(Type.String()),
			speed: Type.Optional(Type.Number({ minimum: 0.7, maximum: 1.5 })),
			codec: Type.Optional(
				literalUnion(["mp3", "wav", "pcm", "mulaw", "alaw"] as const),
			),
			sample_rate: Type.Optional(
				literalUnion([8000, 16000, 22050, 24000, 44100, 48000] as const),
			),
			bit_rate: Type.Optional(
				literalUnion([32000, 64000, 96000, 128000, 192000] as const),
			),
			optimize_streaming_latency: Type.Optional(
				literalUnion([0, 1, 2] as const),
			),
			text_normalization: Type.Optional(Type.Boolean()),
			with_timestamps: Type.Optional(Type.Boolean()),
			outputPath: Type.String({
				description: "Required audio destination path, including filename",
			}),
			timestampsPath: Type.Optional(
				Type.String({ description: "Save the timestamp JSON envelope here" }),
			),
		}),
		async execute(_id, p, signal, _update, ctx) {
			const {
				outputPath,
				timestampsPath,
				codec,
				sample_rate,
				bit_rate,
				...fields
			} = p;
			const body: any = {
				...fields,
				output_format: {
					...(codec === undefined ? {} : { codec }),
					...(sample_rate === undefined ? {} : { sample_rate }),
					...(bit_rate === undefined ? {} : { bit_rate }),
				},
			};
			const response = await api(
				ctx,
				"/tts",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
				signal,
			);
			let audio: Buffer;
			let envelope: any;
			if (p.with_timestamps) {
				envelope = await response.json();
				audio = Buffer.from(envelope.audio, "base64");
			} else audio = Buffer.from(await response.arrayBuffer());
			const path = localPath(ctx, outputPath);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, audio);
			if (timestampsPath && envelope) {
				const tp = localPath(ctx, timestampsPath);
				await mkdir(dirname(tp), { recursive: true });
				await writeFile(tp, JSON.stringify(envelope, null, 2));
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Saved speech to ${path}${envelope ? ` (${envelope.duration}s, timestamps included)` : ""}`,
					},
				],
				details: {
					path,
					bytes: audio.length,
					...(envelope
						? {
								duration: envelope.duration,
								content_type: envelope.content_type,
								audio_timestamps: envelope.audio_timestamps,
							}
						: {}),
				},
			};
		},
	});

	pi.registerTool({
		name: "speech_to_text",
		label: "Speech to Text",
		description:
			"Transcribe a local audio file or URL with every documented multipart REST option.",
		parameters: Type.Object({
			file: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			audio_format: Type.Optional(
				literalUnion(["pcm", "mulaw", "alaw"] as const),
			),
			sample_rate: Type.Optional(Type.Integer()),
			language: Type.Optional(Type.String()),
			format: Type.Optional(Type.Boolean()),
			multichannel: Type.Optional(Type.Boolean()),
			channels: Type.Optional(Type.Integer({ minimum: 2, maximum: 8 })),
			diarize: Type.Optional(Type.Boolean()),
			keyterm: Type.Optional(
				Type.Array(Type.String({ maxLength: 50 }), { maxItems: 100 }),
			),
			filler_words: Type.Optional(Type.Boolean()),
			outputPath: Type.Optional(
				Type.String({ description: "Save full transcript JSON" }),
			),
		}),
		async execute(_id, p, signal, _u, ctx) {
			if (!exactlyOneDefined(p.file, p.url))
				throw new Error("Provide exactly one of file or url");
			const form = new FormData();
			for (const [key, value] of Object.entries(p)) {
				if (key === "file" || key === "outputPath" || value === undefined)
					continue;
				if (key === "keyterm")
					for (const term of value as string[]) form.append("keyterm", term);
				else form.append(key, String(value));
			}
			if (p.file) {
				const path = localPath(ctx, p.file);
				const bytes = await readFile(path);
				form.append(
					"file",
					new Blob([bytes], {
						type:
							MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
					}),
					path.slice(path.lastIndexOf("/") + 1),
				);
			}
			const data: any = await api(
				ctx,
				"/stt",
				{ method: "POST", body: form },
				signal,
			).then((r) => r.json());
			let saved;
			if (p.outputPath) {
				saved = localPath(ctx, p.outputPath);
				await mkdir(dirname(saved), { recursive: true });
				await writeFile(saved, JSON.stringify(data, null, 2));
			}
			return {
				content: [
					{
						type: "text",
						text: `${data.text ?? "Transcription complete"}${saved ? `\nSaved full result to ${saved}` : ""}`,
					},
				],
				details: { ...data, saved },
			};
		},
	});

	pi.registerTool({
		name: "list_speech_voices",
		label: "List Speech Voices",
		description: "List voices available for text-to-speech.",
		promptSnippet: "List available speech voices",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _update, ctx) {
			const response = await fetch(`${API_BASE}/tts/voices`, {
				headers: { Authorization: `Bearer ${await bearer(ctx)}` },
				signal,
			});
			if (!response.ok)
				throw new Error(
					`Could not list SpaceXAI voices (${response.status}): ${await parseError(response)}`,
				);
			const data = await response.json();
			return {
				content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				details: data,
			};
		},
	});

	pi.registerCommand("listen", {
		description: "Read the last assistant response with SpaceXAI TTS",
		handler: async (_args, ctx) => {
			try {
				const text = lastAssistantText(ctx);
				if (!text)
					return void ctx.ui.notify("No assistant response to read", "warning");
				ctx.ui.notify("Generating SpaceXAI speech…", "info");
				await play(await synthesize(ctx, text.slice(0, 15_000)));
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	pi.registerCommand("listen-stop", {
		description: "Stop SpaceXAI TTS playback",
		handler: async (_args, ctx) => {
			player?.kill("SIGTERM");
			player = undefined;
			ctx.ui.notify("Playback stopped", "info");
		},
	});

	pi.registerCommand("auto-listen-on", {
		description:
			"Automatically read final assistant responses with SpaceXAI TTS",
		handler: async (_args, ctx) => {
			const config = await readConfig();
			config.autoListen = true;
			await saveConfig(config);
			ctx.ui.notify("Auto-listen enabled", "info");
		},
	});
	pi.registerCommand("auto-listen-off", {
		description: "Disable automatic SpaceXAI TTS playback",
		handler: async (_args, ctx) => {
			const config = await readConfig();
			config.autoListen = false;
			await saveConfig(config);
			ctx.ui.notify("Auto-listen disabled", "info");
		},
	});
	pi.registerCommand("spacexai-voice", {
		description: "Set TTS voice: /spacexai-voice eve",
		handler: async (args, ctx) => {
			const voice = args.trim();
			if (!voice)
				return void ctx.ui.notify(
					"Usage: /spacexai-voice <voice-id>",
					"warning",
				);
			const config = await readConfig();
			config.voice = voice;
			await saveConfig(config);
			ctx.ui.notify(`SpaceXAI voice set to ${voice}`, "info");
		},
	});

	pi.registerCommand("set-speaking-style", {
		description: "Set how assistant responses are written for spoken delivery",
		handler: async (args, ctx) => {
			const speakingStyle = args.trim();
			if (!speakingStyle)
				return void ctx.ui.notify(
					"Usage: /set-speaking-style <description>",
					"warning",
				);
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
			if (!config.speakingStyle)
				return void ctx.ui.notify("No speaking style is configured", "warning");
			delete config.speakingStyle;
			await saveConfig(config);
			ctx.ui.notify("Speaking style removed", "info");
		},
	});

	// Browser speech-to-speech observer bridged to this coding session.
	registerRealtimeVoice(pi, {
		getToken: (ctx) => bearer(ctx as ExtensionContext),
		readVoice: async () => (await readConfig()).voice,
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
		try {
			await play(await synthesize(ctx, text.slice(0, 15_000)));
		} catch (error) {
			ctx.ui.notify(
				`Auto-listen failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});

	// Ctrl+Space push-to-talk: hold to stream mic → wss://api.x.ai/v1/stt, release to insert into editor.
	// Requires Kitty keyboard protocol (key-release events). No toggle fallback.
	let pttBusy = false;
	let pttRecorder: ChildProcess | null = null;
	let pttWs: WebSocket | null = null;
	let pttTimeout: ReturnType<typeof setTimeout> | null = null;
	const PTT_STATUS_KEY = "spacexai-ptt";

	function setPttStatus(
		ctx: ExtensionContext,
		label: string | undefined,
	): void {
		if (!ctx.hasUI) return;
		if (!label) {
			ctx.ui.setStatus(PTT_STATUS_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		// Bright error red so "recording" is unmistakable in the footer.
		ctx.ui.setStatus(PTT_STATUS_KEY, theme.fg("error", label));
	}

	function waitForExit(proc: ChildProcess, ms: number): Promise<void> {
		return new Promise((resolve) => {
			if (proc.exitCode !== null || proc.killed) return resolve();
			const timer = setTimeout(resolve, ms);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	async function stopPttRecorder(): Promise<void> {
		const proc = pttRecorder;
		pttRecorder = null;
		if (!proc || proc.exitCode !== null) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
		await waitForExit(proc, 800);
		if (proc.exitCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			await waitForExit(proc, 300);
		}
	}

	function isSpaceKeyRelease(data: string): boolean {
		if (!isKeyRelease(data)) return false;
		// Release may arrive as space, ctrl+space, or other modifier+space depending on release order.
		return (
			matchesKey(data, "space") ||
			matchesKey(data, "ctrl+space") ||
			matchesKey(data, "shift+space") ||
			matchesKey(data, "ctrl+shift+space") ||
			matchesKey(data, "alt+space")
		);
	}

	function buildSttWsUrl(language: string): string {
		let url: URL;
		try {
			url = new URL(STT_WS_BASE);
		} catch (error) {
			throw new Error(
				`Invalid STT websocket base URL: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		url.searchParams.set("sample_rate", String(STT_SAMPLE_RATE));
		url.searchParams.set("encoding", "pcm");
		url.searchParams.set("interim_results", "true");
		url.searchParams.set("language", language);
		// PTT finalizes explicitly on release; keep endpointing short for chunk finals while held.
		url.searchParams.set("endpointing", "300");
		return url.toString();
	}

	async function pickPcmRecorder(): Promise<{
		cmd: string;
		args: string[];
	} | null> {
		const hasArecord = await commandExists("arecord");
		const hasFfmpeg = await commandExists("ffmpeg");
		// Raw PCM to stdout — no container headers. arecord first on Linux; ffmpeg elsewhere.
		if (hasArecord && process.platform === "linux") {
			return {
				cmd: "arecord",
				args: [
					"-f",
					"S16_LE",
					"-r",
					String(STT_SAMPLE_RATE),
					"-c",
					"1",
					"-t",
					"raw",
					"-q",
					"-",
				],
			};
		}
		if (hasFfmpeg) {
			const input =
				process.platform === "darwin"
					? ["-f", "avfoundation", "-i", ":0"]
					: process.platform === "linux"
						? ["-f", "alsa", "-i", "default"]
						: ["-f", "dshow", "-i", "audio=default"];
			return {
				cmd: "ffmpeg",
				args: [
					...input,
					"-ar",
					String(STT_SAMPLE_RATE),
					"-ac",
					"1",
					"-f",
					"s16le",
					"-acodec",
					"pcm_s16le",
					"-loglevel",
					"error",
					"pipe:1",
				],
			};
		}
		if (hasArecord) {
			return {
				cmd: "arecord",
				args: [
					"-f",
					"S16_LE",
					"-r",
					String(STT_SAMPLE_RATE),
					"-c",
					"1",
					"-t",
					"raw",
					"-q",
					"-",
				],
			};
		}
		return null;
	}

	function openSttSocket(
		token: string,
		language: string,
		opts?: { signal?: AbortSignal },
	): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			if (opts?.signal?.aborted) {
				reject(new Error("Cancelled"));
				return;
			}
			const ws = new WebSocket(buildSttWsUrl(language), {
				headers: { Authorization: `Bearer ${token}` },
			} as any);

			const timer = setTimeout(() => {
				cleanup();
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(
					new Error("STT WebSocket timed out waiting for transcript.created"),
				);
			}, 15_000);

			const onAbort = () => {
				cleanup();
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(new Error("Cancelled"));
			};

			const onError = (err: Event) => {
				cleanup();
				reject(
					err instanceof ErrorEvent && err.message
						? new Error(err.message)
						: new Error("STT WebSocket connection failed"),
				);
			};

			const onMessage = (event: MessageEvent) => {
				try {
					const msg = JSON.parse(String(event.data)) as {
						type?: string;
						message?: string;
					};
					if (msg.type === "transcript.created") {
						cleanup();
						resolve(ws);
						return;
					}
					if (msg.type === "error") {
						cleanup();
						try {
							ws.close();
						} catch {
							/* ignore */
						}
						reject(
							new Error(msg.message ?? "STT WebSocket error during handshake"),
						);
					}
				} catch {
					// ignore non-JSON during handshake
				}
			};

			const cleanup = () => {
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				ws.removeEventListener("error", onError);
				ws.removeEventListener("message", onMessage);
			};

			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			ws.addEventListener("error", onError);
			ws.addEventListener("message", onMessage);
		});
	}

	type PttOutcome = "stop" | "cancel" | "timeout";

	interface LiveTranscript {
		/** Completed utterances (each speech_final). Never wiped mid-hold. */
		committed: string[];
		/** Best locked text for the open utterance (from chunk finals). */
		currentFinal: string;
		/** Unstable partial for the open utterance. */
		interim: string;
		status: string;
		/** True once the mic process is up and PCM is flowing (or ready). */
		recording: boolean;
		/** ms epoch when recording became live; used for elapsed + pulse. */
		recordingStartedAt?: number;
		doneText?: string;
	}

	/** Merge two hypotheses for the same open utterance (cumulative vs append). */
	function mergeUtterance(prev: string, next: string): string {
		const p = prev.trim();
		const n = next.trim();
		if (!p) return n;
		if (!n) return p;
		if (p === n) return p;
		// Server sent a longer cumulative transcript for this utterance.
		if (n.startsWith(p)) return n;
		if (p.startsWith(n)) return p;
		if (n.includes(p) && n.length >= p.length) return n;
		if (p.includes(n) && p.length >= n.length) return p;
		// Overlap: end of prev matches start of next (chunk boundaries).
		const max = Math.min(p.length, n.length);
		for (let i = max; i >= 8; i--) {
			if (p.slice(-i) === n.slice(0, i))
				return `${p}${n.slice(i)}`.replace(/\s+/g, " ").trim();
		}
		// Word-boundary overlap
		const pWords = p.split(/\s+/);
		const nWords = n.split(/\s+/);
		for (let k = Math.min(pWords.length, nWords.length); k >= 1; k--) {
			if (pWords.slice(-k).join(" ") === nWords.slice(0, k).join(" ")) {
				return [...pWords, ...nWords.slice(k)].join(" ");
			}
		}
		return `${p} ${n}`;
	}

	function openUtteranceText(live: LiveTranscript): string {
		return mergeUtterance(live.currentFinal, live.interim);
	}

	function liveDisplayText(live: LiveTranscript): string {
		// Non-empty doneText wins; empty string is treated as "not set" because the
		// STT server often sends transcript.done with text:"".
		const done = (live.doneText ?? "").trim();
		if (done) return done;
		const parts = [...live.committed];
		const open = openUtteranceText(live);
		if (open) parts.push(open);
		return parts.join(" ").replace(/\s+/g, " ").trim();
	}

	// ANSI-aware width helpers so theme.fg() styling doesn't break the overlay box.
	const ANSI_RE = /\[[0-9;]*m/g;
	function stripAnsi(s: string): string {
		return s.replace(ANSI_RE, "");
	}
	function visibleLen(s: string): number {
		return stripAnsi(s).length;
	}
	/** Clip/pad to `cols` visible characters, preserving ANSI SGR codes. */
	function clipVisible(s: string, cols: number): string {
		if (cols <= 0) return "";
		const plain = stripAnsi(s);
		if (plain.length <= cols) {
			return s + " ".repeat(cols - plain.length);
		}
		// Take a suffix of the plain text, then rebuild with a leading ellipsis.
		// For styled preview we re-apply isn't perfect for mid-string codes; callers
		// should pass already-themed full lines (color wraps whole clipped segment).
		const keep = Math.max(0, cols - 1);
		const sliced = plain.slice(-keep);
		// Prefer returning themed ellipsis+suffix when input was a single color wrap:
		// detect if s is color+plain+reset by comparing strip.
		return `…${sliced}`;
	}

	function createPttOverlay(
		_tui: { requestRender: () => void },
		theme: {
			fg: (
				color:
					| "error"
					| "success"
					| "warning"
					| "muted"
					| "accent"
					| "border"
					| string,
				text: string,
			) => string;
		},
		live: LiveTranscript,
		done: (value: PttOutcome) => void,
	): Component {
		let finished = false;
		const finish = (value: PttOutcome) => {
			if (finished) return;
			finished = true;
			done(value);
		};

		return {
			wantsKeyRelease: true,
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, "escape")) {
					finish("cancel");
					return;
				}
				if (isSpaceKeyRelease(data)) {
					finish("stop");
				}
			},
			render(width: number) {
				const inner = Math.max(24, Math.min(width - 4, width - 4));
				const bar = "─".repeat(Math.max(0, Math.min(inner + 2, width - 2)));

				// Pulse the REC dot ~2 Hz while the mic is live so it's obvious recording started.
				const pulseOn =
					!live.recording || Math.floor(Date.now() / 500) % 2 === 0;
				const recDot = live.recording ? (pulseOn ? "●" : "○") : "○";
				const elapsedSec =
					live.recording && live.recordingStartedAt
						? Math.max(
								0,
								Math.floor((Date.now() - live.recordingStartedAt) / 1000),
							)
						: 0;
				const elapsed = live.recording
					? ` ${String(Math.floor(elapsedSec / 60)).padStart(2, "0")}:${String(elapsedSec % 60).padStart(2, "0")}`
					: "";
				const recPlain = live.recording
					? `${recDot} REC${elapsed}`
					: `${recDot} …`;
				const recBadge = live.recording
					? theme.fg("error", recPlain)
					: theme.fg("dim", recPlain);
				const sep = theme.fg("dim", " · ");
				const header =
					`🎤 ${recBadge}` +
					sep +
					theme.fg("muted", "release Ctrl+Space to insert") +
					sep +
					theme.fg("muted", "Esc cancel") +
					(live.status ? sep + theme.fg("dim", live.status) : "");

				// Live caption — readable text color; REC badge already signals "in progress".
				const text = liveDisplayText(live);
				const bodyPlainFull = text || (live.recording ? "(listening…)" : "");
				const bodyWindow =
					bodyPlainFull.length <= inner
						? bodyPlainFull
						: `…${bodyPlainFull.slice(-(inner - 1))}`;
				const bodyClipped =
					theme.fg("text", bodyWindow) +
					" ".repeat(Math.max(0, inner - bodyWindow.length));

				// Clip header by visible width; re-theme overflow so ANSI doesn't break columns.
				const headerPlain = stripAnsi(header);
				const headerClipped =
					headerPlain.length <= inner
						? header + " ".repeat(inner - headerPlain.length)
						: theme.fg("muted", `…${headerPlain.slice(-(inner - 1))}`);

				const border = (s: string) => theme.fg("borderAccent", s);
				const lines = [
					border(`┌${bar}┐`),
					`${border("│")} ${headerClipped} ${border("│")}`,
					`${border("│")} ${bodyClipped} ${border("│")}`,
					border(`└${bar}┘`),
				];
				return lines.map((line) => {
					// Safety: if terminal is narrower than expected, trim by visible width.
					if (visibleLen(line) <= width) return line;
					return clipVisible(line, width);
				});
			},
		};
	}

	async function runPushToTalk(ctx: ExtensionContext): Promise<void> {
		if (pttBusy || !ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Push-to-talk requires the interactive TUI.", "warning");
			return;
		}
		if (!isKittyProtocolActive()) {
			ctx.ui.notify(
				"Push-to-talk needs Kitty keyboard key-release support. Use a Kitty-protocol terminal (Kitty, Ghostty, WezTerm, recent iTerm2, etc.).",
				"error",
			);
			return;
		}

		const recorderSpec = await pickPcmRecorder();
		if (!recorderSpec) {
			ctx.ui.notify(
				"No audio recorder found. Install arecord or ffmpeg.",
				"error",
			);
			return;
		}

		pttBusy = true;
		const live: LiveTranscript = {
			committed: [],
			currentFinal: "",
			interim: "",
			status: "",
			recording: false,
		};
		let closeOverlay: ((value: PttOutcome) => void) | undefined;
		let renderTimer: ReturnType<typeof setInterval> | undefined;
		let bytesSent = 0;
		let pcmBuf = Buffer.alloc(0);
		let ws: WebSocket | undefined;
		let markedRecording = false;
		// Snapshot editor so we can stream live transcript in-place and restore on cancel.
		const editorBase = (ctx.ui.getEditorText?.() ?? "").trimEnd();
		let lastEditorPush = "";

		const pushLiveToEditor = () => {
			const spoken = liveDisplayText(live);
			const next = spoken
				? editorBase
					? `${editorBase} ${spoken}`
					: spoken
				: editorBase;
			if (next === lastEditorPush) return;
			lastEditorPush = next;
			try {
				ctx.ui.setEditorText(next);
			} catch {
				/* editor may be unavailable mid-teardown */
			}
		};

		const restoreEditor = () => {
			if (lastEditorPush === "") return;
			try {
				ctx.ui.setEditorText(editorBase);
			} catch {
				/* ignore */
			}
			lastEditorPush = editorBase;
		};

		const markRecordingLive = () => {
			if (markedRecording) return;
			markedRecording = true;
			live.recording = true;
			live.recordingStartedAt = Date.now();
			live.status = "recording";
			setPttStatus(ctx, "● REC");
		};

		const cleanupUi = () => {
			if (renderTimer) {
				clearInterval(renderTimer);
				renderTimer = undefined;
			}
			if (pttTimeout) {
				clearTimeout(pttTimeout);
				pttTimeout = null;
			}
			setPttStatus(ctx, undefined);
		};

		try {
			const token = await bearer(ctx);
			const config = await readConfig();
			const language = config.language ?? "en";

			// Open PTT overlay first so Kitty key-release events are delivered to a focused component.
			const overlayDone = ctx.ui.custom<PttOutcome>(
				(tui, theme, _kb, done) => {
					closeOverlay = (value) => {
						cleanupUi();
						done(value);
					};
					const component = createPttOverlay(
						tui,
						theme as never,
						live,
						(value) => closeOverlay?.(value),
					);
					renderTimer = setInterval(() => tui.requestRender(), 100);
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						maxHeight: 4,
						margin: 0,
					},
				},
			);

			pttTimeout = setTimeout(
				() => closeOverlay?.("timeout"),
				MAX_RECORDING_MS,
			);

			live.status = "";
			setPttStatus(ctx, undefined);
			// User may release/cancel while the socket is still handshaking.
			const connectAbort = new AbortController();
			type ConnectRace =
				| { kind: "ws"; socket: WebSocket }
				| { kind: "outcome"; outcome: PttOutcome };
			const raced: ConnectRace = await Promise.race([
				openSttSocket(token, language, { signal: connectAbort.signal }).then(
					(socket) => ({ kind: "ws" as const, socket }),
				),
				overlayDone.then((outcome) => {
					connectAbort.abort();
					return {
						kind: "outcome" as const,
						outcome: (outcome ?? "cancel") as PttOutcome,
					};
				}),
			]);
			if (raced.kind === "outcome") {
				cleanupUi();
				restoreEditor();
				ctx.ui.notify(
					raced.outcome === "timeout"
						? "Recording stopped — exceeded 5 minute limit. Message discarded."
						: raced.outcome === "cancel"
							? "Recording cancelled"
							: "Released before STT connected — try holding a moment longer",
					raced.outcome === "timeout" ? "warning" : "info",
				);
				return;
			}

			ws = raced.socket;
			pttWs = ws;
			live.status = "starting mic…";
			setPttStatus(ctx, "○ starting mic…");

			const onWsMessage = (event: MessageEvent) => {
				try {
					const msg = JSON.parse(String(event.data)) as {
						type?: string;
						text?: string;
						is_final?: boolean;
						speech_final?: boolean;
						message?: string;
					};
					if (msg.type === "transcript.partial") {
						const text = (msg.text ?? "").trim();
						if (msg.is_final) {
							// speech_final = end of utterance (silence / endpointing). Text is THAT
							// utterance only — commit it and keep prior committed utterances.
							// Previously we did finals = [text], which wiped everything said before
							// the latest pause (~endpointing ms), which felt like the start vanishing.
							// chunk final (is_final, !speech_final) = locked ~3s segment within the
							// open utterance; xAI may send cumulative or additive chunks.
							if (msg.speech_final) {
								const utterance = (text || openUtteranceText(live)).trim();
								if (utterance) {
									const last = live.committed[live.committed.length - 1];
									if (last !== utterance) live.committed.push(utterance);
								}
								live.currentFinal = "";
								live.interim = "";
							} else if (text) {
								live.currentFinal = mergeUtterance(live.currentFinal, text);
								live.interim = "";
							}
						} else {
							live.interim = text;
						}
						pushLiveToEditor();
					} else if (msg.type === "transcript.done") {
						// Server currently returns text:"" on transcript.done; never let empty
						// overwrite partials/finals accumulated during the stream (?? only skips nullish).
						const done = (msg.text ?? "").trim();
						live.doneText = done || liveDisplayText(live);
						live.status = "";
						pushLiveToEditor();
					} else if (msg.type === "error") {
						live.status = msg.message ?? "STT error";
					}
				} catch {
					// ignore
				}
			};
			ws.addEventListener("message", onWsMessage);

			const sendPcm = (chunk: Buffer) => {
				if (!ws || ws.readyState !== WebSocket.OPEN) return;
				try {
					ws.send(chunk);
					bytesSent += chunk.length;
				} catch {
					// socket may be closing
				}
			};

			pttRecorder = spawn(recorderSpec.cmd, recorderSpec.args, {
				stdio: ["ignore", "pipe", "ignore"],
			});
			pttRecorder.on("error", () => {
				live.status = "recorder failed";
				setPttStatus(ctx, undefined);
				closeOverlay?.("cancel");
			});
			// Spawn succeeded — treat as live immediately so the user gets feedback
			// even before the first PCM chunk (device open can lag a beat).
			if (pttRecorder.pid) markRecordingLive();
			pttRecorder.stdout?.on("data", (data: Buffer) => {
				markRecordingLive();
				pcmBuf = Buffer.concat([pcmBuf, data]);
				while (pcmBuf.length >= STT_CHUNK_BYTES) {
					const frame = pcmBuf.subarray(0, STT_CHUNK_BYTES);
					pcmBuf = pcmBuf.subarray(STT_CHUNK_BYTES);
					sendPcm(Buffer.from(frame));
				}
			});

			// Blocks until release (stop), Esc (cancel), or max-duration timeout.
			const outcome = (await overlayDone) ?? "cancel";
			cleanupUi();

			await stopPttRecorder();
			if (pcmBuf.length > 0) {
				sendPcm(pcmBuf);
				pcmBuf = Buffer.alloc(0);
			}

			if (outcome === "cancel" || outcome === "timeout") {
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				restoreEditor();
				ctx.ui.notify(
					outcome === "timeout"
						? "Recording stopped — exceeded 5 minute limit. Message discarded."
						: "Recording cancelled",
					outcome === "timeout" ? "warning" : "info",
				);
				return;
			}

			// Release → finalize current utterance, then flush remaining audio.
			live.recording = false;
			live.status = "";
			setPttStatus(ctx, undefined);
			if (ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(JSON.stringify({ type: "finalize" }));
					ws.send(JSON.stringify({ type: "audio.done" }));
				} catch {
					/* ignore */
				}
			}

			const finalText = await new Promise<string>((resolve) => {
				// Prefer non-empty doneText; empty string means server sent text:"" (known API quirk).
				const done = (live.doneText ?? "").trim();
				if (done) {
					resolve(done);
					return;
				}
				// If done already arrived empty, onWsMessage may have filled doneText from partials.
				if (live.doneText !== undefined) {
					resolve(liveDisplayText(live));
					return;
				}
				const deadline = setTimeout(
					() => resolve(liveDisplayText(live)),
					5_000,
				);
				const onFinal = (event: MessageEvent) => {
					try {
						const msg = JSON.parse(String(event.data)) as {
							type?: string;
							text?: string;
						};
						if (msg.type === "transcript.done") {
							clearTimeout(deadline);
							ws!.removeEventListener("message", onFinal);
							const t = (msg.text ?? "").trim();
							resolve(t || liveDisplayText(live));
						}
					} catch {
						/* ignore */
					}
				};
				ws!.addEventListener("message", onFinal);
			});

			try {
				ws.close();
			} catch {
				/* ignore */
			}

			const text = finalText.trim();
			if (!text) {
				restoreEditor();
				return;
			}

			// Final commit: base snapshot + finalized speech (drops stale interim).
			const next = editorBase ? `${editorBase} ${text}` : text;
			lastEditorPush = next;
			ctx.ui.setEditorText(next);
		} catch (error) {
			closeOverlay?.("cancel");
			restoreEditor();
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Voice input failed: ${message}`, "error");
		} finally {
			cleanupUi();
			await stopPttRecorder();
			if (pttWs) {
				try {
					pttWs.close();
				} catch {
					/* ignore */
				}
				pttWs = null;
			}
			pttBusy = false;
		}
	}

	pi.registerShortcut("ctrl+space", {
		description:
			"Push-to-talk voice input (hold Ctrl+Space, release to insert into editor). Also stops TTS if playing.",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			if (player) {
				player.kill("SIGTERM");
				player = undefined;
				ctx.ui.notify("Stopped listening", "info");
				return;
			}
			if (pttBusy) return; // key-repeat while held must not re-enter
			await runPushToTalk(ctx);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (pttTimeout) {
			clearTimeout(pttTimeout);
			pttTimeout = null;
		}
		await stopPttRecorder();
		if (pttWs) {
			try {
				pttWs.close();
			} catch {
				/* ignore */
			}
			pttWs = null;
		}
		pttBusy = false;
		setPttStatus(ctx, undefined);
		player?.kill("SIGTERM");
		player = undefined;
		await unlink(AUDIO_PATH).catch(() => {});
	});
}
