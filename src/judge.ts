import {
	DEFAULT_MAX_JUDGE_PROMPT_CHARS,
	fitPromptWithDegradableSection,
	normalizePromptBudgetOptions,
	renderBoundedContinuationEvidence,
	type PromptBudgetOptions,
} from "./prompt-bounds.ts";
import { redactPromptSensitiveText } from "./redaction.ts";
import type {
	ContinuationSnapshot,
	JudgeResult,
	Snapshot,
	StateEvidenceBundle,
} from "./types.ts";

type JudgePromptContinuation =
	| ContinuationSnapshot
	| {
			triggerEntryId?: string | null;
			turns: Array<{
				turnIndex?: number;
				assistantText: string;
				toolResults: unknown[];
			}>;
	  };

export type JudgePromptInput = {
	candidateSummary: string;
	snapshot: Snapshot;
	continuation: JudgePromptContinuation;
	artifactRefs?: string[];
	stateEvidence?: StateEvidenceBundle;
};

const PARSE_REJECT: JudgeResult = {
	score: 0,
	decision: "reject",
	judgeStatus: "parse_error",
	missing: [],
	contradictions: [],
	diagnosis: "Could not parse judge response",
};

const INVALID_SHAPE_REJECT: JudgeResult = {
	score: 0,
	decision: "reject",
	judgeStatus: "parsed",
	missing: [],
	contradictions: [],
	diagnosis: "Judge response JSON did not match expected object shape",
};

function list(lines: string[]): string {
	return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- None";
}

function renderManifestUserAssertionTrail(snapshot: Snapshot): string[] {
	return snapshot.manifest.userAssertionTrail.map((entry) => {
		const stale = entry.staleReason ? ` (${entry.staleReason})` : "";
		const superseded = entry.supersededByEntryId
			? ` Superseded by: ${entry.supersededByEntryId}.`
			: "";
		return `[${entry.entryId}] ${entry.kind}/${entry.authority}/stale=${entry.staleRisk} — User asserted: ${entry.userAsserted} Evidence excerpt: ${entry.evidenceExcerpt}${stale}${superseded}`;
	});
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
Session user assertion trail:
${list(evidence.session.userAssertionTrail ?? [])}
Session critical literals:
${list(evidence.session.criticalLiterals)}`;
}

function normalizeContinuation(
	continuation: JudgePromptContinuation,
): ContinuationSnapshot {
	return {
		triggerEntryId: continuation.triggerEntryId ?? null,
		turns: continuation.turns.map((turn, index) => ({
			turnIndex: turn.turnIndex ?? index + 1,
			assistantText: turn.assistantText,
			toolResults: turn.toolResults.map((result) => {
				if (typeof result === "object" && result !== null) {
					const raw = result as Record<string, unknown>;
					return {
						toolName:
							typeof raw.toolName === "string" ? raw.toolName : "unknown",
						toolCallId:
							typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
						isError: raw.isError === true,
						text: typeof raw.text === "string" ? raw.text : JSON.stringify(raw),
					};
				}
				return {
					toolName: "unknown",
					isError: false,
					text: String(result),
				};
			}),
		})),
	};
}

function continuationText(
	input: JudgePromptInput,
	options: { maxChars: number; mode?: "standard" | "minimal" | "none" },
): string {
	return renderBoundedContinuationEvidence(
		normalizeContinuation(input.continuation),
		options,
	);
}

function artifactRefsFor(input: JudgePromptInput): string[] {
	return [
		...input.snapshot.manifest.artifactRefs,
		...(input.artifactRefs ?? []),
	];
}

function renderJudgePrompt(
	input: JudgePromptInput,
	continuation: string,
): string {
	const manifest = input.snapshot.manifest;
	const artifactRefs = artifactRefsFor(input);

	return redactPromptSensitiveText(`You are the Slipstream continuation-quality reviewer. Score whether this single candidate summary is strong enough to be the only durable handoff for a capable next coding agent.

Use a strict continuation-probe rubric. Ask: what would the next agent get wrong if it only saw this summary plus the retained recent context? Do not judge whether the task solution is correct. Judge whether the summary preserves enough current-state, next-action, constraint, verification, risk, and artifact-grounding information to continue safely and effectively.

Be selective rather than globally harsh. Accept safe handoffs with advisory imperfections, but reject hard safety/current-state failures.

Score fairly:
- 10: exceptional; a next agent can continue with almost no rereading.
- 9: strong; only minor non-blocking omissions. Accept.
- 8: acceptable with warnings; score 8 summaries may be accepted when current state, next action, constraints, and blockers are clear, and remaining issues are advisory noise, stale capsule material clearly corrected by the authoritative Continuation card/narrative, or recoverable provenance gaps.
- 7: barely safe or materially incomplete; reject for repair.
- below 7: unsafe, misleading, or too incomplete.

Return only JSON with: score 0-10, decision accept|reject, currentState, nextActionReadiness, constraintPreservation, riskAwareness, verificationAwareness, artifactGrounding, retrievability, knowledgeContinuity, staleStateSuppression, lowNoiseLowContradiction, planAlignment, statementSufficiency, nonContradiction, missing, contradictions, diagnosis.
Set decision "reject" when omissions or contradictions make continuation unsafe, materially incomplete, or not production-ready. Set decision "accept" when the handoff is safe to continue from, even if it has advisory warnings. If decision is "accept", missing may contain advisory, non-blocking improvements but must not contain omissions you intend as acceptance blockers. The missing array is for repair-driving omissions when decision is "reject" and advisory omissions when decision is "accept": current protected facts that are needed for high-quality continuation and absent from the candidate summary text. The contradictions array is for unresolved contradictions, especially stale/superseded claims presented as current state. Put non-blocking nuance in diagnosis.

Hard-fail classes: reject any summary that contains secret-shaped values, API keys, tokens, passwords, private keys, certificates, or bearer values. Reject contradictions involving auth, cert, key, deletion, or deploy state even if another section later says to recheck. Reject wrong current dirty-state claims, terminal-vs-pending contradictions, or stale current-state claims when they can mislead the next agent's first action. Do not reject solely because a non-authoritative deterministic capsule contains noisy stale evidence if the Continuation card and narrative unambiguously mark it stale and give a safe next action.

Evaluate these categories:
- currentState: captures latest task status, decisions, and what changed.
- nextActionReadiness: gives correct, specific next steps.
- constraintPreservation: preserves user constraints, workflow constraints, and product-scope boundaries.
- riskAwareness: preserves blockers, failed attempts, caveats, and watch-outs.
- verificationAwareness: prioritizes current verification by external realism. Live/manual/browser/API/integration/smoke validation outranks unit tests when it exercises the changed surface. Passing unit/lint/typecheck evidence should be terse; preserve actionable failing commands/errors and attribute failing checks only when evidence supports it. Do not penalize summaries for omitting exact passing unit-test commands or full unit-test inventories.
- artifactGrounding: cites concrete files/commands/artifacts/entities without pointless inventories.
- retrievability: lets a next agent recover exact state without rereading the whole transcript.
- knowledgeContinuity: preserves non-obvious research findings, causal reasoning, reusable conclusions, and decision rationale.
- staleStateSuppression: labels or suppresses superseded branches instead of presenting them as current.
- lowNoiseLowContradiction: avoids fabricated facts, noisy inventories, and distracting stale context.

Reject critical stale or contradictory current state even when fact recall is high. Reject summaries that claim completion, clean state, or passing verification when the evidence only supports uncertainty or an in-progress handoff. Treat latest verification/risk signals and terminal final-answer evidence as high-priority current-state evidence unless retained continuation context clearly supersedes them. Compare the candidate summary against protected user assertions: penalize summaries that omit high-value user intent, scope, preference, approval, or correction assertions that affect continuation; call out when the candidate omits high-value user intent; and penalize any candidate that revives stale user assertions as current work. User-reported filesystem/test/runtime claims require verification and must not be presented as verified facts unless newer evidence proves them. Artifact references are recovery pointers, not hidden evidence substitutes.

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

Protected user assertions from compacted-away messages:
${list(renderManifestUserAssertionTrail(input.snapshot))}

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
</continuation>`);
}

export function buildJudgePrompt(
	input: JudgePromptInput,
	options?: PromptBudgetOptions,
): string {
	const budget = normalizePromptBudgetOptions(
		options,
		DEFAULT_MAX_JUDGE_PROMPT_CHARS,
	);
	const standardContinuation = continuationText(input, {
		maxChars: budget.continuationMaxChars,
		mode: "standard",
	});
	const minimalContinuation = continuationText(input, {
		maxChars: Math.min(budget.continuationMaxChars, 8_000),
		mode: "minimal",
	});
	const omittedContinuation = continuationText(input, {
		maxChars: 1_000,
		mode: "none",
	});
	return fitPromptWithDegradableSection({
		render: (continuation) => renderJudgePrompt(input, continuation),
		degradableStandard: standardContinuation,
		degradableMinimal: minimalContinuation,
		degradableOmitted: omittedContinuation,
		maxPromptChars: budget.maxPromptChars,
		fixedSectionName: "judge prompt",
	});
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
	if (typeof value !== "object" || value === null) return INVALID_SHAPE_REJECT;
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
		judgeStatus: "parsed",
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
	try {
		return normalizeJudge(JSON.parse(trimmed) as unknown);
	} catch {
		// Continue with fenced or embedded-object recovery below.
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const jsonText =
		fenced?.[1] ??
		trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
	if (!jsonText || jsonText === trimmed.slice(0, 0)) return PARSE_REJECT;
	try {
		return normalizeJudge(JSON.parse(jsonText) as unknown);
	} catch {
		return PARSE_REJECT;
	}
}

function isNonBlockingJudgeNote(note: string): boolean {
	return /not (?:required|necessary|needed|critical|acceptance-blocking) for safe continuation|not acceptance-blocking|optional|nice-to-have|mitigat(?:e|ed|es)|artifact reference may allow recovery|raw git diff text|full git diff/i.test(
		note,
	);
}

function isHardSafetyJudgeNote(note: string): boolean {
	return /\b(secret|api[-_ ]?key|token|password|private key|bearer|auth|cert|certificate|ssh key|delet(?:e|ed|ion)|deploy)\b/i.test(
		note,
	);
}

export function hasSecretShapedValue(text: string): boolean {
	return (
		/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/i.test(text) ||
		/\bBearer\s+(?!\[?REDACTED\]?|<redacted>|redacted\b)[A-Za-z0-9._~+/=-]{16,}/i.test(
			text,
		) ||
		/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|BEARER|CERTIFICATE|CERT)[A-Z0-9_]*\s*[:=]\s*(?:"(?!\[?REDACTED\]?|<redacted>|redacted\b)[^"\s]{8,}"|'(?!\[?REDACTED\]?|<redacted>|redacted\b)[^'\s]{8,}'|`(?!\[?REDACTED\]?|<redacted>|redacted\b)[^`\s]{8,}`|(?!\[?REDACTED\]?|<redacted>|redacted\b)[^\s'"`]{8,})/i.test(
			text,
		)
	);
}

export function isAccepted(
	result: JudgeResult,
	threshold: number,
	candidateSummary = "",
): boolean {
	if (hasSecretShapedValue(candidateSummary)) return false;
	const criticalContradictions = result.contradictions.filter(
		(note) => isHardSafetyJudgeNote(note) || !isNonBlockingJudgeNote(note),
	);
	return (
		result.decision === "accept" &&
		result.score >= threshold &&
		criticalContradictions.length === 0
	);
}
