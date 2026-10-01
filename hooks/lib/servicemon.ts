// servicemon.ts — W125: the one observability module every fleet service
// wires. A tiny metrics registry (counter/histogram primitives, label sets),
// a TTL status cache and a Bun.serve fetch wrapper. Two lines per service:
//
//	const sm = servicemon({ service: "x", port: PORT });
//	Bun.serve({ ..., fetch: sm.fetch(routes) });
//
// GET /status  → JSON snapshot (≤ STATUS_REFRESH_S stale; default 5s,
//                0 = always fresh): { service, port, started_at, uptime_s,
//                healthy, requests { total, by_route }, last_error,
//                generated_at }
// GET /metrics → Prometheus TEXT exposition: COUNTER http_requests_total
//                {route}, HISTOGRAM http_request_duration_seconds (default
//                buckets .005/.01/.025/.05/.1/.25/.5/1/2.5/5/10), COUNTER
//                tokens_total{kind="in|out|cache_read|cache_create"} where
//                the service actually sees usage — a service with no token
//                dimension omits the family honestly rather than faking
//                zeros. /health stays whatever it was (compat).

export const DEFAULT_BUCKETS: number[] = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export type Labels = Record<string, string>;
export type TokenKind = "in" | "out" | "cache_read" | "cache_create";

export interface Counter {
	inc(labels?: Labels, v?: number): void;
	// absolute write for aggregates recomputed from an authoritative source
	// (board tokens_total): Prometheus counter-reset semantics apply
	set(labels: Labels, v: number): void;
}

export interface Histogram {
	observe(labels: Labels | undefined, seconds: number): void;
}

export interface Servicemon {
	// wraps a service's routes as a Bun.serve fetch: answers /status and
	// /metrics itself, instruments everything else (route + duration, errors)
	fetch(
		inner: (req: Request) => Response | Promise<Response>,
	): (req: Request) => Promise<Response>;
	// two-line wiring for an existing Bun.serve options literal:
	//	const base = { port, hostname, async fetch(req) {...} };
	//	Bun.serve(sm.wrapped(base));
	wrapped(o: Bun.ServeOptions): Bun.ServeOptions;
	counter(name: string, help: string): Counter;
	histogram(name: string, help: string, buckets?: number[]): Histogram;
	tokens(kind: TokenKind, n: number, extra?: Labels): void;
	tokensSet(kind: TokenKind, v: number, extra?: Labels): void;
	expose(): string;
	refreshS: number;
}

export interface ServicemonOptions {
	service: string;
	port: number;
	// overrides STATUS_REFRESH_S (default 5s; 0 = always fresh)
	refreshS?: number;
	healthy?: () => boolean;
	buckets?: number[];
	// invoked on every /metrics scrape before exposition — expensive feeds
	// self-throttle against the same TTL window (fleet-board token aggregate)
	onMetrics?: () => void;
}

// /Users/<name> paths never leave the machine through an observability
// payload — status error messages and board project labels scrub to ~
export const scrub = (text: string): string =>
	text.replace(/\/Users\/[^/\s'"]+/g, "~");

// bounded route cardinality: dynamic segments (numeric ids, hex ids,
// uuid/sid-ish tokens) collapse to :id — /verify/123 and /verify/456 are
// ONE route, so the label set can't grow without bound
export const routeOf = (pathname: string): string => {
	if (pathname === "") return "/";
	const segs = pathname
		.split("/")
		.map((s) =>
			/^(?:\d+|[0-9a-f]{8,}|[0-9a-f][0-9a-f-]{7,})$/i.test(s) ? ":id" : s,
		);
	return segs.join("/");
};

const parseRefreshS = (): number => {
	const raw = (process.env.STATUS_REFRESH_S ?? "").trim();
	const n = Number(raw);
	return raw === "" || !Number.isFinite(n) || n < 0 ? 5 : n;
};

const esc = (v: string): string =>
	v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

// W155 http-citizenship: strong content-hash ETag helpers, shared by every
// surface that serves GET-able snapshots (/status, board JSON feeds).
export const etagOf = (body: string): string =>
	`"${new Bun.CryptoHasher("sha1").update(body).digest("hex")}"`;

// If-None-Match: `*`, one tag, or a comma list (RFC 9110 §13.1.2); weak
// comparison — a W/ prefix still matches the strong tag we serve.
export const matchesEtag = (inm: string | null, etag: string): boolean =>
	inm !== null &&
	(inm.trim() === "*" ||
		inm
			.split(",")
			.map((t) => t.trim().replace(/^W\//, ""))
			.includes(etag));

const labelKey = (labels?: Labels): string =>
	labels
		? Object.keys(labels)
				.sort()
				.map((k) => `${k}\u0000${String(labels[k])}`)
				.join("\u0001")
		: "";

const labelStr = (labels: Labels): string => {
	const parts = Object.entries(labels)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([k, v]) => `${k}="${esc(v)}"`);
	return parts.length ? `{${parts.join(",")}}` : "";
};

interface CounterFamily {
	help: string;
	series: Map<string, { labels: Labels; value: number }>;
}

interface HistSeries {
	labels: Labels;
	counts: number[]; // per-bucket, raw — prefix-summed at exposition
	sum: number;
	count: number;
}

interface HistFamily {
	help: string;
	buckets: number[];
	series: Map<string, HistSeries>;
}

export function servicemon(opts: ServicemonOptions): Servicemon {
	const counters = new Map<string, CounterFamily>();
	const histograms = new Map<string, HistFamily>();
	const startedAt = new Date();
	const startedMs = performance.now();
	const refreshS = opts.refreshS ?? parseRefreshS();
	let lastError: { at: string; message: string } | null = null;
	let statusCache: { at: number; body: string } | null = null;

	const counter = (name: string, help: string): Counter => {
		const fam = (): CounterFamily => {
			let f = counters.get(name);
			if (!f) {
				f = { help, series: new Map() };
				counters.set(name, f);
			}
			return f;
		};
		const seriesOf = (labels?: Labels) => {
			const f = fam();
			const k = labelKey(labels);
			let s = f.series.get(k);
			if (!s) {
				s = { labels: labels ? { ...labels } : {}, value: 0 };
				f.series.set(k, s);
			}
			return s;
		};
		return {
			inc: (labels?: Labels, v = 1) => {
				seriesOf(labels).value += v;
			},
			set: (labels: Labels, v: number) => {
				seriesOf(labels).value = v;
			},
		};
	};

	const histogram = (
		name: string,
		help: string,
		buckets?: number[],
	): Histogram => {
		const fam = (): HistFamily => {
			let f = histograms.get(name);
			if (!f) {
				f = { help, buckets: buckets ?? DEFAULT_BUCKETS, series: new Map() };
				histograms.set(name, f);
			}
			return f;
		};
		return {
			observe: (labels: Labels | undefined, seconds: number) => {
				const f = fam();
				const k = labelKey(labels);
				let s = f.series.get(k);
				if (!s) {
					s = {
						labels: labels ? { ...labels } : {},
						counts: f.buckets.map(() => 0),
						sum: 0,
						count: 0,
					};
					f.series.set(k, s);
				}
				let hit = -1;
				for (let i = 0; i < f.buckets.length; i++)
					if (seconds <= f.buckets[i]) {
						hit = i;
						break;
					}
				if (hit >= 0) s.counts[hit] += 1;
				s.sum += seconds;
				s.count += 1;
			},
		};
	};

	const expose = (): string => {
		const lines: string[] = [];
		for (const [name, f] of counters) {
			if (!f.series.size) continue; // no samples → no family, honestly
			lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} counter`);
			for (const s of f.series.values())
				lines.push(`${name}${labelStr(s.labels)} ${s.value}`);
		}
		for (const [name, f] of histograms) {
			if (!f.series.size) continue;
			lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} histogram`);
			for (const s of f.series.values()) {
				let cum = 0;
				f.buckets.forEach((b, i) => {
					cum += s.counts[i];
					lines.push(
						`${name}_bucket${labelStr({ ...s.labels, le: String(b) })} ${cum}`,
					);
				});
				lines.push(
					`${name}_bucket${labelStr({ ...s.labels, le: "+Inf" })} ${s.count}`,
				);
				lines.push(`${name}_sum${labelStr(s.labels)} ${s.sum}`);
				lines.push(`${name}_count${labelStr(s.labels)} ${s.count}`);
			}
		}
		return lines.length ? `${lines.join("\n")}\n` : "";
	};

	const tokenCounts = counter(
		"tokens_total",
		"Cumulative token usage by kind, as seen by this service.",
	);
	const httpRequests = counter(
		"http_requests_total",
		"Total HTTP requests handled, by route.",
	);
	const httpDuration = histogram(
		"http_request_duration_seconds",
		"HTTP request duration in seconds.",
	);

	const noteError = (message: string): void => {
		lastError = {
			at: new Date().toISOString(),
			message: scrub(message).slice(0, 300),
		};
	};

	const snapshot = (): Record<string, unknown> => {
		const byRoute: Record<string, number> = {};
		let total = 0;
		const f = counters.get("http_requests_total");
		if (f)
			for (const s of f.series.values()) {
				total += s.value;
				const r = s.labels.route ?? "?";
				byRoute[r] = (byRoute[r] ?? 0) + s.value;
			}
		return {
			service: opts.service,
			port: opts.port,
			started_at: startedAt.toISOString(),
			uptime_s: Math.round(performance.now() - startedMs) / 1000,
			healthy: opts.healthy ? opts.healthy() === true : true,
			requests: { total, by_route: byRoute },
			last_error: lastError ? { ...lastError } : null,
			generated_at: new Date().toISOString(),
		};
	};

	// W155 http-citizenship: ETag on the snapshot; If-None-Match hit → 304
	// with the ETag echo (docs/design/http-citizenship.md).
	const statusResponse = (req: Request): Response => {
		if (
			refreshS <= 0 ||
			!statusCache ||
			Date.now() - statusCache.at >= refreshS * 1000
		)
			statusCache = { at: Date.now(), body: JSON.stringify(snapshot()) };
		const etag = etagOf(statusCache.body);
		const headers: Record<string, string> = {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			etag,
		};
		if (matchesEtag(req.headers.get("if-none-match"), etag))
			return new Response(null, { status: 304, headers });
		return new Response(statusCache.body, { headers });
	};

	const metricsResponse = (): Response =>
		new Response(expose(), {
			headers: {
				"content-type": "text/plain; version=0.0.4; charset=utf-8",
			},
		});

	const handle = async (
		req: Request,
		inner: (req: Request) => Response | Promise<Response>,
	): Promise<Response> => {
		const t0 = performance.now();
		const path = new URL(req.url).pathname;
		const route = routeOf(path);
		let resp: Response;
		let threw = false;
		if (path === "/status" || path === "/metrics") {
			// W155 http-citizenship: OPTIONS → 204 + Allow; known path with a
			// wrong method → 405 + Allow; HEAD answers the GET headers, no body.
			const allow = "GET, HEAD, OPTIONS";
			if (req.method === "OPTIONS")
				resp = new Response(null, { status: 204, headers: { allow } });
			else if (req.method !== "GET" && req.method !== "HEAD")
				resp = new Response("method not allowed", {
					status: 405,
					headers: { allow },
				});
			else {
				if (path === "/metrics" && opts.onMetrics) {
					try {
						opts.onMetrics();
					} catch {}
				}
				resp = path === "/status" ? statusResponse(req) : metricsResponse();
				if (req.method === "HEAD")
					resp = new Response(null, {
						status: resp.status,
						headers: resp.headers,
					});
			}
		} else {
			try {
				resp = await inner(req);
			} catch (e) {
				threw = true;
				noteError(e instanceof Error ? e.message : String(e));
				resp = new Response("internal error", { status: 500 });
			}
		}
		httpRequests.inc({ route });
		httpDuration.observe({ route }, (performance.now() - t0) / 1000);
		// the synthetic note must not overwrite a real exception's message
		if (!threw && resp.status >= 500)
			noteError(`${req.method} ${route} -> ${resp.status}`);
		return resp;
	};

	return {
		fetch:
			(inner) =>
			(req: Request): Promise<Response> =>
				handle(req, inner),
		wrapped: (o: Bun.ServeOptions): Bun.ServeOptions => ({
			...o,
			fetch: (req: Request): Promise<Response> => handle(req, o.fetch),
		}),
		counter,
		histogram,
		tokens: (kind: TokenKind, n: number, extra?: Labels): void => {
			tokenCounts.inc({ kind, ...extra }, n);
		},
		tokensSet: (kind: TokenKind, v: number, extra?: Labels): void => {
			tokenCounts.set({ kind, ...extra }, v);
		},
		expose,
		refreshS,
	};
}
