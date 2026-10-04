// hooks/board-html/klh-service-row.ts — W273 recovery UX (Lit, UI law).
// One fleet service row: state badge + what the probe saw; DOWN/degraded
// rows expand (native <details>) into what happened, likely causes and the
// exact recovery commands with copy buttons. "re-probe" re-runs the probe
// via GET /api/services/probe and updates the row live; a dark row also
// re-polls on its own so a fix shows up without a click.
// Built by `bun run build:vendor` to hooks/board-html/vendor/ (one shared
// lit-shared.js chunk with klh-components — offline, never CDN).
import { LitElement, css, html, type TemplateResult } from "lit";
import {
	type RowProbe,
	ServiceRowController,
	rowModel,
} from "./service-row-model.ts";

const POLL_MS = 15_000;

class KlhServiceRow extends LitElement {
	static properties = {
		probe: { type: Object },
		busy: { state: true },
		err: { state: true },
		copied: { state: true },
	};

	static styles = css`
		:host {
			display: block;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.1));
			border-radius: 3px;
			padding: 8px 12px;
			margin: 0 0 8px;
			font: 12px/1.45 ui-sans-serif, system-ui;
			color: var(--klh-ink, #e8e6e1);
		}
		.head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.badge {
			font-weight: 700;
			letter-spacing: 0.06em;
			min-width: 76px;
		}
		.ok {
			color: var(--klh-ok, #5c7a35);
		}
		.warn {
			color: var(--klh-accent, #d8900f);
		}
		.bad {
			color: var(--klh-danger-ink, #c96a4f);
		}
		.name {
			font-weight: 600;
		}
		.dim {
			color: var(--klh-dim, #98958e);
		}
		.saw {
			flex: 1 1 200px;
		}
		button {
			font: inherit;
			font-size: 11px;
			cursor: pointer;
			padding: 2px 9px;
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.22));
			border-radius: 2px;
			background: var(--klh-bg, #141413);
			color: var(--klh-ink, #e8e6e1);
		}
		button:hover,
		button:focus-visible {
			border-color: var(--klh-accent, #d8900f);
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
		details {
			margin-top: 8px;
			border-left: 2px solid var(--klh-accent, #d8900f);
			padding-left: 10px;
		}
		summary {
			cursor: pointer;
			color: var(--klh-accent, #d8900f);
			font-weight: 600;
		}
		.what {
			margin: 6px 0;
		}
		h4 {
			margin: 8px 0 3px;
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
		}
		ul,
		ol {
			margin: 0;
			padding-left: 18px;
		}
		li {
			margin: 2px 0;
		}
		.step {
			display: flex;
			gap: 8px;
			align-items: center;
			margin-top: 2px;
		}
		code {
			flex: 1;
			background: var(--klh-bg, #141413);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			padding: 3px 7px;
			font: 11px/1.5 ui-monospace, Menlo, monospace;
			white-space: pre-wrap;
			word-break: break-all;
			user-select: all;
		}
		output {
			display: block;
			margin-top: 4px;
			color: var(--klh-danger-ink, #c96a4f);
		}
	`;

	declare probe: RowProbe | null;
	declare busy: boolean;
	declare err: string | null;
	declare copied: number;
	private ctl: ServiceRowController | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
		this.probe = null;
		this.busy = false;
		this.err = null;
		this.copied = -1;
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.timer = setInterval(() => {
			if (this.probe && this.probe.state !== "up" && !document.hidden)
				void this.reprobe();
		}, POLL_MS);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private controller(): ServiceRowController | null {
		if (!this.probe) return null;
		if (!this.ctl || this.ctl.probe.id !== this.probe.id)
			this.ctl = new ServiceRowController(this.probe);
		this.ctl.probe = this.probe;
		return this.ctl;
	}

	private async reprobe(): Promise<void> {
		const c = this.controller();
		if (!c || this.busy) return;
		this.busy = true;
		this.probe = await c.reprobe((u) => fetch(u, { cache: "no-store" }));
		this.err = c.err;
		this.busy = false;
	}

	private async copy(i: number, cmd: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(cmd);
		} catch {
			// non-secure origin (LAN over http): select-and-copy fallback
			const ta = document.createElement("textarea");
			ta.value = cmd;
			ta.setAttribute("readonly", "");
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			this.renderRoot.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			ta.remove();
		}
		this.copied = i;
		setTimeout(() => {
			if (this.copied === i) this.copied = -1;
		}, 1500);
	}

	private when(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
	}

	protected render(): TemplateResult {
		const p = this.probe;
		if (!p) return html``;
		const m = rowModel(p);
		return html`
			<div class="head">
				<span class="badge ${m.tone}">${m.badge}</span>
				<span class="name">${p.name}</span>
				<span class="dim">${m.where}</span>
				<span class="saw dim">${m.saw}</span>
				<span class="dim">${this.when(p.probed_at)}</span>
				<button
					type="button"
					?disabled=${this.busy}
					@click=${this.reprobe}
				>
					${this.busy ? "probing…" : "re-probe"}
				</button>
			</div>
			${this.err ? html`<output>re-probe failed: ${this.err}</output>` : ""}
			${m.showRecovery ? this.recovery(m) : ""}
		`;
	}

	private recovery(m: ReturnType<typeof rowModel>): TemplateResult {
		return html`
			<details ?open=${m.open}>
				<summary>how to recover</summary>
				<p class="what">${m.what}</p>
				<h4>what the probe saw</h4>
				<div>${m.saw}</div>
				<h4>likely cause</h4>
				<ul>
					${m.causes.map((c) => html`<li>${c}</li>`)}
				</ul>
				<h4>recover — run in order, then re-probe</h4>
				<ol>
					${m.steps.map(
						(s, i) => html`<li>
							<div class="dim">${s.label}</div>
							<div class="step">
								<code>${s.cmd}</code>
								<button
									type="button"
									aria-label="copy: ${s.cmd}"
									@click=${() => this.copy(i, s.cmd)}
								>
									${this.copied === i ? "copied" : "copy"}
								</button>
							</div>
						</li>`,
					)}
				</ol>
			</details>
		`;
	}
}

if (!customElements.get("klh-service-row"))
	customElements.define("klh-service-row", KlhServiceRow);
