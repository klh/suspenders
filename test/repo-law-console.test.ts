// test/repo-law-console.test.ts — W164: the /console/settings repo-scope
// editors at the HANDLER level (the fleet-board hookup is W157's; these
// tests call repoLawRoutes directly against a temp repo + temp secrets
// home — never the live config).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	byoApply,
	byoPreview,
	repoLawsApply,
	repoLawsPreview,
	repoLawRoutes,
} from "../hooks/bin/console-repo-law.ts";

const TMP = mkdtempSync(join(tmpdir(), "w164-console-"));
const REPO = mkdtempSync(join(tmpdir(), "w164-connrepo-"));
writeFileSync(join(REPO, ".git"), "", { flag: "wx" });
const ENV = { ...process.env, BUCKLE_SECRETS_HOME: join(TMP, "secrets") };
const DEPS = {
	repos: [REPO],
	env: ENV,
	guard: () => null, // handler-level tests bypass the origin guard
};
const html = { "content-type": "text/html; charset=utf-8" };
void html;

describe("repo laws console flow", () => {
	test("GET /console/settings/repos lists the repo with its state", async () => {
		const url = new URL("http://x/console/settings/repos");
		const res = await repoLawRoutes(
			new Request(url, { headers: { host: "x" } }),
			url,
			DEPS,
		);
		expect(res).not.toBeNull();
		const body = await res.text();
		expect(body).toContain("SETTINGS · REPO LAWS");
		expect(body).toContain(REPO);
		expect(body).toContain("defaults");
	});

	test("GET /console/settings/repos/edit renders the editor", async () => {
		const url = new URL(
			`http://x/console/settings/repos/edit?repo=${encodeURIComponent(REPO)}`,
		);
		const res = await repoLawRoutes(
			new Request(url, { headers: { host: "x" } }),
			url,
			DEPS,
		);
		const body = await res.text();
		expect(body).toContain("routing laws ·");
		expect(body).toContain("textarea");
	});

	test("preview→apply writes the DOTFILE and mirrors the config (dotfiles win)", async () => {
		const laws = "# w164 test\nprefer=model:qwen*\nmust=cloud\n";
		const prev = await repoLawsPreview(
			new URLSearchParams({ repo: REPO, laws }),
			DEPS,
		);
		expect(prev.status).toBe(200);
		const pv = await prev.text();
		expect(pv).toContain("prefer=model:qwen*");
		expect(pv).toContain("apply"); // the confirm form is on the page
		const form = /name="values" value="([^"]+)"/.exec(pv);
		const mtimeF = /name="mtime" value="([^"]+)"/.exec(pv);
		expect(form).not.toBeNull();
		const formApply = new URLSearchParams({
			feature: "repos",
			values: form[1] ?? "",
			mtime: mtimeF ? mtimeF[1] : "0",
		});
		const res = await repoLawsApply(formApply, DEPS);
		const body = await res.text();
		expect(body).toContain("applied");
		expect(body).toContain("adopt"); // dotfile + no config yet
		expect(readFileSync(join(REPO, ".llm"), "utf8")).toBe(laws);
		const cfg = JSON.parse(
			readFileSync(join(ENV.BUCKLE_SECRETS_HOME, "repo-laws.json"), "utf8"),
		) as { repos: Record<string, { dotfile: string; source: string }> };
		expect(cfg.repos[REPO].dotfile).toBe(laws);
		expect(cfg.repos[REPO].source).toBe("dotfile");
		// second apply with the config entry present → dotfile-wins (mirror)
		const pv2 = await (
			await repoLawsPreview(new URLSearchParams({ repo: REPO, laws }), DEPS)
		).text();
		const f2 = /name="values" value="([^"]+)"/.exec(pv2);
		const m2 = /name="mtime" value="([^"]+)"/.exec(pv2);
		const res2 = await repoLawsApply(
			new URLSearchParams({
				feature: "repos",
				values: f2 ? f2[1] : "",
				mtime: m2 ? m2[1] : "0",
			}),
			DEPS,
		);
		expect(await res2.text()).toContain("dotfile-wins");
	});

	test("invalid laws → editor re-render with line-numbered errors, NO write", async () => {
		const before = existsSync(join(REPO, ".llm"));
		const res = await repoLawsPreview(
			new URLSearchParams({ repo: REPO, laws: "prefer=\nwrongo=1\n" }),
			DEPS,
		);
		const body = await res.text();
		expect(body).toContain("line 1:");
		expect(body).toContain("line 2:");
		expect(existsSync(join(REPO, ".llm"))).toBe(before);
	});

	test("mtime guard: file changed since preview → apply refused", async () => {
		const laws = "prefer=local\n";
		const prev = await repoLawsPreview(
			new URLSearchParams({ repo: REPO, laws }),
			DEPS,
		);
		const pv = await prev.text();
		const form = /name="values" value="([^"]+)"/.exec(pv);
		// someone else writes the dotfile after the preview
		writeFileSync(join(REPO, ".llm"), "prefer=cloud\n");
		const res = await repoLawsApply(
			new URLSearchParams({
				feature: "repos",
				values: form ? form[1] : "",
				mtime: "1", // stale on purpose
			}),
			DEPS,
		);
		const body = await res.text();
		expect(body).toContain("config changed since the preview");
		// the concurrent write survived — apply did not clobber it
		expect(readFileSync(join(REPO, ".llm"), "utf8")).toBe("prefer=cloud\n");
	});
});

describe("byo user-plane console flow", () => {
	test("preview→apply writes local-models.json; key material refused", async () => {
		const good = [
			{
				name: "my-zai",
				base: "https://api.example.net/v1",
				model: "glm-5.3",
				key_name: "zai-one",
			},
		];
		const pv = await (
			await byoPreview(
				new URLSearchParams({ entries: JSON.stringify(good) }),
				DEPS,
			)
		).text();
		expect(pv).toContain("apply");
		const form = /name="values" value="([^"]+)"/.exec(pv);
		const res = await byoApply(
			new URLSearchParams({
				feature: "byo",
				values: form ? form[1] : "",
				mtime: "0",
			}),
			DEPS,
		);
		const body = await res.text();
		expect(body).toContain("user plane written");
		const entries = JSON.parse(
			readFileSync(join(ENV.BUCKLE_SECRETS_HOME, "local-models.json"), "utf8"),
		) as unknown[];
		expect(entries).toHaveLength(1);
		// key material is refused at preview AND apply
		const leak = [
			{
				name: "leak",
				base: "https://x.example.net/v1",
				model: "m",
				api_key: "sk-no",
			},
		];
		const pvL = await (
			await byoPreview(
				new URLSearchParams({ entries: JSON.stringify(leak) }),
				DEPS,
			)
		).text();
		expect(pvL).toContain("key MATERIAL");
		const resL = await byoApply(
			new URLSearchParams({
				feature: "byo",
				values: Buffer.from(JSON.stringify({ entries: leak })).toString(
					"base64",
				),
				mtime: "0",
			}),
			DEPS,
		);
		expect(await resL.text()).toContain("key MATERIAL");
	});
});

describe("write guard", () => {
	test("cross-origin POST is refused with 403", async () => {
		const url = new URL("http://board.local/console/settings/repos/preview");
		const res = await repoLawRoutes(
			new Request(url, {
				method: "POST",
				headers: { origin: "http://evil.example" },
			}),
			url,
			{ ...DEPS, guard: undefined }, // default same-origin guard applies
		);
		expect(res?.status).toBe(403);
	});
});
