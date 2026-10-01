// test/jobslab.test.ts — W177: per-class lane resource ceilings. Covered:
// class resolution (llm:* → the uncapped remote class), defaults + config
// merge from <fleet>/jobslab.json, clamping (non-root may only lower
// priority; caps ≤ 0 = uncapped), the sh -c prefix fragment, env-cap merge,
// and a LIVE sh exec proving the limits + nice take effect in a spawned
// lane process.
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	jobslabEnv,
	jobslabFor,
	jobslabPrefix,
	jobslabTag,
	laneClassOf,
} from "../scripts/lib/jobslab.ts";
import { spawnClaude } from "../scripts/lib/lane.ts";

const fleet = (cfg?: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "jobslab-fleet-"));
	if (cfg !== undefined) writeFileSync(join(dir, "jobslab.json"), cfg);
	return dir;
};

describe("lane class", () => {
	test("llm:* executors resolve to the remote class", () => {
		expect(laneClassOf("llm:macmini:8317")).toBe("llm");
		expect(laneClassOf("claude")).toBe("claude");
		expect(laneClassOf("codex")).toBe("codex");
	});
});

describe("defaults", () => {
	test("working classes carry the forkbomb-ceiling caps", () => {
		for (const cls of ["claude", "codex"]) {
			const js = jobslabFor(cls);
			expect(js.nice).toBe(10);
			expect(js.maxProc).toBe(2048);
			expect(js.cpuSeconds).toBe(3600);
			expect(js.fileBlocks).toBe(4_194_304);
			expect(js.env).toEqual({});
		}
	});

	test("llm (remote) class is locally uncapped", () => {
		const js = jobslabFor("llm");
		expect(js.nice).toBe(0);
		expect(js.maxProc).toBe(0);
		expect(js.cpuSeconds).toBe(0);
		expect(js.fileBlocks).toBe(0);
	});
});

describe("config merge", () => {
	test("class key overrides the default, other keys inherit", () => {
		const dir = fleet(`{"codex": {"maxProc": 4096}}`);
		expect(jobslabFor("codex", dir).maxProc).toBe(4096);
		expect(jobslabFor("codex", dir).nice).toBe(10);
		expect(jobslabFor("claude", dir).maxProc).toBe(2048);
		rmSync(dir, { recursive: true, force: true });
	});

	test('"*" applies to every class, cls wins over *', () => {
		const dir = fleet(`{"*": {"nice": 15}, "claude": {"nice": 5}}`);
		expect(jobslabFor("claude", dir).nice).toBe(5);
		expect(jobslabFor("codex", dir).nice).toBe(15);
		expect(jobslabFor("llm", dir).nice).toBe(15);
		expect(jobslabFor("llm", dir).maxProc).toBe(0);
		rmSync(dir, { recursive: true, force: true });
	});

	test("unreadable/missing config falls back to defaults", () => {
		const js = jobslabFor("claude", "/nonexistent-fleet-dir");
		expect(js.maxProc).toBe(2048);
	});
});

describe("prefix", () => {
	test("emits ulimits in order then exec nice", () => {
		const p = jobslabPrefix({
			nice: 10,
			maxProc: 400,
			cpuSeconds: 60,
			fileBlocks: 100,
			env: {},
		});
		expect(
			p.startsWith(
				"ulimit -u 400; ulimit -t 60; ulimit -f 100; exec nice -n 10 ",
			),
		).toBe(true);
	});

	test("zero caps + zero nice emit a bare exec", () => {
		const p = jobslabPrefix({
			nice: 0,
			maxProc: 0,
			cpuSeconds: 0,
			fileBlocks: 0,
			env: {},
		});
		expect(p).toBe("exec ");
	});
});

describe("env caps", () => {
	test("caps override the incoming lane env", () => {
		const js = {
			nice: 0,
			maxProc: 0,
			cpuSeconds: 0,
			fileBlocks: 0,
			env: { MAX_THINKING_TOKENS: "8000" },
		};
		const out = jobslabEnv(js, {
			HOME: "/u/kk",
			MAX_THINKING_TOKENS: "99999",
		});
		expect(out.MAX_THINKING_TOKENS).toBe("8000");
		expect(out.HOME).toBe("/u/kk");
	});
});

describe("live sh exec", () => {
	test("spawned sh inherits the limits + nice", () => {
		const js = jobslabFor("claude");
		const p = Bun.spawnSync([
			"/bin/sh",
			"-c",
			`${jobslabPrefix(js)}sh -c 'echo u=$(ulimit -Su) t=$(ulimit -t) n=$(ps -o nice= -p $$)'`,
		]);
		const out = p.stdout.toString().trim();
		const m = /u=(\d+) t=(\d+) n=(\d+)/.exec(out);
		expect(m).not.toBeNull();
		expect(Number(m?.[1] ?? 0)).toBe(js.maxProc);
		expect(Number(m?.[2] ?? 0)).toBe(js.cpuSeconds);
		expect(Number(m?.[3] ?? 0)).toBe(js.nice);
	});
});

describe("tag", () => {
	test("compact caps tag renders class + caps", () => {
		const js = jobslabFor("claude");
		expect(jobslabTag("claude", js)).toBe("claude:n10/p2048/c3600/f4194304");
	});
});

describe("spawnClaude wiring", () => {
	test("lane spawn applies slab preamble + env caps end to end", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jobslab-wire-"));
		const cfg = `{"claude": {"maxProc": 1500, "env": {"W177_PROOF": "yes"}}}`;
		writeFileSync(join(dir, "jobslab.json"), cfg);
		const fix = join(dir, "fixture.sh");
		const script = `#!/bin/sh\necho "u=$(ulimit -Su) t=$(ulimit -t) proof=$W177_PROOF nice=$(ps -o nice= -p $$)"\n`;
		writeFileSync(fix, script);
		chmodSync(fix, 0o755);
		const log = join(dir, "fixture.log");
		spawnClaude({
			bin: fix,
			prompt: "hi",
			cwd: dir,
			logFile: log,
			env: {},
			fleetDir: dir,
		}).unref();
		await Bun.sleep(900);
		const out = readFileSync(log, "utf8").trim();
		const m = /u=(\d+) t=(\d+) proof=(\S+) nice=(\d+)/.exec(out);
		expect(m).not.toBeNull();
		expect(m?.[1]).toBe("1500"); // config override reached the rlimit
		expect(m?.[2]).toBe("3600"); // default cpu cap intact
		expect(m?.[3]).toBe("yes"); // env cap rode the lane env
		expect(Number(m?.[4] ?? 0)).toBe(10); // niced
		rmSync(dir, { recursive: true, force: true });
	}, 20_000);
});
