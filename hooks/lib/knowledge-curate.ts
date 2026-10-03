// hooks/lib/knowledge-curate.ts — W208: the knowledge curation engine's
// mechanical half. Recency decay scores every non-retired row (exponential
// half-life — the agent-memory §4 steal), the planner turns low scores into
// retire PROPOSALS, and a human disposes each one (approve = the row retires,
// dismiss = a cooldown before the row may be re-proposed). Pure functions and
// types only: no SQL here — SqliteKnowledgeStore owns the writes, tests run
// the planner without a database. The engine never retires anything by itself.
//
// Knobs are constants, config-over-code stays with the sweep caller: the port
// method and the coord verb accept overrides, these are the fleet defaults.
export const DECAY_HALF_LIFE_DAYS = 45;
export const DECAY_PROPOSE_BELOW = 0.25;
// un-reviewed rows decay twice as fast: a candidate no human promoted is the
// cheapest clutter in the store (live mix: ~79% candidate).
export const DECAY_CANDIDATE_WEIGHT = 0.5;
export const DECAY_DISMISS_COOLDOWN_DAYS = 30;

// score = confidence × 2^(−ageDays / halfLife): a full-confidence row is
// half-spent at the half-life mark. Degenerate half-life (≤0) disables decay
// rather than dividing by zero.
export function decayScore(
	ageDays: number,
	confidence: number,
	halfLifeDays: number = DECAY_HALF_LIFE_DAYS,
): number {
	if (halfLifeDays <= 0) return confidence;
	return confidence * 2 ** (-Math.max(0, ageDays) / halfLifeDays);
}

export interface CurateRow {
	id: number;
	topic: string;
	confidence: number;
	state: string;
	ts: number;
	updated_at: number | null;
}

export interface OpenProposal {
	id: number;
	knowledge_id: number;
	score: number;
}

export interface Dismissal {
	knowledge_id: number;
	decided_at: number;
}

// a new proposal the sweep wants written (already decay-scored)
export interface ProposalDraft {
	knowledgeId: number;
	topic: string;
	score: number;
	ageDays: number;
	confidence: number;
	reason: string;
}

// an existing open proposal whose evidence moved (score/ts refresh)
export interface RefreshDraft {
	proposalId: number;
	score: number;
	ageDays: number;
	reason: string;
}

export interface DecayPlan {
	checked: number;
	propose: ProposalDraft[];
	refresh: RefreshDraft[];
	// open proposals whose row recovered (noted/updated back over threshold) —
	// the sweep auto-closes them 'stale': an outdated proposal is noise
	stale: number[];
}

export interface DecayOpts {
	now?: number;
	halfLifeDays?: number;
	threshold?: number;
	cooldownDays?: number;
}

const DAY_MS = 86_400_000;

const reasonFor = (
	r: CurateRow,
	score: number,
	ageDays: number,
	threshold: number,
): string =>
	`decay ${score.toFixed(3)} < ${threshold} — untouched ${ageDays}d, confidence ${r.confidence}, state ${r.state}`;

// the whole sweep's decision, computed in memory: propose (new open
// proposals), refresh (existing ones re-scored), stale (auto-close). Rows the
// human dismissed inside the cooldown are silent skips, not errors.
export function planDecayProposals(
	rows: CurateRow[],
	open: OpenProposal[],
	dismissals: Dismissal[],
	opts: DecayOpts = {},
): DecayPlan {
	const now = opts.now ?? Date.now();
	const half = opts.halfLifeDays ?? DECAY_HALF_LIFE_DAYS;
	const threshold = opts.threshold ?? DECAY_PROPOSE_BELOW;
	const cooldownMs =
		(opts.cooldownDays ?? DECAY_DISMISS_COOLDOWN_DAYS) * DAY_MS;
	const openByRow = new Map(open.map((p) => [p.knowledge_id, p]));
	const dismissedAt = new Map(
		dismissals.map((d) => [d.knowledge_id, d.decided_at]),
	);
	const plan: DecayPlan = {
		checked: rows.length,
		propose: [],
		refresh: [],
		stale: [],
	};
	for (const r of rows) {
		const ageDays = Math.max(
			0,
			Math.floor((now - (r.updated_at ?? r.ts)) / DAY_MS),
		);
		const conf =
			r.state === "candidate"
				? r.confidence * DECAY_CANDIDATE_WEIGHT
				: r.confidence;
		const score = decayScore(ageDays, conf, half);
		const reason = reasonFor(r, score, ageDays, threshold);
		const existing = openByRow.get(r.id);
		if (score >= threshold) {
			if (existing) plan.stale.push(existing.id);
			continue;
		}
		if (existing) {
			plan.refresh.push({
				proposalId: existing.id,
				score,
				ageDays,
				reason,
			});
			continue;
		}
		const at = dismissedAt.get(r.id);
		if (at !== undefined && now - at < cooldownMs) continue;
		plan.propose.push({
			knowledgeId: r.id,
			topic: r.topic,
			score,
			ageDays,
			confidence: r.confidence,
			reason,
		});
	}
	return plan;
}
