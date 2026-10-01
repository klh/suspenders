// hooks/lib/provenance.ts — W154 provenance label seed (domain-separation
// law, federation-2026-10-01 §2): every session/lane carries a data_domain
// derived from what it actually routed through. Default private (the most
// restrictive domain wins); "hub" only when a hub-entitled model served the
// request. W159 consumes the label at the session-end settle; W160's CR and
// policy channels never carry private-domain content either.

export type DataDomain = "hub" | "private";

/** The routing plane records which plane served the request: a group that is
 *  in the hub-entitled menu went through the hub; everything else (local
 *  swarm, BYO user-plane, unknown) is private by default. */
export function deriveDataDomain(
	group: string | null | undefined,
	hubModelIds: Iterable<string>,
): DataDomain {
	if (group === null || group === undefined || group.length === 0)
		return "private";
	return new Set(hubModelIds).has(group) ? "hub" : "private";
}

/** Load the hub model-id set from the pull client's last-known file. */
export function hubModelIdsFrom(
	lastKnown: { entitlements: { models: Array<{ id: string }> } | null } | null,
): Set<string> {
	return new Set(
		(lastKnown?.entitlements?.models ?? []).map((m) => {
			return m.id;
		}),
	);
}
