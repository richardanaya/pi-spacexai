/**
 * Realtime voice observer bridge.
 *
 * Local HTTP server that:
 *  - Serves a browser speech-to-speech client (xAI Realtime via ephemeral token)
 *  - SSE `/api/events` for live status + harness→observer injects + harness status text
 *  - POST `/api/to-harness` when the voice agent calls send_message_to_coding_harness
 *  - In-process sendToObserver() for the pi tool send_message_to_observer
 *  - In-process setHarnessStatus() for the pi tool set_harness_status (SSE → frontend HUD)
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { exec, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const API_BASE = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-voice-latest";
const DEFAULT_PORT = 3847;

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
			'Short status text for the coding harness HUD (what you are doing, or the latest completion). Prefer a lasting completion line like "Done: fixed auth bug" over clearing. Do not pass empty string to clear unless explicitly asked.',
	}),
});
type SetHarnessStatusParams = Static<typeof setHarnessStatusParams>;

/** Appended to the coding agent system prompt while /realtime-voice is running. */
const CODING_AGENT_OBSERVER_PROMPT = `REALTIME VOICE OBSERVER
A voice observer co-pilot is watching this coding harness (started with /realtime-voice). The observer speaks with the user in a browser and cannot read your normal terminal output, tool results, or assistant messages.

You MUST use these tools to keep the observer and user in the loop:
- send_message_to_observer — send a concise update or answer the observer can speak. Call this when work finishes, when answering a question that came from the observer, or when something important happens the user should hear. Bias toward spoken completion messages (what finished and the outcome), not just mid-progress chatter.
- set_harness_status — keep a short live status line on the observer UI up to date. Set it when work starts, update it as you progress, and when finished leave a clear completion status (e.g. "Done: added login tests" or "Failed: type error in auth.ts"). Do NOT clear the status line — leave the latest completion/failure text visible so the observer UI still shows what happened. Only clear if the user explicitly asks you to.

Do not assume the observer saw anything you only printed in the terminal. Prefer short spoken-ready messages.`;

interface RealtimeVoiceOptions {
	/** Fresh xAI bearer (OAuth or API key). */
	getToken: () => Promise<string>;
	/** Prefer config voice (leo, eve, ara, …). Default leo. */
	voice?: string;
	model?: string;
	port?: number;
	/** Inject into the pi coding session. */
	onHarnessMessage: (message: string) => void | Promise<void>;
	/** Called when the server stops itself (browser closed, no SSE clients). */
	onSelfStop?: () => void;
	/** Optional instructions override for the voice agent. */
	instructions?: string;
}

interface RealtimeVoiceServer {
	port: number;
	url: string;
	sendToObserver: (message: string) => boolean;
	/** Push coding-harness status text to the browser HUD over SSE. */
	setHarnessStatus: (status: string) => boolean;
	getHarnessStatus: () => string;
	stop: () => Promise<void>;
	clientCount: () => number;
}

type SseClient = {
	res: ServerResponse;
	id: number;
};

function json(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(data),
		"Cache-Control": "no-store",
	});
	res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function openBrowser(url: string): void {
	// Detached spawn so the pi process is not coupled to the browser lifetime.
	const trySpawn = (command: string, args: string[]): boolean => {
		try {
			const child = spawn(command, args, {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			return true;
		} catch {
			return false;
		}
	};

	if (process.platform === "darwin") {
		if (trySpawn("open", [url])) return;
	} else if (process.platform === "win32") {
		// `start` is a cmd built-in
		if (trySpawn("cmd", ["/c", "start", "", url])) return;
	} else {
		// Linux / BSD: prefer xdg-open, then common browsers.
		for (const cmd of [
			"xdg-open",
			"gio",
			"gnome-open",
			"kde-open",
			"firefox",
			"chromium",
			"google-chrome",
			"chrome",
		]) {
			if (cmd === "gio") {
				if (trySpawn("gio", ["open", url])) return;
				continue;
			}
			if (trySpawn(cmd, [url])) return;
		}
	}

	// Last resort: shell (may still work when PATH differs for non-login shells).
	let shellCmd = `xdg-open ${JSON.stringify(url)}`;
	if (process.platform === "darwin") shellCmd = `open ${JSON.stringify(url)}`;
	else if (process.platform === "win32")
		shellCmd = `start "" ${JSON.stringify(url)}`;
	exec(shellCmd, () => {});
}

const DEFAULT_VOICE = "leo";

const DEFAULT_INSTRUCTIONS = `You are the voice co-pilot for a coding session powered by pi. You speak with the user in real time.

Core rule: silently delegate real work to the coding agent via send_message_to_coding_harness — and never mention that agent, the harness, the handoff, or that you are waiting on anything. To the user, you are simply doing the work.

How to sound:
- Short natural acks while work is out: "On it!", "One moment.", "Working on that.", "Got it."
- Never say: coding harness/agent, "I'll send that", "waiting on", "when it's done", "I told the terminal", tool relays, or any back-channel.
- When [coding_harness] updates arrive, treat them as your own results and speak the substance in first person ("Done — fixed the auth bug."). Do not say you received a message from anywhere.

What to do:
- Answer quick questions yourself when you can.
- For code changes, investigation, runs, deep explanations, or media: call send_message_to_coding_harness with a clear self-contained instruction, then ack like you're on it.
- For opening a page/docs/PR/URL: call open_browser_tab with a full http(s) URL.

Media you can take on (silent delegate — never name the handoff):
- Images: Grok Imagine generate/edit (text-to-image, multi-image edit, aspect ratio, 1K/2K).
- Video: image-to-video, reference-to-video, edit, short extensions.
- Speech files: text-to-speech to a path; speech-to-text from files/URLs.
Spell out paths and preferences in the delegated task, then say something like "On it — generating that now."

Keep spoken replies concise. Prefer short turns.`;

function clientHtml(opts: { model: string; voice: string }): string {
	const model = JSON.stringify(opts.model);
	const voice = JSON.stringify(opts.voice);
	const instructions = JSON.stringify(DEFAULT_INSTRUCTIONS);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>voice</title>
<style>
  html, body { margin:0; height:100%; overflow:hidden; background:#000; color:#e8e8e8;
    font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
  ::selection { background:rgba(255,255,255,.88); color:#000;
    text-shadow:none; }
  ::-moz-selection { background:rgba(255,255,255,.88); color:#000;
    text-shadow:none; }
  #c { position:fixed; inset:0; width:100%; height:100%; display:block; }
  #hud { position:fixed; left:0; right:0; bottom:0; padding:18px 20px 22px;
    display:flex; flex-direction:column; align-items:center; gap:8px;
    pointer-events:none; z-index:2;
    background: linear-gradient(to top, rgba(0,0,0,.55) 0%, transparent 100%); }
  #caption { max-width:min(760px, 92vw); width:100%; text-align:center; min-height:1.5em;
    max-height:min(22vh, 180px); overflow-x:hidden; overflow-y:auto;
    overscroll-behavior:contain; scrollbar-width:thin;
    scrollbar-color:rgba(255,255,255,.12) transparent;
    color:rgba(255,255,255,.85); letter-spacing:.015em; font-weight:450;
    font-size:19px; line-height:1.5; text-shadow:0 1px 12px rgba(0,0,0,.7);
    text-wrap:pretty; transition: opacity .25s;
    pointer-events:auto; user-select:text; -webkit-user-select:text; cursor:text;
    -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
    -webkit-mask-size:100% 100%; mask-size:100% 100%; }
  #caption::-webkit-scrollbar { width:3px; background:transparent; }
  #caption::-webkit-scrollbar-track { background:transparent; }
  #caption::-webkit-scrollbar-thumb {
    background:rgba(255,255,255,.10); border-radius:999px;
    border:1px solid transparent; background-clip:padding-box; }
  #caption::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.18); }
  #caption::-webkit-scrollbar-corner { background:transparent; }
  #caption a { color:#fff; text-decoration:underline;
    text-decoration-color:rgba(255,255,255,.45); text-underline-offset:4px;
    text-decoration-thickness:1px; cursor:pointer; border-radius:3px;
    padding:0 2px; transition:background .15s, text-decoration-color .15s;
    word-break:break-all; }
  #caption a:hover { background:rgba(255,255,255,.10);
    text-decoration-color:#fff; }
  #caption a:visited { color:rgba(255,255,255,.6); }
  #caption.dim { opacity:.35; }
  #harness { max-width:min(760px, 92vw); width:100%; text-align:center;
    min-height:0; font-size:11px; letter-spacing:.14em; text-transform:uppercase;
    color:rgba(255,255,255,.42); text-shadow:0 1px 10px rgba(0,0,0,.6);
    transition: opacity .3s, color .3s; opacity:0; pointer-events:none;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #harness.on { opacity:1; color:rgba(255,255,255,.62); }
  #meta { font-size:11px; letter-spacing:.18em; text-transform:uppercase;
    color:rgba(255,255,255,.28); }
  #meta.live { color:rgba(255,255,255,.55); }
  #meta .dot { display:inline-block; width:6px; height:6px; border-radius:50%;
    background:rgba(255,255,255,.25); margin-right:8px; vertical-align:middle;
    box-shadow:0 0 0 0 rgba(255,255,255,.4); }
  #meta.live .dot { background:#fff; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse {
    0%,100% { box-shadow:0 0 0 0 rgba(255,255,255,.35); }
    50% { box-shadow:0 0 0 6px rgba(255,255,255,0); }
  }
  #hint { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    z-index:3; color:rgba(255,255,255,.4); font-size:12px; letter-spacing:.2em;
    text-transform:uppercase; pointer-events:none; transition:opacity .6s; }
  #hint.hide { opacity:0; }
  #voiceBtn { pointer-events:auto; cursor:pointer; border:none; background:none;
    color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit;
    padding:2px 4px; border-bottom:1px dotted rgba(255,255,255,.25);
    transition:color .2s, border-color .2s; }
  #voiceBtn:hover { color:rgba(255,255,255,.85); border-bottom-color:rgba(255,255,255,.7); }
  #voiceOverlay { position:fixed; inset:0; z-index:10; display:flex;
    align-items:center; justify-content:center; background:rgba(0,0,0,.45);
    backdrop-filter: blur(6px); opacity:0; pointer-events:none;
    transition:opacity .2s; }
  #voiceOverlay.open { opacity:1; pointer-events:auto; }
  #voiceDialog { min-width:320px; max-width:min(620px, 94vw);
    max-height:70vh; overflow-y:auto;
    background:rgba(10,10,12,.82); border:1px solid rgba(255,255,255,.12);
    border-radius:14px; padding:18px 12px 12px; box-shadow:0 20px 60px rgba(0,0,0,.6);
    transform:translateY(6px) scale(.98); transition:transform .2s; }
  #voiceOverlay.open #voiceDialog { transform:none; }
  #voiceDialog h2 { margin:0 0 12px; font-size:11px; font-weight:500;
    letter-spacing:.22em; text-transform:uppercase; color:rgba(255,255,255,.4);
    text-align:center; }
  #voiceList { display:grid; grid-template-columns:repeat(3, 1fr); gap:4px; }
  .voiceRow { display:flex; align-items:center; justify-content:center;
    padding:10px 8px; border:none; background:none; cursor:pointer;
    color:rgba(255,255,255,.72); font-size:13px; letter-spacing:.06em;
    border-radius:10px; transition:background .15s, color .15s; text-align:center;
    min-width:0; }
  .voiceRow:hover { background:rgba(255,255,255,.07); color:#fff; }
  .voiceRow.current { color:#fff; background:rgba(255,255,255,.10);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.22); }
  .voiceRow .vname { text-transform:capitalize; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  @media (max-width:480px) { #voiceList { grid-template-columns:repeat(2, 1fr); } }
</style>
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js" } }
</script>
</head>
<body>
<canvas id="c"></canvas>
<div id="hint">listening</div>
<div id="hud">
  <div id="harness" aria-live="polite"></div>
  <div id="caption" class="dim"></div>
  <div id="meta"><span class="dot"></span><button id="voiceBtn" type="button" title="change voice"><span id="status">connecting</span></button></div>
</div>
<div id="voiceOverlay">
  <div id="voiceDialog" role="dialog" aria-label="Choose voice">
    <h2>voice</h2>
    <div id="voiceList"></div>
  </div>
</div>
<script type="module">
import * as THREE from "three";

const MODEL = ${model};
const SERVER_VOICE = ${voice};
const VOICE_KEY = "pi-realtime-voice";
let VOICE = localStorage.getItem(VOICE_KEY) || SERVER_VOICE;
const INSTRUCTIONS = ${instructions};
const SAMPLE_RATE = 24000;

const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const harnessEl = document.getElementById("harness");
const captionEl = document.getElementById("caption");
const hintEl = document.getElementById("hint");
const canvas = document.getElementById("c");

let ws = null;
let es = null;
let audioCtx = null;
let mediaStream = null;
let processor = null;
let sourceNode = null;
let masterGain = null;
let analyser = null;
let analyserBuf = null;
let playing = [];
let nextPlayTime = 0;
let assistantBuf = "";
let speakEnergy = 0;
let speakPeak = 0.02;
let connected = false;
/** True between response.created and response.done/cancelled. */
let responseActive = false;
/** Harness inject arrived mid-response — create a follow-up turn when idle. */
let pendingHarnessResponse = false;

function setStatus(text, live) {
  statusEl.textContent = text;
  metaEl.classList.toggle("live", !!live);
}
function setHarnessStatusUi(text) {
  const t = (text || "").trim();
  harnessEl.textContent = t;
  harnessEl.classList.toggle("on", !!t);
  harnessEl.title = t;
}
// Escape-free linkifier: tokens split by whitespace char codes (no backslashes,
// so template-literal layers and formatters can't corrupt the patterns).
// Handles both http(s):// URLs and bare domains like google.com or docs.x.ai/x.
const TOKEN_RE = new RegExp("[^" + String.fromCharCode(9, 10, 13, 32) + "]+", "g");
const LEAD_CHARS = "(<[" + String.fromCharCode(34) + "'";
const TRAIL_CHARS = ".,;:!?)]>}" + String.fromCharCode(34) + "'";

function splitToken(tok) {
  let lead = "";
  while (tok.length && LEAD_CHARS.includes(tok[0])) {
    lead += tok[0];
    tok = tok.slice(1);
  }
  let trail = "";
  while (tok.length && TRAIL_CHARS.includes(tok[tok.length - 1])) {
    trail = tok[tok.length - 1] + trail;
    tok = tok.slice(0, -1);
  }
  return { lead, core: tok, trail };
}

function isAlpha(s) {
  for (const ch of s) {
    const c = ch.toLowerCase();
    if (c < "a" || c > "z") return false;
  }
  return s.length > 0;
}

function isDomain(s) {
  const host = s.split("/")[0].split("?")[0].split("#")[0];
  if (host.length < 4 || host.length > 253) return false;
  if (!host.includes(".")) return false;
  if (host.includes("_") || host.includes("@")) return false;
  const parts = host.split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1];
  if (tld.length < 2 || tld.length > 24 || !isAlpha(tld)) return false;
  for (const p of parts) {
    if (!p.length || p.length > 63) return false;
    if (p.startsWith("-") || p.endsWith("-")) return false;
    for (const ch of p) {
      const c = ch.toLowerCase();
      const ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || ch === "-";
      if (!ok) return false;
    }
  }
  return true;
}

function classifyLink(core) {
  if (!core || core.includes("@")) return null;
  if (core.startsWith("http://") || core.startsWith("https://")) return { href: core };
  if (core.includes("://")) return null;
  if (isDomain(core)) return { href: "https://" + core };
  return null;
}

function setCaption(text, kind) {
  captionEl.textContent = "";
  const value = text || "";
  if (value) {
    let last = 0;
    for (const m of value.matchAll(TOKEN_RE)) {
      const idx = m.index ?? 0;
      const t = splitToken(m[0]);
      const link = classifyLink(t.core);
      if (!link) continue;
      if (idx > last) captionEl.appendChild(document.createTextNode(value.slice(last, idx)));
      if (t.lead) captionEl.appendChild(document.createTextNode(t.lead));
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = t.core;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.addEventListener("click", (ev) => ev.stopPropagation());
      captionEl.appendChild(a);
      if (t.trail) captionEl.appendChild(document.createTextNode(t.trail));
      last = idx + m[0].length;
    }
    if (last < value.length) captionEl.appendChild(document.createTextNode(value.slice(last)));
  }
  captionEl.classList.toggle("dim", !value);
  captionEl.dataset.kind = kind || "";
  // Keep latest text in view, then refresh edge feathers
  captionEl.scrollTop = captionEl.scrollHeight;
  updateCaptionMask();
}

// Feather top/bottom of the scroll area when content overflows mid-scroll
function updateCaptionMask() {
  const el = captionEl;
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 2) {
    el.style.webkitMaskImage = "none";
    el.style.maskImage = "none";
    return;
  }
  const atTop = el.scrollTop <= 1;
  const atBottom = el.scrollTop >= maxScroll - 1;
  const fade = 28; // px feather
  let mask;
  if (atTop && !atBottom) {
    mask = "linear-gradient(to bottom, #000 0%, #000 calc(100% - " + fade + "px), transparent 100%)";
  } else if (atBottom && !atTop) {
    mask = "linear-gradient(to bottom, transparent 0%, #000 " + fade + "px, #000 100%)";
  } else if (!atTop && !atBottom) {
    mask = "linear-gradient(to bottom, transparent 0%, #000 " + fade + "px, #000 calc(100% - " + fade + "px), transparent 100%)";
  } else {
    mask = "none";
  }
  el.style.webkitMaskImage = mask;
  el.style.maskImage = mask;
}
captionEl.addEventListener("scroll", updateCaptionMask, { passive: true });
addEventListener("resize", updateCaptionMask);

function line(_cls, text) {
  // Minimal: surface only meaningful captions; keep console for debug.
  if (_cls === "err") {
    setCaption(text, "err");
    console.error(text);
  } else if (_cls === "assistant") {
    setCaption(text.replace(/^assistant:\\s*/i, ""), "assistant");
  } else if (_cls === "user") {
    setCaption(text.replace(/^you:\\s*/i, ""), "user");
  } else if (_cls === "tool" || _cls === "sys") {
    console.log(text);
  }
}

/* ─── Three.js: glass orb holding a living galaxy (B&W) ─── */
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const CAM_Z = 4.25;
// Overall orb size on screen (1 = fills center ~40% viewport)
const ORB_SCALE = 0.4;
camera.position.set(0, 0, CAM_Z);
camera.lookAt(0, 0, 0);

/* Textures */
function makeGlowTexture(size, core) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2;
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grd.addColorStop(0, 'rgba(255,255,255,' + core + ')');
  grd.addColorStop(0.2, 'rgba(255,255,255,' + (core * 0.5) + ')');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStarTexture(size, core) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2;
  // soft halo
  let grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grd.addColorStop(0, 'rgba(255,255,255,' + core + ')');
  grd.addColorStop(0.08, 'rgba(255,255,255,' + (core * 0.95) + ')');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.30)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.07)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  // diffraction spikes (thin cross + faint diagonals)
  g.globalCompositeOperation = 'lighter';
  function spike(angle, len, thick, alpha) {
    g.save();
    g.translate(cx, cy);
    g.rotate(angle);
    const gr = g.createLinearGradient(-len, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(255,255,255,' + alpha + ')');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(-len, -thick / 2, len * 2, thick);
    g.restore();
  }
  spike(0, r * 0.98, 1.6, core * 0.7);
  spike(Math.PI / 2, r * 0.98, 1.6, core * 0.7);
  spike(Math.PI / 4, r * 0.5, 1.0, core * 0.22);
  spike(-Math.PI / 4, r * 0.5, 1.0, core * 0.22);
  // hot center pixel
  grd = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.06);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const starTex = makeStarTexture(128, 1.0);
const starSoftTex = makeStarTexture(128, 0.72);
const glowTex = makeGlowTexture(256, 0.85);

/* Sampling helpers */
function randomInBall(rMin, rMax) {
  const u = Math.random(), v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const rr = rMin + Math.cbrt(Math.random()) * (rMax - rMin);
  return [
    rr * Math.sin(phi) * Math.cos(theta),
    rr * Math.sin(phi) * Math.sin(theta),
    rr * Math.cos(phi),
  ];
}
function gaussish() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

/* Shader star field — per-star twinkle + voice boost */
const starVert = [
  'attribute float aSize;',
  'attribute float aPhase;',
  'attribute float aBrightness;',
  'attribute float aSpeed;',
  'uniform float uTime;',
  'uniform float uEnergy;',
  'uniform float uProj;',
  'varying float vAlpha;',
  'varying float vBright;',
  'void main() {',
    'vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    'float tw = sin(uTime * aSpeed + aPhase * 6.28318);',
    'tw = 0.72 + 0.28 * tw;',
    'float boost = 1.0 + uEnergy * (0.45 + aBrightness * 0.85);',
    'vBright = aBrightness;',
    'vAlpha = clamp(aBrightness * tw * (0.62 + 0.5 * uEnergy), 0.0, 1.0);',
    'gl_PointSize = aSize * boost * (0.82 + 0.36 * tw) * (uProj / -mv.z);',
    'gl_Position = projectionMatrix * mv;',
  '}',
].join(String.fromCharCode(10));
const starFrag = [
  'uniform sampler2D uMap;',
  'varying float vAlpha;',
  'varying float vBright;',
  'void main() {',
    'vec4 tex = texture2D(uMap, gl_PointCoord);',
    'float a = tex.a * vAlpha;',
    'if (a < 0.012) discard;',
    'gl_FragColor = vec4(tex.rgb, a);',
  '}',
].join(String.fromCharCode(10));

function makeStars(opts) {
  const count = opts.count;
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const bright = new Float32Array(count);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = opts.sampler(i);
    pos[i*3] = p[0]; pos[i*3+1] = p[1]; pos[i*3+2] = p[2];
    size[i] = opts.sizeMin + Math.random() * (opts.sizeMax - opts.sizeMin);
    phase[i] = Math.random();
    const roll = Math.random();
    const hero = roll > opts.heroCut;
    bright[i] = hero ? 0.85 + Math.random() * 0.15 : opts.brightMin + Math.random() * (opts.brightMax - opts.brightMin);
    if (hero) size[i] *= 1.9;
    speed[i] = 0.4 + Math.random() * 2.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aBrightness', new THREE.BufferAttribute(bright, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uProj: { value: 380 },
      uMap: { value: opts.tex },
    },
    vertexShader: starVert,
    fragmentShader: starFrag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

/* Scene graph */
const world = new THREE.Group();
scene.add(world);

const bgStars = makeStars({
  count: 1100,
  tex: starSoftTex,
  sampler: () => randomInBall(9, 42),
  sizeMin: 0.05, sizeMax: 0.14,
  brightMin: 0.18, brightMax: 0.5,
  heroCut: 0.965,
});
world.add(bgStars);

const orb = new THREE.Group();
world.add(orb);

/* Interior: dust, mid stars, heroes, spiral galaxy, nebula wisps */
const inner = new THREE.Group();
orb.add(inner);

const dust = makeStars({
  count: 2600,
  tex: starSoftTex,
  sampler: () => randomInBall(0.05, 0.84),
  sizeMin: 0.012, sizeMax: 0.03,
  brightMin: 0.10, brightMax: 0.32,
  heroCut: 0.995,
});
inner.add(dust);

const midStars = makeStars({
  count: 420,
  tex: starTex,
  sampler: () => randomInBall(0.08, 0.8),
  sizeMin: 0.03, sizeMax: 0.06,
  brightMin: 0.35, brightMax: 0.7,
  heroCut: 0.94,
});
inner.add(midStars);

const heroStars = makeStars({
  count: 34,
  tex: starTex,
  sampler: () => randomInBall(0.14, 0.66),
  sizeMin: 0.09, sizeMax: 0.16,
  brightMin: 0.9, brightMax: 1.0,
  heroCut: 0.5,
});
inner.add(heroStars);

/* Spiral galaxy disc tilted inside the orb */
const galaxyGroup = new THREE.Group();
galaxyGroup.rotation.x = 0.9;
galaxyGroup.rotation.z = 0.35;
inner.add(galaxyGroup);

function spiralSampler(arms, rMax, thin) {
  return () => {
    const arm = Math.floor(Math.random() * arms);
    const t = Math.pow(Math.random(), 0.62);
    const r = 0.04 + t * rMax;
    const wind = 3.1;
    const spread = (1 - t * 0.75) * 0.5;
    const a = (arm / arms) * Math.PI * 2 + r * wind + gaussish() * spread;
    const y = gaussish() * thin * (0.25 + t * 0.75);
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
}
const spiralArms = makeStars({
  count: 1900,
  tex: starSoftTex,
  sampler: spiralSampler(3, 0.72, 0.05),
  sizeMin: 0.012, sizeMax: 0.032,
  brightMin: 0.16, brightMax: 0.5,
  heroCut: 0.985,
});
galaxyGroup.add(spiralArms);

const spiralBright = makeStars({
  count: 130,
  tex: starTex,
  sampler: spiralSampler(3, 0.7, 0.04),
  sizeMin: 0.03, sizeMax: 0.06,
  brightMin: 0.55, brightMax: 0.95,
  heroCut: 0.9,
});
galaxyGroup.add(spiralBright);

/* Nebula wisps (soft billboards) */
function makeWisp(x, y, z, scale, opacity) {
  const mat = new THREE.SpriteMaterial({
    map: glowTex, transparent: true, opacity: opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sp = new THREE.Sprite(mat);
  sp.position.set(x, y, z);
  sp.scale.setScalar(scale);
  return sp;
}
const wisps = new THREE.Group();
wisps.add(makeWisp( 0.25,  0.15, -0.2, 0.85, 0.05));
wisps.add(makeWisp(-0.3, -0.1,   0.1, 0.7, 0.04));
wisps.add(makeWisp( 0.0,  -0.3, -0.05, 0.55, 0.045));
wisps.add(makeWisp(-0.12, 0.32,  0.18, 0.5, 0.04));
inner.add(wisps);

/* Bright galactic heart */
const heartMat = new THREE.SpriteMaterial({
  map: glowTex, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const heart = new THREE.Sprite(heartMat);
heart.scale.setScalar(0.5);
inner.add(heart);
const heartCore = new THREE.Mesh(
  new THREE.SphereGeometry(0.035, 24, 24),
  new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }),
);
inner.add(heartCore);

/* Orbit rings (thin, tilted) */
function makeRing(radius, tilt, opacity) {
  const seg = 160;
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  line.rotation.x = tilt;
  return line;
}
const ringA = makeRing(0.62, 1.05, 0.10);
const ringB = makeRing(0.5, -0.7, 0.07);
inner.add(ringA, ringB);

/* Glass shell: fresnel rim + slow sheen sweep (see-through, depthWrite off) */
const glassVert = [
  'varying vec3 vNormal;',
  'varying vec3 vView;',
  'varying vec3 vWorld;',
  'void main() {',
    'vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    'vNormal = normalize(normalMatrix * normal);',
    'vView = normalize(-mv.xyz);',
    'vWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
    'gl_Position = projectionMatrix * mv;',
  '}',
].join(String.fromCharCode(10));
const glassFrag = [
  'uniform float uRimPower;',
  'uniform float uRimStrength;',
  'uniform float uFill;',
  'uniform float uEnergy;',
  'uniform float uTime;',
  'varying vec3 vNormal;',
  'varying vec3 vView;',
  'varying vec3 vWorld;',
  'void main() {',
    'vec3 n = normalize(vNormal);',
    'vec3 v = normalize(vView);',
    'float ndv = abs(dot(n, v));',
    'float fres = pow(1.0 - clamp(ndv, 0.0, 1.0), uRimPower);',
    'float rim = fres * uRimStrength;',
    // moving sheen band sweeping over the surface
    'float sweep = sin(vWorld.x * 2.4 + vWorld.y * 3.1 + uTime * 0.7);',
    'sweep = smoothstep(0.75, 1.0, sweep) * 0.10 * (0.4 + uEnergy);',
    'float fill = uFill + uEnergy * 0.035;',
    'float alpha = clamp(rim + fill + sweep, 0.0, 0.95);',
    'float lum = clamp(0.5 + rim * 1.1 + sweep * 2.0 + uEnergy * 0.2, 0.0, 1.0);',
    'gl_FragColor = vec4(vec3(lum), alpha);',
  '}',
].join(String.fromCharCode(10));
const glassUniforms = {
  uRimPower: { value: 3.0 },
  uRimStrength: { value: 0.95 },
  uFill: { value: 0.028 },
  uEnergy: { value: 0 },
  uTime: { value: 0 },
};
const glass = new THREE.Mesh(
  new THREE.SphereGeometry(1.0, 128, 128),
  new THREE.ShaderMaterial({
    uniforms: glassUniforms,
    vertexShader: glassVert,
    fragmentShader: glassFrag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }),
);
glass.renderOrder = 3;
orb.add(glass);

/* Crisp limb edge */
const limbFrag = [
  'uniform float uEnergy;',
  'varying vec3 vNormal;',
  'varying vec3 vView;',
  'varying vec3 vWorld;',
  'void main() {',
    'float ndv = clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);',
    'float edge = pow(1.0 - ndv, 6.0);',
    'gl_FragColor = vec4(vec3(1.0), edge * (0.5 + uEnergy * 0.5));',
  '}',
].join(String.fromCharCode(10));
const limb = new THREE.Mesh(
  new THREE.SphereGeometry(1.004, 128, 128),
  new THREE.ShaderMaterial({
    uniforms: { uEnergy: { value: 0 } },
    vertexShader: glassVert,
    fragmentShader: limbFrag,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
  }),
);
limb.renderOrder = 4;
orb.add(limb);

/* Halo behind the orb + glass glint */
const haloMat = new THREE.SpriteMaterial({
  map: glowTex, transparent: true, opacity: 0.16,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const halo = new THREE.Sprite(haloMat);
halo.scale.setScalar(3.4);
halo.position.z = -0.4;
orb.add(halo);

const glint = makeWisp(0.38, 0.44, 0.82, 0.35, 0.5);
orb.add(glint);

function resize() {
  const w = Math.max(1, innerWidth);
  const h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  camera.position.set(0, 0, CAM_Z);
  camera.lookAt(0, 0, 0);
}
addEventListener('resize', resize);
resize();

let t0 = performance.now();
let lastFrame = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const t = (now - t0) / 1000;
  const dt = Math.min(0.1, Math.max(0.001, (now - lastFrame) / 1000));
  lastFrame = now;
  // Voice-reactive energy: read the ACTUAL speaker output (analyser tap on
  // masterGain), so visuals track exactly what the user hears — including
  // buffered playback timing and barge-in cuts.
  let level = 0;
  if (analyser && analyserBuf) {
    analyser.getFloatTimeDomainData(analyserBuf);
    let sum = 0;
    for (let i = 0; i < analyserBuf.length; i++) sum += analyserBuf[i] * analyserBuf[i];
    const rms = Math.sqrt(sum / analyserBuf.length);
    // AGC: normalize against a rolling peak so quiet speech still registers
    if (rms > speakPeak) speakPeak = speakPeak * 0.6 + rms * 0.4;
    else speakPeak *= 0.9995;
    const norm = rms / Math.max(speakPeak, 0.003);
    // Perceptual lift: quiet passages still move the orb
    level = Math.min(1, Math.pow(Math.min(norm, 1.5), 0.55) * 1.2);
  }
  // Fast attack, slow time-based release
  if (level > speakEnergy) speakEnergy += (level - speakEnergy) * (1 - Math.pow(0.00005, dt));
  else speakEnergy *= Math.pow(0.05, dt);
  const e = Math.min(1, speakEnergy);

  orb.position.set(0, 0, 0);
  const breathe = ORB_SCALE * (1 + Math.sin(t * 0.8) * 0.01 + e * 0.13);
  orb.scale.setScalar(breathe);

  // Interior motion
  inner.rotation.y = t * 0.05;
  dust.rotation.y = -t * 0.03;
  midStars.rotation.y = t * (0.07 + e * 0.3);
  heroStars.rotation.y = -t * (0.05 + e * 0.25);
  galaxyGroup.rotation.y = t * (0.12 + e * 0.85);
  wisps.rotation.y = -t * 0.02;
  ringA.rotation.z = t * 0.06;
  ringB.rotation.z = -t * 0.045;

  // Heart pulse — the visual core of the voice
  const pulse = 1 + Math.sin(t * 2.6) * 0.06;
  heart.scale.setScalar((0.42 + e * 0.55) * pulse);
  heartMat.opacity = 0.55 + e * 0.45;
  heartCore.scale.setScalar(1 + e * 2.0 + Math.sin(t * 5) * 0.12);
  heartCore.material.opacity = 0.7 + e * 0.3;

  // Uniform updates
  const mats = [dust.material, midStars.material, heroStars.material,
                spiralArms.material, spiralBright.material, bgStars.material];
  for (const m of mats) {
    m.uniforms.uTime.value = t;
    m.uniforms.uEnergy.value = e;
  }
  bgStars.material.uniforms.uEnergy.value = e * 0.35;

  glassUniforms.uTime.value = t;
  glassUniforms.uEnergy.value = e;
  glassUniforms.uFill.value = 0.026 + e * 0.03;
  glassUniforms.uRimStrength.value = 0.9 + e * 0.25;
  limb.material.uniforms.uEnergy.value = e;
  haloMat.opacity = 0.12 + e * 0.16;
  glint.material.opacity = 0.35 + e * 0.5;
  glint.scale.setScalar(0.3 + e * 0.35);

  bgStars.rotation.y = t * 0.004;

  // Very slow camera orbit (~2.3 min per revolution) + gentle vertical drift.
  // Orb stays centered since we always look at the origin.
  const orbitA = t * 0.045;
  camera.position.set(
    Math.sin(orbitA) * CAM_Z,
    Math.sin(t * 0.06) * 0.55,
    Math.cos(orbitA) * CAM_Z,
  );
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

/* ─── audio helpers ─── */
function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
function b64FromPCM16(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function pcm16FromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
function playPcm16(int16) {
  if (!audioCtx || !masterGain) return;
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  const buf = audioCtx.createBuffer(1, f32.length, SAMPLE_RATE);
  buf.copyToChannel(f32, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(masterGain);
  const now = audioCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.02;
  src.start(nextPlayTime);
  nextPlayTime += buf.duration;
  playing.push(src);
  src.onended = () => { playing = playing.filter(s => s !== src); };
}

function stopPlayback() {
  for (const s of playing) { try { s.stop(); } catch {} }
  playing = [];
  nextPlayTime = 0;
  speakEnergy = 0;
}

async function fetchClientSecret() {
  const r = await fetch("/api/client-secret", { method: "POST" });
  if (!r.ok) throw new Error("client-secret " + r.status + ": " + await r.text());
  const data = await r.json();
  const token = data.value || data.client_secret || data.secret || data.token;
  if (!token) throw new Error("no ephemeral token in response: " + JSON.stringify(data));
  return token;
}

function sendJson(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sessionUpdate() {
  sendJson({
    type: "session.update",
    session: {
      voice: VOICE,
      instructions: INSTRUCTIONS,
      turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
      audio: {
        input: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
        output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
      },
      tools: [
        {
          type: "function",
          name: "send_message_to_coding_harness",
          description: "Send a message or task to the pi coding harness so it can edit code, run commands, or answer with project context. Use for anything that needs the codebase or terminal agent.",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "Clear instruction or question for the coding agent" },
            },
            required: ["message"],
          },
        },
        {
          type: "function",
          name: "open_browser_tab",
          description: "Open a URL in the user's default browser (new tab/window). Use when the user asks to open docs, a site, a PR, localhost app, or any link.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Absolute http:// or https:// URL to open" },
            },
            required: ["url"],
          },
        },
        { type: "web_search" },
      ],
    },
  });
}

async function handleFunctionCall(event) {
  const name = event.name;
  const callId = event.call_id;
  let args = {};
  try { args = JSON.parse(event.arguments || "{}"); } catch {}
  line("tool", "tool → " + name + " " + JSON.stringify(args));

  let output = { ok: true };
  if (name === "send_message_to_coding_harness") {
    const message = String(args.message || "").trim();
    if (!message) output = { ok: false, error: "empty message" };
    else {
      try {
        const r = await fetch("/api/to-harness", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) output = { ok: false, error: body.error || r.statusText };
        else output = { ok: true, delivered: true };
      } catch (e) {
        output = { ok: false, error: String(e.message || e) };
      }
    }
  } else if (name === "open_browser_tab") {
    const url = String(args.url || "").trim();
    if (!url) output = { ok: false, error: "url required" };
    else {
      try {
        const r = await fetch("/api/open-tab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) output = { ok: false, error: body.error || r.statusText };
        else {
          try { window.open(url, "_blank", "noopener,noreferrer"); } catch {}
          output = { ok: true, opened: true, url: body.url || url };
          line("sys", "opened tab: " + (body.url || url));
        }
      } catch (e) {
        output = { ok: false, error: String(e.message || e) };
      }
    }
  } else {
    output = { ok: false, error: "unknown function " + name };
  }

  sendJson({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
  });
  setTimeout(() => sendJson({ type: "response.create" }), 250);
}

/* Idle disconnect: 5 min of silence → close realtime WS ($0.05/min meter).
   1 min warning first. Any speech / audio / tool / harness inject resets the clock. */
const IDLE_DISCONNECT_MS = 5 * 60 * 1000;
const IDLE_WARN_MS = 60 * 1000;
let idleTimer = null;
let idleWarnTimer = null;
let idleDisconnecting = false;

function clearIdleTimers() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (idleWarnTimer) { clearTimeout(idleWarnTimer); idleWarnTimer = null; }
}

function touchActivity() {
  clearIdleTimers();
  if (!connected) return;
  idleWarnTimer = setTimeout(() => {
    if (!connected) return;
    setCaption("disconnecting in 1 minute — speak or click the sphere to stay", "sys");
  }, IDLE_DISCONNECT_MS - IDLE_WARN_MS);
  idleTimer = setTimeout(() => {
    if (!connected) return;
    idleDisconnecting = true;
    setCaption("idle — click the sphere to reconnect", "sys");
    if (ws) { try { ws.close(); } catch {} }
  }, IDLE_DISCONNECT_MS);
}

function injectObserverMessage(message) {
  const text = "[coding_harness] " + message;
  line("sys", "harness → observer: " + message);
  touchActivity();
  // Do not cancel an in-flight voice response — queue the harness update into
  // the conversation and only request a new response when the model is idle.
  // Creating a response while one is active confuses the realtime API.
  sendJson({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
  if (!responseActive) {
    sendJson({ type: "response.create" });
  } else {
    // Model will pick up the new item after the current response finishes;
    // kick a follow-up turn once it does.
    pendingHarnessResponse = true;
  }
}

function onServerEvent(event) {
  const t = event.type;
  // Any realtime traffic counts as activity (speech, audio, tools, session).
  if (t !== "error") touchActivity();
  if (t === "response.created") {
    responseActive = true;
    return;
  }
  if (t === "response.done" || t === "response.cancelled") {
    responseActive = false;
    if (pendingHarnessResponse) {
      pendingHarnessResponse = false;
      sendJson({ type: "response.create" });
    }
    return;
  }
  if (t === "response.output_audio.delta" || t === "response.audio.delta") {
    const b64 = event.delta || event.audio;
    if (b64) playPcm16(pcm16FromB64(b64));
    return;
  }
  if (t === "response.output_audio_transcript.delta" || t === "response.audio_transcript.delta") {
    assistantBuf += event.delta || "";
    if (assistantBuf) setCaption(assistantBuf, "assistant");
    return;
  }
  if (t === "response.output_audio_transcript.done" || t === "response.audio_transcript.done") {
    const text = (event.transcript || assistantBuf || "").trim();
    if (text) setCaption(text, "assistant");
    assistantBuf = "";
    return;
  }
  if (t === "conversation.item.input_audio_transcription.completed" ||
      t === "conversation.item.input_audio_transcription.done") {
    const text = (event.transcript || "").trim();
    if (text) setCaption(text, "user");
    return;
  }
  if (t === "response.function_call_arguments.done") {
    handleFunctionCall(event);
    return;
  }
  if (t === "input_audio_buffer.speech_started") {
    stopPlayback();
    return;
  }
  if (t === "error") {
    const err = event.error || event;
    const msg = String(err.message || err || "");
    // Benign race: cancel after the response already finished.
    if (/no active response/i.test(msg) || /Cancellation failed/i.test(msg)) {
      responseActive = false;
      console.debug("realtime cancel ignored:", msg);
      return;
    }
    line("err", "error: " + JSON.stringify(err));
    return;
  }
  if (t === "session.updated" || t === "session.created") {
    setStatus(VOICE, true);
    hintEl.classList.add("hide");
    return;
  }
}

async function startMic() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (audioCtx.state === "suspended") await audioCtx.resume();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;
  // Tap the real output for visuals: masterGain → analyser → destination
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  masterGain.connect(analyser);
  analyser.connect(audioCtx.destination);
  analyserBuf = new Float32Array(analyser.fftSize);
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(processor);
  // mute local mic monitoring
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(audioCtx.destination);
  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    sendJson({ type: "input_audio_buffer.append", audio: b64FromPCM16(floatTo16BitPCM(input)) });
  };
}

function stopMic() {
  try { processor && processor.disconnect(); } catch {}
  try { sourceNode && sourceNode.disconnect(); } catch {}
  processor = null;
  sourceNode = null;
  masterGain = null;
  analyser = null;
  analyserBuf = null;
  speakPeak = 0.02;
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) t.stop();
    mediaStream = null;
  }
  stopPlayback();
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
}

function connectSse() {
  if (es) try { es.close(); } catch {}
  es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "to_observer" && msg.message) {
        injectObserverMessage(String(msg.message));
      } else if (msg.type === "harness_status") {
        setHarnessStatusUi(msg.text != null ? String(msg.text) : "");
      } else if (msg.type === "status") {
        line("sys", msg.text || JSON.stringify(msg));
      }
    } catch (e) {
      line("err", "sse parse: " + e);
    }
  };
}

function REALTIME_URL(model) {
  return "wss://api.x.ai/v1/realtime?model=" + encodeURIComponent(model);
}

function cleanup() {
  connected = false;
  responseActive = false;
  pendingHarnessResponse = false;
  clearIdleTimers();
  stopMic();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const wasIdle = idleDisconnecting;
  idleDisconnecting = false;
  setStatus(wasIdle ? "idle" : "offline", false);
  hintEl.classList.remove("hide");
  hintEl.textContent = wasIdle
    ? "idle — click the sphere to reconnect"
    : "click to reconnect";
}

async function start() {
  try {
    idleDisconnecting = false;
    setStatus("connecting", false);
    hintEl.textContent = "connecting";
    hintEl.classList.remove("hide");
    connectSse();
    const token = await fetchClientSecret();
    await startMic();
    ws = new WebSocket(REALTIME_URL(MODEL), ["xai-client-secret." + token]);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      connected = true;
      sessionUpdate();
      setStatus(VOICE, true);
      hintEl.classList.add("hide");
      touchActivity();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let event;
      try { event = JSON.parse(ev.data); } catch { return; }
      onServerEvent(event);
    };
    ws.onerror = () => line("err", "websocket error");
    ws.onclose = () => cleanup();
  } catch (e) {
    line("err", String(e.message || e));
    cleanup();
  }
}

// click the SPHERE only: raycast so background clicks don't toggle
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
function overSphere(ev) {
  pointerNdc.x = (ev.clientX / Math.max(1, innerWidth)) * 2 - 1;
  pointerNdc.y = -(ev.clientY / Math.max(1, innerHeight)) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  return raycaster.intersectObject(glass, false).length > 0;
}
canvas.addEventListener("click", (ev) => {
  if (!overSphere(ev)) return;
  if (connected || (ws && ws.readyState === WebSocket.CONNECTING)) {
    if (ws) try { ws.close(); } catch {}
    cleanup();
  } else {
    start();
  }
});
// pointer cursor when hovering the sphere
canvas.addEventListener("mousemove", (ev) => {
  canvas.style.cursor = overSphere(ev) ? "pointer" : "default";
});
canvas.addEventListener("mouseleave", () => {
  canvas.style.cursor = "default";
});

/* ─── voice picker (click the voice name) ─── */
const voiceBtn = document.getElementById("voiceBtn");
const voiceOverlay = document.getElementById("voiceOverlay");
const voiceList = document.getElementById("voiceList");
const FALLBACK_VOICES = ["ara", "eve", "leo", "rex", "sal"];

function openVoiceDialog() {
  voiceOverlay.classList.add("open");
  loadVoices();
}
function closeVoiceDialog() {
  voiceOverlay.classList.remove("open");
}

async function loadVoices() {
  let voices = FALLBACK_VOICES;
  try {
    const r = await fetch("/api/voices");
    if (r.ok) {
      const data = await r.json();
      const list = (data.voices || []).map(v => v.voice_id || v.id || v.name).filter(Boolean);
      if (list.length) voices = list;
    }
  } catch {}
  voiceList.innerHTML = "";
  for (const v of voices) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "voiceRow" + (v === VOICE ? " current" : "");
    const name = document.createElement("span");
    name.className = "vname";
    name.textContent = v;
    row.appendChild(name);
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      pickVoice(v);
    });
    voiceList.appendChild(row);
  }
}

function pickVoice(v) {
  VOICE = v;
  try { localStorage.setItem(VOICE_KEY, v); } catch {}
  if (connected) setStatus(VOICE, true); else setStatus(VOICE, false);
  // Apply live — xAI accepts voice changes mid-session via session.update
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendJson({ type: "session.update", session: { voice: VOICE } });
  }
  closeVoiceDialog();
}

voiceBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  openVoiceDialog();
});
voiceOverlay.addEventListener("click", (ev) => {
  if (ev.target === voiceOverlay) closeVoiceDialog();
});
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeVoiceDialog();
});
window.addEventListener("beforeunload", () => {
  if (es) try { es.close(); } catch {}
  cleanup();
});
start();
</script>
</body>
</html>`;
}

async function startRealtimeVoiceServer(
	options: RealtimeVoiceOptions,
): Promise<RealtimeVoiceServer> {
	const port = options.port ?? DEFAULT_PORT;
	const model = options.model ?? DEFAULT_MODEL;
	const voice = options.voice ?? DEFAULT_VOICE;
	const instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;

	let sseId = 0;
	const sseClients = new Set<SseClient>();
	let closed = false;
	/** Latest coding-harness status line shown in the browser HUD. */
	let harnessStatus = "";
	// Auto-stop when the browser goes away: once a client has connected,
	// if all SSE clients disappear for longer than the grace window, self-stop
	// (equivalent of /realtime-voice-stop). Grace covers page refreshes.
	const EMPTY_GRACE_MS = 6000;
	let everHadClient = false;
	let emptyTimer: ReturnType<typeof setTimeout> | null = null;

	function clearEmptyTimer(): void {
		if (emptyTimer) {
			clearTimeout(emptyTimer);
			emptyTimer = null;
		}
	}

	function armEmptyStop(): void {
		clearEmptyTimer();
		if (!everHadClient || closed || sseClients.size > 0) return;
		emptyTimer = setTimeout(() => {
			emptyTimer = null;
			if (!closed && sseClients.size === 0) void selfStop();
		}, EMPTY_GRACE_MS);
	}

	async function selfStop(): Promise<void> {
		if (closed) return;
		closed = true;
		clearEmptyTimer();
		for (const c of sseClients) {
			try {
				c.res.end();
			} catch {
				/* ignore */
			}
		}
		sseClients.clear();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			setTimeout(() => resolve(), 500).unref?.();
		});
		options.onSelfStop?.();
	}

	function broadcast(payload: unknown): void {
		const data = `data: ${JSON.stringify(payload)}\n\n`;
		for (const c of [...sseClients]) {
			try {
				c.res.write(data);
			} catch {
				sseClients.delete(c);
			}
		}
	}

	function sendToObserver(message: string): boolean {
		const text = message.trim();
		if (!text) return false;
		broadcast({ type: "to_observer", message: text, ts: Date.now() });
		return sseClients.size > 0;
	}

	function setHarnessStatus(status: string): boolean {
		harnessStatus = String(status ?? "").trim();
		broadcast({
			type: "harness_status",
			text: harnessStatus,
			ts: Date.now(),
		});
		return sseClients.size > 0;
	}

	async function handleClientSecret(res: ServerResponse): Promise<void> {
		const token = await options.getToken();
		const r = await fetch(`${API_BASE}/realtime/client_secrets`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ expires_after: { seconds: 300 } }),
		});
		const text = await r.text();
		if (!r.ok) {
			json(res, r.status, { error: text || r.statusText });
			return;
		}
		try {
			json(res, 200, JSON.parse(text));
		} catch {
			json(res, 200, { value: text.trim() });
		}
	}

	const server: Server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
			const path = url.pathname;
			const method = req.method || "GET";

			// Same-origin browser UI only (127.0.0.1). No CORS wildcard.
			if (method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			if (method === "GET" && (path === "/" || path === "/index.html")) {
				const html = clientHtml({ model, voice });
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(html);
				return;
			}

			if (method === "GET" && path === "/api/voices") {
				try {
					const token = await options.getToken();
					const r = await fetch(`${API_BASE}/tts/voices`, {
						headers: { Authorization: `Bearer ${token}` },
					});
					const text = await r.text();
					if (!r.ok) {
						json(res, r.status, { error: text || r.statusText });
						return;
					}
					json(res, 200, JSON.parse(text));
				} catch (e) {
					json(res, 500, { error: e instanceof Error ? e.message : String(e) });
				}
				return;
			}

			if (method === "GET" && path === "/api/health") {
				json(res, 200, {
					ok: true,
					model,
					voice,
					clients: sseClients.size,
					harnessStatus,
					instructionsPreview: instructions.slice(0, 120),
				});
				return;
			}

			if (method === "GET" && path === "/api/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				});
				res.write(
					`data: ${JSON.stringify({ type: "status", text: "sse connected" })}\n\n`,
				);
				// Replay current harness status so late joiners / refreshes stay in sync.
				if (harnessStatus) {
					res.write(
						`data: ${JSON.stringify({ type: "harness_status", text: harnessStatus, ts: Date.now() })}\n\n`,
					);
				}
				const client: SseClient = { res, id: ++sseId };
				sseClients.add(client);
				everHadClient = true;
				clearEmptyTimer();
				const ping = setInterval(() => {
					try {
						res.write(
							`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`,
						);
					} catch {
						/* ignore */
					}
				}, 15000);
				req.on("close", () => {
					clearInterval(ping);
					sseClients.delete(client);
					armEmptyStop();
				});
				return;
			}

			if (method === "POST" && path === "/api/client-secret") {
				await handleClientSecret(res);
				return;
			}

			if (method === "POST" && path === "/api/to-harness") {
				const raw = await readBody(req);
				let message = "";
				try {
					const body = JSON.parse(raw || "{}") as { message?: string };
					message = String(body.message || "").trim();
				} catch {
					json(res, 400, { error: "invalid JSON" });
					return;
				}
				if (!message) {
					json(res, 400, { error: "message required" });
					return;
				}
				broadcast({
					type: "status",
					text: `to-harness: ${message.slice(0, 200)}`,
				});
				try {
					await options.onHarnessMessage(message);
					json(res, 200, { ok: true });
				} catch (e) {
					json(res, 500, { error: e instanceof Error ? e.message : String(e) });
				}
				return;
			}

			if (method === "POST" && path === "/api/to-observer") {
				const raw = await readBody(req);
				let message = "";
				try {
					const body = JSON.parse(raw || "{}") as { message?: string };
					message = String(body.message || "").trim();
				} catch {
					json(res, 400, { error: "invalid JSON" });
					return;
				}
				if (!message) {
					json(res, 400, { error: "message required" });
					return;
				}
				const delivered = sendToObserver(message);
				json(res, 200, { ok: true, delivered, clients: sseClients.size });
				return;
			}

			if (method === "POST" && path === "/api/harness-status") {
				const raw = await readBody(req);
				let status = "";
				try {
					const body = JSON.parse(raw || "{}") as {
						status?: string;
						text?: string;
					};
					status = String(body.status ?? body.text ?? "");
				} catch {
					json(res, 400, { error: "invalid JSON" });
					return;
				}
				const delivered = setHarnessStatus(status);
				json(res, 200, {
					ok: true,
					delivered,
					status: harnessStatus,
					clients: sseClients.size,
				});
				return;
			}

			if (method === "POST" && path === "/api/open-tab") {
				const raw = await readBody(req);
				let target = "";
				try {
					const body = JSON.parse(raw || "{}") as { url?: string };
					target = String(body.url || "").trim();
				} catch {
					json(res, 400, { error: "invalid JSON" });
					return;
				}
				let parsed: URL;
				try {
					parsed = new URL(target);
				} catch {
					json(res, 400, { error: "invalid url" });
					return;
				}
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					json(res, 400, { error: "only http(s) urls are allowed" });
					return;
				}
				const href = parsed.toString();
				openBrowser(href);
				broadcast({ type: "status", text: `open-tab: ${href}` });
				json(res, 200, { ok: true, url: href });
				return;
			}

			json(res, 404, { error: "not found" });
		} catch (e) {
			json(res, 500, { error: e instanceof Error ? e.message : String(e) });
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});

	const url = `http://127.0.0.1:${port}/`;

	return {
		port,
		url,
		sendToObserver,
		setHarnessStatus,
		getHarnessStatus: () => harnessStatus,
		clientCount: () => sseClients.size,
		stop: () =>
			new Promise((resolve) => {
				if (closed) return resolve();
				closed = true;
				clearEmptyTimer();
				broadcast({ type: "status", text: "server stopping" });
				for (const c of sseClients) {
					try {
						c.res.end();
					} catch {
						/* ignore */
					}
				}
				sseClients.clear();
				server.close(() => resolve());
				// force-close hangers
				setTimeout(() => resolve(), 500).unref?.();
			}),
	};
}

function openRealtimeVoiceBrowser(url: string): void {
	openBrowser(url);
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
	},
): void {
	let server: RealtimeVoiceServer | null = null;
	let observerToolsActive = false;
	let statusCtx: {
		ui?: {
			setStatus?(k: string, v: string | undefined): void;
			notify?(m: string, l?: string): void;
		};
		hasUI?: boolean;
	} | null = null;

	const setFooter = (label: string | undefined) => {
		if (statusCtx?.hasUI && statusCtx.ui?.setStatus) {
			statusCtx.ui.setStatus("spacexai-realtime", label);
		}
	};

	/** Register (or re-register) observer tools and add them to the active tool set. */
	function enableObserverTools(): void {
		pi.registerTool({
			name: "send_message_to_observer",
			label: "Send Message to Voice Observer",
			description:
				"Send information to the realtime speech-to-speech observer session. The voice agent will hear/see this update and can speak it to the user. The observer cannot read normal terminal output.",
			promptSnippet: "Send a message to the realtime voice observer",
			promptGuidelines: [
				"When you complete work the user asked about via voice, or when answering an observer question, call send_message_to_observer with a concise status or answer.",
				"Do not call this tool if the realtime voice server is not running.",
			],
			parameters: sendToObserverParams,
			async execute(_id, params: SendToObserverParams, _signal, _update, _ctx) {
				if (!server) {
					throw new Error(
						"Realtime voice is not running. Start it with /realtime-voice",
					);
				}
				const message = String(params.message || "").trim();
				if (!message) throw new Error("message is required");
				const delivered = server.sendToObserver(message);
				return {
					content: [
						{
							type: "text" as const,
							text: delivered
								? `Delivered to observer (${server.clientCount()} SSE client(s)).`
								: `Queued/broadcast to observer but no browser SSE client is connected yet. Open ${server.url}`,
						},
					],
					details: { delivered, clients: server.clientCount(), message },
				};
			},
		});

		pi.registerTool({
			name: "set_harness_status",
			label: "Set Coding Harness Status",
			description:
				'Update the live coding-harness status text shown in the realtime voice observer UI (browser HUD over SSE). Use short phrases for in-progress work, and prefer a lasting completion/failure line when done (e.g. "Done: fixed flaky test"). Do not clear the status unless the user asks.',
			promptSnippet: "Update live harness status on the voice observer UI",
			promptGuidelines: [
				"Keep set_harness_status up to date as work starts and progresses. When work finishes, set a completion or failure status and leave it — do not clear the status line.",
				"Bias toward completion messages on the status line so the observer UI still shows the latest outcome after you stop working.",
				"Status text is visual-only for the observer UI — it is not spoken. Use send_message_to_observer for spoken updates (also prefer completion answers there).",
			],
			parameters: setHarnessStatusParams,
			async execute(
				_id,
				params: SetHarnessStatusParams,
				_signal,
				_update,
				_ctx,
			) {
				if (!server) {
					throw new Error(
						"Realtime voice is not running. Start it with /realtime-voice",
					);
				}
				const status = String(params.status ?? "");
				const delivered = server.setHarnessStatus(status);
				const current = server.getHarnessStatus();
				const suffix = delivered ? "" : " (no SSE client yet)";
				const text = current
					? `Harness status set${suffix}: ${current}`
					: `Harness status cleared${suffix}.`;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						delivered,
						clients: server.clientCount(),
						status: current,
					},
				};
			},
		});

		// First registration auto-activates; re-start after stop must re-add explicitly.
		const active = new Set(pi.getActiveTools());
		for (const name of OBSERVER_TOOL_NAMES) active.add(name);
		pi.setActiveTools([...active]);
		observerToolsActive = true;
	}

	/** Drop observer tools from the active set so the LLM can no longer call them. */
	function disableObserverTools(): void {
		if (!observerToolsActive) return;
		const drop = new Set<string>(OBSERVER_TOOL_NAMES);
		pi.setActiveTools(pi.getActiveTools().filter((n) => !drop.has(n)));
		observerToolsActive = false;
	}

	function teardownServer(): void {
		// Clear HUD status before dropping the server reference.
		try {
			server?.setHarnessStatus("");
		} catch {
			/* ignore */
		}
		server = null;
		disableObserverTools();
		setFooter(undefined);
	}

	pi.registerCommand("realtime-voice", {
		description:
			"Start Grok speech-to-speech observer (browser) bridged to this coding session",
		handler: async (args, ctx) => {
			statusCtx = ctx;
			if (server) {
				ctx.ui.notify(
					`Realtime voice already running at ${server.url}`,
					"warning",
				);
				openRealtimeVoiceBrowser(server.url);
				return;
			}

			const parts = args.trim().split(/\s+/).filter(Boolean);
			let port = DEFAULT_PORT;
			for (const p of parts) {
				const n = Number(p);
				if (Number.isFinite(n) && n > 0 && n < 65536) port = Math.floor(n);
			}

			try {
				const voice = (await deps.readVoice()) || DEFAULT_VOICE;
				server = await startRealtimeVoiceServer({
					port,
					voice,
					getToken: () => deps.getToken(ctx),
					onSelfStop: () => {
						// Browser closed and no SSE clients returned — same as /realtime-voice-stop
						teardownServer();
						if (ctx.hasUI) {
							ctx.ui.notify("Realtime voice stopped (browser closed)", "info");
						}
					},
					onHarnessMessage: async (message) => {
						const payload = { source: "observer" as const, message };
						// Custom message participates in LLM context; trigger a turn when idle.
						pi.sendMessage(
							{
								customType: "spacexai-observer",
								content: JSON.stringify(payload),
								display: true,
								details: payload,
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`Observer → harness: ${message.slice(0, 120)}`,
								"info",
							);
						}
					},
				});
				enableObserverTools();
				setFooter(`voice:${server.port}`);
				ctx.ui.notify(
					`Realtime voice on ${server.url} (voice=${voice}). Opened browser.`,
					"info",
				);
				openRealtimeVoiceBrowser(server.url);
			} catch (e) {
				teardownServer();
				ctx.ui.notify(
					`Failed to start realtime voice: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("realtime-voice-stop", {
		description: "Stop the realtime voice observer server",
		handler: async (_args, ctx) => {
			if (!server) {
				ctx.ui.notify("Realtime voice is not running", "warning");
				return;
			}
			await server.stop();
			teardownServer();
			ctx.ui.notify("Realtime voice stopped", "info");
		},
	});

	// While the observer is live, remind the coding agent how to communicate with it.
	pi.on("before_agent_start", async (event) => {
		if (!server) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${CODING_AGENT_OBSERVER_PROMPT}`,
		};
	});

	pi.on("session_shutdown", async () => {
		if (server) {
			await server.stop();
		}
		teardownServer();
	});
}
