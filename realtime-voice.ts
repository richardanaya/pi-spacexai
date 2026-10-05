/**
 * Realtime voice observer.
 *
 * /realtime-voice-start opens wss://api.x.ai/v1/realtime from this process,
 * streams the microphone (arecord or ffmpeg), and plays replies with ffplay.
 * No browser page.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const VOICE_LOG = join(homedir(), ".pi", "spacexai-realtime.log");

function logVoice(line: string): void {
	const text = `${new Date().toISOString()} ${line}\n`;
	try {
		appendFileSync(VOICE_LOG, text);
	} catch {
		/* ignore */
	}
}
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const API_BASE = "https://api.x.ai/v1";
const REALTIME_URL = "wss://api.x.ai/v1/realtime";
const DEFAULT_MODEL = "grok-voice-latest";
const SAMPLE_RATE = 24_000;
/** 100 ms of s16le mono. */
const FRAME_BYTES = (SAMPLE_RATE * 2) / 10;
const IDLE_DISCONNECT_MS = 5 * 60 * 1000;
const IDLE_WARN_MS = 60 * 1000;

const sendToObserverParams = Type.Object({
	message: Type.String({
		description:
			"Concise update or answer for the voice observer to convey to the user",
	}),
});
type SendToObserverParams = Static<typeof sendToObserverParams>;

const setHarnessStatusParams = Type.Object({
	status: Type.String({
		description:
			'Short status text shown in the terminal while realtime voice is running. Prefer a lasting completion line like "Done: fixed auth bug" over clearing. Do not pass empty string to clear unless explicitly asked.',
	}),
});
type SetHarnessStatusParams = Static<typeof setHarnessStatusParams>;

/** Appended to the coding agent system prompt while realtime voice is running. */
const CODING_AGENT_OBSERVER_PROMPT = `REALTIME VOICE OBSERVER
A voice observer co-pilot is in this terminal (started with /realtime-voice-start). The observer speaks with the user and cannot read your normal terminal output, tool results, or assistant messages.

You MUST use these tools to keep the observer and user in the loop:
- send_message_to_observer — send the outcome the voice agent should speak. This arrives as a work_landed update. Call it when a voice-requested job finishes. Bias toward the outcome, not a play-by-play.
- set_harness_status — keep a short live status line in the terminal up to date. Set it when work starts, update it as you progress, and when finished leave a clear completion status (e.g. "Done: added login tests" or "Failed: type error in auth.ts"). Do NOT clear the status line — leave the latest completion/failure text visible. Only clear if the user explicitly asks you to.

Do not assume the observer saw anything you only printed in the terminal. Prefer short spoken-ready messages.

When the latest request came from the voice observer, do not write a chat reply. The user is listening, not reading. Call send_message_to_observer with what they should hear, and set_harness_status for the status line. Do not type the spoken answer into the chat.`;

interface RealtimeVoiceOptions {
	/** Fresh xAI bearer (OAuth or API key). */
	getToken: () => Promise<string>;
	/** Prefer config voice (leo, eve, ara, …). Default leo. */
	voice?: string;
	model?: string;
	/** Start a coding-session job. Return a receipt id. */
	onSendTask: (request: string) => Promise<{ receipt: string }>;
	/** Current project session directory and the live chat. */
	conversations: {
		currentId: () => string | undefined;
		dir: () => string | undefined;
		currentText: () => string;
	};
	/** Called when the session stops itself (idle timeout or socket close). */
	onSelfStop?: (reason: string) => void;
	/** Terminal status line (not spoken). */
	onStatus?: (status: string) => void;
	/** Mic level from 0 (silence) to 1 (loud). */
	onLevel?: (level: number) => void;
	/** Spoken line. Not shown in the chat. */
	onCaption?: (kind: "user" | "assistant", text: string, id: string) => void;
	/** Optional instructions override for the voice agent. */
	instructions?: string;
}

interface RealtimeVoiceSession {
	voice: string;
	setVoice: (voice: string) => boolean;
	sendToObserver: (message: string) => boolean;
	setHarnessStatus: (status: string) => boolean;
	getHarnessStatus: () => string;
	connected: () => boolean;
	stop: () => Promise<void>;
}

const DEFAULT_VOICE = "leo";

const DEFAULT_INSTRUCTIONS = `You are the voice co-pilot for a coding session. You speak with the user in real time. You have four tools.

send_task
Request a job. The request is at most 2000 characters. You receive a receipt, not the outcome. Speak a short ack such as "On it." Do not mention a receipt, a handoff, or that you are waiting.

search_conversations
Search prior conversations. You get at most 6 hits, best first. scope is this-chat, earlier, or everything. Pass id to read that hit in full. from and to are YYYY-MM-DD. if_missing is required: say-no-record means tell the user there is no record; send-task means a job is requested for you when nothing matches.

end_the_call
Hang up. No parameters. Use only when the user is parting. Say goodbye out loud in the same turn before you call it.

read_background_updates
The system calls this. You never call it. It carries background mail, including work_landed when a job finishes. If the user just asked something and an update also arrives, answer the user first, then mention the update as a short aside. Speak a work_landed result in first person, as your own outcome. Do not mention tools or receipts.

Answer quick questions yourself. For code, investigation, runs, or media, call send_task with a self-contained request. Keep spoken replies short. Do not speak IP addresses or file paths unless the user asks.`;

function chatText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const bits: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const item = part as { type?: string; text?: string };
		if (item.type === "text" && item.text) bits.push(item.text);
		else if (item.type === "image") bits.push("[image]");
	}
	return bits.join(" ");
}

function formatChatLog(messages: unknown[]): string {
	const lines: string[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as { role?: string; content?: unknown };
		const role = message.role || "message";
		if (role !== "user" && role !== "assistant" && role !== "custom" && role !== "toolResult") {
			continue;
		}
		let text = chatText(message.content).replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (text.length > 1500) text = `${text.slice(0, 1500)}…`;
		lines.push(`${role}: ${text}`);
	}
	const joined = lines.join("\n");
	if (!joined) return "(empty chat)";
	const cap = 12_000;
	return joined.length > cap ? joined.slice(joined.length - cap) : joined;
}

function commandExists(cmd: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("which", [cmd], (err) => resolve(!err));
	});
}

function inDateRange(date: string, from?: string, to?: string): boolean {
	const day = date.slice(0, 10);
	if (from && day < from) return false;
	if (to && day > to) return false;
	return true;
}

function scoreText(text: string, terms: string[]): number {
	const hay = text.toLowerCase();
	let score = 0;
	for (const term of terms) {
		let at = 0;
		while (at >= 0) {
			at = hay.indexOf(term, at);
			if (at >= 0) {
				score += 1;
				at += term.length;
			}
		}
	}
	return score;
}

function snippetAround(text: string, terms: string[]): string {
	const hay = text.toLowerCase();
	let at = -1;
	for (const term of terms) {
		at = hay.indexOf(term);
		if (at >= 0) break;
	}
	if (at < 0) at = 0;
	const start = Math.max(0, at - 80);
	const slice = text.slice(start, start + 220).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${slice}${start + 220 < text.length ? "…" : ""}`;
}

interface ConversationDoc {
	id: string;
	date: string;
	text: string;
	current: boolean;
}

async function loadSessionFile(file: string): Promise<ConversationDoc | null> {
	let raw = "";
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return null;
	}
	let id = "";
	let date = "";
	const lines: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: {
			type?: string;
			id?: string;
			timestamp?: string;
			message?: { role?: string; content?: unknown };
			customType?: string;
			content?: unknown;
			summary?: string;
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			id = String(entry.id || id);
			date = String(entry.timestamp || date);
			continue;
		}
		if (!date && entry.timestamp) date = entry.timestamp;
		if (entry.type === "message" && entry.message) {
			const text = chatText(entry.message.content).replace(/\s+/g, " ").trim();
			if (text) lines.push(`${entry.message.role || "message"}: ${text}`);
		} else if (entry.type === "custom_message") {
			const text = chatText(entry.content).replace(/\s+/g, " ").trim();
			if (text) lines.push(`custom: ${text}`);
		} else if (entry.type === "compaction" && entry.summary) {
			lines.push(`summary: ${entry.summary}`);
		}
	}
	if (!id) return null;
	return { id, date, text: lines.join("\n"), current: false };
}

async function searchConversations(
	options: RealtimeVoiceOptions,
	args: {
		query?: string;
		scope?: string;
		id?: string;
		from?: string;
		to?: string;
		if_missing?: string;
	},
	sendTask: (request: string) => Promise<{ receipt: string }>,
): Promise<Record<string, unknown>> {
	const query = String(args.query || "").trim();
	const scope = args.scope || "everything";
	if (!["this-chat", "earlier", "everything"].includes(scope)) {
		return { ok: false, error: "scope must be this-chat, earlier, or everything" };
	}
	if (args.if_missing !== "say-no-record" && args.if_missing !== "send-task") {
		return { ok: false, error: "if_missing must be say-no-record or send-task" };
	}
	for (const value of [args.from, args.to]) {
		if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			return { ok: false, error: "from and to must be YYYY-MM-DD" };
		}
	}
	const currentId = options.conversations.currentId();
	const docs: ConversationDoc[] = [];
	if (scope !== "earlier") {
		docs.push({
			id: currentId || "this-chat",
			date: new Date().toISOString(),
			text: options.conversations.currentText(),
			current: true,
		});
	}
	if (scope !== "this-chat") {
		const dir = options.conversations.dir();
		if (dir) {
			let names: string[] = [];
			try {
				names = await readdir(dir);
			} catch {
				names = [];
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				const doc = await loadSessionFile(join(dir, name));
				if (!doc || doc.id === currentId) continue;
				docs.push(doc);
			}
		}
	}
	const wanted = String(args.id || "").trim();
	if (wanted) {
		const doc = docs.find((item) => item.id === wanted);
		if (!doc || (args.from || args.to) && !inDateRange(doc.date, args.from, args.to)) {
			return missingConversations(args.if_missing, query, sendTask);
		}
		const text = doc.text.length > 8000 ? doc.text.slice(doc.text.length - 8000) : doc.text;
		return {
			ok: true,
			id: doc.id,
			date: doc.date.slice(0, 10),
			text: text || "(empty)",
		};
	}
	if (!query) return { ok: false, error: "query is required" };
	const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
	const hits = docs
		.filter((doc) => inDateRange(doc.date, args.from, args.to))
		.map((doc) => ({ doc, score: scoreText(doc.text, terms.length ? terms : [query.toLowerCase()]) }))
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 6)
		.map((hit) => ({
			id: hit.doc.id,
			date: hit.doc.date.slice(0, 10),
			score: hit.score,
			snippet: snippetAround(hit.doc.text, terms.length ? terms : [query.toLowerCase()]),
		}));
	if (!hits.length) return missingConversations(args.if_missing, query, sendTask);
	return { ok: true, hits };
}

async function missingConversations(
	ifMissing: string,
	query: string,
	sendTask: (request: string) => Promise<{ receipt: string }>,
): Promise<Record<string, unknown>> {
	if (ifMissing === "send-task") {
		if (!query) return { ok: false, error: "query is required to send a task" };
		if (query.length > 2000) {
			return { ok: false, error: "query exceeds 2000 characters", hits: [] };
		}
		const receipt = await sendTask(query);
		return { ok: true, hits: [], if_missing: "send-task", ...receipt };
	}
	return { ok: true, hits: [], if_missing: "say-no-record" };
}

async function pickPlayer(): Promise<{ cmd: string; args: string[] }> {
	if (await commandExists("aplay")) {
		return {
			cmd: "aplay",
			args: [
				"-q",
				"-t",
				"raw",
				"-f",
				"S16_LE",
				"-c",
				"1",
				"-r",
				String(SAMPLE_RATE),
				"--buffer-time=60000",
			],
		};
	}
	if (await commandExists("paplay")) {
		return {
			cmd: "paplay",
			args: [
				"--raw",
				`--format=s16le`,
				`--rate=${SAMPLE_RATE}`,
				"--channels=1",
			],
		};
	}
	if (await commandExists("ffplay")) {
		return {
			cmd: "ffplay",
			args: [
				"-f",
				"s16le",
				"-ar",
				String(SAMPLE_RATE),
				"-ac",
				"1",
				"-nodisp",
				"-autoexit",
				"-loglevel",
				"error",
				"-i",
				"pipe:0",
			],
		};
	}
	throw new Error("No audio player found. Install alsa-utils (aplay) or ffmpeg (ffplay).");
}

async function pickRecorder(): Promise<{ cmd: string; args: string[] }> {
	const hasArecord = await commandExists("arecord");
	const hasFfmpeg = await commandExists("ffmpeg");
	if (hasArecord && process.platform === "linux") {
		return {
			cmd: "arecord",
			args: [
				"-f",
				"S16_LE",
				"-r",
				String(SAMPLE_RATE),
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
				: ["-f", "alsa", "-i", "default"];
		return {
			cmd: "ffmpeg",
			args: [
				"-loglevel",
				"error",
				...input,
				"-ac",
				"1",
				"-ar",
				String(SAMPLE_RATE),
				"-f",
				"s16le",
				"-acodec",
				"pcm_s16le",
				"pipe:1",
			],
		};
	}
	throw new Error("No audio recorder found. Install arecord or ffmpeg.");
}

async function fetchClientSecret(bearer: string): Promise<string> {
	const r = await fetch(`${API_BASE}/realtime/client_secrets`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${bearer}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ expires_after: { seconds: 300 } }),
	});
	const text = await r.text();
	if (!r.ok) {
		throw new Error(
			`Could not mint a realtime token (${r.status}): ${text || r.statusText}`,
		);
	}
	let data: { value?: string; client_secret?: string; secret?: string; token?: string };
	try {
		data = JSON.parse(text);
	} catch {
		const trimmed = text.trim();
		if (!trimmed) throw new Error("Realtime token response was empty");
		return trimmed;
	}
	const token = data.value || data.client_secret || data.secret || data.token;
	if (!token) throw new Error(`No ephemeral token in response: ${text}`);
	return token;
}

async function startRealtimeVoice(
	options: RealtimeVoiceOptions,
): Promise<RealtimeVoiceSession> {
	const playerSpec = await pickPlayer();
	const recorderSpec = await pickRecorder();
	const model = options.model ?? DEFAULT_MODEL;
	let voice = options.voice ?? DEFAULT_VOICE;
	const instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;

	const token = await fetchClientSecret(await options.getToken());
	const ws = new WebSocket(
		`${REALTIME_URL}?model=${encodeURIComponent(model)}`,
		[`xai-client-secret.${token}`],
	);

	let closed = false;
	let stopping = false;
	let stopRequested = false;
	let pendingAsync = false;
	let lastReceipt: string | null = null;
	const asyncQueue: unknown[] = [];
	let responseActive = false;
	let assistantBuf = "";
	let assistantTurnId = "";
	let harnessStatus = "";
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let idleWarnTimer: ReturnType<typeof setTimeout> | null = null;
	let player: ChildProcess | null = null;
	/** Wall-clock time when queued PCM should finish playing. */
	let spokenUntil = 0;
	let endingCall = false;
	let holdPlayback = false;
	let playbackItemId = "";
	let playbackStartedAt = 0;
	let queuedMs = 0;
	let sessionReady = false;
	let sessionUpdated = false;
	let sessionReadyWait: (() => void) | null = null;
	let sessionUpdatedWait: (() => void) | null = null;
	let lastTrouble = "";
	let recorder: ChildProcess | null = null;
	let micBuf = Buffer.alloc(0);

	const send = (obj: unknown) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
	};

	function clearIdleTimers(): void {
		if (idleTimer) clearTimeout(idleTimer);
		if (idleWarnTimer) clearTimeout(idleWarnTimer);
		idleTimer = null;
		idleWarnTimer = null;
	}

	function touchActivity(): void {
		clearIdleTimers();
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		idleWarnTimer = setTimeout(() => {
			if (closed) return;
			options.onStatus?.("disconnecting in 1 minute — speak to stay");
		}, IDLE_DISCONNECT_MS - IDLE_WARN_MS);
		idleTimer = setTimeout(() => {
			if (closed) return;
			void stop("idle");
		}, IDLE_DISCONNECT_MS);
	}

	function stopPlayback(): void {
		if (!player) return;
		const child = player;
		player = null;
		try {
			child.stdin?.end();
		} catch {
			/* ignore */
		}
		try {
			child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	}

	function ensurePlayer(): ChildProcess {
		if (player && !player.killed && player.stdin?.writable) return player;
		const child = spawn(playerSpec.cmd, playerSpec.args, {
			stdio: ["pipe", "ignore", "pipe"],
		});
		player = child;
		child.stdin?.on("error", () => {
			if (player === child) player = null;
		});
		let err = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			err = (err + chunk.toString("utf8")).slice(-400);
		});
		child.on("exit", (code, signal) => {
			const unexpected = player === child;
			if (unexpected) player = null;
			// Barge-in and hang-up kill this process on purpose.
			if (!unexpected || closed || stopping || signal) return;
			if (code && code !== 0) {
				options.onStatus?.(
					`speaker stopped (${playerSpec.cmd} exit ${code}${err ? `: ${err.trim()}` : ""})`,
				);
			}
		});
		return child;
	}

	function playedMs(): number {
		if (!playbackStartedAt) return 0;
		const elapsed = Date.now() - playbackStartedAt;
		return Math.max(0, Math.min(queuedMs, elapsed));
	}

	function notePlayback(itemId: string, bytes: number): void {
		if (itemId && itemId !== playbackItemId) {
			playbackItemId = itemId;
			playbackStartedAt = Date.now();
			queuedMs = 0;
		}
		if (!playbackStartedAt) playbackStartedAt = Date.now();
		queuedMs += (bytes / 2 / SAMPLE_RATE) * 1000;
	}

	function playPcm(bytes: Buffer): void {
		if (closed || stopping || holdPlayback || bytes.length === 0) return;
		const ms = (bytes.length / 2 / SAMPLE_RATE) * 1000;
		const now = Date.now();
		if (spokenUntil < now) spokenUntil = now;
		spokenUntil += ms;
		const child = ensurePlayer();
		const stdin = child.stdin;
		if (!stdin?.writable) return;
		try {
			stdin.write(bytes);
		} catch {
			if (player === child) player = null;
		}
	}

	async function endAfterSpeech(): Promise<void> {
		if (endingCall || closed) return;
		endingCall = true;
		stopRequested = false;
		// Leave the socket up until the goodbye already queued has played.
		const wait = Math.max(0, spokenUntil - Date.now()) + 400;
		await new Promise((resolve) => setTimeout(resolve, wait));
		if (!closed) await stop("voice");
	}

	function tone(freq: number, ms: number): Buffer {
		const n = Math.floor((SAMPLE_RATE * ms) / 1000);
		const buf = Buffer.alloc(n * 2);
		const attack = Math.floor(n * 0.35);
		const release = Math.floor(n * 0.45);
		for (let i = 0; i < n; i++) {
			const env = Math.min(1, i / attack, (n - i) / release);
			const sample = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 0.18 * env;
			buf.writeInt16LE(
				Math.max(-32767, Math.min(32767, Math.round(sample * 32767))),
				i * 2,
			);
		}
		return buf;
	}

	function playCue(kind: "start" | "stop"): Promise<void> {
		// A one-shot player. The live speech pipe buffers short writes and never
		// plays them, and shutdown kills that process before a cue can drain.
		const gap = Buffer.alloc(Math.floor(SAMPLE_RATE * 2 * 0.06));
		const tail = Buffer.alloc(Math.floor(SAMPLE_RATE * 2 * 0.12));
		const bytes =
			kind === "start"
				? Buffer.concat([tone(349, 280), gap, tone(440, 420), tail])
				: Buffer.concat([tone(440, 240), gap, tone(330, 520), tail]);
		return new Promise((resolve) => {
			const child = spawn(playerSpec.cmd, playerSpec.args, {
				stdio: ["pipe", "ignore", "ignore"],
			});
			child.stdin?.on("error", () => {});
			const done = () => resolve();
			const timer = setTimeout(() => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				done();
			}, 1500);
			child.on("exit", () => {
				clearTimeout(timer);
				done();
			});
			child.on("error", () => {
				clearTimeout(timer);
				done();
			});
			child.stdin?.end(bytes);
		});
	}

	function sessionUpdate(): void {
		send({
			type: "session.update",
			session: {
				voice,
				instructions,
				turn_detection: {
					type: "server_vad",
					threshold: 0.3,
					silence_duration_ms: 500,
				},
				audio: {
					input: {
						format: { type: "audio/pcm", rate: SAMPLE_RATE },
						transcription: { model: "grok-transcribe" },
					},
					output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
				},
				tools: [
					{
						type: "function",
						function: {
							name: "send_task",
							description:
								"Request a job. Returns a receipt. The outcome arrives later as work_landed through read_background_updates. Rejects requests over 2000 characters instead of truncating them.",
							parameters: {
								type: "object",
								properties: {
									request: {
										type: "string",
										description: "The job to do. Max 2000 characters.",
									},
								},
								required: ["request"],
							},
						},
					},
					{
						type: "function",
						function: {
							name: "search_conversations",
							description:
								"Search prior conversations. Returns up to 6 hits, best first. Pass id to read that hit in full. scope is this-chat, earlier, or everything. from and to are YYYY-MM-DD. if_missing is say-no-record or send-task.",
							parameters: {
								type: "object",
								properties: {
									query: { type: "string", description: "What to look for." },
									scope: {
										type: "string",
										description: "this-chat, earlier, or everything. Default everything.",
									},
									id: { type: "string", description: "Read that hit in full." },
									from: { type: "string", description: "Start date, YYYY-MM-DD." },
									to: { type: "string", description: "End date, YYYY-MM-DD." },
									if_missing: {
										type: "string",
										description:
											"say-no-record: tell the user there is no record. send-task: request a job when nothing matches.",
									},
								},
								required: ["query", "if_missing"],
							},
						},
					},
					{
						type: "function",
						function: {
							name: "end_the_call",
							description:
								"Hang up. Use only on a parting greeting, and say goodbye out loud first.",
							parameters: { type: "object", properties: {} },
						},
					},
					{
						type: "function",
						function: {
							name: "read_background_updates",
							description:
								"Read JSON background updates, including work_landed. The system calls this. Do not call it yourself.",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			},
		});
	}

	async function issueTask(request: string): Promise<{ receipt: string }> {
		const issued = await options.onSendTask(request);
		lastReceipt = issued.receipt;
		return issued;
	}

	function flushAsync(): void {
		if (!asyncQueue.length || ws.readyState !== WebSocket.OPEN) return;
		if (responseActive || stopRequested) {
			pendingAsync = true;
			return;
		}
		pendingAsync = false;
		const updates = asyncQueue.splice(0);
		const callId = `upd_${Date.now()}`;
		send({
			type: "conversation.item.create",
			item: {
				type: "function_call",
				call_id: callId,
				name: "read_background_updates",
				arguments: "{}",
			},
		});
		send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output: JSON.stringify({ updates }),
			},
		});
		send({ type: "response.create" });
	}

	async function handleFunctionCall(event: {
		name?: string;
		call_id?: string;
		arguments?: string;
	}): Promise<void> {
		const name = event.name;
		const callId = event.call_id;
		let args: {
			request?: string;
			message?: string;
			query?: string;
			scope?: string;
			id?: string;
			from?: string;
			to?: string;
			if_missing?: string;
		} = {};
		try {
			args = JSON.parse(event.arguments || "{}");
		} catch {
			/* ignore */
		}
		let output: Record<string, unknown> = { ok: true };
		if (name === "send_task") {
			const request = String(args.request || "").trim();
			if (!request) output = { ok: false, error: "request is required" };
			else if (request.length > 2000) {
				output = { ok: false, error: "request exceeds 2000 characters" };
			} else {
				try {
					const receipt = await issueTask(request);
					output = { ok: true, ...receipt };
				} catch (e) {
					output = {
						ok: false,
						error: e instanceof Error ? e.message : String(e),
					};
				}
			}
		} else if (name === "search_conversations") {
			try {
				output = await searchConversations(options, args, issueTask);
			} catch (e) {
				output = {
					ok: false,
					error: e instanceof Error ? e.message : String(e),
				};
			}
		} else if (name === "end_the_call") {
			stopRequested = true;
			output = { ok: true, ending: true };
		} else if (name === "read_background_updates") {
			output = { updates: asyncQueue.splice(0) };
		} else {
			output = { ok: false, error: `unknown function ${name}` };
		}
		send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output: JSON.stringify(output),
			},
		});
		if (stopRequested && !responseActive) {
			void endAfterSpeech();
			return;
		}
		if (!stopRequested) setTimeout(() => send({ type: "response.create" }), 250);
	}

	function injectObserverMessage(message: string): boolean {
		if (ws.readyState !== WebSocket.OPEN) return false;
		asyncQueue.push({
			type: "work_landed",
			receipt: lastReceipt,
			summary: message,
		});
		flushAsync();
		touchActivity();
		return true;
	}

	function onServerEvent(event: Record<string, unknown>): void {
		const t = String(event.type || "");
		if (t === "session.created") {
			sessionReady = true;
			sessionReadyWait?.();
			sessionReadyWait = null;
		}
		if (t === "session.updated") {
			sessionUpdated = true;
			sessionUpdatedWait?.();
			sessionUpdatedWait = null;
		}
		if (t !== "error") touchActivity();
		if (t === "response.created") {
			responseActive = true;
			assistantBuf = "";
			const response = event.response as { id?: string } | undefined;
			assistantTurnId = String(response?.id || event.response_id || `voice-${Date.now()}`);
			return;
		}
		if (t === "response.done" || t === "response.cancelled") {
			responseActive = false;
			if (stopRequested) {
				void endAfterSpeech();
				return;
			}
			if (pendingAsync) flushAsync();
			return;
		}
		if (t === "response.output_audio.delta" || t === "response.audio.delta") {
			const b64 = String(event.delta || event.audio || "");
			if (!b64) return;
			const bytes = Buffer.from(b64, "base64");
			notePlayback(String(event.item_id || ""), bytes.length);
			playPcm(bytes);
			return;
		}
		if (
			t === "response.output_audio_transcript.done" ||
			t === "response.audio_transcript.done"
		) {
			const text = String(event.transcript || assistantBuf || "").trim();
			assistantBuf = "";
			if (text) options.onCaption?.("assistant", text, assistantTurnId || "voice");
			return;
		}
		if (
			t === "response.output_audio_transcript.delta" ||
			t === "response.audio_transcript.delta"
		) {
			assistantBuf += String(event.delta || "");
			options.onCaption?.("assistant", assistantBuf, assistantTurnId || "voice");
			return;
		}
		if (
			t === "conversation.item.input_audio_transcription.completed" ||
			t === "conversation.item.input_audio_transcription.done" ||
			t === "conversation.item.input_audio_transcription.updated"
		) {
			const text = String(event.transcript || "").trim();
			const id = String(event.item_id || "you");
			if (text) options.onCaption?.("user", text, id);
			return;
		}
		if (t === "response.function_call_arguments.done") {
			void handleFunctionCall(event as { name?: string; call_id?: string; arguments?: string });
			return;
		}
		if (t === "input_audio_buffer.speech_started") {
			if (endingCall) return;
			holdPlayback = true;
			const heardMs = Math.round(playedMs());
			const itemId = playbackItemId;
			spokenUntil = Date.now();
			stopPlayback();
			if (itemId) {
				send({
					type: "conversation.item.truncate",
					item_id: itemId,
					content_index: 0,
					audio_end_ms: heardMs,
				});
			}
			if (responseActive) send({ type: "response.cancel" });
			responseActive = false;
			playbackItemId = "";
			playbackStartedAt = 0;
			queuedMs = 0;
			return;
		}
		if (t === "conversation.item.truncated") {
			const text = String(event.transcript || "").trim();
			const id = String(event.item_id || "");
			if (text) options.onCaption?.("assistant", text, assistantTurnId || id || "voice");
			return;
		}
		if (t === "input_audio_buffer.speech_stopped") {
			holdPlayback = false;
			return;
		}
		if (t === "error") {
			const detail = JSON.stringify(event);
			const err = event.error as { message?: string } | undefined;
			const msg = String(err?.message || "");
			if (/no active response/i.test(msg) || /Cancellation failed/i.test(msg)) {
				responseActive = false;
				return;
			}
			lastTrouble = detail;
			logVoice(detail);
			options.onStatus?.(detail);
		}
	}

	function startMic(): void {
		recorder = spawn(recorderSpec.cmd, recorderSpec.args, {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let lastLevelAt = 0;
		recorder.stdout?.on("data", (chunk: Buffer) => {
			if (closed || ws.readyState !== WebSocket.OPEN) return;
			micBuf = Buffer.concat([micBuf, chunk]);
			while (micBuf.length >= FRAME_BYTES) {
				const frame = micBuf.subarray(0, FRAME_BYTES);
				micBuf = micBuf.subarray(FRAME_BYTES);
				const now = Date.now();
				if (now - lastLevelAt >= 80) {
					lastLevelAt = now;
					let peak = 0;
					for (let i = 0; i < frame.length; i += 2) {
						const sample = Math.abs(frame.readInt16LE(i));
						if (sample > peak) peak = sample;
					}
					options.onLevel?.(Math.min(1, (peak / 32768) * 6));
				}
				send({
					type: "input_audio_buffer.append",
					audio: Buffer.from(frame).toString("base64"),
				});
			}
		});
		recorder.on("exit", (code, signal) => {
			if (closed || stopping) return;
			options.onStatus?.(
				`microphone stopped (${signal || code || "exit"}). /realtime-voice-stop and start again.`,
			);
		});
	}

	function stopMic(): void {
		if (!recorder) return;
		const child = recorder;
		recorder = null;
		try {
			child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	}

	async function stop(reason?: string): Promise<void> {
		if (closed || stopping) return;
		stopping = true;
		clearIdleTimers();
		stopMic();
		stopPlayback();
		try {
			await playCue("stop");
		} catch {
			/* ignore */
		}
		closed = true;
		try {
			ws.close();
		} catch {
			/* ignore */
		}
		if (reason) options.onSelfStop?.(reason);
	}

	ws.addEventListener("message", (ev) => {
		void (async () => {
			let raw = "";
			const data = ev.data;
			if (typeof data === "string") raw = data;
			else if (data instanceof ArrayBuffer) raw = Buffer.from(data).toString("utf8");
			else if (ArrayBuffer.isView(data))
				raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
			else if (data && typeof (data as Blob).text === "function") raw = await (data as Blob).text();
			else return;
			try {
				onServerEvent(JSON.parse(raw) as Record<string, unknown>);
			} catch {
				/* binary audio frames are not used; json transport carries base64 */
			}
		})();
	});
	ws.addEventListener("close", (ev) => {
		const detail = `socket closed code=${ev.code} reason=${ev.reason || "(none)"}${lastTrouble ? ` last=${lastTrouble}` : ""}`;
		logVoice(detail);
		if (!closed) void stop(detail);
	});

	await new Promise<void>((resolve, reject) => {
		const fail = (err: Error) => {
			ws.removeEventListener("open", onOpen);
			reject(err);
		};
		const onOpen = () => {
			ws.removeEventListener("error", onErr);
			resolve();
		};
		const onErr = () => fail(new Error("Realtime voice websocket failed"));
		ws.addEventListener("open", onOpen, { once: true });
		ws.addEventListener("error", onErr, { once: true });
	});

	await new Promise<void>((resolve) => {
		if (sessionReady) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, 1500);
		sessionReadyWait = () => {
			clearTimeout(timer);
			resolve();
		};
	});
	sessionUpdate();
	await new Promise<void>((resolve) => {
		if (sessionUpdated) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, 1500);
		sessionUpdatedWait = () => {
			clearTimeout(timer);
			resolve();
		};
	});
	if (lastTrouble) {
		closed = true;
		stopPlayback();
		try {
			ws.close();
		} catch {
			/* ignore */
		}
		throw new Error(lastTrouble);
	}
	await playCue("start");
	startMic();
	touchActivity();

	return {
		get voice() {
			return voice;
		},
		setVoice: (next: string) => {
			const id = next.trim();
			if (!id) return false;
			voice = id;
			send({ type: "session.update", session: { voice: id } });
			return ws.readyState === WebSocket.OPEN;
		},
		sendToObserver: injectObserverMessage,
		setHarnessStatus: (status: string) => {
			harnessStatus = String(status ?? "").trim();
			options.onStatus?.(harnessStatus);
			return ws.readyState === WebSocket.OPEN;
		},
		getHarnessStatus: () => harnessStatus,
		connected: () => !closed && ws.readyState === WebSocket.OPEN,
		stop: () => stop(),
	};
}

const OBSERVER_TOOL_NAMES = [
	"send_message_to_observer",
	"set_harness_status",
] as const;

/** Wire slash commands + harness tools onto an ExtensionAPI. */
export function registerRealtimeVoice(
	pi: ExtensionAPI,
	deps: {
		getToken: (ctx: {
			modelRegistry: {
				getApiKeyForProvider(provider: string): Promise<string | undefined>;
			};
		}) => Promise<string>;
		readVoice: () => Promise<string | undefined>;
		writeVoice: (voice: string) => Promise<void>;
	},
): void {
	let session: RealtimeVoiceSession | null = null;
	let pendingReceipt: string | null = null;
	let reportedReceipt: string | null = null;
	let observerToolsActive = false;
	let statusCtx: {
		ui?: {
			setStatus?(k: string, v: string | undefined): void;
			notify?(m: string, l?: string): void;
			setWidget?(
				key: string,
				content: string[] | undefined,
				options?: { placement?: "aboveEditor" | "belowEditor" },
			): void;
			custom?<T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => { render(width: number): string[]; invalidate(): void },
				options?: {
					overlay?: boolean;
					overlayOptions?: {
						width?: number;
						anchor?: "top-right";
						margin?: { top?: number; right?: number };
						nonCapturing?: boolean;
					};
				},
			): Promise<T>;
		};
		hasUI?: boolean;
	} | null = null;
	let voiceDialog: {
		turns: { id: string; who: "you" | "voice"; text: string }[];
		invalidate(): void;
		render(width: number): string[];
	} | null = null;
	let closeVoiceDialog: (() => void) | null = null;

	function openVoiceDialog(): void {
		const ui = statusCtx?.ui;
		if (!ui?.custom || voiceDialog) return;
		const dialog = {
			turns: [] as { id: string; who: "you" | "voice"; text: string }[],
			invalidate() {},
			render(width: number): string[] {
				const inner = Math.max(8, width - 2);
				const rows: { color: string; text: string }[] = [];
				for (const turn of this.turns) {
					const words = turn.text.replace(/\s+/g, " ").trim();
					if (!words) continue;
					const color = turn.who === "you" ? "\x1b[36m" : "\x1b[33m";
					for (const row of wrapCaption(words, inner)) rows.push({ color, text: row });
				}
				const view = rows.slice(-12);
				while (view.length < 4) view.unshift({ color: "", text: "" });
				const lines = [
					`┌\x1b[36myou\x1b[0m · \x1b[33mvoice\x1b[0m ${"─".repeat(Math.max(0, inner - 12))}┐`,
				];
				for (const row of view) {
					const pad = " ".repeat(Math.max(0, inner - row.text.length));
					lines.push(`│${row.color}${row.text}\x1b[0m${pad}│`);
				}
				lines.push(`└${"─".repeat(inner)}┘`);
				return lines;
			},
		};
		voiceDialog = dialog;
		void ui.custom(
			(_tui, _theme, _keys, done) => {
				closeVoiceDialog = () => done(undefined);
				return dialog;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					width: 44,
					margin: { top: 1, right: 1 },
					nonCapturing: true,
				},
			},
		);
	}

	function dismissVoiceDialog(): void {
		const close = closeVoiceDialog;
		closeVoiceDialog = null;
		voiceDialog = null;
		close?.();
	}

	const setFooter = (label: string | undefined) => {
		if (statusCtx?.hasUI && statusCtx.ui?.setStatus) {
			statusCtx.ui.setStatus("spacexai-realtime", label);
		}
	};

	function micMeter(level: number): string {
		const steps = "▁▂▃▄▅▆▇█";
		let bar = "";
		for (let i = 0; i < 8; i++) {
			bar += level >= (i + 1) / 8 ? steps[i] : "▁";
		}
		return bar;
	}

	function wrapCaption(text: string, width: number): string[] {
		if (!text) return [];
		const rows: string[] = [];
		let rest = text;
		while (rest.length > width) {
			rows.push(rest.slice(0, width));
			rest = rest.slice(width);
		}
		if (rest) rows.push(rest);
		return rows;
	}

	function enableObserverTools(): void {
		pi.registerTool({
			name: "send_message_to_observer",
			label: "Send Message to Voice Observer",
			description:
				"Send information to the realtime speech-to-speech observer. The voice agent will speak this update to the user. The observer cannot read normal terminal output.",
			promptSnippet: "Send a message to the realtime voice observer",
			promptGuidelines: [
				"When you complete work the user asked about via voice, or when answering an observer question, call send_message_to_observer with a concise status or answer.",
				"Do not call this tool if realtime voice is not running.",
			],
			parameters: sendToObserverParams,
			async execute(_id, params: SendToObserverParams) {
				if (!session) {
					throw new Error(
						"Realtime voice is not running. Start it with /realtime-voice-start",
					);
				}
				const message = String(params.message || "").trim();
				if (!message) throw new Error("message is required");
				reportedReceipt = pendingReceipt;
				const delivered = session.sendToObserver(message);
				return {
					content: [
						{
							type: "text" as const,
							text: delivered
								? "Delivered to the voice observer."
								: "Voice session is not connected.",
						},
					],
					details: { delivered, message },
				};
			},
		});

		pi.registerTool({
			name: "set_harness_status",
			label: "Set Coding Harness Status",
			description:
				'Update the live coding-harness status text in the terminal while realtime voice is running. Use short phrases for in-progress work, and prefer a lasting completion/failure line when done (e.g. "Done: fixed flaky test"). Do not clear the status unless the user asks.',
			promptSnippet: "Update live harness status during realtime voice",
			promptGuidelines: [
				"Keep set_harness_status up to date as work starts and progresses. When work finishes, set a completion or failure status and leave it — do not clear the status line.",
				"Status text is shown in the terminal and is not spoken. Use send_message_to_observer for spoken updates.",
			],
			parameters: setHarnessStatusParams,
			async execute(_id, params: SetHarnessStatusParams) {
				if (!session) {
					throw new Error(
						"Realtime voice is not running. Start it with /realtime-voice-start",
					);
				}
				const status = String(params.status ?? "");
				const delivered = session.setHarnessStatus(status);
				const current = session.getHarnessStatus();
				const text = current
					? `Harness status set: ${current}`
					: "Harness status cleared.";
				return {
					content: [{ type: "text" as const, text }],
					details: { delivered, status: current },
				};
			},
		});

		const active = new Set(pi.getActiveTools());
		for (const name of OBSERVER_TOOL_NAMES) active.add(name);
		pi.setActiveTools([...active]);
		observerToolsActive = true;
	}

	function disableObserverTools(): void {
		if (!observerToolsActive) return;
		const drop = new Set<string>(OBSERVER_TOOL_NAMES);
		pi.setActiveTools(pi.getActiveTools().filter((n) => !drop.has(n)));
		observerToolsActive = false;
	}

	function teardownSession(): void {
		session = null;
		pendingReceipt = null;
		reportedReceipt = null;
		disableObserverTools();
		setFooter(undefined);
		statusCtx?.ui?.setWidget?.("spacexai-caption", undefined);
		dismissVoiceDialog();
	}

	const startVoice = async (
		_args: string,
		ctx: {
			ui: { notify(m: string, l?: string): void };
			hasUI?: boolean;
			modelRegistry: {
				getApiKeyForProvider(provider: string): Promise<string | undefined>;
			};
			sessionManager: {
				buildSessionContext(): { messages: unknown[] };
				getSessionId?: () => string | undefined;
				getSessionDir?: () => string | undefined;
			};
		},
	) => {
			statusCtx = ctx;
			if (session?.connected()) {
				setFooter(`realtime · ${session.voice}`);
				return;
			}
			try {
				const voice = (await deps.readVoice()) || DEFAULT_VOICE;
				let level = 0;
				const showCaption = (who: "you" | "voice", text: string, id: string) => {
					if (!voiceDialog) openVoiceDialog();
					if (!voiceDialog || !id) return;
					const turns = voiceDialog.turns;
					const existing = turns.find((turn) => turn.id === id);
					if (existing) existing.text = text;
					else turns.push({ id, who, text });
					if (turns.length > 30) turns.splice(0, turns.length - 30);
				};
				const paint = () => {
					setFooter(`realtime · ${voice}  ${micMeter(level)}`);
				};
				session = await startRealtimeVoice({
					voice,
					getToken: () => deps.getToken(ctx),
					onLevel: (next) => {
						level = next;
						paint();
					},
					onCaption: (kind, text, id) => {
						showCaption(kind === "user" ? "you" : "voice", text, id);
						paint();
					},
					onStatus: (status) => {
						if (!status || !ctx.hasUI) return;
						const shown = status.length > 400 ? `${status.slice(0, 400)}…` : status;
						ctx.ui.notify(shown, "error");
					},
					onSelfStop: (reason) => {
						teardownSession();
						if (reason === "voice") {
							setFooter(undefined);
							return;
						}
						const shown = reason.length > 400 ? `${reason.slice(0, 400)}…` : reason;
						setFooter(shown);
						if (ctx.hasUI) ctx.ui.notify(shown, "error");
					},
					onSendTask: async (request) => {
						const receipt = `task_${Date.now().toString(36)}`;
						pendingReceipt = receipt;
						reportedReceipt = null;
						pi.sendMessage(
							{
								customType: "spacexai-task",
								content: request,
								display: false,
								details: { source: "observer", receipt, request },
							},
							{ triggerTurn: true, deliverAs: "steer" },
						);
						return { receipt };
					},
					conversations: {
						currentId: () => ctx.sessionManager.getSessionId?.() ?? undefined,
						dir: () => ctx.sessionManager.getSessionDir?.() ?? undefined,
						currentText: () =>
							formatChatLog(ctx.sessionManager.buildSessionContext().messages),
					},
				});
				enableObserverTools();
				openVoiceDialog();
				setFooter(`realtime · ${session.voice}  ${micMeter(0)}`);
			} catch (e) {
				try {
					await session?.stop();
				} catch {
					/* ignore */
				}
				teardownSession();
				ctx.ui.notify(
					`Failed to start realtime voice: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		};

	pi.registerCommand("realtime-voice-start", {
		description:
			"Start Grok speech-to-speech in this terminal (mic + speaker)",
		handler: startVoice,
	});

	pi.registerCommand("realtime-voice-select", {
		description:
			"Set the realtime voice: /realtime-voice-select eve (also used by /listen)",
		handler: async (args, ctx) => {
			statusCtx = ctx;
			const next = args.trim();
			if (!next) {
				const current = (await deps.readVoice()) || DEFAULT_VOICE;
				setFooter(session?.connected() ? `realtime · ${current}` : `voice · ${current}`);
				return;
			}
			await deps.writeVoice(next);
			if (session?.connected()) session.setVoice(next);
			setFooter(session?.connected() ? `realtime · ${next}` : `voice · ${next}`);
		},
	});

	pi.registerCommand("realtime-voice-stop", {
		description: "Stop the realtime voice session",
		handler: async (_args, ctx) => {
			statusCtx = ctx;
			if (!session) {
				ctx.ui.notify("Realtime voice is not running", "warning");
				return;
			}
			await session.stop();
			teardownSession();
		},
	});

	pi.on("agent_end", (event) => {
		if (!session?.connected() || !pendingReceipt) return;
		if (reportedReceipt === pendingReceipt) {
			pendingReceipt = null;
			return;
		}
		const receipt = pendingReceipt;
		pendingReceipt = null;
		const messages = (event as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
		let summary = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role !== "assistant") continue;
			summary = chatText(messages[i].content).replace(/\s+/g, " ").trim();
			if (summary) break;
		}
		if (!summary) summary = "The task finished.";
		if (summary.length > 400) summary = `${summary.slice(0, 400)}…`;
		session.sendToObserver(summary);
		logVoice(`work_landed ${receipt} ${summary}`);
	});

	pi.on("before_agent_start", async (event) => {
		if (!session) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${CODING_AGENT_OBSERVER_PROMPT}`,
		};
	});

	pi.on("session_shutdown", async () => {
		if (session) await session.stop();
		teardownSession();
	});
}
