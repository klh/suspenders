// hooks/lib/http.ts — W179.3: capped-body JSON helpers shared by the sim
// smoke chain (sim/smoke.ts) and the nightly soak (hooks/bin/soak.ts).
// Streams-over-buffers law: every response body is read through a bounded
// cap — never res.text()/res.json() on an untrusted surface.
export const BODY_CAP = 64 * 1024;

export class BodyTooBig extends Error {}

// streams-over-buffers: capped stream read — never res.text()/res.json().
export async function readCapped(
	res: Response,
	cap = BODY_CAP,
): Promise<{ text: string; truncated: boolean }> {
	const reader = res.body?.getReader();
	if (!reader) return { text: "", truncated: false };
	const dec = new TextDecoder();
	let text = "";
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			truncated = true;
			await reader.cancel();
			break;
		}
		text += dec.decode(value, { stream: true });
	}
	if (!truncated) text += dec.decode();
	if (truncated) throw new BodyTooBig(`body exceeded ${String(cap)}B cap`);
	return { text, truncated: false };
}

export async function getJson(
	url: string,
	init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: unknown }> {
	const res = await fetch(url, init);
	const { text } = await readCapped(res);
	let body: unknown = null;
	if (text.length > 0) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text.slice(0, 120);
		}
	}
	return { status: res.status, headers: res.headers, body };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
