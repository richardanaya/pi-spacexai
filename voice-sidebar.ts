/**
 * Right-column sidebar for realtime voice mode.
 *
 * The compositor follows pi-sidebar-tui
 * (https://github.com/bi0h4z4rd88/pi-sidebar-tui @ a9006b9f3aba4e2b5ec21a6db9132a052440a13d):
 * narrow `terminal.columns` so pi draws the chat on the left, paint the panel
 * into the rightmost columns after each render, and fold that paint into the
 * same synchronized-output frame. Only rows whose text changed are rewritten.
 * pi-sidebar-tui is a session/todos extension, not a reusable voice panel, so
 * this copies that layout and update loop instead of depending on the package.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const MIN_SIDEBAR_WIDTH = 10;
export const MAX_SIDEBAR_WIDTH = 120;
export const DEFAULT_SIDEBAR_WIDTH = 40;
export const VOICE_SIDEBAR_USAGE =
	"Usage: /realtime-voice-sidebar width <10-120>";

export interface VoiceSidebarSettings {
	width: number;
}

export const DEFAULT_VOICE_SIDEBAR_SETTINGS: VoiceSidebarSettings = {
	width: DEFAULT_SIDEBAR_WIDTH,
};

export interface VoiceTurn {
	id: string;
	who: "you" | "voice";
	text: string;
}

export interface VoiceSidebarModel {
	connected: boolean;
	voice: string;
	/** Mic level from 0 (silence) to 1 (loud). */
	level: number;
	harnessStatus: string;
	/** Idle warning, device failure, or other transient notice. */
	notice: string;
	turns: VoiceTurn[];
	cwd?: string;
	/** Activity spinner frame. The host increments this on a timer. */
	frame: number;
}

export interface SidebarLayout {
	raw: number;
	main: number;
	sidebar: number;
	separatorColumn: number;
	sidebarColumn: number;
}

type SidebarColor = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";

type ThemeLike = {
	fg(color: SidebarColor, text: string): string;
	bold(text: string): string;
} | null;

interface SidebarTerminal {
	rows: number;
	columns: number;
	write(data: string): void;
}

export interface SidebarInputResult {
	consume?: boolean;
	data?: string;
}

export interface SidebarTui {
	terminal: SidebarTerminal;
	requestRender?: () => void;
	addInputListener?: (listener: (data: string) => SidebarInputResult | undefined) => () => void;
}

/** pi's TUI.doRender is private in the types and public at runtime. */
type RenderHost = SidebarTui & {
	doRender?: (...args: unknown[]) => unknown;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const RESET = "\x1b[22;23;24;39m";
const FALLBACK_HEX: Record<string, string> = {
	accent: "#febc38",
	success: "#5faf5f",
	warning: "#ff9500",
	error: "#e05561",
	text: "#00afaf",
	muted: "#6c6c6c",
	dim: "#6c6c6c",
};

let activeTheme: ThemeLike = null;

export function setVoiceSidebarTheme(theme: ThemeLike): void {
	activeTheme = theme;
}

function hexToAnsi(color: string): string {
	const h = color.replace("#", "");
	const r = Number.parseInt(h.slice(0, 2), 16);
	const g = Number.parseInt(h.slice(2, 4), 16);
	const b = Number.parseInt(h.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function bold(text: string): string {
	if (activeTheme?.bold) return activeTheme.bold(text);
	return `\x1b[1m${text}${RESET}`;
}

function dim(text: string): string {
	if (activeTheme?.fg) return activeTheme.fg("dim", text);
	return `\x1b[2m${text}${RESET}`;
}

function fg(colorName: SidebarColor, text: string): string {
	if (activeTheme?.fg) return activeTheme.fg(colorName, text);
	const hex = FALLBACK_HEX[colorName] ?? "#ffffff";
	return `${hexToAnsi(hex)}${text}${RESET}`;
}

export function spinnerFrameAt(frame: number): string {
	const n = SPINNER_FRAMES.length;
	const i = ((frame % n) + n) % n;
	return SPINNER_FRAMES[i] ?? SPINNER_FRAMES[0];
}

export function micMeter(level: number): string {
	const steps = "▁▂▃▄▅▆▇█";
	const clamped = Math.max(0, Math.min(1, level));
	let bar = "";
	for (let i = 0; i < 8; i++) {
		bar += clamped >= (i + 1) / 8 ? steps[i] : "▁";
	}
	return bar;
}

export function trunc(text: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(text) <= max) return text;
	let result = "";
	let width = 0;
	for (const ch of text) {
		const cw = visibleWidth(ch);
		if (width + cw > max - 1) break;
		result += ch;
		width += cw;
	}
	return `${result}…`;
}

function panelHeader(title: string, width: number): string[] {
	return [bold(` ${title}`), dim("─".repeat(Math.max(0, width)))];
}

function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
	}
	return join(homedir(), ".pi", "agent");
}

export function voiceSidebarConfigPath(): string {
	return (
		process.env.PI_SPACEXAI_VOICE_SIDEBAR_CONFIG ||
		join(agentDir(), "spacexai-voice-sidebar.json")
	);
}

export function loadVoiceSidebarSettings(
	path: string = voiceSidebarConfigPath(),
): VoiceSidebarSettings {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { ...DEFAULT_VOICE_SIDEBAR_SETTINGS };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...DEFAULT_VOICE_SIDEBAR_SETTINGS };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ...DEFAULT_VOICE_SIDEBAR_SETTINGS };
	}
	const obj = parsed as Record<string, unknown>;
	const settings: VoiceSidebarSettings = { ...DEFAULT_VOICE_SIDEBAR_SETTINGS };
	const width = obj.width;
	if (
		typeof width === "number" &&
		Number.isInteger(width) &&
		width >= MIN_SIDEBAR_WIDTH &&
		width <= MAX_SIDEBAR_WIDTH
	) {
		settings.width = width;
	}
	return settings;
}

export function saveVoiceSidebarSettings(
	settings: VoiceSidebarSettings,
	path: string = voiceSidebarConfigPath(),
): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	chmodSync(path, 0o600);
}

export type VoiceSidebarCommand = { type: "width"; width: number } | { type: "usage" };

export function parseVoiceSidebarCommand(args: string): VoiceSidebarCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const cmd = parts[0] ?? "";
	if (cmd === "width") {
		const token = parts[1] ?? "";
		if (!/^\d+$/.test(token)) return { type: "usage" };
		const width = Number.parseInt(token, 10);
		if (width < MIN_SIDEBAR_WIDTH || width > MAX_SIDEBAR_WIDTH) {
			return { type: "usage" };
		}
		return { type: "width", width };
	}
	return { type: "usage" };
}

/**
 * Columns left for pi's main chat. One column is the separator.
 * On a very narrow terminal the sidebar shrinks so the chat keeps a column.
 */
export function sidebarLayout(
	rawColumns: number,
	preferredWidth: number,
): SidebarLayout {
	const raw = Number.isFinite(rawColumns) ? Math.max(1, Math.floor(rawColumns)) : 80;
	const preferred = Number.isFinite(preferredWidth)
		? Math.max(1, Math.floor(preferredWidth))
		: DEFAULT_SIDEBAR_WIDTH;
	const sidebar = Math.min(preferred, Math.max(1, raw - 2));
	const separatorColumn = Math.max(1, raw - sidebar);
	return {
		raw,
		main: Math.max(1, separatorColumn - 1),
		sidebar,
		separatorColumn,
		sidebarColumn: separatorColumn + 1,
	};
}

function renderVoicePanel(model: VoiceSidebarModel, width: number): string[] {
	const lines = [...panelHeader("Voice", width)];
	const state = model.connected ? fg("success", "live") : fg("muted", "off");
	const mark = model.connected
		? fg("accent", spinnerFrameAt(model.frame))
		: dim("·");
	const voice = trunc(model.voice || "leo", Math.max(1, width - 16));
	lines.push(` ${mark} ${state}${dim(" · ")}${fg("accent", voice)}`);
	const hot = model.level > 0.05;
	lines.push(
		`${dim(" mic ")}${fg(hot ? "success" : "muted", micMeter(model.level))}`,
	);
	const notice = model.notice.replace(/\s+/g, " ").trim();
	if (notice) {
		const wrapped = wrapTextWithAnsi(notice, Math.max(1, width - 1)).slice(0, 3);
		for (const row of wrapped) lines.push(fg("error", ` ${row}`));
	}
	return lines;
}

function renderHarnessPanel(model: VoiceSidebarModel, width: number): string[] {
	const lines = [...panelHeader("Harness", width)];
	const status = model.harnessStatus.replace(/\s+/g, " ").trim();
	if (!status) {
		lines.push(dim(" (no status)"));
		return lines;
	}
	const wrapped = wrapTextWithAnsi(status, Math.max(1, width - 1));
	const shown = wrapped.slice(-3);
	for (const row of shown) lines.push(` ${row}`);
	return lines;
}

function transcriptRows(model: VoiceSidebarModel, width: number): string[] {
	const labelWidth = 7;
	const textWidth = Math.max(1, width - labelWidth);
	const rows: string[] = [];
	for (const turn of model.turns) {
		const words = turn.text.replace(/\s+/g, " ").trim();
		if (!words) continue;
		const name = turn.who === "you" ? "you" : "voice";
		const color = turn.who === "you" ? "accent" : "warning";
		const prefix = ` ${fg(color, name.padEnd(5))} `;
		const wrapped = wrapTextWithAnsi(words, textWidth);
		if (wrapped.length === 0) continue;
		rows.push(prefix + wrapped[0]);
		for (const extra of wrapped.slice(1)) {
			rows.push(`${" ".repeat(labelWidth)}${extra}`);
		}
	}
	return rows;
}

/** Rows moved per mouse-wheel notch. */
export const TRANSCRIPT_WHEEL_ROWS = 3;

export interface TranscriptLayout {
	lines: string[];
	/** Index of the first transcript row shown. */
	start: number;
	/** How many transcript rows fit under the header. */
	room: number;
	/** Wrapped transcript rows before the window is applied. */
	bodyRows: number;
	/** 0-based row of the first transcript line inside `lines`. */
	bodyRow: number;
	/** True when the window includes the newest row. */
	atBottom: boolean;
}

/**
 * `scrollStart` is the first transcript row to show.
 * `Infinity` follows the newest lines.
 */
export function layoutVoiceSidebar(
	model: VoiceSidebarModel,
	width: number,
	maxRows = 48,
	scrollStart = Number.POSITIVE_INFINITY,
): TranscriptLayout {
	const safeWidth = Math.max(1, width);
	const limit = Math.max(1, maxRows);
	const voice = renderVoicePanel(model, safeWidth);
	const harness = renderHarnessPanel(model, safeWidth);
	const head = [...voice, "", ...harness, ""];
	const title = panelHeader("Transcript", safeWidth);
	const room = Math.max(0, limit - head.length - title.length);
	const body = transcriptRows(model, safeWidth);
	const maxStart = Math.max(0, body.length - Math.max(room, 1));
	const start =
		body.length === 0
			? 0
			: Math.min(maxStart, Math.max(0, Math.floor(scrollStart)));
	const atBottom = body.length === 0 || start >= maxStart;
	let titleLine = title[0] ?? "";
	if (body.length > 0 && room > 0 && (start > 0 || !atBottom)) {
		const mark = `${start > 0 ? "↑" : ""}${atBottom ? "" : "↓"}`;
		const label = " Transcript";
		const gap = Math.max(1, safeWidth - visibleWidth(label) - visibleWidth(mark));
		titleLine = bold(`${label}${" ".repeat(gap)}${mark}`);
	}
	const titled = [titleLine, ...title.slice(1)];
	const transcript =
		body.length === 0
			? [dim(" (listening…)")]
			: body.slice(start, start + Math.max(room, 1));
	const bodyRow = head.length + titled.length;
	let lines = [...head, ...titled, ...transcript];
	if (lines.length > limit) lines = lines.slice(lines.length - limit);
	return {
		lines: lines.map((line) => truncateToWidth(line, safeWidth, "", true)),
		start,
		room,
		bodyRows: body.length,
		bodyRow: Math.min(bodyRow, lines.length),
		atBottom,
	};
}

export function renderVoiceSidebar(
	model: VoiceSidebarModel,
	width: number,
	maxRows = 48,
	scrollStart = Number.POSITIVE_INFINITY,
): string[] {
	return layoutVoiceSidebar(model, width, maxRows, scrollStart).lines;
}

/** SGR mouse wheel (`CSI < btn ; col ; row M`). Columns and rows are 1-based. */
export interface WheelEvent {
	/** -1 is up, +1 is down. */
	delta: -1 | 1;
	col: number;
	row: number;
}

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)[Mm]/g;

/** Pull wheel notches out of an input chunk and drop every SGR mouse report. */
export function takeWheelEvents(data: string): { events: WheelEvent[]; rest: string } {
	const events: WheelEvent[] = [];
	const rest = data.replace(SGR_MOUSE, (match, btnRaw, colRaw, rowRaw) => {
		const btn = Number(btnRaw);
		const col = Number(colRaw);
		const row = Number(rowRaw);
		const wheel = btn & 64;
		const axis = btn & 3;
		if (wheel && (axis === 0 || axis === 1) && col > 0 && row > 0) {
			events.push({ delta: axis === 0 ? -1 : 1, col, row });
		}
		return "";
	});
	return { events, rest };
}

/**
 * One-line footer used while the sidebar is hidden.
 * A live call shows the voice, mic meter, notice, and harness status.
 * Before the socket is up, a notice such as "connecting…" is shown on its own.
 */
export function voiceFooterLabel(
	model: VoiceSidebarModel,
	sidebarShowing: boolean,
): string | undefined {
	if (sidebarShowing) return undefined;
	const notice = model.notice.replace(/\s+/g, " ").trim();
	const harness = model.harnessStatus.replace(/\s+/g, " ").trim();
	if (!model.connected) return notice || undefined;
	const bits = [`realtime · ${model.voice || "leo"}`, micMeter(model.level)];
	if (notice) bits.push(notice.length > 80 ? `${notice.slice(0, 80)}…` : notice);
	if (harness) bits.push(harness.length > 80 ? `${harness.slice(0, 80)}…` : harness);
	return bits.join("  ");
}

export function createRenderScheduler(
	paint: () => void,
	delayMs = 16,
): { schedule(): void; cancel(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let tick = 0;
	return {
		schedule() {
			const mine = ++tick;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				if (mine === tick) paint();
			}, delayMs);
		},
		cancel() {
			tick += 1;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

const SIDEBAR_BG = (() => {
	const hex = process.env.PI_SPACEXAI_VOICE_SIDEBAR_BG?.replace("#", "") ?? "";
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
})();
const BG_RESET = "\x1b[49m";

function moveCursor(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

function descriptorFor(obj: object, key: string): PropertyDescriptor | undefined {
	let target: object | null = obj;
	while (target) {
		const found = Object.getOwnPropertyDescriptor(target, key);
		if (found) return found;
		target = Object.getPrototypeOf(target);
	}
	return undefined;
}

export class VoiceSidebarCompositor {
	private readonly tui: RenderHost;
	private readonly terminal: SidebarTerminal;
	private readonly getModel: () => VoiceSidebarModel;
	private readonly preferredWidth: number;
	private readonly originalWrite: (data: string) => void;
	private originalColumnsDesc: PropertyDescriptor | undefined;
	private originalColumnsOwnDesc: PropertyDescriptor | undefined;
	private originalDoRender: ((...args: unknown[]) => unknown) | null = null;
	private installed = false;
	private disposed = false;
	private cachedLines: string[] | null = null;
	private cachedColumns = 0;
	private cachedRows = 0;
	private cachedWidth = 0;
	private cacheValid = false;
	/** First transcript row. Ignored while `transcriptFollow` is set. */
	private transcriptStart = 0;
	private transcriptFollow = true;
	private removeInputListener: (() => void) | null = null;
	private originalHandleInput: ((data: string) => void) | null = null;
	private ownsMouseTracking = false;

	constructor(
		tui: SidebarTui,
		getModel: () => VoiceSidebarModel,
		sidebarWidth = DEFAULT_SIDEBAR_WIDTH,
	) {
		this.tui = tui as RenderHost;
		this.terminal = tui.terminal;
		this.getModel = getModel;
		this.preferredWidth = sidebarWidth;
		this.originalWrite = this.terminal.write.bind(this.terminal);
	}

	install(): void {
		if (this.installed || this.disposed) return;
		this.installed = true;

		this.originalColumnsDesc = descriptorFor(this.terminal, "columns");
		this.originalColumnsOwnDesc = Object.getOwnPropertyDescriptor(
			this.terminal,
			"columns",
		);
		const origDesc = this.originalColumnsDesc;
		const terminal = this.terminal;
		const self = this;

		Object.defineProperty(terminal, "columns", {
			configurable: true,
			enumerable: true,
			get() {
				return sidebarLayout(readColumns(origDesc, terminal), self.preferredWidth).main;
			},
		});

		const host = this.tui as SidebarTui & {
			handleTerminalInput?: (data: string) => void;
		};
		// Fullscreen pi registers its own listener first and consumes every wheel.
		// Wrap the input entry so a wheel over the sidebar is handled before that.
		if (typeof host.handleTerminalInput === "function") {
			const original = host.handleTerminalInput.bind(host);
			this.originalHandleInput = host.handleTerminalInput;
			host.handleTerminalInput = (data: string) => {
				const result = self.onInput(data);
				if (result?.consume) return;
				original(result?.data ?? data);
			};
		} else if (host.addInputListener) {
			this.ownsMouseTracking = true;
			this.originalWrite("\x1b[?1000h\x1b[?1006h");
			this.removeInputListener = host.addInputListener((data) => this.onInput(data));
		}

		if (typeof this.tui.doRender === "function") {
			const originalDoRender = this.tui.doRender;
			this.originalDoRender = originalDoRender;
			this.tui.doRender = (...args: unknown[]) => {
				if (self.disposed) return originalDoRender.apply(this.tui, args);

				const writeOwnDesc = Object.getOwnPropertyDescriptor(terminal, "write");
				const originalWrite = terminal.write;
				const mainWidth = sidebarLayout(
					self.rawColumns(),
					self.preferredWidth,
				).main;
				let forceFullPaint = false;
				let result: unknown;
				let thrown: unknown;
				let didThrow = false;

				self.originalWrite("\x1b[?2026h");
				try {
					Object.defineProperty(terminal, "write", {
						configurable: true,
						enumerable: true,
						writable: true,
						value(data: string) {
							if (typeof data !== "string") return originalWrite.call(terminal, data);
							if (/\x1b\[(?:2J|3J)/.test(data)) forceFullPaint = true;
							const sanitized = data
								.replace(/\x1b\[\?2026[hl]/g, "")
								.replace(/\x1b\[2K/g, `\x1b[${mainWidth}X`);
							return originalWrite.call(terminal, sanitized);
						},
					});
					try {
						result = originalDoRender.apply(this.tui, args);
					} catch (error) {
						didThrow = true;
						thrown = error;
					}
					if (!didThrow) {
						try {
							self.paintInternal(forceFullPaint, false);
						} catch {
							/* Sidebar painting must never break pi's render cycle. */
						}
					}
				} finally {
					if (writeOwnDesc) Object.defineProperty(terminal, "write", writeOwnDesc);
					else Reflect.deleteProperty(terminal, "write");
					self.originalWrite("\x1b[?2026l");
				}
				if (didThrow) throw thrown;
				return result;
			};
		}
	}

	paint(): void {
		this.paintInternal(false, true);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.installed = false;
		this.removeInputListener?.();
		this.removeInputListener = null;
		const host = this.tui as SidebarTui & {
			handleTerminalInput?: (data: string) => void;
		};
		if (this.originalHandleInput) {
			host.handleTerminalInput = this.originalHandleInput;
			this.originalHandleInput = null;
		}
		if (this.ownsMouseTracking) {
			this.ownsMouseTracking = false;
			try {
				this.originalWrite("\x1b[?1006l\x1b[?1000l");
			} catch {
				/* Shutting down must not fail because the terminal is gone. */
			}
		}
		if (this.originalColumnsOwnDesc) {
			Object.defineProperty(this.terminal, "columns", this.originalColumnsOwnDesc);
		} else {
			Reflect.deleteProperty(this.terminal, "columns");
		}
		if (this.originalDoRender !== null) {
			this.tui.doRender = this.originalDoRender;
		}
		this.cacheValid = false;
	}

	private rawColumns(): number {
		return readColumns(this.originalColumnsDesc, this.terminal);
	}

	private formatLine(line: string | undefined, width: number): string {
		const content = line === undefined ? "" : truncateToWidth(line, width, "", true);
		const padding = Math.max(0, width - visibleWidth(content));
		return `${SIDEBAR_BG}${content}${" ".repeat(padding)}${BG_RESET}`;
	}

	private onInput(data: string): SidebarInputResult | undefined {
		const { events } = takeWheelEvents(data);
		if (events.length === 0 || !events.some((event) => this.wheelOverSidebar(event))) {
			return undefined;
		}
		let scrolled = false;
		for (const event of events) {
			if (this.wheelOverSidebar(event) && this.scrollTranscript(event)) scrolled = true;
		}
		if (scrolled) this.paint();
		return { consume: true };
	}

	private wheelOverSidebar(event: WheelEvent): boolean {
		const layout = sidebarLayout(this.rawColumns(), this.preferredWidth);
		return event.col >= layout.sidebarColumn;
	}

	private scrollTranscript(event: WheelEvent): boolean {
		const rawRows = Math.max(0, Math.floor(Number(this.terminal.rows) || 0));
		if (rawRows === 0) return false;
		const layout = sidebarLayout(this.rawColumns(), this.preferredWidth);
		const model = this.getModel();
		const cwd = model.cwd ?? "";
		const bodyRows = cwd ? Math.max(1, rawRows - 1) : rawRows;
		const frame = layoutVoiceSidebar(
			model,
			layout.sidebar,
			bodyRows,
			this.transcriptFollow ? Number.POSITIVE_INFINITY : this.transcriptStart,
		);
		const maxStart = Math.max(0, frame.bodyRows - Math.max(frame.room, 1));
		const next = Math.min(
			maxStart,
			Math.max(0, frame.start + event.delta * TRANSCRIPT_WHEEL_ROWS),
		);
		if (next === frame.start) return false;
		this.transcriptStart = next;
		this.transcriptFollow = next >= maxStart;
		return true;
	}

	private paintInternal(forceFull: boolean, standalone: boolean): void {
		if (this.disposed || !this.installed) return;
		const rawRows = Math.max(0, Math.floor(Number(this.terminal.rows) || 0));
		if (rawRows === 0) return;
		const layout = sidebarLayout(this.rawColumns(), this.preferredWidth);
		const model = this.getModel();
		const cwd = model.cwd ?? "";
		const bodyRows = cwd ? Math.max(1, rawRows - 1) : rawRows;
		const lines = renderVoiceSidebar(
			model,
			layout.sidebar,
			bodyRows,
			this.transcriptFollow ? Number.POSITIVE_INFINITY : this.transcriptStart,
		);

		const home = process.env.HOME ?? "";
		const cwdDisplay = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
		const cwdTruncated =
			visibleWidth(cwdDisplay) > layout.sidebar - 1
				? `…${cwdDisplay.slice(-(layout.sidebar - 2))}`
				: cwdDisplay;
		const cwdLine = dim(` ${cwdTruncated}`);

		const formatted: string[] = [];
		for (let row = 1; row <= rawRows; row++) {
			if (row === rawRows && cwd) formatted.push(this.formatLine(cwdLine, layout.sidebar));
			else formatted.push(this.formatLine(lines[row - 1], layout.sidebar));
		}

		const dimensionsChanged =
			this.cachedColumns !== layout.raw ||
			this.cachedRows !== rawRows ||
			this.cachedWidth !== layout.sidebar;
		const paintAll = forceFull || !this.cacheValid || dimensionsChanged;
		const rows = paintAll
			? formatted.map((_, index) => index)
			: formatted.reduce<number[]>((changed, line, index) => {
					if (this.cachedLines?.[index] !== line) changed.push(index);
					return changed;
				}, []);
		if (rows.length === 0) return;

		let buf = standalone ? "\x1b[?2026h" : "";
		buf += "\x1b7";
		buf += "\x1b[?7l";
		for (const index of rows) {
			const row = index + 1;
			buf += moveCursor(row, layout.separatorColumn);
			buf += dim("│");
			buf += moveCursor(row, layout.sidebarColumn);
			buf += formatted[index];
		}
		buf += "\x1b[?7h";
		buf += "\x1b8";
		if (standalone) buf += "\x1b[?2026l";

		try {
			this.originalWrite(buf);
		} catch {
			this.cacheValid = false;
			return;
		}
		this.cachedLines = formatted;
		this.cachedColumns = layout.raw;
		this.cachedRows = rawRows;
		this.cachedWidth = layout.sidebar;
		this.cacheValid = true;
	}
}

function readColumns(
	desc: PropertyDescriptor | undefined,
	terminal: SidebarTerminal,
): number {
	const raw = desc?.get
		? desc.get.call(terminal)
		: typeof desc?.value === "number"
			? desc.value
			: undefined;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 80;
}

/** Installs and resizes one voice sidebar on a pi TUI. */
export class VoiceSidebarSession {
	private tui: SidebarTui | null = null;
	private compositor: VoiceSidebarCompositor | null = null;
	private settings: VoiceSidebarSettings;
	private readonly settingsPath: string;
	private readonly getModel: () => VoiceSidebarModel;

	constructor(getModel: () => VoiceSidebarModel, settingsPath?: string) {
		this.getModel = getModel;
		this.settingsPath = settingsPath ?? voiceSidebarConfigPath();
		this.settings = loadVoiceSidebarSettings(this.settingsPath);
	}

	get width(): number {
		return this.settings.width;
	}

	get showing(): boolean {
		return this.compositor !== null;
	}

	bind(tui: SidebarTui): void {
		if (this.tui === tui && this.compositor !== null) return;
		this.unmount(false);
		this.tui = tui;
		this.mount();
	}

	setWidth(width: number): void {
		this.settings.width = width;
		this.persist();
		if (!this.compositor || !this.tui) return;
		this.unmount(false);
		this.mount();
	}

	paint(): void {
		if (this.compositor) this.compositor.paint();
		else this.tui?.requestRender?.();
	}

	dispose(): void {
		this.unmount(false);
		this.tui = null;
	}

	private mount(): void {
		if (!this.tui || this.compositor) return;
		const compositor = new VoiceSidebarCompositor(
			this.tui,
			this.getModel,
			this.settings.width,
		);
		compositor.install();
		this.compositor = compositor;
		this.tui.requestRender?.();
	}

	private unmount(reflow: boolean): void {
		this.compositor?.dispose();
		this.compositor = null;
		if (reflow) this.tui?.requestRender?.();
	}

	private persist(): void {
		saveVoiceSidebarSettings(this.settings, this.settingsPath);
	}
}
