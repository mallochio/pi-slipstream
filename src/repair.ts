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
Session critical literals:
${list(evidence.session.criticalLiterals)}`;
}

function repairContinuation(
	continuation: ContinuationSnapshot | undefined,
): string {
	if (!continuation || continuation.turns.length === 0) return "None";
	return continuation.turns
		.map(
			(turn, index) =>
				`Turn ${index + 1}: ${turn.assistantText}\nTool results: ${JSON.stringify(turn.toolResults)}`,
		)
		.join("\n\n");
}

export function buildRepairPrompt(
	summary: string,
	judge: JudgeResult,
	context: RepairPromptContext = {},
): string {
	return `Rewrite the full summary into a clean revised checkpoint. Do not append an addendum. Do not modify, reinterpret, or overwrite raw artifact truth.

Use the judge feedback to produce a complete replacement summary with the required continuation-handoff sections. Remove stale or superseded claims instead of merely appending corrections. Preserve exact active paths, commands, errors, decisions, verification evidence, risks, and next actions needed for safe continuation. Optimize for what a strong next agent needs before its next tool call; a slightly longer accurate runbook is better than a terse summary that hides blockers. Keep artifact references as recovery pointers, not substitutes for current facts.

Start the repaired summary with the exact heading "Continuation card:" in the first screenful, followed by these exact labels when evidence supports them:
- Current task:
- Latest status:
- Next tool action:
- Primary blocker/risk:
- Stale branch to ignore:

Before writing Latest status and Primary blocker/risk, reconcile protected latest verification/risk signals and protected terminal final-answer evidence against older summary claims and stale candidates. New successful/failing checks, delivered review/final-answer state, exact terminal-answer verdicts, dirty-state caveats, and unresolved risks are high-priority current-state evidence. A final_delivered signal is a state lock: if it conflicts with older in-progress loops, pending subagent work, or “needs synthesis” wording, mark those older branches stale unless later evidence reopens the task.

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
${repairContinuation(context.continuation)}
</continuation>

Summary to rewrite:
<summary>
${summary}
</summary>`;
}
