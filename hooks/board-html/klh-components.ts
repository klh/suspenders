// hooks/board-html/klh-components.ts — board UI components (Lit, UI law).
// Built to hooks/board-html/vendor/klh-components.js (lit inlined — the
// vendored, offline bundle; never CDN) and served by the board as a static
// module at /vendor/klh-components.js. Registers klh-decision-eval and
// self-mounts one affordance per OPEN decision card (.dec[data-id]).
import { LitElement, html, css, type TemplateResult } from "lit";

type EvalEntry = { ts: number; text: string };

class KlhDecisionEval extends LitElement {
	static properties = {
		eventId: { type: Number, attribute: "event-id" },
		count: { state: true },
		latest: { state: true },
		busy: { state: true },
		err: { state: true },
	};

	static styles = css`
		:host {
			display: block;
			margin-top: 6px;
			font: 12px/1.45 ui-sans-serif, system-ui;
		}
		.row {
			display: flex;
			gap: 8px;
			align-items: center;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button:hover {
			border-color: var(--klh-accent, #d9a53a);
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.cnt {
			color: var(--klh-dim, #97917f);
		}
		output {
			display: block;
			margin-top: 6px;
			white-space: pre-wrap;
			color: var(--klh-ink, #e8e4da);
			border-left: 2px solid var(--klh-accent, #d9a53a);
			padding-left: 8px;
		}
		output.err {
			color: #e07a5f;
			border-left-color: #e07a5f;
		}
	`;

	declare eventId: number;
	declare count: number;
	declare latest: EvalEntry | null;
	declare busy: boolean;
	declare err: string | null;

	constructor() {
		super();
		this.count = 0;
		this.latest = null;
		this.busy = false;
		this.err = null;
	}

	connectedCallback(): void {
		super.connectedCallback();
		void this.hydrate();
	}

	private async hydrate(): Promise<void> {
		if (!this.eventId) return;
		try {
			const r = await fetch(`/api/decisions/${this.eventId}/evals`);
			if (!r.ok) return;
			const d = (await r.json()) as { evals?: EvalEntry[] };
			this.apply(d.evals ?? []);
		} catch {
			// feed unavailable — the button still works
		}
	}

	private apply(evals: EvalEntry[], count?: number): void {
		this.count = count ?? evals.length;
		this.latest = evals[evals.length - 1] ?? null;
		this.err = null;
	}

	private async evaluate(): Promise<void> {
		if (this.busy || !this.eventId) return;
		this.busy = true;
		this.err = null;
		try {
			const r = await fetch(`/api/decisions/${this.eventId}/evaluate`, {
				method: "POST",
			});
			const d = (await r.json()) as {
				ok?: boolean;
				latest?: EvalEntry;
				count?: number;
				error?: string;
			};
			if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
			if (d.latest) this.apply([d.latest], d.count);
		} catch (e) {
			this.err = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
	}

	private when(ts: number): string {
		return new Date(ts).toLocaleTimeString();
	}

	protected render(): TemplateResult {
		return html`
			<div class="row">
				<button
					?disabled=${this.busy}
					@click=${this.evaluate}
					type="button"
				>
					${this.busy ? "evaluating…" : "re-evaluate"}
				</button>
				<span class="cnt">
					${this.count}
					${this.count === 1 ? "evaluation" : "evaluations"}
				</span>
			</div>
			${this.err ? html`<output class="err">${this.err}</output>` : ""}
			${
				this.latest
					? html`<output>
						${this.when(this.latest.ts)} — ${this.latest.text}
					</output>`
					: ""
			}
		`;
	}
}

customElements.define("klh-decision-eval", KlhDecisionEval);

// self-mount: every OPEN decision card gets the affordance, including cards
// the legacy poll re-renders later (MutationObserver, dedup per card)
function mountAll(): void {
	const cards = document.querySelectorAll<HTMLElement>(".dec[data-id]");
	for (const card of cards) {
		if (card.querySelector("klh-decision-eval")) continue;
		const host = card.querySelector(".dec-actions") ?? card;
		const el = document.createElement("klh-decision-eval");
		el.setAttribute("event-id", card.getAttribute("data-id") ?? "");
		host.appendChild(el);
	}
}
const obs = new MutationObserver(mountAll);
function armObserver(): void {
	const list = document.querySelector("#decisions");
	if (!list) {
		setTimeout(armObserver, 300);
		return;
	}
	obs.observe(list, { childList: true, subtree: true });
	mountAll();
}
armObserver();
