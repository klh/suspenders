// hooks/session-end.ts — SessionEnd: mark the session CLOSED in the control
// plane. Deliberately does NOT release owned work — a closed session may be
// resumed (coord resume-session); work stays with the owner until rebind or
// `work orphaned` → `work reclaim`. W92: talks to the control plane through
// the store port (HTTP when a store server runs, embedded SQLite otherwise)
// — never opens the DB directly.
const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
	session_id?: string;
};
if (input.session_id) {
	const { makeStore } = await import("./lib/store-ports.ts");
	const store = await makeStore();
	await store.sessionClose(input.session_id);
	store.close();
}
process.exit(0);
