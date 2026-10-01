// hooks/bin/console-repo-law.ts — W164: the /console/settings repo-scope
// editors (repo law editor + BYO user-plane editor). Same grammar and ONE
// parser as the dotfile (hooks/lib/repo-laws.ts — two editors, one store);
// the W147 flow (form → preview diff → apply) writes the DOTFILE itself on
// dotfile-backed repos — dotfiles win, the config store mirrors.
//
// MOUNT (one-line seam for the board dispatcher — fleet-board.ts is W157's;
// coordinate the hookup through the W157 thread):
//   import { repoLawRoutes } from "./console-repo-law.ts";
//   …in the dispatch chain, before the 404 fallthrough:
//   { const r = await repoLawRoutes(req, url, { guard: writeGuard, me: consoleMe() });
//     if (r) return r; }
// deps.guard is the board's origin/host writeGuard; when absent a local
// same-origin guard applies. All state lives in the repo's .llm dotfile and
// <secrets-home>/repo-laws.json + local-models.json (config-over-code).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	esc,
	consolePage,
	previewPage,
	type ConsoleMe,
} from "./console-html.ts";
import { atomicWrite, diffLines } from "../lib/board-config.ts";
import {
	parseLlmDotfile,
	repoLawsConfigPath,
	readRepoLawsConfig,
	reconcileApply,
	reconcileRepoLaws,
	readUserPlane,
	userPlanePath,
	validateUserPlaneEntry,
	writeUserPlane,
	type RepoLawsEntry,
} from "../lib/repo-laws.ts";
import { scrub } from "../lib/servicemon.ts";
import { openGovernorDb } from "../lib/govdb.ts";

// ─── deps (injected by the board hookup; sane standalone defaults) ────────
export interface RepoLawDeps {
	guard?: (req: Request, url: URL) => Response | null;
	me?: () => ConsoleMe; // consoleMe() — the topbar avatar payload
	repos?: string[]; // repo roots the editor offers (defaults to the workgraph)
	env?: NodeJS.ProcessEnv;
}

/** Same-origin write guard: Origin/Referer host must equal the request
 *  Host. The board hookup injects fleet-board's own writeGuard instead. */
export function defaultWriteGuard(req: Request, _url: URL): Response | null {
	const host = req.headers.get("host") ?? "";
	const origin = req.headers.get("origin") ?? "";
	const ref = req.headers.get("referer") ?? "";
	const src = origin || ref;
	if (!src) return new Response("forbidden: missing origin", { status: 403 });
	try {
		if (new URL(src).host !== host)
			return new Response("forbidden: cross-origin write", { status: 403 });
	} catch {
		return new Response("forbidden: bad origin", { status: 403 });
	}
	return null;
}

/** Repo roots for the picker: injected list wins; else the workgraph's
 *  distinct project paths that exist on disk. Never throws. */
export function listRepos(deps: RepoLawDeps): string[] {
	if (deps.repos !== undefined) return deps.repos;
	try {
		const db = openGovernorDb();
		const rows = db
			.query(
				"select distinct project from work_items where project is not null",
			)
			.all() as { project: string }[];
		return [
			...new Set(
				rows
					.map((r) => r.project.replace(/\/\.git$/, ""))
					.filter((p) => existsSync(p) && existsSync(join(p, ".git"))),
			),
		].sort();
	} catch {
		return [];
	}
}

// ─── per-repo law state (what the index shows) ────────────────────────────
export interface RepoLawState {
	root: string;
	state: string; // adopt | dotfile-wins | config-governs | defaults
	dotfile: string | null; // absolute dotfile path, null = none
	why: string;
}

/** Read the reconciliation state for one repo (no writes). */
export function repoLawState(
	root: string,
	env: NodeJS.ProcessEnv = {},
): RepoLawState {
	const dotPath = join(root, ".llm");
	const hasDot = existsSync(dotPath);
	const cfg = readRepoLawsConfig(env);
	const hasCfg = cfg.repos[root] !== undefined;
	const r = reconcileRepoLaws({
		dotfile: hasDot ? "present" : null,
		config: hasCfg ? "present" : null,
	});
	return {
		root,
		state: r.state,
		dotfile: hasDot ? dotPath : null,
		why: r.why,
	};
}

// ─── pages ─────────────────────────────────────────────────────────────────
const PAGE_CSS = `.lawtbl{width:100%;border-collapse:collapse;font-size:12px}.lawtbl td,.lawtbl th{padding:5px 8px;border-bottom:1px solid #2c2c2a;text-align:left}.lawtbl th{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#98958e}.lawtbl textarea{width:100%;min-height:160px;background:#141413;color:#e8e6e1;border:1px solid rgba(255,255,255,.14);border-radius:2px;padding:8px;font:12px ui-monospace,Menlo,monospace}.chip{display:inline-block;border:1px solid rgba(255,255,255,.14);border-radius:2px;padding:1px 7px;font-size:11px;color:#c3c2b7}.chip.dotfile{color:#a5c78a;border-color:#5c7a35}.chip.mirror{color:#c3c2b7}.chip.config{color:#d8900f;border-color:#d8900f}.chip.defaults{color:#98958e}`;

export const REPO_LAWS_CSS = PAGE_CSS;

const stateChip = (state: string): string => {
	const cls =
		state === "adopt" || state === "dotfile-wins"
			? "dotfile"
			: state === "config-governs"
				? "config"
				: "defaults";
	return `<span class="chip ${cls}">${esc(state)}</span>`;
};

/** GET /console/settings/repos — the repo law index: every repo with its
 *  reconciliation state, linking into the per-repo editor. */
export function repoLawsIndexPage(
	states: RepoLawState[],
	me?: ConsoleMe,
): string {
	const rows = states
		.map(
			(s) =>
				`<tr><td><b>${esc(s.root)}</b></td><td>${stateChip(s.state)}</td><td class="dim">${esc(s.why)}</td><td><a class="btn2" href="/console/settings/repos/edit?repo=${encodeURIComponent(s.root)}">edit laws</a></td></tr>`,
		)
		.join("");
	const body = `<style>${PAGE_CSS}</style><p class="dimpl">Repo-scoped routing laws — same W96 grammar, one parser. DOTFILES WIN: the .llm dotfile is the source; the config entry mirrors it. Writes go to the dotfile itself (preview + confirm, never silent).</p><div class="panel"><h2>repos</h2>${
		states.length
			? `<table class="lawtbl"><thead><tr><th>repo</th><th>state</th><th>why</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
			: `<p class="dimpl">no repos found — the picker lists the workgraph's project roots</p>`
	}</div><div class="panel"><h2>user plane (BYO-LLM)</h2><p class="dimpl">Private LLMs registered from YOUR config — entries carry the key NAME, the value lives in the secrets home at mode 600. They appear alongside — never inside — the hub-entitled menu.</p><div class="btnrow"><a class="btn2" href="/console/settings/byo">edit user plane</a></div></div>`;
	return consolePage("SETTINGS · REPO LAWS", "settings", body, me);
}

// ─── preview → apply (the W147 write guard, dotfile flavor) ───────────────
export interface DotfileValues {
	repo: string;
	text: string;
}

/** POST /console/settings/repos/preview — validate hard (the parser is the
 *  law), diff, and render the confirm page. Invalid input never reaches the
 *  confirm step. */
export function repoLawsPreview(
	form: URLSearchParams,
	deps: RepoLawDeps,
): Response {
	const env = deps.env ?? process.env;
	const root = form.get("repo") ?? "";
	const st = editorState(root, env);
	const text = form.get("laws") ?? "";
	const p = parseLlmDotfile(text);
	if (!p.ok) {
		const errs = p.errors.map((e) => `line ${String(e.line)}: ${e.why}`);
		return new Response(
			repoLawsEditPage({ ...st, text, errors: errs }, deps.me?.()),
		);
	}
	return repoLawsPreviewOk(st, text, env, deps);
}

/** Valid input: diff + the confirm page (mtime captured for the apply
 *  guard; values ride base64 like every other settings feature). */
function repoLawsPreviewOk(
	st: EditorState,
	text: string,
	env: NodeJS.ProcessEnv,
	deps: RepoLawDeps,
): Response {
	const mtime = existsSync(st.target)
		? String(statSync(st.target).mtimeMs)
		: "0";
	const values: DotfileValues = { repo: st.root, text };
	return new Response(
		previewPage(
			{
				feature: "repos",
				diff: diffLines(st.text, text),
				valuesJson: JSON.stringify(values),
				mtimeMs: mtime,
				target: scrub(st.target),
				flash: `reconciliation state: ${repoLawState(st.root, env).state}`,
			},
			deps.me?.(),
		),
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

/** POST /console/settings/repos/apply — mtime guard → re-validate (the
 *  parser is the law) → atomic dotfile write → reconcile (dotfiles win:
 *  the config store mirrors the dotfile). */
export function repoLawsApply(
	form: URLSearchParams,
	deps: RepoLawDeps,
): Response {
	const env = deps.env ?? process.env;
	let root = form.get("repo") ?? "";
	let text = form.get("laws") ?? "";
	const mtime = form.get("mtime") ?? "0";
	const valuesRaw = form.get("values");
	if (valuesRaw !== null && valuesRaw.length > 0) {
		const v = JSON.parse(
			Buffer.from(valuesRaw, "base64").toString("utf8"),
		) as DotfileValues;
		root = v.repo;
		text = v.text;
	}
	const st = editorState(root, env);
	if (existsSync(st.target) && String(statSync(st.target).mtimeMs) !== mtime)
		return new Response(
			repoLawsEditPage(
				{
					...st,
					errors: [
						"config changed since the preview — review the fresh diff and confirm again",
					],
				},
				deps.me?.(),
			),
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	return repoLawsApplyWrite(st, text, env, deps);
}

/** The write half of apply: validate → atomic dotfile write → the config
 *  store mirrors (dotfiles win). Redirect to the index with the state. */
function repoLawsApplyWrite(
	st: EditorState,
	text: string,
	env: NodeJS.ProcessEnv,
	deps: RepoLawDeps,
): Response {
	const p = parseLlmDotfile(text);
	if (!p.ok) {
		const errs = p.errors.map((e) => `line ${String(e.line)}: ${e.why}`);
		return new Response(
			repoLawsEditPage({ ...st, text, errors: errs }, deps.me?.()),
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	}
	atomicWrite(st.target, text);
	const ra = reconcileApply(st.root, env);
	if (ra.entry === null) removeRepoLawsEntry(st.root, env);
	else upsertRepoLawsEntry(st.root, ra.entry, env);
	const body = `<style>${PAGE_CSS}</style><div class="flash">applied ${esc(scrub(st.target))} — ${esc(ra.state)}: ${esc(ra.why)}</div><p><a class="btn2" href="/console/settings/repos">back to repo laws</a></p>`;
	return new Response(body, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

/** Upsert/remove in <secrets-home>/repo-laws.json (the reconciliation
 *  target the console mirrors into on every dotfile apply). */
function upsertRepoLawsEntry(
	root: string,
	entry: RepoLawsEntry,
	env: NodeJS.ProcessEnv,
): void {
	const p = repoLawsConfigPath(env);
	const cfg = readRepoLawsConfig(env);
	cfg.repos[root] = entry;
	atomicWrite(p, JSON.stringify(cfg, null, "\t"));
}

function removeRepoLawsEntry(root: string, env: NodeJS.ProcessEnv): void {
	const p = repoLawsConfigPath(env);
	const cfg = readRepoLawsConfig(env);
	delete cfg.repos[root];
	atomicWrite(p, JSON.stringify(cfg, null, "\t"));
}

// ─── BYO user plane (the menu's user half) ────────────────────────────────
export const byoPage = (
	read: { entries: unknown[]; errors: string[] },
	me?: ConsoleMe,
): string => {
	const listed = read.entries
		.map(
			(e) =>
				`<tr><td><b>${esc(String((e as { name: string }).name))}</b></td><td>${esc(String((e as { base: string }).base))}</td><td>${esc(String((e as { model: string }).model))}</td><td>${esc(String((e as { key_name?: string }).key_name ?? "—"))}</td><td><span class="chip dotfile">user</span></td></tr>`,
		)
		.join("");
	const body =
		`<style>${PAGE_CSS}</style>` +
		`<p class="dimpl">Private LLMs from YOUR config — the key NAME rides config, the value lives in the secrets home at mode 600. Entries appear alongside — never inside — the hub-entitled menu.</p>` +
		(read.errors.length
			? `<div class="errbox">${esc(read.errors.join("\n"))}</div>`
			: "") +
		`<div class="panel"><h2>registered user-plane models</h2>` +
		(listed
			? `<table class="lawtbl"><thead><tr><th>name</th><th>base</th><th>model</th><th>key name</th><th>plane</th></tr></thead><tbody>${listed}</tbody></table>`
			: `<p class="dimpl">none registered — the JSON below is the whole registry</p>`) +
		`</div><div class="panel"><h2>edit</h2><form method="post" action="/console/settings/byo/preview"><textarea name="entries" aria-label="user-plane entries JSON">${esc(JSON.stringify(read.entries, null, 2))}</textarea><p class="cfoot">JSON array: {name, base, model, key_name?, roles?} — api_key/key/token fields are REFUSED (key material lives by NAME in the secrets home). Store: ${esc(scrub(userPlanePath()))}</p><div class="btnrow"><button class="btn" type="submit">preview diff</button></div></form></div>`;
	return consolePage("SETTINGS · USER PLANE", "settings", body, me);
};

/** POST /console/settings/byo/preview — validate the WHOLE list (any bad
 *  entry = back to the editor with the errors, loud), diff, confirm page. */
export function byoPreview(form: URLSearchParams, deps: RepoLawDeps): Response {
	const env = deps.env ?? process.env;
	const raw = form.get("entries") ?? "[]";
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return new Response(
			byoPage(
				{ entries: [], errors: [`JSON does not parse: ${String(e)}`] },
				deps.me?.(),
			),
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	}
	const cur = readUserPlane(env);
	const next = Array.isArray(parsed) ? parsed : [parsed];
	return finishByoPreview(next, cur.entries, env, deps);
}

/** Valid JSON: validate entries, diff vs current, render the confirm page. */
function finishByoPreview(
	next: unknown[],
	curEntries: unknown[],
	env: NodeJS.ProcessEnv,
	deps: RepoLawDeps,
): Response {
	const errs = validateAllEntries(next);
	if (errs.length)
		return new Response(byoPage({ entries: [], errors: errs }, deps.me?.()), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	const mtime = existsSync(userPlanePath(env))
		? String(statSync(userPlanePath(env)).mtimeMs)
		: "0";
	return new Response(
		previewPage(
			{
				feature: "byo",
				diff: diffLines(
					JSON.stringify(curEntries, null, 2),
					JSON.stringify(next, null, 2),
				),
				valuesJson: JSON.stringify({ entries: next }),
				mtimeMs: mtime,
				target: scrub(userPlanePath(env)),
			},
			deps.me?.(),
		),
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

/** Validate every entry up front (loud, index-named). */
function validateAllEntries(next: unknown[]): string[] {
	const errs: string[] = [];
	for (const [i, e] of next.entries()) {
		const err = validateUserPlaneEntry(e);
		if (err !== null) errs.push(`entry[${String(i)}]: ${err}`);
	}
	return errs;
}

/** POST /console/settings/byo/apply — validate-all → atomic write of
 *  local-models.json (mtime guard included). */
export function byoApply(form: URLSearchParams, deps: RepoLawDeps): Response {
	const env = deps.env ?? process.env;
	const raw = form.get("values") ?? "";
	let values: { entries?: unknown[] } = {};
	try {
		values = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
			entries?: unknown[];
		};
	} catch {
		values = {};
	}
	const entries = Array.isArray(values.entries) ? values.entries : [];
	return byoApplyWrite(entries, env, deps);
}

/** Validate-all-then-write, with the honest flash naming what was written. */
function byoApplyWrite(
	entries: unknown[],
	env: NodeJS.ProcessEnv,
	deps: RepoLawDeps,
): Response {
	const errs = validateAllEntries(entries);
	if (errs.length)
		return new Response(byoPage({ entries: [], errors: errs }, deps.me?.()), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	const w = writeUserPlane(entries, env);
	if (!w.ok)
		return new Response(
			byoPage({ entries: [], errors: [w.why] }, deps.me?.()),
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	return new Response(
		`<style>${PAGE_CSS}</style><div class="flash">user plane written — ${String(w.wrote)} entry(ies); key material never leaves the secrets home</div><p><a class="btn2" href="/console/settings/byo">back</a></p>`,
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}
export interface EditorState {
	root: string;
	target: string; // the dotfile path this editor writes
	text: string; // current dotfile text ("" = none yet)
	exists: boolean;
	errors: string[]; // parse errors for the CURRENT text (loud, line numbers)
}

/** Current dotfile text + parse verdict for the editor. */
export function editorState(
	root: string,
	_env: NodeJS.ProcessEnv = {},
): EditorState {
	const dotPath = join(root, ".llm");
	const exists = existsSync(dotPath);
	const text = exists ? readFileSync(dotPath, "utf8") : "";
	const p = parseLlmDotfile(text);
	const errors = p.ok
		? []
		: p.errors.map((e) => `line ${String(e.line)}: ${e.why}`);
	return { root, target: dotPath, text, exists, errors };
}

/** GET /console/settings/repos/edit?repo=… — the laws editor. Invalid
 *  current text shows the parser's own errors verbatim, never a guess. */
export function repoLawsEditPage(st: EditorState, me?: ConsoleMe): string {
	const errbox = st.errors.length
		? `<div class="errbox">current .llm does not parse:\n${esc(st.errors.join("\n"))}</div>`
		: "";
	const body = `<style>${PAGE_CSS}</style><p class="dimpl">Target file: <span class="mono">${esc(st.target)}${st.exists ? "" : " (new file)"}</span>. DOTFILES WIN — the GUI writes the dotfile; the config entry mirrors it on apply.</p><div class="panel"><h2>routing laws · ${esc(st.root)}</h2><form method="post" action="/console/settings/repos/preview"><input type="hidden" name="repo" value="${esc(st.root)}"><textarea name="laws" aria-label="repo routing laws">${esc(st.text)}</textarea><p class="cfoot">Grammar: prefer=&lt;expr&gt; · must=&lt;expr&gt; · tier=simple|medium|complex|very_complex · fallback=csv · # comments · invalid lines fail loudly with line numbers</p><div class="btnrow"><button class="btn" type="submit">preview diff</button><a class="btn2" href="/console/settings/repos">cancel</a></div></form></div>${errbox}`;
	return consolePage("SETTINGS · REPO LAWS", "settings", body, me);
}

// ─── the router (the one-line seam for the board dispatcher) ──────────────
export async function repoLawRoutes(
	req: Request,
	url: URL,
	deps: RepoLawDeps = {},
): Promise<Response | null> {
	const env = deps.env ?? process.env;
	const me = deps.me?.();
	const html = { "content-type": "text/html; charset=utf-8" } as const;
	const p = url.pathname;
	if (p === "/console/settings/repos" && req.method === "GET") {
		const states = listRepos(deps).map((r) => repoLawState(r, env));
		return new Response(repoLawsIndexPage(states, me), { headers: html });
	}
	if (p === "/console/settings/repos/edit" && req.method === "GET") {
		const root = url.searchParams.get("repo") ?? "";
		if (!root || !existsSync(join(root, ".git")))
			return new Response("not a repo root", { status: 404 });
		return new Response(repoLawsEditPage(editorState(root, env), me), {
			headers: html,
		});
	}
	if (p === "/console/settings/repos/preview" && req.method === "POST") {
		const g = (deps.guard ?? defaultWriteGuard)(req, url);
		if (g) return g;
		return repoLawsPreview(new URLSearchParams(await req.text()), deps);
	}
	if (p === "/console/settings/repos/apply" && req.method === "POST") {
		const g = (deps.guard ?? defaultWriteGuard)(req, url);
		if (g) return g;
		return repoLawsApply(new URLSearchParams(await req.text()), deps);
	}
	if (p === "/console/settings/byo" && req.method === "GET") {
		return new Response(byoPage(readUserPlane(env), me), { headers: html });
	}
	if (p === "/console/settings/byo/preview" && req.method === "POST") {
		const g = (deps.guard ?? defaultWriteGuard)(req, url);
		if (g) return g;
		return byoPreview(new URLSearchParams(await req.text()), deps);
	}
	if (p === "/console/settings/byo/apply" && req.method === "POST") {
		const g = (deps.guard ?? defaultWriteGuard)(req, url);
		if (g) return g;
		return byoApply(new URLSearchParams(await req.text()), deps);
	}
	return null;
}
