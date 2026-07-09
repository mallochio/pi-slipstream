import { DEFAULT_MAX_CONVERSATION_CHARS } from "./config.ts";
import { fullDiffRecoveryStatus } from "./diff-recovery.ts";
import { redactPromptSensitiveText } from "./redaction.ts";
import type { CompleteTextFn, Snapshot, StateEvidenceBundle } from "./types.ts";

export type SummaryPromptOptions = {
	artifactRefs?: string[];
	maxConversationChars?: number;
	maxPromptChars?: number;
	stateEvidence?: StateEvidenceBundle;
};

export const DEFAULT_MAX_SUMMARY_PROMPT_CHARS = 650_000;

const CODEX_COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`;

const CONTINUATION_CARD_HEADING = "Continuation card:";
const CODEX_SUMMARY_PREFIX =
	"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

function insertCodexSummaryPrefix(summary: string): string {
	const anchoredPrefix = `${CONTINUATION_CARD_HEADING}\n${CODEX_SUMMARY_PREFIX}`;
	if (!summary.startsWith(`${CONTINUATION_CARD_HEADING}\n`)) return summary;
	if (summary === anchoredPrefix || summary.startsWith(`${anchoredPrefix}\n`))
		return summary;
	return `${anchoredPrefix}\n\n${summary.slice(CONTINUATION_CARD_HEADING.length + 1)}`;
}

function list(lines: string[]): string {
	return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- None";
}

function fenced(text: string): string {
	return text.trim() ? `\n\`\`\`text\n${text}\n\`\`\`` : " None";
}

function boundedConversation(messages: string[], maxChars: number): string {
	const full = messages.join("\n\n");
	if (full.length <= maxChars) return full;
	if (maxChars <= 0)
		return `[... Slipstream omitted ${full.length.toLocaleString()} characters from the raw conversation span because protected fixed prompt sections consumed the prompt budget. Full raw span is preserved in local artifacts for later tool-assisted recovery. ...]`;
	const headChars = Math.floor(maxChars * 0.2);
	const tailChars = maxChars - headChars;
	const omittedChars = full.length - maxChars;
	return `${full.slice(0, headChars)}\n\n[... Slipstream omitted ${omittedChars.toLocaleString()} characters from the middle of the raw conversation span. Full raw span is preserved in local artifacts for later tool-assisted recovery, but artifact paths are not visible evidence for this model call. Preserve current, continuation-relevant facts explicitly and mark stale or superseded history instead of restating it as current. ...]\n\n${full.slice(-tailChars)}`;
}

export function isDegenerateCandidateSummary(summary: string): boolean {
	const contentLines = summary
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !/^#{1,6}\s+/.test(line));
	return contentLines.length === 0;
}

function capsuleList(lines: string[], limit: number): string {
	const selected = lines.slice(0, limit);
	if (selected.length === 0) return "- None";
	const omitted = lines.length - selected.length;
	const rendered = selected.map((line) => `- ${line}`).join("\n");
	return omitted > 0 ? `${rendered}\n- ... ${omitted} more` : rendered;
}

function uniqueNonEmpty(lines: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		unique.push(trimmed);
	}
	return unique;
}

function compactOneLine(text: string, maxChars: number): string {
	const compacted = text
		.replace(/^Terminal latest assistant answer \[[^\]]+\] exact text:\s*/i, "")
		.replace(/^Terminal latest assistant answer exact text:\s*/i, "")
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^#{1,6}\s+/, ""))
		.filter((line) => line && line !== "```" && !/^[-*_]{3,}$/.test(line))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (compacted.length <= maxChars) return compacted;
	return `${compacted.slice(0, maxChars - 1).trimEnd()}…`;
}

function renderUserAssertionTrail(
	entries: Snapshot["manifest"]["userAssertionTrail"],
): string[] {
	return entries.map((entry) => {
		const stale = entry.staleReason ? ` (${entry.staleReason})` : "";
		const superseded = entry.supersededByEntryId
			? ` Superseded by: ${entry.supersededByEntryId}.`
			: "";
		return `[${entry.entryId}] ${entry.kind}/${entry.authority}/stale=${entry.staleRisk} — User asserted: ${entry.userAsserted} Evidence excerpt: ${entry.evidenceExcerpt}${stale}${superseded}`;
	});
}

function digestTerminalFinalAnswer(lines: string[]): string {
	const candidates = lines
		.flatMap((line) =>
			compactOneLine(line, 2_000)
				.split(/(?<=[.!?])\s+/)
				.map((sentence) => sentence.trim()),
		)
		.filter(Boolean);
	const priority = candidates.filter((sentence) =>
		/\b(?:verdict|recommendation|changed|implemented|blocked|blocker|risk|caveat|next|decision|done|wait|approved|not approved)\b/i.test(
			sentence,
		),
	);
	const selected = (priority.length ? priority : candidates).slice(0, 3);
	return capsuleList(
		selected.map((line) => compactOneLine(line, 220)),
		3,
	);
}

function recoveryPointer(refs: string[]): string {
	const first = refs.find((ref) => ref.trim());
	if (!first) return "None";
	const trimmed = first.trim();
	if (/^artifact:\/\//.test(trimmed)) return trimmed;
	const slash = trimmed.lastIndexOf("/");
	if (slash <= 0) return trimmed;
	return trimmed.slice(0, slash);
}

function verificationDigest(snapshot: Snapshot): string {
	const manifest = snapshot.manifest;
	const lines = [
		...manifest.latestSignals.map((signal) => {
			if (signal.kind === "verification_success")
				return `passed check — ${signal.text}`;
			if (signal.kind === "verification_failure")
				return `failing/needs-attention check — ${signal.text}`;
			if (signal.kind === "final_delivered")
				return `terminal state — ${signal.text}`;
			if (signal.kind === "risk") return `risk — ${signal.text}`;
			return `delivered output — ${signal.text}`;
		}),
		...manifest.openLoops.map(
			(loop) => `open loop (${loop.priority}) — ${loop.summary}`,
		),
		...manifest.recentVerification.map((line) => `recent check — ${line}`),
	];
	return capsuleList(
		lines.map((line) => compactOneLine(line, 220)),
		3,
	);
}

export function buildCurrentStateCapsule(
	snapshot: Snapshot,
	artifactRefs: string[] = [],
): string {
	const manifest = snapshot.manifest;
	const allArtifactRefs = uniqueNonEmpty([
		...artifactRefs,
		...manifest.artifactRefs,
	]);
	const fileCount =
		manifest.filesModified.length + manifest.filesDeleted.length;
	return `## Deterministic Evidence Capsule

Generated by Slipstream as a compact non-authoritative recovery index after the model-written handoff. The Continuation card and narrative sections above are authoritative current state; use this capsule only to locate raw evidence or recheck stale/history-sensitive facts.

- Session: ${snapshot.sessionId}
- CWD: ${snapshot.cwd}
- First kept entry: ${snapshot.firstKeptEntryId ?? "unknown"}
- Tokens before compaction: ${snapshot.tokensBefore ?? "unknown"}
- Recovery pointer: ${recoveryPointer(allArtifactRefs)}
- Raw evidence counts: terminal answers ${manifest.terminalFinalAnswerEvidence.length}; verification/risk signals ${manifest.latestSignals.length}; session-history file entries ${fileCount}; stale signals ${manifest.staleSignals.length}; artifacts ${allArtifactRefs.length}

### Latest exchange digest
${capsuleList(
	manifest.latestExchangeState.map((line) => compactOneLine(line, 220)),
	2,
)}

### Terminal answer digest
${digestTerminalFinalAnswer(manifest.terminalFinalAnswerEvidence)}

### Active risk/verification digest
${verificationDigest(snapshot)}`;
}

export function withCurrentStateCapsule(
	summary: string,
	snapshot: Snapshot,
	artifactRefs: string[] = [],
): string {
	let prose = summary
		.trim()
		.replace(
			/\n\n---\n\n## Deterministic (?:Current-State|Evidence) Capsule[\s\S]*$/,
			"",
		)
		.trim();
	if (/^## Deterministic (?:Current-State|Evidence) Capsule/.test(prose)) {
		prose = prose
			.split(/\n\n---\n\n/)
			.slice(1)
			.join("\n\n---\n\n")
			.trim();
	}
	return `${insertCodexSummaryPrefix(prose)}\n\n---\n\n${buildCurrentStateCapsule(snapshot, artifactRefs)}`;
}

function renderStateEvidence(
	evidence: StateEvidenceBundle | undefined,
): string {
	if (!evidence) return "None";
	return `Generated: ${evidence.generatedAt}
CWD: ${evidence.cwd}

Session distilled facts:
Files read:
${list(evidence.session.filesRead)}

Files modified:
${list(evidence.session.filesModified)}

Files deleted:
${list(evidence.session.filesDeleted)}

Unresolved errors:
${list(evidence.session.unresolvedErrors)}

User decisions:
${list(evidence.session.userDecisions)}

Constraints:
${list(evidence.session.constraints)}

Open loops:
${list(evidence.session.openLoops)}

Verification evidence:
${list(evidence.session.recentVerification)}

Latest compacted updates:
${list(evidence.session.latestUpdates)}

Retained-tail updates still visible after compaction; these are high-priority current-state anchors and override older compacted updates when they conflict:
${list(evidence.session.retainedTailUpdates)}

Latest user/assistant exchange state:
${list(evidence.session.latestExchangeState)}

Terminal final-answer evidence:
${list(evidence.session.terminalFinalAnswerEvidence)}

Latest verification and risk signals:
${list(evidence.session.latestSignals)}

Stale or superseded candidates:
${list(evidence.session.staleSignals)}

Session user assertion trail:
${list(evidence.session.userAssertionTrail ?? [])}

Critical literals:
${list(evidence.session.criticalLiterals)}

Read-only git evidence for writer grounding. Use it to understand current code state, but do not copy huge diffs verbatim unless needed to preserve an exact change.
Git available: ${evidence.git.available}
Git errors:
${list(evidence.git.errors)}

Git status --short:${fenced(evidence.git.statusShort)}

Git diff --stat:${fenced(evidence.git.diffStat)}

Full git diff artifact paths:
${list(evidence.git.fullDiffArtifactPaths ?? [])}
${fullDiffRecoveryStatus(evidence)}
Full git diff SHA-256: ${evidence.git.fullDiffSha256 ?? "None"}
Full git diff bytes: ${evidence.git.fullDiffBytes ?? "None"}
Full git diff complete: ${evidence.git.fullDiffComplete ?? "unknown"}
Full git diff preserved: ${evidence.git.fullDiffPreserved ?? "unknown"}

Bounded git diff -U20:${fenced(evidence.git.diff)}
${evidence.git.omittedDiffChars ? `\nOmitted git diff characters: ${evidence.git.omittedDiffChars}` : ""}`;
}

function renderHandoffSignals(
	snapshot: Snapshot,
	artifactRefs: string[],
): string {
	const manifest = snapshot.manifest;
	return `Current handoff signals:
- Trajectory spine inputs: retained-tail updates + latest compacted updates + verification + open loops + stale signals should determine why the next action follows from the latest state.
- Previous summary is a checkpoint to revise, not final truth: ${manifest.previousSummary ? "present" : "none"}
- Latest user/assistant exchange state: ${manifest.latestExchangeState.slice(-4).join(" | ") || "None"}
- Terminal final-answer digest: ${digestTerminalFinalAnswer(manifest.terminalFinalAnswerEvidence).replace(/\n/g, " | ")}
- Retained-tail updates still visible after compaction: ${manifest.retainedTailUpdates.slice(-4).join(" | ") || "None"}
- Latest compacted updates: ${manifest.latestUpdates.slice(-4).join(" | ") || "None"}
- Latest verification and risk signals: ${
		manifest.latestSignals
			.map((signal) => `${signal.kind}: ${signal.text}`)
			.slice(-8)
			.join(" | ") || "None"
	}
- Recent verification: ${manifest.recentVerification.slice(-6).join(" | ") || "None"}
- Open loops/blockers: ${
		manifest.openLoops
			.map((loop) => loop.summary)
			.slice(-6)
			.join(" | ") || "None"
	}
- User decisions/constraints: ${
		[
			...manifest.userDecisions.map((decision) => decision.text),
			...manifest.constraints.map((constraint) => constraint.text),
		]
			.slice(-8)
			.join(" | ") || "None"
	}
- Historical user assertions from compacted-away messages: ${
		renderUserAssertionTrail(manifest.userAssertionTrail)
			.slice(-6)
			.join(" | ") || "None"
	}
- Files read/modified/deleted: ${
		[
			...manifest.filesRead.map((path) => `read ${path}`),
			...manifest.filesModified.map((path) => `modified ${path}`),
			...manifest.filesDeleted.map((path) => `deleted ${path}`),
		]
			.slice(-12)
			.join(" | ") || "None"
	}
- Stale/superseded candidates to treat cautiously: ${
		manifest.staleSignals
			.map((signal) => `${signal.text} (${signal.reason})`)
			.slice(-8)
			.join(" | ") || "None"
	}
- Artifact refs for recovery: ${artifactRefs.slice(-12).join(" | ") || "None"}`;
}

function renderSummaryPrompt(
	snapshot: Snapshot,
	artifactRefs: string[],
	stateEvidence: string,
	conversation: string,
): string {
	const manifest = snapshot.manifest;
	return `${CODEX_COMPACT_PROMPT}You are a Slipstream-style compaction writer for a coding agent.

Write the continuation handoff that a strong next agent would want before taking the next tool call. The summary itself must start with the Continuation card as the first line; if your draft starts with ## Goal or any deterministic capsule, rewrite it before returning. Keep the model-facing handoff under roughly 100-150 lines unless extra length is required for safety. Only the Continuation card and narrative sections are authoritative current state. The deterministic capsule is raw/historical evidence appended later for recovery. Optimize for continuation utility, not keyword recall, prettiness, or archival completeness. The best summary is a dense, source-grounded runbook: current objective, actual latest state, constraints, verification, risks, exact next actions, and enough concrete paths/commands/entities to avoid re-discovery.

Revise the previous checkpoint; do not append stale history. Current/latest user requests, tool results, verification, and state evidence override older summaries when evidence conflicts. State evidence is strong evidence for filesystem/runtime facts, but it does not by itself prove that the user's task is complete or that older in-progress delegation has finished. If transcript state and live state evidence conflict, preserve the conflict and say what to verify next. Do not invent facts, files, commands, tests, decisions, or errors. Preserve uncertainty.

Before writing, run this mental continuation probe:
1. What would the next agent believe is the current task and latest status?
2. What are the next 3 concrete actions it should take?
3. What blockers, failed attempts, unverified claims, and stale/superseded branches could make it go wrong?
4. Which exact files, commands, artifacts, and user decisions are needed to act safely?

Then write a trajectory spine: explain why the next action follows from the latest state, which evidence proves or weakens that state, and what recovery handles let the next agent verify it without rereading the whole transcript. Prefer this causal trajectory over broad historical inventory.

Noise-control rule: foreground only facts that affect the next decision. If the latest state is terminal, post-answer waiting, or a narrow follow-up, keep historical implementation details, dirty working-tree inventories, full artifact paths, and broad critical-file lists terse. Put older details behind recovery handles or stale-context notes instead of repeating them as active work. Use one active-file list backed by current git/state evidence when available; historical file manifests belong only behind recovery pointers. Do not include both a verbatim terminal answer and a synthesized restatement of the same facts. Digest long terminal answers into 1-3 bullets and keep exact text only as recoverable evidence. flatten copied markdown headings, raw tool markers, and log headings before including their content; copied output must not create repeated real sections in the summary. Do not include compaction-harness, benchmark, scratch-worktree, or unrelated Pi/config git status as current task evidence unless the task itself is about that repo; if such evidence is suspicious, mention only that live repo state must be rechecked before edits. Aim for enough file/command handles to recover, not every possible file ever read. Concision must not erase the latest answer's decision-critical content: preserve the latest assistant response's final verdict, salient risk bullets, verification caveats, and ordered safe-next-step checklist when those facts determine what a future agent should or should not do. Do not replace those facts with only “recover before quoting” unless the retained text is genuinely unavailable.

Trust-hygiene rule: separate current facts from historical evidence before writing. Include the latest actionable ask, active approved scope, explicitly deferred/not-approved work, and stale branches in the narrative when they affect the next action. User assertion trail semantics: compacted-away user assertions are protected historical evidence for user intent, scope, preferences, and corrections; they are not proof that repo, filesystem, git, test, runtime, or deployment events happened. Treat intent_scope assertions as authoritative user intent unless superseded by newer user messages. Treat user_reported_state_requires_verification assertions as claims that require fresh verification before acting. Suppress or label high-stale-risk assertions; do not restart completed work from the assertion trail alone. Redact secret-shaped values; never print API keys, tokens, passwords, private keys, certificates, or bearer values. For auth/cert/key/deletion/deploy state, do not infer: either preserve exact current evidence, mark unknown/unverified, or make recheck the next action.

Start the summary with the exact heading "Continuation card:" as the first line, followed by these exact labels when evidence supports them:
- Current task:
- Latest status:
- Next tool action:
- Primary blocker/risk:
- Stale branch to ignore:

Before writing Latest status, Next tool action, and Primary blocker/risk, reconcile the latest user/assistant exchange state, terminal final-answer evidence, retained-tail updates, and Latest verification/risk signals against older summaries, older open loops, and stale candidates. Retained-tail updates are the newest messages still visible after compaction; treat them as current-state anchors, not optional history. Terminal final-answer evidence is protected source text: if it includes a verdict, recommendation, implementation checklist, risk, or verification caveat, carry that content into Latest status, Next Actions, or Blockers/Risks instead of merely listing an artifact/recovery handle. If the latest exchange state says the latest user request already has a subsequent assistant response, do not describe the request as unanswered or the answer as still needing synthesis unless later tool/error evidence after that assistant response proves it was incomplete. If there is no tool activity after the latest assistant response, treat that response as the terminal latest state: demote older pending subagents, in-progress scout/status checks, and “needs synthesis” loops to stale context or recovery handles rather than foregrounding them as Next tool action. New user requests, assistant answers, successful/failing checks, delivered review/final-answer state, dirty-state caveats, and unresolved risks are high-priority current-state evidence. A final_delivered signal is a state lock: if it conflicts with older in-progress loops, pending subagent work, or “needs synthesis” wording, mark those older branches stale unless later evidence reopens the task.

Artifact references are durable local pointers for future tool-assisted recovery, not a substitute for critical current-state facts. Do not make prose summary the only copy of raw code, diffs, JSON/YAML/config, errors, or verification evidence.

Verification priority: Live/manual/browser/API/integration/smoke validation should lead when it exercises the changed surface. Passing unit/lint/typecheck evidence should be terse: outcome and scope are enough. Preserve unsuperseded actionable failing checks with command/error details, and preserve attribution only when evidence says caused by this session, pre-existing, superseded, or unknown. Do not preserve full passing unit-test inventories or exact passing unit-test commands unless needed for the next action. Normalize ## Verification / Evidence into a compact table when multiple checks/signals exist:

| Check | Status | Freshness | Relevance |
|---|---|---|---|
| <command or surface> | passed/failed/not run/unknown | latest/superseded/pre-existing/after edit | why it matters |

Include critical/current protected facts that are needed for safe continuation. You may omit protected facts only when they are stale, superseded, non-continuation-relevant, or safely recoverable from listed artifacts; if omission could mislead the next agent, mention it under stale context or risks. Prefer a slightly longer correct handoff over a clean but under-informative one.

Add a bounded ## Session Findings section for durable facts that are likely useful later in the same session but are not necessarily the immediate next action. Use at most 5 bullets. Include only source-grounded durable facts, investigation conclusions, runbook-level gotchas, artifact locations, or user preferences that would otherwise be easy to lose. Omit transient chatter, raw logs, secrets, broad inventories, and anything already fully captured as current state or stale context.

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

${renderHandoffSignals(snapshot, artifactRefs)}

Protected manifest:

Files read:
${list(manifest.filesRead)}

Files modified:
${list(manifest.filesModified)}

Files deleted:
${list(manifest.filesDeleted)}

Unresolved errors:
${list(manifest.errors.map((e) => e.message))}

User decisions:
${list(manifest.userDecisions.map((d) => d.text))}

Constraints:
${list(manifest.constraints.map((c) => c.text))}

Open loops:
${list(manifest.openLoops.map((l) => l.summary))}

Verification evidence:
${list(manifest.recentVerification)}

Latest compacted updates:
${list(manifest.latestUpdates)}

Retained-tail updates still visible after compaction; these override older compacted updates when they conflict:
${list(manifest.retainedTailUpdates)}

Latest user/assistant exchange state:
${list(manifest.latestExchangeState)}

Terminal final-answer evidence; these exact latest-answer spans override retained-tail truncation:
${list(manifest.terminalFinalAnswerEvidence)}

Latest verification and risk signals:
${list(manifest.latestSignals.map((signal) => `${signal.kind}: ${signal.text}`))}

Stale or superseded candidates:
${list(manifest.staleSignals.map((signal) => `${signal.text} — ${signal.reason}`))}

Historical user assertions from compacted-away messages:
${list(renderUserAssertionTrail(manifest.userAssertionTrail))}

Critical literals / exact expected strings:
${list(manifest.criticalLiterals)}

Previous checkpoint to revise:
${manifest.previousSummary ?? "None"}

State evidence bundle:
${stateEvidence}

Artifact references:
${list(artifactRefs)}

Conversation span to compact:
<conversation>
${conversation}
</conversation>`;
}

export function buildSummaryPrompt(
	snapshot: Snapshot,
	options: SummaryPromptOptions = {},
): string {
	const artifactRefs = uniqueNonEmpty([
		...(options.artifactRefs ?? []),
		...snapshot.manifest.artifactRefs,
	]);
	const requestedConversationChars =
		options.maxConversationChars ?? DEFAULT_MAX_CONVERSATION_CHARS;
	const maxPromptChars =
		options.maxPromptChars ?? DEFAULT_MAX_SUMMARY_PROMPT_CHARS;
	const stateEvidence = renderStateEvidence(options.stateEvidence);
	const initialConversation = boundedConversation(
		snapshot.summaryInputMessages,
		requestedConversationChars,
	);
	const initialPrompt = redactPromptSensitiveText(
		renderSummaryPrompt(
			snapshot,
			artifactRefs,
			stateEvidence,
			initialConversation,
		),
	);
	if (initialPrompt.length <= maxPromptChars) return initialPrompt;

	const skeletonPrompt = redactPromptSensitiveText(
		renderSummaryPrompt(snapshot, artifactRefs, stateEvidence, ""),
	);
	if (skeletonPrompt.length >= maxPromptChars) {
		throw new Error(
			`Slipstream summary prompt fixed sections exceed maxPromptChars (${skeletonPrompt.length} >= ${maxPromptChars}); reduce protected manifest/state evidence before retrying.`,
		);
	}
	const remainingConversationChars = Math.max(
		0,
		maxPromptChars - skeletonPrompt.length,
	);
	const cappedConversation = boundedConversation(
		snapshot.summaryInputMessages,
		Math.min(requestedConversationChars, remainingConversationChars),
	);
	const cappedPrompt = redactPromptSensitiveText(
		renderSummaryPrompt(
			snapshot,
			artifactRefs,
			stateEvidence,
			cappedConversation,
		),
	);
	if (cappedPrompt.length <= maxPromptChars) return cappedPrompt;

	const omittedConversation = boundedConversation(
		snapshot.summaryInputMessages,
		0,
	);
	const omissionOnlyPrompt = redactPromptSensitiveText(
		renderSummaryPrompt(
			snapshot,
			artifactRefs,
			stateEvidence,
			omittedConversation,
		),
	);
	if (omissionOnlyPrompt.length <= maxPromptChars) return omissionOnlyPrompt;
	throw new Error(
		`Slipstream summary prompt exceeds maxPromptChars after conversation capping (${omissionOnlyPrompt.length} > ${maxPromptChars}); reduce protected manifest/state evidence before retrying.`,
	);
}

export async function generateCandidateSummary(
	snapshot: Snapshot,
	completeText: CompleteTextFn,
	signal?: AbortSignal,
): Promise<string> {
	const summary = await completeText(buildSummaryPrompt(snapshot), signal);
	return summary.trim();
}
