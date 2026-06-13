import { isAccepted, parseJudgeResult } from "./judge.ts";
import { redactPromptSensitiveText } from "./redaction.ts";
import { isDegenerateCandidateSummary } from "./summary.ts";
import type { CompleteTextFn, JudgeResult } from "./types.ts";

export type SlipstreamSourceEvidence = {
	sourceMessageExcerpts?: string[];
	filesModified?: string[];
	unresolvedErrors?: string[];
	userDecisions?: string[];
	constraints?: string[];
	openLoops?: string[];
	recentVerification?: string[];
	latestUpdates?: string[];
	retainedTailUpdates?: string[];
	latestExchangeState?: string[];
	terminalFinalAnswerEvidence?: string[];
	staleSignals?: string[];
	criticalLiterals?: string[];
};

export type ValidateOnlyInput = {
	candidate: string;
	sourceEvidence: SlipstreamSourceEvidence;
	continuation?: string | string[];
	completeText: CompleteTextFn;
	config?: {
		judgeThreshold?: number;
		repairAttempts?: number;
		repairEnabled?: boolean;
	};
	signal?: AbortSignal;
};

export type ValidationResult = {
	summary: string;
	accepted: boolean;
	repaired: boolean;
	score: number;
	missing: string[];
	contradictions: string[];
	diagnosis: string;
	repairCount: number;
	judge: JudgeResult;
};

function list(lines: readonly string[] | undefined): string {
	if (!lines?.length) return "- None";
	return lines.map((line) => `- ${line}`).join("\n");
}

function renderContinuation(
	continuation: ValidateOnlyInput["continuation"],
): string {
	if (continuation === undefined) return "- None";
	if (Array.isArray(continuation)) return list(continuation);
	return continuation.trim() ? continuation : "- None";
}

function renderEvidence(evidence: SlipstreamSourceEvidence): string {
	return `Source message excerpts:\n${list(evidence.sourceMessageExcerpts)}\n\nFiles modified:\n${list(evidence.filesModified)}\n\nUnresolved errors:\n${list(evidence.unresolvedErrors)}\n\nUser decisions:\n${list(evidence.userDecisions)}\n\nConstraints:\n${list(evidence.constraints)}\n\nOpen loops:\n${list(evidence.openLoops)}\n\nRecent verification:\n${list(evidence.recentVerification)}\n\nLatest updates:\n${list(evidence.latestUpdates)}\n\nRetained-tail updates:\n${list(evidence.retainedTailUpdates)}\n\nLatest exchange state:\n${list(evidence.latestExchangeState)}\n\nTerminal final-answer evidence:\n${list(evidence.terminalFinalAnswerEvidence)}\n\nStale or superseded signals:\n${list(evidence.staleSignals)}\n\nCritical literals:\n${list(evidence.criticalLiterals)}`;
}

function buildExternalJudgePrompt(
	candidate: string,
	input: ValidateOnlyInput,
): string {
	return redactPromptSensitiveText(`You are the Slipstream artifact-free integration API judge. Judge the candidate summary against only the caller-provided source evidence and continuation. This API is artifact-free: do not assume hidden local files, stats, widgets, pending state, or ctx.compact side effects exist.\n\nReturn only JSON with this shape:\n{\n  "score": 0-10,\n  "decision": "accept" | "reject",\n  "missing": ["..."],\n  "contradictions": ["..."],\n  "diagnosis": "..."\n}\n\nReject if the candidate omits current constraints, unresolved errors, user decisions, or next-action information needed for safe continuation. Accept safe score-8 handoffs with advisory warnings when current state and next action are clear. Do not let advisory missing[] items veto acceptance, but reject critical contradictions. Live/manual/browser/API/integration/smoke verification outranks unit tests when it exercises the changed surface; passing unit/lint/typecheck evidence should be terse, while actionable failing checks need command/error and evidenced attribution. Hard-reject secret-shaped values, contradictions involving auth/cert/key/deletion/deploy state, wrong current dirty-state claims, terminal-vs-pending contradictions, and stale current-state claims that can mislead the next action.\n\nSource evidence:\n${renderEvidence(input.sourceEvidence)}\n\nContinuation evidence:\n${renderContinuation(input.continuation)}\n\nCandidate summary:\n<summary>\n${candidate}\n</summary>`);
}

function buildExternalRepairPrompt(
	candidate: string,
	judge: JudgeResult,
	input: ValidateOnlyInput,
): string {
	return redactPromptSensitiveText(`Rewrite the full candidate summary for the Slipstream artifact-free integration API. Preserve true useful content from the candidate, fix the judge findings, and ground the summary only in caller-provided source evidence and continuation. Do not mention hidden artifacts, stats, widgets, pending state, or ctx.compact side effects.

Use the same paired policy as main Slipstream: make the current state and next action clear enough that safe score-8 handoffs can be accepted with advisory warnings, while fixing the causes of hard rejects. Start repaired summaries with "Continuation card:" as the first line; if your draft starts with ## Goal or any deterministic capsule, rewrite it before returning. Keep the model-facing handoff under roughly 100-150 lines unless extra length is required for safety. Do not include both a verbatim terminal answer and a synthesized restatement of the same facts; digest long terminal answers into 1-3 bullets and keep exact text only as recoverable evidence. Use one active-file list backed by current evidence when available; historical file manifests belong only behind recovery pointers. flatten copied markdown headings, raw tool markers, and log headings before including their content; copied output must not create repeated real sections in the summary. Live/manual/browser/API/integration/smoke verification should lead when it exercises the changed surface. Keep passing unit/lint/typecheck evidence terse. Preserve actionable failing checks with command/error and evidenced attribution. Normalize ## Verification / Evidence into a compact table when multiple checks/signals exist:\n\n| Check | Status | Freshness | Relevance |\n|---|---|---|---|\n| <command or surface> | passed/failed/not run/unknown | latest/superseded/pre-existing/after edit | why it matters |\n\nRedact secret-shaped values; never print API keys, tokens, passwords, private keys, certificates, or bearer values. For auth/cert/key/deletion/deploy state, wrong current dirty-state claims, terminal-vs-pending contradictions, and stale current-state claims, do not smooth over contradictions: preserve exact current evidence, mark unknown/unverified, or make recheck the next action.

Judge diagnosis: ${judge.diagnosis}
Missing facts:
${list(judge.missing)}
Contradictions:
${list(judge.contradictions)}

Source evidence:
${renderEvidence(input.sourceEvidence)}

Continuation evidence:
${renderContinuation(input.continuation)}

Previous candidate summary:
<summary>
${candidate}
</summary>`);
}

function clampRepairAttempts(value: number | undefined): number {
	if (value === undefined) return 1;
	if (!Number.isFinite(value)) return 1;
	return Math.max(0, Math.min(3, Math.floor(value)));
}

export async function slipstreamStyleValidateAndRepair(
	input: ValidateOnlyInput,
): Promise<ValidationResult> {
	const threshold = input.config?.judgeThreshold ?? 7;
	const repairEnabled = input.config?.repairEnabled !== false;
	const repairAttempts = repairEnabled
		? clampRepairAttempts(input.config?.repairAttempts)
		: 0;
	let summary = input.candidate;
	let judge = parseJudgeResult(
		await input.completeText(
			buildExternalJudgePrompt(summary, input),
			input.signal,
		),
	);
	let repaired = false;
	let repairCount = 0;
	let bestAcceptedSummary = isAccepted(judge, threshold, summary)
		? summary
		: null;
	let bestAcceptedJudge = isAccepted(judge, threshold, summary) ? judge : null;

	for (
		let attempt = 0;
		attempt < repairAttempts && !isAccepted(judge, threshold, summary);
		attempt += 1
	) {
		const repairedSummary = await input.completeText(
			buildExternalRepairPrompt(summary, judge, input),
			input.signal,
		);
		repaired = true;
		if (isDegenerateCandidateSummary(repairedSummary)) continue;
		repairCount += 1;
		summary = repairedSummary;
		judge = parseJudgeResult(
			await input.completeText(
				buildExternalJudgePrompt(summary, input),
				input.signal,
			),
		);
		if (
			isAccepted(judge, threshold, summary) &&
			(bestAcceptedJudge === null || judge.score > bestAcceptedJudge.score)
		) {
			bestAcceptedSummary = summary;
			bestAcceptedJudge = judge;
		}
	}

	if (bestAcceptedSummary !== null && bestAcceptedJudge !== null) {
		summary = bestAcceptedSummary;
		judge = bestAcceptedJudge;
	}

	return {
		summary,
		accepted: isAccepted(judge, threshold, summary),
		repaired,
		score: judge.score,
		missing: judge.missing,
		contradictions: judge.contradictions,
		diagnosis: judge.diagnosis,
		repairCount,
		judge,
	};
}
