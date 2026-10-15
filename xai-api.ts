/**
 * Pure request builders for the xAI APIs this extension calls.
 * Kept separate from the pi extension so tests can check wire shapes
 * without loading the harness.
 */

export const DEFAULT_RESPONSES_MODEL = "grok-4.7";
/**
 * Speech-to-text model. grok-voice-3.0 is speech-to-speech only and is not
 * accepted on /v1/stt. grok-voice-transcribe-1.0 reached end of life on
 * October 2, 2026 and is no longer listed; those requests are rewritten to 2.0.
 */
export const STT_MODEL = "grok-voice-transcribe-2.0";
export const STT_WS_BASE = "wss://api.x.ai/v1/stt";
export const REALTIME_URL = "wss://api.x.ai/v1/realtime";
/** Flagship speech-to-speech model. grok-voice-latest currently aliases this. */
export const REALTIME_MODEL = "grok-voice-3.0";
/**
 * Models the realtime handshake still lists. grok-voice-2.0 is deprecated.
 * grok-voice-latest follows the current flagship.
 */
export const REALTIME_MODELS = [
	"grok-voice-3.0",
	"grok-voice-latest",
	"grok-voice-2.0",
] as const;
/** Input transcription model inside a speech-to-speech session. Not an STT slug. */
export const REALTIME_TRANSCRIBE_MODEL = "grok-transcribe";
export const IMAGE_MODEL_2 = "grok-imagine-image-2.0";
/**
 * Still a listed Imagine model ($0.05/image) until November 2, 2026.
 * grok-imagine-image-pro is an alias of this slug.
 */
export const IMAGE_MODEL_QUALITY = "grok-imagine-image-quality";
/** grok-imagine-video-1.5 accepts 14; grok-imagine-video still caps at 7. */
export const MAX_REFERENCE_IMAGES = 14;
export const MAX_X_HANDLES = 20;
export const MAX_WEB_DOMAINS = 5;

export const VIDEO_ASPECT_RATIOS = [
	"1:1",
	"16:9",
	"9:16",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"21:9",
	"5:2",
] as const;

/**
 * Chat Completions is function-calling only. These server-side tool types
 * belong on /v1/responses. live_search is the removed realtime-search parameter.
 */
export const COMPLETIONS_FORBIDDEN_TOOL_TYPES = new Set([
	"web_search",
	"x_search",
	"code_interpreter",
	"code_execution",
	"live_search",
	"image_generation",
	"file_search",
	"mcp",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function stripForbiddenCompletionsTools(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	if (!Array.isArray(payload.tools)) return payload;
	const tools = payload.tools.filter(
		(tool) =>
			!isRecord(tool) ||
			typeof tool.type !== "string" ||
			!COMPLETIONS_FORBIDDEN_TOOL_TYPES.has(tool.type),
	);
	return { ...payload, tools };
}

export function responsesSearchModel(
	model: { provider?: string; id?: string } | null | undefined,
): string {
	if (model?.provider === "xai" && model.id) return model.id;
	return DEFAULT_RESPONSES_MODEL;
}

export function buildWebSearchTool(options: {
	allowedDomains?: string[];
	excludedDomains?: string[];
	enableImageUnderstanding?: boolean;
	enableImageSearch?: boolean;
}): Record<string, unknown> {
	if (options.allowedDomains?.length && options.excludedDomains?.length) {
		throw new Error(
			"allowed_domains and excluded_domains cannot be set together",
		);
	}
	const tool: Record<string, unknown> = { type: "web_search" };
	const filters: Record<string, string[]> = {};
	if (options.allowedDomains?.length) {
		filters.allowed_domains = options.allowedDomains.slice(0, MAX_WEB_DOMAINS);
	}
	if (options.excludedDomains?.length) {
		filters.excluded_domains = options.excludedDomains.slice(0, MAX_WEB_DOMAINS);
	}
	if (Object.keys(filters).length) tool.filters = filters;
	if (options.enableImageUnderstanding) tool.enable_image_understanding = true;
	if (options.enableImageSearch) tool.enable_image_search = true;
	return tool;
}

export function buildXSearchTool(options: {
	fromDate?: string;
	toDate?: string;
	allowedHandles?: string[];
	excludedHandles?: string[];
	enableImageUnderstanding?: boolean;
	enableVideoUnderstanding?: boolean;
}): Record<string, unknown> {
	if (options.allowedHandles?.length && options.excludedHandles?.length) {
		throw new Error(
			"allowed_x_handles and excluded_x_handles cannot be set together",
		);
	}
	const tool: Record<string, unknown> = { type: "x_search" };
	if (options.fromDate) tool.from_date = options.fromDate;
	if (options.toDate) tool.to_date = options.toDate;
	const strip = (handles: string[]) =>
		handles.slice(0, MAX_X_HANDLES).map((handle) => handle.replace(/^@/, ""));
	if (options.allowedHandles?.length) {
		tool.allowed_x_handles = strip(options.allowedHandles);
	}
	if (options.excludedHandles?.length) {
		tool.excluded_x_handles = strip(options.excludedHandles);
	}
	if (options.enableImageUnderstanding) tool.enable_image_understanding = true;
	if (options.enableVideoUnderstanding) tool.enable_video_understanding = true;
	return tool;
}

export function buildAgentSearchBody(args: {
	model: string;
	query: string;
	tools: Record<string, unknown>[];
	maxTurns?: number;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: args.model,
		input: args.query,
		tools: args.tools,
		store: false,
		temperature: 0.1,
		max_output_tokens: 8192,
		// grok-4.7 defaults to high reasoning, which stalls a short search.
		reasoning: { effort: "low" },
	};
	if (args.maxTurns !== undefined) body.max_turns = args.maxTurns;
	return body;
}

/** Same shape Grok Build's WebSearchClient reads from /v1/responses. */
export function responsesOutputText(data: {
	output?: unknown;
	output_text?: unknown;
}): { text: string; citations: string[] } {
	const citations: string[] = [];
	const texts: string[] = [];
	const output = Array.isArray(data.output) ? data.output : [];
	for (const item of output) {
		if (!isRecord(item) || item.type !== "message") continue;
		const content = Array.isArray(item.content) ? item.content : [];
		for (const part of content) {
			if (!isRecord(part)) continue;
			if (part.type === "output_text" && typeof part.text === "string") {
				texts.push(part.text);
			}
			const anns = Array.isArray(part.annotations) ? part.annotations : [];
			for (const ann of anns) {
				if (isRecord(ann) && typeof ann.url === "string" && ann.url) {
					citations.push(ann.url);
				}
			}
		}
	}
	if (!texts.length && typeof data.output_text === "string") {
		texts.push(data.output_text);
	}
	return {
		text: texts.join("\n") || "No search results found.",
		citations: [...new Set(citations)],
	};
}

export function searchUsage(
	data: unknown,
): Record<string, unknown> | undefined {
	if (!isRecord(data) || !isRecord(data.usage)) return undefined;
	const details = data.usage.server_side_tool_usage_details;
	return isRecord(details) ? details : undefined;
}

export function normalizeImageRequest(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...body };
	const model = typeof next.model === "string" ? next.model : undefined;
	// quality (low | medium | auto) exists only on grok-imagine-image-2.0.
	// grok-imagine-image-quality is its own model until November 2, 2026.
	if (model && model !== IMAGE_MODEL_2 && next.quality !== undefined) {
		throw new Error(
			`quality is only supported on ${IMAGE_MODEL_2}. ${IMAGE_MODEL_QUALITY} is a separate model, and grok-imagine-image-pro is an alias of it.`,
		);
	}
	if (next.deferred === true && next.response_format === "b64_json") {
		throw new Error(
			'Deferred image requests only support response_format "url".',
		);
	}
	return next;
}

export function resolveSttModel(model?: string): string {
	if (!model || model === "grok-voice-transcribe-1.0") return STT_MODEL;
	return model;
}

export function resolveRealtimeModel(model?: string): string {
	const id = model?.trim();
	if (!id) return REALTIME_MODEL;
	if ((REALTIME_MODELS as readonly string[]).includes(id)) return id;
	throw new Error(
		`Unknown realtime model "${id}". Choose ${REALTIME_MODELS.join(", ")}.`,
	);
}

export function buildRealtimeUrl(model?: string, base = REALTIME_URL): string {
	let url: URL;
	try {
		url = new URL(base);
	} catch (error) {
		throw new Error(
			`Invalid realtime websocket URL: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	url.searchParams.set("model", resolveRealtimeModel(model));
	return url.toString();
}

/** Speech-to-speech function tools are flat. The nested Chat Completions shape is not the documented session schema. */
export function realtimeFunctionTool(tool: {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	};
}

/**
 * session.update for Grok Voice. The published parameters are
 * turn_detection.type and turn_detection.idle_timeout_ms. threshold and
 * silence_duration_ms are the OpenAI Realtime fields this client already
 * sends; Voice 3.0 documents the same API, so they stay.
 * Input transcription stays on grok-transcribe, which is separate from
 * grok-voice-3.0 and from grok-voice-transcribe-2.0.
 */
export function buildRealtimeSessionUpdate(input: {
	voice: string;
	instructions: string;
	sampleRate: number;
	tools: Record<string, unknown>[];
}): Record<string, unknown> {
	return {
		type: "session.update",
		session: {
			voice: input.voice,
			instructions: input.instructions,
			turn_detection: {
				type: "server_vad",
				threshold: 0.3,
				silence_duration_ms: 500,
			},
			audio: {
				input: {
					format: { type: "audio/pcm", rate: input.sampleRate },
					transcription: { model: REALTIME_TRANSCRIBE_MODEL },
				},
				output: { format: { type: "audio/pcm", rate: input.sampleRate } },
			},
			tools: input.tools,
		},
	};
}

export function buildSttWsUrl(options: {
	base?: string;
	sampleRate: number;
	language: string;
	model?: string;
	endpointingMs?: number;
}): string {
	let url: URL;
	try {
		url = new URL(options.base ?? STT_WS_BASE);
	} catch (error) {
		throw new Error(
			`Invalid STT websocket base URL: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	url.searchParams.set("sample_rate", String(options.sampleRate));
	url.searchParams.set("encoding", "pcm");
	url.searchParams.set("interim_results", "true");
	url.searchParams.set("language", options.language);
	url.searchParams.set("endpointing", String(options.endpointingMs ?? 300));
	url.searchParams.set("model", resolveSttModel(options.model));
	return url.toString();
}

/**
 * POST /v1/tts has no model field. Text to Speech is billed per character
 * and does not use grok-voice-3.0.
 */
export function buildTtsBody(input: {
	text: string;
	language: string;
	voice_id?: string;
	speed?: number;
	codec?: string;
	sample_rate?: number;
	bit_rate?: number;
	optimize_streaming_latency?: string;
	text_normalization?: boolean;
	with_timestamps?: boolean;
	replace?: Record<string, string>;
	includeEmptyOutputFormat?: boolean;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		text: input.text,
		language: input.language,
	};
	if (input.voice_id !== undefined) body.voice_id = input.voice_id;
	if (input.speed !== undefined) body.speed = input.speed;
	if (input.optimize_streaming_latency !== undefined) {
		body.optimize_streaming_latency = input.optimize_streaming_latency;
	}
	if (input.text_normalization !== undefined) {
		body.text_normalization = input.text_normalization;
	}
	if (input.with_timestamps !== undefined) {
		body.with_timestamps = input.with_timestamps;
	}
	if (input.replace && Object.keys(input.replace).length) {
		body.replace = input.replace;
	}
	const output: Record<string, unknown> = {};
	if (input.codec !== undefined) output.codec = input.codec;
	if (input.sample_rate !== undefined) output.sample_rate = input.sample_rate;
	if (input.bit_rate !== undefined) output.bit_rate = input.bit_rate;
	if (Object.keys(output).length || input.includeEmptyOutputFormat) {
		body.output_format = output;
	}
	return body;
}

export function customVoicePage(data: unknown): {
	voices: unknown[];
	next?: string;
} {
	if (!isRecord(data)) return { voices: [] };
	const voices = Array.isArray(data.voices) ? data.voices : [];
	const token = data.pagination_token;
	if (typeof token === "string" && token.length > 0) return { voices, next: token };
	return { voices };
}

export function mergeVoiceCatalog(
	builtin: unknown,
	customVoices: unknown[],
): Record<string, unknown> {
	const base = isRecord(builtin) ? { ...builtin } : {};
	return { ...base, custom_voices: customVoices };
}
