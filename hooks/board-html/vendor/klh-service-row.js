import{r,e,s}from"./lit-shared.js";var c=(o)=>o.state??(o.up?"up":"down"),l=(o)=>{let t=c(o),i=o.recovery,a=t!=="up"&&i!==null;return{badge:t==="up"?"UP":t==="degraded"?"DEGRADED":"DOWN",tone:t==="up"?"ok":t==="degraded"?"warn":"bad",where:i?.probe.kind==="launchd"?"launchd":i?.probe.kind==="http"?`:${i.probe.port}${i.probe.path}`:`:${o.port}`,showRecovery:a,open:t==="down",saw:o.detail,what:i?.what??"",causes:a&&i?i.causes:[],steps:a&&i?i.recovery:[]}};class n{probe;busy=!1;err=null;constructor(o){this.probe=o}async reprobe(o){if(this.busy)return this.probe;this.busy=!0,this.err=null;try{let t=await o(`/api/services/probe?id=${encodeURIComponent(this.probe.id)}`),i=await t.json();if(!t.ok||!i.ok||!i.service)throw Error(i.error??`HTTP ${t.status}`);this.probe=i.service}catch(t){this.err=t instanceof Error?t.message:String(t)}finally{this.busy=!1}return this.probe}}var d=15000;class p extends s{static properties={probe:{type:Object},busy:{state:!0},err:{state:!0},copied:{state:!0}};static styles=r`
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
	`;ctl=null;timer=null;constructor(){super();this.probe=null,this.busy=!1,this.err=null,this.copied=-1}connectedCallback(){super.connectedCallback(),this.timer=setInterval(()=>{if(this.probe&&this.probe.state!=="up"&&!document.hidden)this.reprobe()},d)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer);this.timer=null}controller(){if(!this.probe)return null;if(!this.ctl||this.ctl.probe.id!==this.probe.id)this.ctl=new n(this.probe);return this.ctl.probe=this.probe,this.ctl}async reprobe(){let o=this.controller();if(!o||this.busy)return;this.busy=!0,this.probe=await o.reprobe((t)=>fetch(t,{cache:"no-store"})),this.err=o.err,this.busy=!1}async copy(o,t){try{await navigator.clipboard.writeText(t)}catch{let i=document.createElement("textarea");i.value=t,i.setAttribute("readonly",""),i.style.position="fixed",i.style.opacity="0",this.renderRoot.appendChild(i),i.select(),document.execCommand("copy"),i.remove()}this.copied=o,setTimeout(()=>{if(this.copied===o)this.copied=-1},1500)}when(o){let t=new Date(o);return Number.isNaN(t.getTime())?"":t.toLocaleTimeString()}render(){let o=this.probe;if(!o)return e``;let t=l(o);return e`
			<div class="head">
				<span class="badge ${t.tone}">${t.badge}</span>
				<span class="name">${o.name}</span>
				<span class="dim">${t.where}</span>
				<span class="saw dim">${t.saw}</span>
				<span class="dim">${this.when(o.probed_at)}</span>
				<button
					type="button"
					?disabled=${this.busy}
					@click=${this.reprobe}
				>
					${this.busy?"probing…":"re-probe"}
				</button>
			</div>
			${this.err?e`<output>re-probe failed: ${this.err}</output>`:""}
			${t.showRecovery?this.recovery(t):""}
		`}recovery(o){return e`
			<details ?open=${o.open}>
				<summary>how to recover</summary>
				<p class="what">${o.what}</p>
				<h4>what the probe saw</h4>
				<div>${o.saw}</div>
				<h4>likely cause</h4>
				<ul>
					${o.causes.map((t)=>e`<li>${t}</li>`)}
				</ul>
				<h4>recover — run in order, then re-probe</h4>
				<ol>
					${o.steps.map((t,i)=>e`<li>
							<div class="dim">${t.label}</div>
							<div class="step">
								<code>${t.cmd}</code>
								<button
									type="button"
									aria-label="copy: ${t.cmd}"
									@click=${()=>this.copy(i,t.cmd)}
								>
									${this.copied===i?"copied":"copy"}
								</button>
							</div>
						</li>`)}
				</ol>
			</details>
		`}}if(!customElements.get("klh-service-row"))customElements.define("klh-service-row",p);
