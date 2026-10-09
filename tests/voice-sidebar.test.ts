import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createRenderScheduler,
	loadVoiceSidebarSettings,
	micMeter,
	parseVoiceSidebarCommand,
	renderVoiceSidebar,
	saveVoiceSidebarSettings,
	sidebarLayout,
	VoiceSidebarCompositor,
	VoiceSidebarSession,
	voiceFooterLabel,
	type SidebarTui,
	type VoiceSidebarModel,
} from "../voice-sidebar.ts";

function strip(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function model(overrides: Partial<VoiceSidebarModel> = {}): VoiceSidebarModel {
	return {
		connected: true,
		voice: "eve",
		level: 0.5,
		harnessStatus: "Done: fixed auth",
		notice: "",
		turns: [
			{ id: "u1", who: "you", text: "fix the login bug" },
			{ id: "v1", who: "voice", text: "On it." },
		],
		cwd: "/tmp/proj",
		frame: 0,
		...overrides,
	};
}

test("sidebar layout matches the pi-sidebar-tui column split", () => {
	assert.deepEqual(sidebarLayout(80, 20), {
		raw: 80,
		main: 59,
		sidebar: 20,
		separatorColumn: 60,
		sidebarColumn: 61,
	});
	assert.deepEqual(sidebarLayout(100, 40), {
		raw: 100,
		main: 59,
		sidebar: 40,
		separatorColumn: 60,
		sidebarColumn: 61,
	});
	const narrow = sidebarLayout(10, 20);
	assert.equal(narrow.main, 1);
	assert.equal(narrow.sidebar, 8);
	assert.equal(narrow.main + 1 + narrow.sidebar, narrow.raw);
});

test("renderVoiceSidebar shows voice status, harness status, and transcript", () => {
	const lines = renderVoiceSidebar(model(), 40, 24);
	const text = lines.map(strip).join("\n");
	assert.match(text, /Voice/);
	assert.match(text, /live/);
	assert.match(text, /eve/);
	assert.match(text, /mic/);
	assert.match(text, new RegExp(micMeter(0.5)));
	assert.match(text, /Harness/);
	assert.match(text, /Done: fixed auth/);
	assert.match(text, /Transcript/);
	assert.match(text, /you/);
	assert.match(text, /fix the login bug/);
	assert.match(text, /voice/);
	assert.match(text, /On it/);
	for (const line of lines) {
		assert.equal(visibleWidth(line), 40);
	}
});

test("renderVoiceSidebar keeps the latest transcript lines", () => {
	const turns = Array.from({ length: 12 }, (_, i) => ({
		id: `t${i}`,
		who: i % 2 === 0 ? ("you" as const) : ("voice" as const),
		text: `utterance-${i}-end`,
	}));
	const lines = renderVoiceSidebar(model({ turns, harnessStatus: "" }), 36, 16);
	const text = lines.map(strip).join("\n");
	assert.match(text, /Voice/);
	assert.match(text, /utterance-11-end/);
	assert.doesNotMatch(text, /utterance-0-end/);
});

test("renderVoiceSidebar empty transcript and width 1", () => {
	const listening = renderVoiceSidebar(model({ turns: [], harnessStatus: "" }), 32, 20);
	assert.match(listening.map(strip).join("\n"), /listening/);
	assert.doesNotThrow(() => renderVoiceSidebar(model(), 1, 4));
});

test("footer is hidden while the sidebar is showing", () => {
	const live = model();
	assert.equal(voiceFooterLabel(live, true), undefined);
	const hidden = voiceFooterLabel(live, false);
	assert.match(hidden ?? "", /realtime · eve/);
	assert.match(hidden ?? "", new RegExp(micMeter(0.5)));
	assert.match(hidden ?? "", /Done: fixed auth/);
	assert.equal(
		voiceFooterLabel(model({ connected: false, notice: "connecting…" }), false),
		"connecting…",
	);
	assert.equal(voiceFooterLabel(model({ connected: false, notice: "" }), false), undefined);
});

test("parseVoiceSidebarCommand accepts on, off, and width 10-120", () => {
	assert.deepEqual(parseVoiceSidebarCommand("on"), { type: "on" });
	assert.deepEqual(parseVoiceSidebarCommand("off"), { type: "off" });
	assert.deepEqual(parseVoiceSidebarCommand("width 40"), { type: "width", width: 40 });
	assert.deepEqual(parseVoiceSidebarCommand("width 10"), { type: "width", width: 10 });
	assert.deepEqual(parseVoiceSidebarCommand("width 120"), { type: "width", width: 120 });
	for (const args of ["", "width", "width 9", "width 121", "width 40.5", "toggle"]) {
		assert.equal(parseVoiceSidebarCommand(args).type, "usage");
	}
});

test("settings round-trip and invalid files fall back", () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-sidebar-"));
	const path = join(dir, "settings.json");
	try {
		assert.equal(loadVoiceSidebarSettings(path).enabled, true);
		assert.equal(loadVoiceSidebarSettings(path).width, 40);
		saveVoiceSidebarSettings({ enabled: false, width: 55 }, path);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.deepEqual(loadVoiceSidebarSettings(path), { enabled: false, width: 55 });
		writeFileSync(path, "{", "utf8");
		assert.equal(loadVoiceSidebarSettings(path).width, 40);
		writeFileSync(path, JSON.stringify({ enabled: true, width: 4 }), "utf8");
		assert.equal(loadVoiceSidebarSettings(path).width, 40);
		assert.equal(loadVoiceSidebarSettings(path).enabled, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fakeTui(rawColumns = 80, rows = 8): {
	tui: SidebarTui;
	writes: string[];
	setColumns(n: number): void;
	renders: { count: number };
} {
	let columns = rawColumns;
	const writes: string[] = [];
	const renders = { count: 0 };
	const terminal = {
		rows,
		get columns() {
			return columns;
		},
		set columns(value: number) {
			columns = value;
		},
		write(data: string) {
			writes.push(data);
		},
	};
	const tui: SidebarTui = {
		terminal,
		doRender() {
			terminal.write("\x1b[2Kmain\x1b[?2026h");
		},
		requestRender() {
			renders.count += 1;
		},
	};
	return {
		tui,
		writes,
		setColumns(n: number) {
			columns = n;
		},
		renders,
	};
}

test("compositor narrows columns, paints a diff, and restores on dispose", () => {
	const { tui, writes, setColumns } = fakeTui(80, 24);
	const state = model({ cwd: "" });
	const originalRender = tui.doRender;
	const compositor = new VoiceSidebarCompositor(tui, () => state, 20);
	compositor.install();
	assert.equal(tui.terminal.columns, 59);
	assert.notEqual(tui.doRender, originalRender);

	compositor.paint();
	const first = writes.length;
	assert.ok(first > 0);
	assert.match(writes.at(-1) ?? "", /\x1b\[\?2026h/);
	assert.match(writes.at(-1) ?? "", /\x1b\[\?2026l/);
	assert.match(writes.at(-1) ?? "", /\x1b\[1;60H/);
	assert.match(strip(writes.at(-1) ?? ""), /Voice/);

	compositor.paint();
	assert.equal(writes.length, first);

	state.harnessStatus = "Done: added tests";
	compositor.paint();
	assert.ok(writes.length > first);
	const delta = writes.at(-1) ?? "";
	assert.match(strip(delta), /Done: added tests/);
	assert.doesNotMatch(delta, /\x1b\[1;60H/);

	setColumns(100);
	compositor.paint();
	assert.match(writes.at(-1) ?? "", /\x1b\[1;80H/);

	setColumns(80);
	writes.length = 0;
	tui.doRender?.();
	const joined = writes.join("");
	assert.match(joined, /^\x1b\[\?2026h/);
	assert.match(joined, /\x1b\[\?2026l$/);
	assert.match(joined, /\x1b\[59X/);
	assert.equal(writes[1]?.includes("\x1b[2K"), false);
	assert.equal(writes[1]?.includes("\x1b[?2026"), false);

	compositor.dispose();
	compositor.dispose();
	assert.equal(tui.terminal.columns, 80);
	assert.equal(tui.doRender, originalRender);
});

test("compositor keeps the render frame closed when pi throws", () => {
	const { tui, writes } = fakeTui();
	tui.doRender = () => {
		throw new Error("boom");
	};
	const compositor = new VoiceSidebarCompositor(tui, () => model({ cwd: "" }), 20);
	compositor.install();
	assert.throws(() => tui.doRender?.(), /boom/);
	assert.match(writes.join(""), /\x1b\[\?2026l/);
	writes.length = 0;
	tui.terminal.write("plain");
	assert.deepEqual(writes, ["plain"]);
	compositor.dispose();
});

test("compositor pins the working directory on the last row", () => {
	const previous = process.env.HOME;
	process.env.HOME = "/home/me";
	try {
		const { tui, writes } = fakeTui(80, 4);
		const compositor = new VoiceSidebarCompositor(
			tui,
			() => model({ cwd: "/home/me/proj" }),
			20,
		);
		compositor.install();
		compositor.paint();
		assert.match(strip(writes.at(-1) ?? ""), /~\/proj/);
		compositor.dispose();
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
});

test("session toggles, resizes, and remembers settings", () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-sidebar-session-"));
	const path = join(dir, "settings.json");
	const { tui, renders } = fakeTui();
	const session = new VoiceSidebarSession(() => model(), path);
	try {
		session.bind(tui);
		assert.equal(session.showing, true);
		assert.equal(tui.terminal.columns, sidebarLayout(80, 40).main);
		assert.equal(renders.count, 1);

		session.setWidth(24);
		assert.equal(tui.terminal.columns, sidebarLayout(80, 24).main);
		assert.equal(loadVoiceSidebarSettings(path).width, 24);

		session.setEnabled(false);
		assert.equal(session.showing, false);
		assert.equal(tui.terminal.columns, 80);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).enabled, false);

		session.setEnabled(true);
		assert.equal(session.showing, true);
		assert.equal(tui.terminal.columns, sidebarLayout(80, 24).main);

		session.dispose();
		assert.equal(tui.terminal.columns, 80);
		assert.equal(session.showing, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("render scheduler coalesces and cancel drops a pending paint", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let paints = 0;
		const scheduler = createRenderScheduler(() => {
			paints += 1;
		}, 16);
		scheduler.schedule();
		scheduler.schedule();
		assert.equal(paints, 0);
		mock.timers.tick(16);
		assert.equal(paints, 1);
		scheduler.schedule();
		scheduler.cancel();
		mock.timers.tick(16);
		assert.equal(paints, 1);
	} finally {
		mock.timers.reset();
	}
});
