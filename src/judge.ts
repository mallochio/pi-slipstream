import type {
	ContinuationSnapshot,
	JudgeResult,
	Snapshot,
	StateEvidenceBundle,
} from "./types.ts";

export type JudgePromptInput = {
	candidateSummary: string;
	snapshot: Snapshot;
	continuation:
		| ContinuationSnapshot
		| { turns: Array<{ assistantText: string; toolResults: unknown[] }> };
	artifactRefs?: string[];
	stateEvidence?: StateEvidenceBundle;
};

const REJECT: JudgeResult = {
	score: 0,
	decision: "reject",
	missing: [],
	contradictions: [],
	diagnosis: "Could not parse judge response",
};

function list(lines: string[]): string {
	return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- None";
}

function distilledStateEvidence(
	evidence: StateEvidenceBundle | undefined,
): string {
	if (!evidence) return "None";
	return `State evidence for judging is deliberately distilled. Raw git diff text is writer-grounding evidence only and is not acceptance-blocking by itself.
Git available: ${evidence.git.available}
Git errors:
${list(evidence.git.errors)}
Git status --short:
${list(evidence.git.statusShort ? evidence.git.statusShort.split("\n") : [])}
Git diff --stat:
${list(evidence.git.diffStat ? evidence.git.diffStat.split("\n") : [])}
Full git diff artifact paths:
${list(evidence.git.fullDiffArtifactPaths ?? [])}
Full git diff SHA-256: ${evidence.git.fullDiffSha256 ?? "None"}
Full git diff bytes: ${evidence.git.fullDiffBytes ?? "None"}
Full git diff complete: ${evidence.git.fullDiffComplete ?? "unknown"}
Full git diff preserved: ${evidence.git.fullDiffPreserved ?? "unknown"}
Session files modified:
${list(evidence.session.filesModified)}
Session unresolved errors:
${list(evidence.session.unresolvedErrors)}
Session verification evidence:
${list(evidence.session.recentVerification)}
Session decisions:
${list(evidence.session.userDecisions)}
Session constraints:
${list(evidence.session.constraints)}
Session latest compacted updates:
${list(evidence.session.latestUpdates)}
Session retained-tail updates:
${list(evidence.session.retainedTailUpdates)}
Session latest user/assistant exchange state:
${list(evidence.session.latestExchangeState)}
Session terminal final-answer evidence:
${list(evidence.session.terminalFinalAnswerEvidence)}
Session latest verification and risk signals:
${list(evidence.session.latestSignals)}
Session stale/superseded candidates:
${list(evidence.session.staleSignals)}
Session critical literals:
${list(evidence.session.criticalLiterals)}`;
}

function continuationText(input: JudgePromptInput): string {
	return input.continuation.turns
		.map(
			(turn, index) =>
				`Turn ${index + 1}: ${turn.assistantText}\nTool results: ${JSON.stringify(turn.toolResults)}`,
		)
		.join("\n\n");
}

function artifactRefsFor(input: JudgePromptInput): string[] {
	return [
		...input.snapshot.manifest.artifactRefs,
		...(input.artifactRefs ?? []),
	];
}

export function buildJudgePrompt(input: JudgePromptInput): string {
	const manifest = input.snapshot.manifest;
	const artifactRefs = artifactRefsFor(input);
	const continuation = continuationText(input);

	return `You are the Slipstream continuation-quality reviewer. Score whether this single candidate summary is strong enough to be the only durable handoff for a capable next coding agent.

Use a strict continuation-probe rubric. Ask: what would the next agent get wrong if it only saw this summary plus the retained recent context? Do not judge whether the task solution is correct. Judge whether the summary preserves enough current-state, next-action, constraint, verification, risk, and artifact-grounding information to continue safely and effectively.

A safe-but-weak summary should be rejected so Slipstream repairs it. Do not accept summaries that merely avoid catastrophe while losing important reasoning, stale-state boundaries, verification status, recovery handles, or next-action specificity.

Score harshly but fairly:
- 10: exceptional; a next agent can continue with almost no rereading.
- 9: strong; only minor non-blocking omissions. Accept.
- 8: safe but materially improvable; reject for repair unless every material continuation detail is already present.
- 7: barely safe; reject for repair.
- below 7: unsafe, misleading, or too incomplete.

Return only JSON with: score 0-10, decision accept|reject, currentState, nextActionReadiness, constraintPreservation, riskAwareness, verificationAwareness, artifactGrounding, retrievability, knowledgeContinuity, staleStateSuppression, lowNoiseLowContradiction, planAlignment, statementSufficiency, nonContradiction, missing, contradictions, diagnosis.
Set decision "accept" only when the summary is production-ready as a durable handoff and has no critical omissions or contradictions. The missing array is for repair-driving omissions: current protected facts that are needed for high-quality continuation and absent from the candidate summary text. The contradictions array is for unresolved contradictions, especially stale/superseded claims presented as current state. Put non-blocking nuance in diagnosis.

Evaluate these categories:
- currentState: captures latest task status, decisions, and what changed.
- nextActionReadiness: gives correct, specific next steps.
- constraintPreservation: preserves user constraints, workflow constraints, and product-scope boundaries.
- riskAwareness: preserves blockers, failed attempts, caveats, and watch-outs.
- verificationAwareness: preserves tests/checks/evidence and what remains unverified.
- artifactGrounding: cites concrete files/commands/artifacts/entities without pointless inventories.
- retrievability: lets a next agent recover exact state without rereading the whole transcript.
- knowledgeContinuity: preserves non-obvious research findings, causal reasoning, reusable conclusions, and decision rationale.
- staleStateSuppression: labels or suppresses superseded branches instead of presenting them as current.
- lowNoiseLowContradiction: avoids fabricated facts, noisy inventories, and distracting stale context.

Reject critical stale or contradictory current state even when fact recall is high. Reject summaries that claim completion, clean state, or passing verification when the evidence only supports uncertainty or an in-progress handoff. Treat latest verification/risk signals and terminal final-answer evidence as high-priority current-state evidence unless retained continuation context clearly supersedes them. Artifact references are recovery pointers, not hidden evidence substitutes.

Protected manifest files modified:
${list(manifest.filesModified)}

Protected manifest errors:
${list(manifest.errors.map((e) => e.message))}

Protected decisions:
${list(manifest.userDecisions.map((d) => d.text))}

Protected constraints:
${list(manifest.constraints.map((c) => c.text))}

Protected open loops:
${list(manifest.openLoops.map((l) => l.summary))}

Protected verification evidence:
${list(manifest.recentVerification)}

Protected latest compacted updates:
${list(manifest.latestUpdates)}

Protected retained-tail updates still visible after compaction:
${list(manifest.retainedTailUpdates)}

Protected latest user/assistant exchange state:
${list(manifest.latestExchangeState)}

Protected terminal final-answer evidence:
${list(manifest.terminalFinalAnswerEvidence)}

Protected latest verification and risk signals:
${list(manifest.latestSignals.map((signal) => `${signal.kind}: ${signal.text}`))}

Protected stale or superseded candidates:
${list(manifest.staleSignals.map((signal) => `${signal.text} — ${signal.reason}`))}

Protected critical literals / exact expected strings:
${list(manifest.criticalLiterals)}

Protected distilled state evidence:
${distilledStateEvidence(input.stateEvidence)}

Protected artifact references (pointers only, not evidence substitutes):
${list(artifactRefs)}

Candidate summary:
<summary>
${input.candidateSummary}
</summary>

Continuation evidence:
<continuation>
${continuation || "None"}
</continuation>`;
}

function numericField(
	raw: Record<string, unknown>,
	key: string,
): number | undefined {
	return typeof raw[key] === "number" && Number.isFinite(raw[key])
		? Math.max(0, Math.min(10, raw[key] as number))
		: undefined;
}

function normalizeJudge(value: unknown): JudgeResult {
	if (typeof value !== "object" || value === null) return REJECT;
	const raw = value as Record<string, unknown>;
	const score = numericField(raw, "score") ?? 0;
	const decision = raw.decision === "accept" ? "accept" : "reject";
	const missing = Array.isArray(raw.missing)
		? raw.missing.filter((item): item is string => typeof item === "string")
		: [];
	const contradictions = Array.isArray(raw.contradictions)
		? raw.contradictions.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	return {
		score,
		decision,
		planAlignment: numericField(raw, "planAlignment"),
		statementSufficiency: numericField(raw, "statementSufficiency"),
		nonContradiction: numericField(raw, "nonContradiction"),
		currentState: numericField(raw, "currentState"),
		nextActionReadiness: numericField(raw, "nextActionReadiness"),
		constraintPreservation: numericField(raw, "constraintPreservation"),
		verificationAwareness: numericField(raw, "verificationAwareness"),
		staleStateSuppression: numericField(raw, "staleStateSuppression"),
		artifactGrounding: numericField(raw, "artifactGrounding"),
		riskAwareness: numericField(raw, "riskAwareness"),
		retrievability: numericField(raw, "retrievability"),
		knowledgeContinuity: numericField(raw, "knowledgeContinuity"),
		lowNoiseLowContradiction: numericField(raw, "lowNoiseLowContradiction"),
		missing,
		contradictions,
		diagnosis: typeof raw.diagnosis === "string" ? raw.diagnosis : "",
	};
}

export function parseJudgeResult(text: string): JudgeResult {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const jsonText =
		fenced?.[1] ??
		trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
	if (!jsonText || jsonText === trimmed.slice(0, 0)) return REJECT;
	try {
		return normalizeJudge(JSON.parse(jsonText) as unknown);
	} catch {
		return REJECT;
	}
}

function isNonBlockingJudgeNote(note: string): boolean {
	return /not (?:required|necessary|needed|critical|acceptance-blocking) for safe continuation|not acceptance-blocking|optional|nice-to-have|mitigat(?:e|ed|es)|artifact reference may allow recovery|raw git diff text|full git diff/i.test(
		note,
	);
}

export function isAccepted(result: JudgeResult, threshold: number): boolean {
	const criticalMissing = result.missing.filter(
		(note) => !isNonBlockingJudgeNote(note),
	);
	const criticalContradictions = result.contradictions.filter(
		(note) => !isNonBlockingJudgeNote(note),
	);
	return (
		result.decision === "accept" &&
		result.score >= threshold &&
		criticalMissing.length === 0 &&
		criticalContradictions.length === 0
	);
}
