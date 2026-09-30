// belt-hint.test.ts — W96 seam: BeltDistillClient must send belt the hint
// 'prefer local distill reasoning' (belt decides, local-first) — not the old
// role pin, and not the interim INGEST_LLM_URL env pin. The worker process
// runs as a child (isolated env), the "belt" is an in-process stub that
// captures the request; no real model, no real fleet.
import { afterAll, describe, expect, test } from "bun:test";

let captured: { auth: string | null; body: Record<string, unknown> } | null =
	null;

const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method !== "POST" || !req.url.endsWith("/api/route"))
			return new Response("not found", { status: 404 });
		const auth = req.headers.get("authorization");
		const body = (await req.json()) as Record<string, unknown>;
		captured = { auth, body };
		return Response.json({ reply: "[]" });
	},
});

afterAll(() => stub.stop(true));

describe("BeltDistillClient W96 hint", () => {
	test("sends 'prefer local distill reasoning', execute, no role pin", async () => {
		const script = [
			`const m = await import(${JSON.stringify(
				new URL("../hooks/lib/knowledge-ports.ts", import.meta.url).pathname,
			)});`,
			`const c = new m.BeltDistillClient();`,
			`const out = await c.distill("payload-w96", {`,
			`  domain: "d", area: "a", codeOrigin: "c", originSid: "s",`,
			`});`,
			`console.log("RESULT" + JSON.stringify(out));`,
		].join("\n");
		const p = Bun.spawn(["bun", "-e", script], {
			env: {
				...process.env,
				SUSPENDERS_BELT_URL: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_TOKEN: "w96-test-token",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (code !== 0)
			throw new Error(`child failed (${code}): ${err.slice(0, 400)}`);
		if (!captured) throw new Error("stub saw no /api/route request");
		expect(captured.auth).toBe("Bearer w96-test-token");
		expect(captured.body.hint).toBe("prefer local distill reasoning");
		expect(captured.body.execute).toBe(true);
		expect(captured.body.role).toBeUndefined();
		expect(Array.isArray(captured.body.messages)).toBe(true);
		// the reply flows through parseDistill — "[]" means zero rows, cleanly
		expect(JSON.parse(out.split("RESULT")[1] ?? "bad")).toEqual([]);
	});
});
