import { fullDiffRecoveryStatus } from "./diff-recovery.ts";
import {
	DEFAULT_MAX_REPAIR_PROMPT_CHARS,
	fitPromptWithDegradableSection,
	normalizePromptBudgetOptions,
	renderBoundedContinuationEvidence,
	type PromptBudgetOptions,
} from "./prompt-bounds.ts";
import { redactPromptSensitiveText } from "./redaction.ts";
import type {
	ContinuationSnapshot,
	JudgeResult,
	StateEvidenceBundle,
} from "./types.ts";

export type RepairPromptContext = {
	artifactRefs?: string[];
	stateEvidence?: StateEvidenceBundle;
	continuation?: ContinuationSnapshot;
};

function list(lines: string[]): string {
	return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- None";
}

function repairStateEvidence(
	evidence: StateEvidenceBundle | undefined,
): string {
	if (!evidence) return "None";
	return `Git available: ${evidence.git.available}
Git errors:
${list(evidence.git.errors)}
Git status --short:
${list(evidence.git.statusShort ? evidence.git.statusShort.split("\n") : [])}
Git diff --stat:
${list(evidence.git.diffStat ? evidence.git.diffStat.split("\n") : [])}
Full git diff artifact paths:
${list(evidence.git.fullDiffArtifactPaths ?? [])}
${fullDiffRecoveryStatus(evidence)}
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
Session open loops:
${list(evidence.session.openLoops)}
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

function repairContinuation(
	continuation: ContinuationSnapshot | undefined,
	options: { maxChars: number; mode?: "standard" | "minimal" | "none" },
): string {
	if (!continuation || continuation.turns.length === 0) return "None";
	return renderBoundedContinuationEvidence(continuation, options);
}

function renderRepairPrompt(
	summary: string,
	judge: JudgeResult,
	context: RepairPromptContext,
	continuation: string,
): string {
	return redactPromptSensitiveText(`Rewrite the full summary into a clean revised checkpoint. Do not append an addendum. Do not modify, reinterpret, or overwrite raw artifact truth.

Use the judge feedback to produce a complete replacement summary with the required continuation-handoff sections. Remove stale or superseded claims instead of merely appending corrections. Preserve exact active paths, commands, errors, decisions, verification evidence, risks, and next actions needed for safe continuation. Keep the model-facing handoff under roughly 100-150 lines unless extra length is required for safety. Optimize for what a strong next agent needs before its next tool call; a slightly longer accurate runbook is better than a terse summary that hides blockers. Keep artifact references as recovery pointers, not substitutes for current facts. Only the Continuation card and narrative sections are authoritative current state; any deterministic capsule is raw/historical evidence and must not be used as current truth without reconciliation.

Start the repaired summary with the exact heading "Continuation card:" as the first line; if your draft starts with ## Goal or any deterministic capsule, rewrite it before returning. Follow it with these exact labels when evidence supports them:
- Current task:
- Latest status:
- Next tool action:
- Primary blocker/risk:
- Stale branch to ignore:

Before writing Latest status and Primary blocker/risk, reconcile protected latest verification/risk signals and protected terminal final-answer evidence against older summary claims and stale candidates. New successful/failing checks, delivered review/final-answer state, exact terminal-answer verdicts, dirty-state caveats, and unresolved risks are high-priority current-state evidence. Do not include both a verbatim terminal answer and a synthesized restatement of the same facts; digest long terminal answers into 1-3 bullets and keep exact text only as recoverable evidence. Use one active-file list backed by current git/state evidence when available; historical file manifests belong only behind recovery pointers. flatten copied markdown headings, raw tool markers, and log headings before including their content; copied output must not create repeated real sections in the summary. A final_delivered signal is a state lock: if it conflicts with older in-progress loops, pending subagent work, or “needs synthesis” wording, mark those older branches stale unless later evidence reopens the task. Include the latest actionable ask, active approved scope, explicitly deferred/not-approved work, and stale branches when they affect the next action. Protected user assertions are historical compacted-away user intent/scope evidence: preserve high-value corrections and preferences when they affect continuation, but do not revive stale assertions as current work. User-reported filesystem/test/runtime claims require verification before they can be stated as facts.

Hard safety repair rule: Redact secret-shaped values; never print API keys, tokens, passwords, private keys, certificates, or bearer values. For auth/cert/key/deletion/deploy state, do not smooth over contradictions: either preserve exact current evidence, mark unknown/unverified, or make recheck the next action.

Verification repair priority: Live/manual/browser/API/integration/smoke validation should lead when it exercises the changed surface. For unit/lint/typecheck evidence, keep passing unit/lint/typecheck results terse and preserve actionable failing commands/errors. Only preserve failure attribution when evidenced: caused by this session, pre-existing, superseded, or unknown. Normalize ## Verification / Evidence into a compact table when multiple checks/signals exist:

| Check | Status | Freshness | Relevance |
|---|---|---|---|
| <command or surface> | passed/failed/not run/unknown | latest/superseded/pre-existing/after edit | why it matters |

Repair the trajectory spine too: under ## Trajectory Analysis, explain why the next action follows from the latest state, which evidence proves or weakens that state, and what recovery handles let the next agent verify it without rereading the whole transcript.

Add a bounded ## Session Findings section for durable facts likely useful later in the same session but not necessarily the immediate next action. Use at most 5 bullets. Include only source-grounded durable facts, investigation conclusions, runbook-level gotchas, artifact locations, or user preferences that would otherwise be easy to lose.

Required output sections:
## Goal
## Current State
## User Constraints / Preferences
## Completed Work
## Active Decisions
## Trajectory Analysis
## Verification / Evidence
## Session Findings
## Blockers / Risks
## Next Actions
## Critical Files / Artifacts
## Superseded or Stale Context to Ignore

Judge diagnosis: ${judge.diagnosis}
Missing:
${judge.missing.map((item) => `- ${item}`).join("\n") || "- None"}
Contradictions:
${judge.contradictions.map((item) => `- ${item}`).join("\n") || "- None"}

Protected repair context:
- Use these protected facts to correct the summary instead of guessing.
- Raw git diff text is not embedded here; recover it from artifact paths if needed.

State evidence:
${repairStateEvidence(context.stateEvidence)}

Artifact references:
${list(context.artifactRefs ?? [])}

Continuation evidence:
<continuation>
${continuation}
</continuation>

Summary to rewrite:
<summary>
${summary}
</summary>`);
}

export function buildRepairPrompt(
	summary: string,
	judge: JudgeResult,
	context: RepairPromptContext = {},
	options?: PromptBudgetOptions,
): string {
	const budget = normalizePromptBudgetOptions(
		options,
		DEFAULT_MAX_REPAIR_PROMPT_CHARS,
	);
	const standardContinuation = repairContinuation(context.continuation, {
		maxChars: budget.continuationMaxChars,
		mode: "standard",
	});
	const minimalContinuation = repairContinuation(context.continuation, {
		maxChars: Math.min(budget.continuationMaxChars, 8_000),
		mode: "minimal",
	});
	const omittedContinuation = repairContinuation(context.continuation, {
		maxChars: 1_000,
		mode: "none",
	});
	return fitPromptWithDegradableSection({
		render: (continuation) =>
			renderRepairPrompt(summary, judge, context, continuation),
		degradableStandard: standardContinuation,
		degradableMinimal: minimalContinuation,
		degradableOmitted: omittedContinuation,
		maxPromptChars: budget.maxPromptChars,
		fixedSectionName: "repair prompt",
	});
}
