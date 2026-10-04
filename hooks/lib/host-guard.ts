// hooks/lib/host-guard.ts — W264 perimeter: the ONE host/origin/write-token
// guard shared by the fleet board and knowledge-api.
//  • host allowlist on EVERY request: loopback names + *.local names from
//    SUSPENDERS_ALLOWED_HOSTS (default suspenders.local, the Caddy front) +
//    an explicitly configured non-wildcard bind. The Host header alone never
//    proves locality — it must name an allowlisted host (DNS-rebind defense).
//  • browser branch (Origin present): Origin host ∈ allowlist AND Origin ==
//    Host (CSRF defense).
//  • writes: a per-install random token (0600 file under the state dir) as
//    the X-KLH-Write-Token header, or the HttpOnly SameSite=Strict cookie
//    the board sets on its own pages (HTML form posts cannot set headers).
//    No token → 403, never 500.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";

export const WRITE_TOKEN_HEADER = "x-klh-write-token";
export const WRITE_TOKEN_COOKIE = "klh_write_token";

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"];
const WILDCARD_BINDS = new Set(["", "0.0.0.0", "::", "[::]"]);

const forbid = (error: string): Response =>
	Response.json({ ok: false, error }, { status: 403 });

export function writeTokenPath(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.SUSPENDERS_WRITE_TOKEN_FILE ??
		`${env.HOME}/.cache/claude-governor/write-token`
	);
}

function readToken(path: string): string | null {
	const t = readFileSync(path, "utf8").trim();
	return t.length >= 32 ? t : null;
}

// generated once per install; "wx" makes concurrent first starts race-safe
// (the loser reads the winner's file). null = unavailable → writes 403.
export function ensureWriteToken(path = writeTokenPath()): string | null {
	try {
		return readToken(path);
	} catch {}
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, {
			mode: 0o600,
			flag: "wx",
		});
	} catch {}
	try {
		chmodSync(path, 0o600);
		return readToken(path);
	} catch {
		return null;
	}
}

let cached: string | null | undefined;
export function writeToken(): string | null {
	if (cached === undefined || cached === null) cached = ensureWriteToken();
	return cached;
}

function normHost(h: string): string {
	return h
		.trim()
		.toLowerCase()
		.replace(/\.$/, "")
		.replace(/^\[(.*)\]$/, "$1");
}

// Host header / URL.host → bare hostname (port + IPv6 brackets stripped)
export function hostnameOf(host: string): string {
	const h = host.trim().toLowerCase();
	const v6 = h.match(/^\[([^\]]+)\](?::\d+)?$/);
	if (v6) return normHost(v6[1] ?? "");
	return normHost(h.replace(/:\d+$/, ""));
}

export function hostAllowlist(
	bind: string,
	env: NodeJS.ProcessEnv = process.env,
): Set<string> {
	const names = (env.SUSPENDERS_ALLOWED_HOSTS ?? "suspenders.local")
		.split(",")
		.map(normHost)
		.filter((n) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(n));
	const set = new Set([...LOOPBACK, ...names]);
	const b = normHost(bind);
	if (!WILDCARD_BINDS.has(b)) set.add(b);
	return set;
}

function cookieToken(req: Request): string | null {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === WRITE_TOKEN_COOKIE)
			return part.slice(i + 1).trim();
	}
	return null;
}

function sameToken(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export interface GuardOptions {
	bind: string;
	write: boolean;
	token?: () => string | null;
	env?: NodeJS.ProcessEnv;
}

export function hostGuard(req: Request, opts: GuardOptions): Response | null {
	const allow = hostAllowlist(opts.bind, opts.env);
	const host = (req.headers.get("host") ?? "").trim().toLowerCase();
	if (!host || !allow.has(hostnameOf(host))) return forbid("untrusted host");
	const origin = req.headers.get("origin");
	if (origin) {
		let ohost = "";
		try {
			ohost = new URL(origin).host.toLowerCase();
		} catch {
			return forbid("bad origin");
		}
		if (!ohost || !allow.has(hostnameOf(ohost)))
			return forbid("untrusted origin");
		if (ohost.replace(/\.$/, "") !== host.replace(/\.$/, ""))
			return forbid("cross-origin request");
	}
	if (!opts.write) return null;
	const expected = (opts.token ?? writeToken)();
	if (!expected) return forbid("write token unavailable");
	const presented = req.headers.get(WRITE_TOKEN_HEADER) ?? cookieToken(req);
	if (!presented) return forbid("write token required");
	if (!sameToken(presented, expected)) return forbid("bad write token");
	return null;
}

// W203 (W181 F2): read-side auth classifier — true when the caller presented
// the install's write token (header or cookie). hostGuard still owns host/
// origin pinning; this only classifies anonymous vs token-bearing READS.
export function tokenOk(req: Request): boolean {
	const expected = writeToken();
	if (!expected) return false;
	const presented = req.headers.get(WRITE_TOKEN_HEADER) ?? cookieToken(req);
	return !!presented && sameToken(presented, expected);
}

export const isWriteMethod = (m: string): boolean =>
	!["GET", "HEAD", "OPTIONS"].includes(m.toUpperCase());

// C1 fix: this machine's own interface IPs, so a browser that resolved
// suspenders.local to the LAN IP (192.168.1.210) still counts as "us" —
// computed lazily and cached; interfaces don't change mid-process.
let ownIPs: Set<string> | undefined;
function localInterfaceIPs(): Set<string> {
	if (ownIPs) return ownIPs;
	ownIPs = new Set<string>();
	for (const addrs of Object.values(networkInterfaces()))
		for (const a of addrs ?? []) ownIPs.add(a.address);
	return ownIPs;
}

// C1 (fresh opus-5.5-max audit, 2026-10-04): the host allowlist legitimately
// includes suspenders.local — Caddy's LAN-facing name — so "Host passed the
// allowlist" is NOT "this client is local": any LAN host reaching the board
// through Caddy satisfied the old check and got handed the write cookie.
// Gate on the real network-layer origin instead.
export function isLocalClient(req: Request, directIP: string | null): boolean {
	const xff = req.headers.get("x-forwarded-for");
	const last = xff
		? (xff
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.pop() ?? null)
		: null;
	const ip = (last ?? directIP)?.replace(/^::ffff:/, "") ?? null;
	if (!ip) return false;
	return LOOPBACK.includes(ip) || localInterfaceIPs().has(ip);
}

// the board's own HTML pages carry the token as an HttpOnly SameSite=Strict
// cookie so its forms and same-origin fetches authenticate without JS ever
// seeing the secret; non-HTML responses pass through untouched (streamed)
export function withWriteCookie(
	res: Response,
	req: Request,
	directIP: string | null,
	token: string | null = writeToken(),
): Response {
	const ct = res.headers.get("content-type") ?? "";
	if (!token || !ct.startsWith("text/html") || !isLocalClient(req, directIP))
		return res;
	const headers = new Headers(res.headers);
	headers.append(
		"set-cookie",
		`${WRITE_TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
	);
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}
