import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAgentSearchBody,
	buildSttWsUrl,
	buildTtsBody,
	buildWebSearchTool,
	buildXSearchTool,
	COMPLETIONS_FORBIDDEN_TOOL_TYPES,
	customVoicePage,
	DEFAULT_RESPONSES_MODEL,
	MAX_REFERENCE_IMAGES,
	mergeVoiceCatalog,
	normalizeImageRequest,
	resolveSttModel,
	responsesOutputText,
	responsesSearchModel,
	searchUsage,
	STT_MODEL,
	stripForbiddenCompletionsTools,
	VIDEO_ASPECT_RATIOS,
} from "../xai-api.ts";

test("search falls back to grok-4.7 and keeps the session model", () => {
	assert.equal(responsesSearchModel(undefined), DEFAULT_RESPONSES_MODEL);
	assert.equal(responsesSearchModel({ provider: "openai", id: "gpt" }), "grok-4.7");
	assert.equal(
		responsesSearchModel({ provider: "xai", id: "grok-4.6" }),
		"grok-4.6",
	);
});

test("agent search body uses low reasoning and omits top_p", () => {
	const body = buildAgentSearchBody({
		model: "grok-4.7",
		query: "latest starship flight",
		tools: [{ type: "web_search" }],
		maxTurns: 2,
	});
	assert.equal(body.model, "grok-4.7");
	assert.equal(body.input, "latest starship flight");
	assert.equal(body.store, false);
	assert.equal(body.temperature, 0.1);
	assert.equal("top_p" in body, false);
	assert.deepEqual(body.reasoning, { effort: "low" });
	assert.equal(body.max_turns, 2);
	assert.equal(body.max_output_tokens, 8192);
});

test("web search tool filters and image flags", () => {
	assert.deepEqual(
		buildWebSearchTool({
			allowedDomains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"],
			enableImageUnderstanding: true,
			enableImageSearch: true,
		}),
		{
			type: "web_search",
			filters: { allowed_domains: ["a.com", "b.com", "c.com", "d.com", "e.com"] },
			enable_image_understanding: true,
			enable_image_search: true,
		},
	);
	assert.throws(
		() =>
			buildWebSearchTool({
				allowedDomains: ["a.com"],
				excludedDomains: ["b.com"],
			}),
		/cannot be set together/,
	);
});

test("x search keeps exclusive to_date and adds media understanding", () => {
	assert.deepEqual(
		buildXSearchTool({
			fromDate: "2026-09-01",
			toDate: "2026-10-01",
			allowedHandles: ["@SpaceX", "Tesla"],
			enableImageUnderstanding: true,
			enableVideoUnderstanding: true,
		}),
		{
			type: "x_search",
			from_date: "2026-09-01",
			to_date: "2026-10-01",
			allowed_x_handles: ["SpaceX", "Tesla"],
			enable_image_understanding: true,
			enable_video_understanding: true,
		},
	);
	assert.throws(
		() =>
			buildXSearchTool({
				allowedHandles: ["a"],
				excludedHandles: ["b"],
			}),
		/cannot be set together/,
	);
});

test("responses text keeps url citations and usage details", () => {
	const parsed = responsesOutputText({
		output: [
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Starship flew.",
						annotations: [
							{ type: "url_citation", url: "https://example.com/a" },
							{ type: "url_citation", url: "https://example.com/a" },
						],
					},
				],
			},
		],
	});
	assert.equal(parsed.text, "Starship flew.");
	assert.deepEqual(parsed.citations, ["https://example.com/a"]);
	assert.deepEqual(
		searchUsage({
			usage: { server_side_tool_usage_details: { x_posts_fetched: 3 } },
		}),
		{ x_posts_fetched: 3 },
	);
});

test("retired image slugs map to imagine 2.0 quality low", () => {
	assert.deepEqual(
		normalizeImageRequest({ model: "grok-imagine-image-quality", prompt: "cat" }),
		{ model: "grok-imagine-image-2.0", prompt: "cat", quality: "low" },
	);
	assert.deepEqual(
		normalizeImageRequest({
			model: "grok-imagine-image-pro",
			prompt: "cat",
			quality: "medium",
		}),
		{ model: "grok-imagine-image-2.0", prompt: "cat", quality: "medium" },
	);
	assert.deepEqual(
		normalizeImageRequest({ model: "grok-imagine-image", prompt: "cat" }),
		{ model: "grok-imagine-image", prompt: "cat" },
	);
	assert.throws(
		() =>
			normalizeImageRequest({
				model: "grok-imagine-image",
				quality: "low",
			}),
		/only supported on grok-imagine-image-2.0/,
	);
	assert.throws(
		() =>
			normalizeImageRequest({
				model: "grok-imagine-image-2.0",
				deferred: true,
				response_format: "b64_json",
			}),
		/response_format "url"/,
	);
});

test("speech model and websocket query pin transcribe 2.0", () => {
	assert.equal(resolveSttModel(undefined), STT_MODEL);
	assert.equal(resolveSttModel("grok-voice-transcribe-1.0"), STT_MODEL);
	assert.equal(resolveSttModel("custom-stt"), "custom-stt");
	const url = new URL(
		buildSttWsUrl({ sampleRate: 16000, language: "en", endpointingMs: 300 }),
	);
	assert.equal(url.protocol, "wss:");
	assert.equal(url.pathname, "/v1/stt");
	assert.equal(url.searchParams.get("model"), STT_MODEL);
	assert.equal(url.searchParams.get("encoding"), "pcm");
	assert.equal(url.searchParams.get("sample_rate"), "16000");
	assert.equal(url.searchParams.get("interim_results"), "true");
	assert.equal(url.searchParams.get("endpointing"), "300");
	assert.equal(url.searchParams.get("language"), "en");
});

test("tts body accepts latency 2 and a pronunciation map", () => {
	assert.deepEqual(
		buildTtsBody({
			text: "nginx",
			language: "en",
			voice_id: "leo",
			optimize_streaming_latency: "2",
			replace: { nginx: "/ˈɛndʒɪn ˈɛks/" },
			codec: "mp3",
			sample_rate: 24000,
			bit_rate: 128000,
		}),
		{
			text: "nginx",
			language: "en",
			voice_id: "leo",
			optimize_streaming_latency: "2",
			replace: { nginx: "/ˈɛndʒɪn ˈɛks/" },
			output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
		},
	);
});

test("video aspect ratios and reference cap match the current imagine docs", () => {
	assert.ok(VIDEO_ASPECT_RATIOS.includes("21:9"));
	assert.ok(VIDEO_ASPECT_RATIOS.includes("5:2"));
	assert.equal(MAX_REFERENCE_IMAGES, 14);
});

test("chat completions payload drops server-side tool types", () => {
	const stripped = stripForbiddenCompletionsTools({
		messages: [],
		tools: [
			{ type: "function", function: { name: "local" } },
			{ type: "web_search" },
			{ type: "x_search" },
			{ type: "live_search" },
			{ type: "code_interpreter" },
			{ type: "image_generation" },
			{ type: "file_search" },
			{ type: "mcp" },
		],
	});
	assert.deepEqual(stripped.tools, [
		{ type: "function", function: { name: "local" } },
	]);
	for (const type of [
		"web_search",
		"x_search",
		"live_search",
		"code_interpreter",
		"image_generation",
		"file_search",
		"mcp",
	]) {
		assert.equal(COMPLETIONS_FORBIDDEN_TOOL_TYPES.has(type), true);
	}
});

test("custom voice pages merge onto the built-in catalog", () => {
	assert.deepEqual(customVoicePage({ voices: [{ voice_id: "abc" }], pagination_token: "next" }), {
		voices: [{ voice_id: "abc" }],
		next: "next",
	});
	assert.deepEqual(customVoicePage({ voices: [], pagination_token: null }), {
		voices: [],
	});
	assert.deepEqual(
		mergeVoiceCatalog({ voices: [{ voice_id: "eve" }] }, [{ voice_id: "custom" }]),
		{
			voices: [{ voice_id: "eve" }],
			custom_voices: [{ voice_id: "custom" }],
		},
	);
});
