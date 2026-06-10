import { isAccepted, parseJudgeResult } from "./judge.ts";
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
	return `You are the Slipstream artifact-free integration API judge. Judge the candidate summary against only the caller-provided source evidence and continuation. This API is artifact-free: do not assume hidden local files, stats, widgets, pending state, or ctx.compact side effects exist.\n\nReturn only JSON with this shape:\n{\n  "score": 0-10,\n  "decision": "accept" | "reject",\n  "missing": ["..."],\n  "contradictions": ["..."],\n  "diagnosis": "..."\n}\n\nReject if the candidate omits current constraints, unresolved errors, user decisions, or next-action information needed for safe continuation.\n\nSource evidence:\n${renderEvidence(input.sourceEvidence)}\n\nContinuation evidence:\n${renderContinuation(input.continuation)}\n\nCandidate summary:\n<summary>\n${candidate}\n</summary>`;
}

function buildExternalRepairPrompt(
	candidate: string,
	judge: JudgeResult,
	input: ValidateOnlyInput,
): string {
	return `Rewrite the full candidate summary for the Slipstream artifact-free integration API. Preserve true useful content from the candidate, fix the judge findings, and ground the summary only in caller-provided source evidence and continuation. Do not mention hidden artifacts, stats, widgets, pending state, or ctx.compact side effects.\n\nJudge diagnosis: ${judge.diagnosis}\nMissing facts:\n${list(judge.missing)}\nContradictions:\n${list(judge.contradictions)}\n\nSource evidence:\n${renderEvidence(input.sourceEvidence)}\n\nContinuation evidence:\n${renderContinuation(input.continuation)}\n\nPrevious candidate summary:\n<summary>\n${candidate}\n</summary>`;
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
	let bestAcceptedSummary = isAccepted(judge, threshold) ? summary : null;
	let bestAcceptedJudge = isAccepted(judge, threshold) ? judge : null;

	for (
		let attempt = 0;
		attempt < repairAttempts && !isAccepted(judge, threshold);
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
			isAccepted(judge, threshold) &&
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
		accepted: isAccepted(judge, threshold),
		repaired,
		score: judge.score,
		missing: judge.missing,
		contradictions: judge.contradictions,
		diagnosis: judge.diagnosis,
		repairCount,
		judge,
	};
}
