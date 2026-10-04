// theme.test.ts — W269: the klh dark/light theme layer — token swap CSS,
// pre-paint resolution + persistence (localStorage `klh-theme`, system =
// prefers-color-scheme), the settings-panel binding, and every page wearing
// the tokens instead of hardcoded palette colors. W291: scale tokens, the
// shared klh·fleet strip, and the version pin that guards the vendored
// copies in belt + klh-local.
import { describe, expect, test } from "bun:test";
import {
	FLEET_NAV_CSS,
	FLEET_NAV_JS,
	FLEET_SITES,
	fleetNav,
	KLH_THEME_VERSION,
	SCALE,
	settingsBlock,
	THEME_CSS,
	THEME_HEAD,
	THEME_KEY,
	THEME_PREPAINT_JS,
	THEME_SETTINGS_CSS,
	THEME_SETTINGS_JS,
	TOKENS,
} from "../hooks/lib/theme.ts";
import { HTML } from "../hooks/bin/fleet-board-html.ts";
import { consolePage } from "../hooks/bin/console-html.ts";

type Listener = (e: { key?: string; target?: unknown }) => void;

// minimal browser double: documentElement attrs, localStorage, matchMedia,
// document/window event buses — enough to run the shipped script strings
function browser(opts: {
	stored?: string | null;
	prefersLight?: boolean | null;
	storageThrows?: boolean;
}) {
	const attrs: Record<string, string> = {};
	const store = new Map<string, string>();
	if (opts.stored != null) store.set(THEME_KEY, opts.stored);
	const docL: Record<string, Listener[]> = {};
	const winL: Record<string, Listener[]> = {};
	const mqL: Listener[] = [];
	const events: { theme: string; pref: string }[] = [];
	const mq =
		opts.prefersLight == null
			? null
			: {
					matches: opts.prefersLight,
					addEventListener: (_t: string, f: Listener) => mqL.push(f),
				};
	const localStorage = {
		getItem: (k: string) => {
			if (opts.storageThrows) throw new Error("denied");
			return store.get(k) ?? null;
		},
		setItem: (k: string, v: string) => {
			if (opts.storageThrows) throw new Error("denied");
			store.set(k, v);
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
	};
	const document = {
		documentElement: {
			setAttribute: (k: string, v: string) => {
				attrs[k] = v;
			},
		},
		addEventListener: (t: string, f: Listener) => {
			docL[t] = [...(docL[t] ?? []), f];
		},
		dispatchEvent: (e: { type: string; detail: (typeof events)[0] }) => {
			events.push(e.detail);
			for (const f of docL[e.type] ?? []) f(e);
			return true;
		},
		getElementById: (_id: string): unknown => null,
	};
	class CustomEvent {
		type: string;
		detail: unknown;
		constructor(type: string, init: { detail: unknown }) {
			this.type = type;
			this.detail = init.detail;
		}
	}
	const window: Record<string, unknown> = {
		localStorage,
		matchMedia: mq ? () => mq : undefined,
		addEventListener: (t: string, f: Listener) => {
			winL[t] = [...(winL[t] ?? []), f];
		},
	};
	const run = (src: string) =>
		new Function("window", "document", "CustomEvent", "Node", src)(
			window,
			document,
			CustomEvent,
			Object,
		);
	run(THEME_PREPAINT_JS);
	return { attrs, store, mq, mqL, winL, docL, events, window, document, run };
}

const api = (b: ReturnType<typeof browser>) =>
	b.window.klhTheme as {
		pref: () => string;
		set: (p: string) => string;
		apply: () => string;
	};

describe("token CSS (W269)", () => {
	test("every token has a dark and a light value, both emitted", () => {
		for (const [k, [dark, light]] of Object.entries(TOKENS)) {
			expect(k.startsWith("--klh-")).toBe(true);
			expect(dark.length).toBeGreaterThan(0);
			expect(light.length).toBeGreaterThan(0);
			expect(THEME_CSS).toContain(`${k}:${dark};`);
			expect(THEME_CSS).toContain(`${k}:${light};`);
		}
	});
	test("docs/theme-tokens.md lists every token with both values", async () => {
		const doc = await Bun.file(
			new URL("../docs/theme-tokens.md", import.meta.url),
		).text();
		const q = (s: string) => s.replace(/[.()]/g, "\\$&");
		for (const [k, [dark, light]] of Object.entries(TOKENS))
			expect(doc).toMatch(
				new RegExp(
					`\`${k}\`\\s*\\|\\s*\`${q(dark)}\`\\s*\\|\\s*\`${q(light)}\``,
				),
			);
	});
	test("data-theme selectors swap the set; dark is the no-attr default", () => {
		expect(THEME_CSS).toContain(
			':root,:root[data-theme="dark"]{color-scheme:dark;',
		);
		expect(THEME_CSS).toContain(
			':root[data-theme="light"]{color-scheme:light;',
		);
		expect(THEME_CSS).toContain(
			"@media (prefers-color-scheme: light){:root:not([data-theme])",
		);
	});
});

// full regex escape: scale values carry quotes, commas and dots
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

describe("scale tokens (W291)", () => {
	test("one theme-independent :root rule, ahead of the colour sets", () => {
		const head = THEME_CSS.slice(0, THEME_CSS.indexOf("}") + 1);
		expect(head).toStartWith(":root{--klh-");
		for (const [k, v] of Object.entries(SCALE)) {
			expect(k.startsWith("--klh-")).toBe(true);
			expect(TOKENS[k]).toBeUndefined();
			expect(head).toContain(`${k}:${v};`);
			expect(THEME_CSS.split(`${k}:`).length).toBe(2);
		}
	});
	test("docs/theme-tokens.md lists every scale token with its value", async () => {
		const doc = await Bun.file(
			new URL("../docs/theme-tokens.md", import.meta.url),
		).text();
		for (const [k, v] of Object.entries(SCALE))
			expect(doc).toMatch(new RegExp(`\`${k}\`\\s*\\|\\s*\`${rx(v)}\``));
	});
});

describe("pre-paint resolution + persistence (W269)", () => {
	test("no stored pref + no media query → system → dark", () => {
		const b = browser({});
		expect(b.attrs["data-theme"]).toBe("dark");
		expect(b.attrs["data-theme-pref"]).toBe("system");
	});
	test("system follows prefers-color-scheme", () => {
		expect(browser({ prefersLight: true }).attrs["data-theme"]).toBe("light");
		expect(browser({ prefersLight: false }).attrs["data-theme"]).toBe("dark");
	});
	test("stored pref wins over the media query", () => {
		const b = browser({ stored: "dark", prefersLight: true });
		expect(b.attrs["data-theme"]).toBe("dark");
		expect(b.attrs["data-theme-pref"]).toBe("dark");
		expect(browser({ stored: "light" }).attrs["data-theme"]).toBe("light");
	});
	test("junk stored value degrades to system", () => {
		const b = browser({ stored: "neon", prefersLight: true });
		expect(b.attrs["data-theme"]).toBe("light");
		expect(b.attrs["data-theme-pref"]).toBe("system");
	});
	test("set() persists light/dark, system clears the key", () => {
		const b = browser({ prefersLight: false });
		expect(api(b).set("light")).toBe("light");
		expect(b.store.get(THEME_KEY)).toBe("light");
		expect(b.attrs["data-theme"]).toBe("light");
		api(b).set("system");
		expect(b.store.has(THEME_KEY)).toBe(false);
		expect(b.attrs["data-theme"]).toBe("dark");
	});
	test("blocked storage still themes (system)", () => {
		const b = browser({ storageThrows: true, prefersLight: true });
		expect(b.attrs["data-theme"]).toBe("light");
		expect(api(b).set("dark")).toBe("light");
	});
	test("OS scheme flip re-applies only while on system", () => {
		const b = browser({ prefersLight: false });
		const mq = b.mq as { matches: boolean };
		mq.matches = true;
		for (const f of b.mqL) f({});
		expect(b.attrs["data-theme"]).toBe("light");
		api(b).set("dark");
		mq.matches = false;
		for (const f of b.mqL) f({});
		mq.matches = true;
		for (const f of b.mqL) f({});
		expect(b.attrs["data-theme"]).toBe("dark");
	});
	test("cross-tab storage event re-applies", () => {
		const b = browser({});
		b.store.set(THEME_KEY, "light");
		for (const f of b.winL.storage ?? []) f({ key: THEME_KEY });
		expect(b.attrs["data-theme"]).toBe("light");
	});
	test("klh-themechange fires with {theme, pref}", () => {
		const b = browser({ prefersLight: true });
		api(b).set("dark");
		expect(b.events).toEqual([
			{ theme: "light", pref: "system" },
			{ theme: "dark", pref: "dark" },
		]);
	});
});

describe("settings panel binding (W269)", () => {
	test("markup: native details + one radio per pref, system checked", () => {
		const m = settingsBlock("<a href='/x'>more</a>");
		expect(m).toStartWith('<details class="klh-settings" id="klh-settings">');
		for (const p of ["light", "dark", "system"])
			expect(m).toContain(`name="${THEME_KEY}" value="${p}"`);
		expect(m).toContain('value="system" checked');
		expect(m).toContain("<a href='/x'>more</a>");
	});
	test("radios reflect the pref and write through klhTheme.set", () => {
		const b = browser({ stored: "light" });
		type Radio = {
			value: string;
			checked: boolean;
			on?: (e: { target: Radio }) => void;
			addEventListener: (t: string, f: (e: { target: Radio }) => void) => void;
		};
		const radios: Radio[] = ["light", "dark", "system"].map((value) => {
			const r: Radio = {
				value,
				checked: false,
				addEventListener: (_t, f) => {
					r.on = f;
				},
			};
			return r;
		});
		const box = {
			open: true,
			querySelectorAll: () => radios,
			querySelector: () => null,
			contains: () => false,
		};
		b.document.getElementById = (id: string) =>
			id === "klh-settings" ? box : null;
		b.run(THEME_SETTINGS_JS);
		expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
		radios[1].on?.({ target: radios[1] });
		expect(b.store.get(THEME_KEY)).toBe("dark");
		expect(b.attrs["data-theme"]).toBe("dark");
		expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
		for (const f of b.docL.keydown ?? []) f({ key: "Escape" } as never);
		expect(box.open).toBe(false);
	});
});

describe("fleet strip markup (W291)", () => {
	test("native nav, one link per site in order, current marked + unprobed", () => {
		const m = fleetNav("suspenders");
		expect(m).toStartWith(
			'<nav class="klh-fleetnav" id="klh-fleetnav" aria-label="klh fleet">',
		);
		const links = [...m.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)];
		expect(links.map((l) => l[2])).toEqual(["belt", "suspenders", "local"]);
		expect(links[1][1]).toContain('aria-current="page"');
		expect(links[1][1]).not.toContain("data-repo");
		for (const i of [0, 2]) {
			expect(links[i][1]).not.toContain("aria-current");
			expect(links[i][1]).toContain(`data-repo="${FLEET_SITES[i].repo}"`);
		}
		expect(fleetNav("")).not.toContain("aria-current");
	});
	test("sites: https .local hosts, klh repos, ports in the titles", () => {
		const ports = { belt: ":7791", suspenders: ":7799", local: ":7792" };
		for (const s of FLEET_SITES) {
			expect(s.href).toMatch(/^https:\/\/[a-z]+\.local$/);
			expect(s.repo).toBe(`https://github.com/klh/${s.id}`);
			expect(s.title).toContain(ports[s.id]);
		}
	});
	test("css is tokens only; no innerHTML / DOM construction anywhere", () => {
		for (const css of [FLEET_NAV_CSS, THEME_SETTINGS_CSS])
			expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
		for (const src of [FLEET_NAV_JS, THEME_SETTINGS_JS, THEME_PREPAINT_JS])
			expect(src).not.toMatch(
				/innerHTML|outerHTML|document\.write|createElement/,
			);
	});
});

// FLEET_NAV_JS against a fake strip: two sibling links + a scripted fetch
function fleetStrip(up: (url: string) => boolean, hidden = false) {
	const link = (href: string, repo: string) => {
		const cls = new Set<string>();
		const toggle = (c: string, on: boolean) => {
			if (on) cls.add(c);
			else cls.delete(c);
		};
		const getAttribute = (k: string) => (k === "data-repo" ? repo : null);
		return {
			href,
			title: `${href} tip`,
			cls,
			classList: { toggle },
			getAttribute,
		};
	};
	const links = [
		link("https://belt.local/", "https://github.com/klh/belt"),
		link("https://bar.local/", "https://github.com/klh/local"),
	];
	const calls: [string, Record<string, string>][] = [];
	const on: Record<string, () => void> = {};
	let every = 0;
	const document = {
		hidden,
		getElementById: (id: string) =>
			id === "klh-fleetnav" ? { querySelectorAll: () => links } : null,
		addEventListener: (t: string, f: () => void) => {
			on[t] = f;
		},
	};
	const fetch = (url: string, init: Record<string, string>) => {
		calls.push([url, init]);
		return up(url)
			? Promise.resolve({})
			: Promise.reject(new TypeError("down"));
	};
	const tick = (_f: () => void, ms: number) => {
		every = ms;
	};
	new Function("window", "document", "setInterval", FLEET_NAV_JS)(
		{ fetch },
		document,
		tick,
	);
	const settle = () => new Promise((r) => setTimeout(r, 0));
	return { links, calls, on, settle, every: () => every };
}

describe("fleet strip probe (W291)", () => {
	test("probes each sibling: HEAD /ping, no-cors, every 5s", async () => {
		const s = fleetStrip(() => true);
		await s.settle();
		expect(s.calls.map((c) => c[0])).toEqual([
			"https://belt.local/ping",
			"https://bar.local/ping",
		]);
		expect(s.calls[0][1]).toEqual({
			method: "HEAD",
			mode: "no-cors",
			cache: "no-store",
		});
		expect(s.every()).toBe(5000);
		expect(s.links.map((l) => l.cls.has("down"))).toEqual([false, false]);
	});
	test("unreachable site dims + points at its repo, then recovers", async () => {
		let barUp = false;
		const s = fleetStrip((u) => !u.includes("bar.local") || barUp);
		await s.settle();
		const bar = s.links[1];
		expect([bar.cls.has("down"), bar.href]).toEqual([
			true,
			"https://github.com/klh/local",
		]);
		expect(bar.title).toContain("unreachable");
		expect(s.links[0].cls.has("down")).toBe(false);
		barUp = true;
		s.on.visibilitychange();
		await s.settle();
		expect([bar.cls.has("down"), bar.href, bar.title]).toEqual([
			false,
			"https://bar.local/",
			"https://bar.local/ tip",
		]);
	});
	test("hidden tab: no probes until it is visible again", async () => {
		const s = fleetStrip(() => true, true);
		await s.settle();
		expect(s.calls).toEqual([]);
	});
});

// strip the token block itself + data: URIs, then no palette literal remains
const palette =
	/#(141413|171614|1c1b19|232220|e8e6e1|98958e|d8900f|c96a4f|af2f12)\b|rgba\(255,255,255/i;
const bodyOf = (h: string) =>
	h.replace(THEME_HEAD, "").replace(/data:image\/[^"]+/g, "");

describe("pages wear the theme (W269)", () => {
	test("fleet board: pre-paint in <head>, settings in the topbar, no palette literals", () => {
		const head = HTML.slice(0, HTML.indexOf("</head>"));
		expect(head).toContain(THEME_HEAD);
		expect(head.indexOf(THEME_HEAD)).toBeLessThan(head.indexOf("<style>\n"));
		expect(HTML).toContain('id="klh-settings"');
		expect(HTML).toContain("klh-themechange");
		expect(bodyOf(HTML)).not.toMatch(palette);
		expect(HTML).not.toContain("color-scheme: dark");
	});
	test("console page: same contract, settings link kept", () => {
		const page = consolePage("Settings", "settings", "<p>x</p>");
		expect(page.slice(0, page.indexOf("</head>"))).toContain(THEME_HEAD);
		expect(page).toContain('id="klh-settings"');
		expect(page).toContain('<a aria-current="page" href="/console/settings">');
		expect(bodyOf(page)).not.toMatch(palette);
	});
	test("board + console wear the fleet strip above #cbar, menu names pages", () => {
		const strip = fleetNav("suspenders");
		const page = consolePage("Belt", "belt", "<p>x</p>");
		for (const h of [HTML, page]) {
			expect(h.split(strip).length).toBe(2);
			expect(h.indexOf(strip)).toBeLessThan(h.indexOf('id="cbar"'));
			expect(h).toContain(FLEET_NAV_CSS);
			expect(h).toContain(FLEET_NAV_JS);
		}
		const tabs = [...page.matchAll(/class="cnav"[^>]*>([^<]+)</g)].map(
			(m) => m[1],
		);
		expect(tabs).toEqual(["belt gateway", "fleet board", "local services"]);
		expect(page).toContain('aria-current="page" href="/console/belt"');
	});
});

describe("token names resolve (W291)", () => {
	// a var(--klh-typo, #hex) silently wears its dark fallback forever —
	// klh-service-row shipped --klh-base/--klh-bad: black-on-black in light
	test("every var(--klh-*) under hooks/ names a defined token", async () => {
		const defined = new Set(
			[...THEME_CSS.matchAll(/(--klh-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
		);
		const root = `${import.meta.dir}/..`;
		const stray: string[] = [];
		for await (const f of new Bun.Glob("hooks/**/*.ts").scan(root)) {
			const src = await Bun.file(`${root}/${f}`).text();
			for (const m of src.matchAll(/var\((--klh-[a-z0-9-]+)/g))
				if (!defined.has(m[1])) stray.push(`${f}: ${m[1]}`);
		}
		expect(stray).toEqual([]);
	});
});

describe("vendoring pin (W291)", () => {
	test("THEME_HEAD stamps the version on the token block", () => {
		expect(THEME_HEAD).toStartWith(
			`<style id="klh-theme-tokens" data-klh-theme="${KLH_THEME_VERSION}">`,
		);
	});
	// Edited hooks/lib/theme.ts? Bump KLH_THEME_VERSION, paste the new sha256
	// here, then re-copy the file to belt + local bin/klh-theme.ts
	// (docs/theme-tokens.md, "Vendoring").
	test("theme.ts bytes are pinned to KLH_THEME_VERSION", async () => {
		const src = await Bun.file(
			new URL("../hooks/lib/theme.ts", import.meta.url),
		).arrayBuffer();
		const sha256 = new Bun.CryptoHasher("sha256").update(src).digest("hex");
		expect({ version: KLH_THEME_VERSION, sha256 }).toEqual({
			version: "1.1.0",
			sha256:
				"5941ab1ba3ce1b25af38cd46ff68a70182dd2be8d55a0ef739f65f87a80b6d99",
		});
	});
});
