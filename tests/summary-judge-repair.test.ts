import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildJudgePrompt,
	isAccepted,
	parseJudgeResult,
} from "../src/judge.ts";
import { renderBoundedContinuationEvidence } from "../src/prompt-bounds.ts";
import { buildRepairPrompt } from "../src/repair.ts";
import {
	buildCurrentStateCapsule,
	buildSummaryPrompt,
	withCurrentStateCapsule,
} from "../src/summary.ts";
import type { Snapshot } from "../src/types.ts";

const CODEX_COMPACT_PROMPT =
	"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n" +
	"Include:\n" +
	"- Current progress and key decisions made\n" +
	"- Important context, constraints, or user preferences\n" +
	"- What remains to be done (clear next steps)\n" +
	"- Any critical data, examples, or references needed to continue\n\n" +
	"Be concise, structured, and focused on helping the next LLM seamlessly continue the work.\n";

const CODEX_SUMMARY_PREFIX =
	"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

const snapshot: Snapshot = {
	sessionId: "s1",
	cwd: "/repo",
	triggerEntryId: "e1",
	firstKeptEntryId: "k1",
	tokensBefore: 1000,
	summaryInputMessages: ["[User]: fix it"],
	keptBoundary: { keepFromIndex: 1, firstKeptEntryId: "k1" },
	manifest: {
		filesRead: ["/repo/src/a.ts"],
		filesModified: ["/repo/src/b.ts"],
		filesDeleted: [],
		errors: [
			{
				source: "tool",
				message: "edit failed",
				entryId: "t1",
				unresolved: true,
			},
		],
		userDecisions: [{ text: "Use Slipstream", entryId: "u1" }],
		constraints: [{ text: "Must preserve comments", entryId: "u1" }],
		openLoops: [
			{ summary: "Need implementation", entryId: "u1", priority: "high" },
		],
		recentVerification: ["npm test failed"],
		latestUpdates: [
			"[Assistant a-final]: Final recommendation: use gpt-5.4-mini for auto and reserve gpt-5.5 for manual checkpoints.",
		],
		retainedTailUpdates: [
			"[User u-latest]: actually wait for user follow-up now",
		],
		latestExchangeState: [
			"Latest user request has a subsequent assistant response: [assistant a-final]: answer delivered",
		],
		terminalFinalAnswerEvidence: [
			"Terminal latest assistant answer [a-final] exact text:\nFinal verdict: wait for user follow-up. Risk: git status came from wrapper CWD. Verification caveat: npm test failed before repair.",
		],
		latestSignals: [
			{
				kind: "verification_failure",
				text: "npm test failed before repair",
				entryId: "b1",
			},
			{
				kind: "final_delivered",
				text: "Final audit answer was already sent; wait for user follow-up",
				entryId: "a2",
			},
			{
				kind: "risk",
				text: "git status came from wrapper CWD",
				entryId: "a1",
			},
		],
		staleSignals: [
			{
				text: "npm test failed",
				reason: "Later evidence says npm test passed",
			},
		],
		userAssertionTrail: [
			{
				entryId: "u-assert-1",
				kind: "correction_supersession",
				authority: "intent_scope",
				userAsserted:
					"User corrected that validation must pair with summary prompt improvement, not stricter prompting alone.",
				evidenceExcerpt:
					"Actually this is not just stricter prompting; validation has to be paired with the summary-prompt change.",
				staleRisk: "low",
			},
			{
				entryId: "u-assert-2",
				kind: "historical_background",
				authority: "user_reported_state_requires_verification",
				userAsserted: "User reported that npm test passed earlier.",
				evidenceExcerpt: "npm test passed earlier.",
				staleRisk: "medium",
				staleReason:
					"User-reported runtime or verification state requires fresh verification before acting.",
			},
		],
		criticalLiterals: ["TASK-1:high:alpha|shared|gamma", "E_RETRYABLE"],
		previousSummary: "older",
		artifactRefs: ["artifact://raw"],
		knownFileRefs: new Set(["/repo/src/a.ts", "/repo/src/b.ts"]),
	},
};

describe("summary, judge, and repair", () => {
	it("appends only a compact non-authoritative recovery capsule after model prose", () => {
		const noisySnapshot: Snapshot = {
			...snapshot,
			manifest: {
				...snapshot.manifest,
				terminalFinalAnswerEvidence: [
					"Terminal latest assistant answer [a-final] exact text:\n## Passed live\nThe exhaustive live-test report is intentionally long and should not be copied verbatim.\n\n## Passed live\nDuplicate heading block that belongs in recovery only.\n\nFinal verdict: wait for user follow-up. Risk: git status came from wrapper CWD. Verification caveat: npm test failed before repair.",
				],
				filesModified: Array.from(
					{ length: 30 },
					(_, index) => `/repo/src/noisy-${index}.ts`,
				),
				staleSignals: Array.from({ length: 20 }, (_, index) => ({
					text: `stale branch ${index}`,
					reason: "later evidence superseded it",
				})),
				artifactRefs: [
					"/repo/.scratch/compactions/old-run/state-evidence.json",
					"/repo/.scratch/compactions/old-run/trigger-raw-001.json",
				],
			},
		};
		const capsule = buildCurrentStateCapsule(noisySnapshot, [
			"/repo/.scratch/compactions/run-1/git-diff-full-001.patch",
		]);
		const summary = withCurrentStateCapsule(
			"Continuation card:\n- Current task: Continue safely\n\n## Goal\nContinue safely",
			noisySnapshot,
			["/repo/.scratch/compactions/run-1/git-diff-full-001.patch"],
		);

		assert.match(capsule, /^## Deterministic Evidence Capsule/);
		assert.match(capsule, /compact non-authoritative recovery index/);
		assert.match(capsule, /Terminal answer digest/);
		assert.match(capsule, /Final verdict: wait for user follow-up/);
		assert.doesNotMatch(capsule, /## Passed live/);
		assert.doesNotMatch(
			capsule,
			/exhaustive live-test report is intentionally long/,
		);
		assert.doesNotMatch(capsule, /noisy-29/);
		assert.doesNotMatch(capsule, /Session-history changed files/);
		assert.match(capsule, /Active risk\/verification digest/);
		assert.match(
			capsule,
			/Recovery pointer: \/repo\/\.scratch\/compactions\/run-1/,
		);
		assert.doesNotMatch(
			capsule,
			/Recovery pointer: \/repo\/\.scratch\/compactions\/old-run/,
		);
		assert.equal(capsule.split("\n").length <= 32, true);
		assert.ok(
			summary.startsWith(
				`Continuation card:\n${CODEX_SUMMARY_PREFIX}\n\n- Current task:`,
			),
		);
		assert.equal(summary.split(CODEX_SUMMARY_PREFIX).length - 1, 1);
		assert.match(
			summary,
			/## Goal\nContinue safely\n\n---\n\n## Deterministic Evidence Capsule/,
		);
		assert.equal(
			withCurrentStateCapsule(summary, noisySnapshot, [
				"/repo/.scratch/compactions/run-1/git-diff-full-001.patch",
			]),
			summary,
		);

		const normalized = withCurrentStateCapsule(
			`## Deterministic Current-State Capsule\n\nOld authoritative capsule\n\n---\n\nContinuation card:\n- Current task: Continue safely\n\n## Goal\nContinue safely`,
			noisySnapshot,
			["/repo/.scratch/compactions/run-1/git-diff-full-001.patch"],
		);
		assert.match(normalized, /^Continuation card:/);
		assert.doesNotMatch(normalized, /Old authoritative capsule/);
		assert.match(
			normalized,
			/## Goal\nContinue safely\n\n---\n\n## Deterministic Evidence Capsule/,
		);
	});

	it("does not prefix malformed or later continuation-card anchors", () => {
		for (const prose of [
			"Continuation card :\n- Current task: malformed anchor",
			"## Goal\nContinue safely\n\nContinuation card:\n- Current task: later anchor",
		]) {
			const summary = withCurrentStateCapsule(prose, snapshot);
			assert.equal(summary.split(CODEX_SUMMARY_PREFIX).length - 1, 0);
			assert.ok(summary.startsWith(`${prose}\n\n---\n\n`));
		}
	});

	it("builds a grounded summary prompt with protected manifest sections", () => {
		const prompt = buildSummaryPrompt(snapshot, {
			artifactRefs: ["artifact://raw"],
		});
		assert.equal(
			prompt.slice(0, CODEX_COMPACT_PROMPT.length),
			CODEX_COMPACT_PROMPT,
		);
		assert.match(prompt, /Revise the previous checkpoint/);
		assert.match(
			prompt,
			/summary itself must start with the Continuation card as the first line/,
		);
		assert.match(
			prompt,
			/if your draft starts with ## Goal or any deterministic capsule/,
		);
		assert.match(
			prompt,
			/Only the Continuation card and narrative sections are authoritative/,
		);
		assert.match(
			prompt,
			/The deterministic capsule is raw\/historical evidence/,
		);
		assert.match(prompt, /model-facing handoff under roughly 100-150 lines/);
		assert.match(
			prompt,
			/Do not include both a verbatim terminal answer and a synthesized restatement/,
		);
		assert.match(prompt, /flatten copied markdown headings/);
		assert.match(prompt, /\| Check \| Status \| Freshness \| Relevance \|/);
		assert.match(prompt, /one active-file list/);
		assert.match(
			prompt,
			/Current\/latest user requests.*override older summaries/s,
		);
		assert.match(prompt, /Superseded or Stale Context to Ignore/);
		assert.match(prompt, /Current handoff signals/);
		assert.match(prompt, /Trajectory spine/);
		assert.match(prompt, /why the next action follows from the latest state/);
		assert.match(prompt, /## Trajectory Analysis/);
		assert.match(prompt, /## Session Findings/);
		assert.match(prompt, /at most 5 bullets/);
		assert.match(prompt, /durable facts/);
		assert.match(
			prompt,
			/exact heading "Continuation card:" as the first line/,
		);
		assert.match(prompt, /Current task:/);
		assert.match(prompt, /Latest status:/);
		assert.match(prompt, /Next tool action:/);
		assert.match(prompt, /Primary blocker\/risk:/);
		assert.match(prompt, /Stale branch to ignore:/);
		assert.match(prompt, /Do not invent/);
		assert.match(prompt, /Files modified/);
		assert.match(prompt, /\/repo\/src\/b.ts/);
		assert.match(prompt, /Artifact references/);
		assert.equal((prompt.match(/artifact:\/\/raw/g) ?? []).length, 2);
		assert.match(prompt, /Use Slipstream/);
		assert.match(prompt, /TASK-1:high:alpha\|shared\|gamma/);
		assert.match(prompt, /Latest compacted updates/);
		assert.match(prompt, /reserve gpt-5\.5 for manual checkpoints/);
		assert.match(
			prompt,
			/Retained-tail updates still visible after compaction/,
		);
		assert.match(prompt, /actually wait for user follow-up now/);
		assert.match(prompt, /current-state anchors/);
		assert.match(prompt, /Latest user\/assistant exchange state/);
		assert.match(prompt, /subsequent assistant response/);
		assert.match(prompt, /Terminal final-answer evidence/);
		assert.match(prompt, /Final verdict: wait for user follow-up/);
		assert.match(prompt, /override retained-tail truncation/);
		assert.match(prompt, /implementation checklist/);
		assert.match(prompt, /carry that content into Latest status/);
		assert.match(prompt, /Latest verification and risk signals/);
		assert.match(prompt, /verification_failure: npm test failed before repair/);
		assert.match(
			prompt,
			/Live\/manual\/browser\/API\/integration\/smoke validation/,
		);
		assert.match(
			prompt,
			/Passing unit\/lint\/typecheck evidence should be terse/,
		);
		assert.match(prompt, /Do not preserve full passing unit-test inventories/);
		assert.match(
			prompt,
			/Normalize ## Verification \/ Evidence into a compact table/,
		);
		assert.match(
			prompt,
			/final_delivered: Final audit answer was already sent/,
		);
		assert.match(prompt, /A final_delivered signal is a state lock/);
		assert.match(prompt, /Noise-control rule/);
		assert.match(prompt, /foreground only facts that affect the next decision/);
		assert.match(prompt, /decision-critical content/);
		assert.match(prompt, /salient risk bullets/);
		assert.match(prompt, /ordered safe-next-step checklist/);
		assert.match(prompt, /unrelated Pi\/config git status/);
		assert.match(prompt, /risk: git status came from wrapper CWD/);
		assert.match(prompt, /not a substitute for critical current-state facts/);
		assert.match(prompt, /active approved scope/);
		assert.match(prompt, /latest actionable ask/);
		assert.match(prompt, /Redact secret-shaped values/);
		assert.match(prompt, /auth\/cert\/key\/deletion\/deploy/);
		assert.match(prompt, /stale or superseded candidates/i);
		assert.match(
			prompt,
			/Historical user assertions from compacted-away messages/,
		);
		assert.match(prompt, /User assertion trail semantics/);
		assert.match(prompt, /user intent, scope, preferences, and corrections/);
		assert.match(prompt, /require fresh verification before acting/);
		assert.match(
			prompt,
			/validation must pair with summary prompt improvement/,
		);
	});

	it("includes state evidence as protected inputs", () => {
		const prompt = buildSummaryPrompt(snapshot, {
			stateEvidence: {
				generatedAt: "2026-05-27T00:00:00.000Z",
				cwd: "/repo",
				git: {
					available: true,
					statusShort: " M src/b.ts",
					diffStat: "src/b.ts | 2 +-",
					diff: "+STATE_EVIDENCE_SENTINEL",
					errors: [],
					fullDiffArtifactPaths: [
						"/repo/.scratch/compactions/run/git-diff-full-omitted.txt",
					],
					fullDiffComplete: false,
					fullDiffPreserved: false,
				},
				session: {
					filesRead: ["/repo/src/a.ts"],
					filesModified: ["/repo/src/b.ts"],
					filesDeleted: [],
					unresolvedErrors: ["edit failed"],
					userDecisions: ["Use Slipstream"],
					constraints: ["Must preserve comments"],
					openLoops: ["Need implementation"],
					recentVerification: ["npm test failed"],
					latestUpdates: ["reserve gpt-5.5 for manual checkpoints"],
					retainedTailUpdates: ["latest retained answer already sent"],
					latestExchangeState: [
						"Latest user request has a subsequent assistant response",
					],
					terminalFinalAnswerEvidence: [
						"Terminal latest assistant answer [a2] exact text:\nFinal verdict: state evidence should preserve terminal answer.",
					],
					latestSignals: [
						"verification_failure: npm test failed before repair",
					],
					staleSignals: [
						"npm test failed — Later evidence says npm test passed",
					],
					userAssertionTrail: [
						"[u-assert-1] correction_supersession/intent_scope/stale=low — User asserted: User corrected that validation must pair with summary prompt improvement, not stricter prompting alone. Evidence excerpt: Actually this is not just stricter prompting; validation has to be paired with the summary-prompt change.",
					],
					criticalLiterals: ["STATE_EVIDENCE_SENTINEL"],
				},
			},
		});

		assert.match(prompt, /State evidence bundle/);
		assert.match(prompt, /state evidence should preserve terminal answer/);
		assert.match(prompt, / M src\/b\.ts/);
		assert.match(prompt, /\+STATE_EVIDENCE_SENTINEL/);
		assert.match(prompt, /Full git diff recovery: partial/);
		assert.match(prompt, /rerun git diff/);
		assert.doesNotMatch(prompt, /Chunk evidence/);
		assert.match(prompt, /Session user assertion trail/);
		assert.match(
			prompt,
			/validation must pair with summary prompt improvement/,
		);
	});

	it("redacts secret-retrieval commands and env values from model prompts", () => {
		const prompt = buildSummaryPrompt(
			{
				...snapshot,
				summaryInputMessages: [
					"Run grep '^OPENWEBUI_ADMIN_PASSWORD=' .env | cut -d= -f2- | wl-copy before continuing.",
				],
				manifest: {
					...snapshot.manifest,
					latestUpdates: ["WEBUI_SECRET_KEY=dev-smoke-secret"],
					terminalFinalAnswerEvidence: [
						"Terminal latest assistant answer [a1] exact text:\nUse OPENWEBUI_ADMIN_PASSWORD=supersecretvalue to log in.",
					],
				},
			},
			{
				stateEvidence: {
					generatedAt: "2026-05-27T00:00:00.000Z",
					cwd: "/repo",
					git: {
						available: true,
						statusShort: "",
						diffStat: "",
						diff: "",
						errors: [],
					},
					session: {
						filesRead: [],
						filesModified: [],
						filesDeleted: [],
						unresolvedErrors: [
							"grep '^OPENWEBUI_ADMIN_PASSWORD=' .env | cut -d= -f2- | wl-copy",
						],
						userDecisions: [],
						constraints: [],
						openLoops: [],
						recentVerification: [],
						latestUpdates: ["WEBUI_SECRET_KEY=dev-smoke-secret"],
						retainedTailUpdates: [],
						latestExchangeState: [],
						terminalFinalAnswerEvidence: [],
						latestSignals: [],
						staleSignals: [],
						userAssertionTrail: [],
						criticalLiterals: [],
					},
				},
			},
		);

		assert.doesNotMatch(prompt, /wl-copy/);
		assert.doesNotMatch(prompt, /dev-smoke-secret/);
		assert.doesNotMatch(prompt, /supersecretvalue/);
		assert.match(prompt, /OPENWEBUI_ADMIN_PASSWORD=\[REDACTED\]/);
		assert.match(prompt, /WEBUI_SECRET_KEY=\[REDACTED\]/);
		assert.match(prompt, /\[REDACTED secret-retrieval command/);

		const judgePrompt = buildJudgePrompt({
			candidateSummary:
				"Continuation card:\n- Current task: Continue.\n\nOPENWEBUI_ADMIN_PASSWORD=supersecretvalue",
			snapshot,
			continuation: {
				turns: [
					{
						assistantText:
							"grep '^OPENWEBUI_ADMIN_PASSWORD=' .env | cut -d= -f2- | wl-copy",
						toolResults: [],
					},
				],
			},
		});
		assert.doesNotMatch(judgePrompt, /wl-copy/);
		assert.doesNotMatch(judgePrompt, /supersecretvalue/);
		assert.match(judgePrompt, /OPENWEBUI_ADMIN_PASSWORD=\[REDACTED\]/);

		const repairPrompt = buildRepairPrompt(
			"OPENWEBUI_ADMIN_PASSWORD=supersecretvalue",
			{
				score: 2,
				decision: "reject",
				missing: [],
				contradictions: [],
				diagnosis: "secret exposed",
			},
			{
				continuation: {
					triggerEntryId: "a1",
					turns: [
						{
							turnIndex: 1,
							assistantText:
								"grep '^OPENWEBUI_ADMIN_PASSWORD=' .env | cut -d= -f2- | wl-copy",
							toolResults: [],
						},
					],
				},
			},
		);
		assert.doesNotMatch(repairPrompt, /wl-copy/);
		assert.doesNotMatch(repairPrompt, /supersecretvalue/);
		assert.match(repairPrompt, /OPENWEBUI_ADMIN_PASSWORD=\[REDACTED\]/);
	});

	it("caps model-visible conversation text while preserving artifact-backed manifest", () => {
		const prompt = buildSummaryPrompt(
			{
				...snapshot,
				summaryInputMessages: [
					"A".repeat(100),
					"B".repeat(100),
					"C".repeat(100),
				],
			},
			{ maxConversationChars: 120 },
		);
		assert.match(prompt, /Slipstream omitted/);
		assert.match(prompt, /Full raw span is preserved in local artifacts/);
		assert.match(prompt, /artifact paths are not visible evidence/);
		assert.match(prompt, /mark stale or superseded history/);
		assert.match(prompt, /A{20}/);
		assert.match(prompt, /C{90}/);
		assert.match(prompt, /TASK-1:high:alpha\|shared\|gamma/);
	});

	it("caps total summary prompt size by reducing conversation budget", () => {
		const prompt = buildSummaryPrompt(
			{
				...snapshot,
				summaryInputMessages: ["A".repeat(300_000), "B".repeat(300_000)],
			},
			{ maxConversationChars: 500_000, maxPromptChars: 120_000 },
		);

		assert.equal(prompt.length < 150_000, true);
		assert.match(prompt, /Slipstream omitted/);
		assert.match(prompt, /TASK-1:high:alpha\|shared\|gamma/);
	});

	it("fails fast when fixed summary prompt sections exceed the prompt cap", () => {
		assert.throws(
			() =>
				buildSummaryPrompt(
					{
						...snapshot,
						manifest: {
							...snapshot.manifest,
							previousSummary: "P".repeat(20_000),
						},
						summaryInputMessages: ["conversation"],
					},
					{ maxPromptChars: 10_000 },
				),
			/summary prompt fixed sections exceed maxPromptChars/,
		);
	});

	it("parses strict and fenced judge JSON", () => {
		const parsed = parseJudgeResult(
			'{"score":8,"decision":"accept","currentState":7,"staleStateSuppression":6,"missing":[],"contradictions":[]}',
		);
		assert.equal(parsed.decision, "accept");
		assert.equal(parsed.judgeStatus, "parsed");
		assert.equal(parsed.currentState, 7);
		assert.equal(parsed.staleStateSuppression, 6);
		const contentReject = parseJudgeResult(
			'```json\n{"score":3,"decision":"reject","missing":["file"],"contradictions":[]}\n```',
		);
		assert.equal(contentReject.judgeStatus, "parsed");
		assert.equal(contentReject.missing[0], "file");
		const invalidShapeReject = parseJudgeResult("```json\n123\n```");
		assert.equal(invalidShapeReject.decision, "reject");
		assert.equal(invalidShapeReject.judgeStatus, "parsed");
		assert.equal(
			invalidShapeReject.diagnosis,
			"Judge response JSON did not match expected object shape",
		);
		const rawInvalidShapeReject = parseJudgeResult("123");
		assert.equal(rawInvalidShapeReject.judgeStatus, "parsed");
		assert.equal(
			rawInvalidShapeReject.diagnosis,
			"Judge response JSON did not match expected object shape",
		);
		const nullShapeReject = parseJudgeResult("null");
		assert.equal(nullShapeReject.judgeStatus, "parsed");
		const parseReject = parseJudgeResult("not json");
		assert.equal(parseReject.decision, "reject");
		assert.equal(parseReject.judgeStatus, "parse_error");
		assert.equal(parseReject.diagnosis, "Could not parse judge response");
	});

	it("does not let missing notes veto acceptance but still rejects critical contradictions", () => {
		assert.equal(
			isAccepted(
				{
					score: 8,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "",
				},
				7,
			),
			true,
		);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: ["/repo/src/b.ts"],
					contradictions: [],
					diagnosis: "",
				},
				7,
			),
			true,
		);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: [
						"Exact final contents of notes.md are not included, but this is not required for safe continuation.",
					],
					contradictions: [],
					diagnosis: "summary is sufficient",
				},
				7,
			),
			true,
		);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: [
						"Exact final contents are omitted, but artifact refs make recovery safe.",
					],
					contradictions: [],
					diagnosis: "judge returned an advisory omission",
				},
				7,
			),
			true,
		);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: [
						"A shorter command inventory would be nice-to-have, not acceptance-blocking.",
					],
					contradictions: [],
					diagnosis: "judge returned another advisory omission",
				},
				7,
			),
			true,
		);
		assert.equal(
			isAccepted(
				{
					score: 7,
					decision: "accept",
					missing: [],
					contradictions: [
						"Summary says no unresolved errors, while continuation evidence contains an intentional failing command. The addendum mitigates this by identifying it as intentional evidence.",
					],
					diagnosis: "sufficient to continue safely",
				},
				7,
			),
			true,
		);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [
						"This mismatch is not production-impacting and is mitigated by an explicit recheck.",
					],
					diagnosis:
						"advisory production note is not a hard-safety contradiction",
				},
				7,
			),
			true,
		);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [
						"The cert deletion status is contradictory but not acceptance-blocking because later text tells the next agent to recheck.",
					],
					diagnosis: "security-sensitive contradiction is mitigated",
				},
				7,
			),
			false,
		);
		for (const candidateSummary of [
			"Continuation card:\n- Primary blocker/risk: none\nSynthetic secret example: VALS_API_KEY=fake-redacted-placeholder-123456",
			'Continuation card:\n- Primary blocker/risk: none\nSynthetic secret example: OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz"',
			"Continuation card:\n- Primary blocker/risk: none\nSynthetic secret example: GITHUB_TOKEN='ghp_abcdefghijklmnopqrstuvwxyz'",
			'Continuation card:\n- Primary blocker/risk: none\nSynthetic secret example: bearer="abcdefghijklmnopqrstuvwxyz"',
			'Continuation card:\n- Primary blocker/risk: none\nSynthetic secret example: certificate="MIIFAKECERTDATA0123456789"',
			"Continuation card:\n- Primary blocker/risk: none\nSynthetic cert example:\n-----BEGIN CERTIFICATE-----\nMIIFAKECERTDATA0123456789\n-----END CERTIFICATE-----",
		]) {
			assert.equal(
				isAccepted(
					{
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "summary is sufficient",
					},
					7,
					candidateSummary,
				),
				false,
			);
		}
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [
						"Summary presents stale current state: npm test failed, but later evidence says npm test passed.",
					],
					diagnosis: "high fact recall but stale current state",
				},
				7,
			),
			false,
		);
		assert.equal(
			isAccepted(
				{
					score: 6,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "",
				},
				7,
			),
			false,
		);
	});

	it("bounds oversized continuation tool results in judge and repair prompts", () => {
		const hugeToolText = `${"A".repeat(120_000)}IMPORTANT_TAIL_SENTINEL`;
		const continuation = {
			triggerEntryId: "a-huge",
			turns: [
				{
					turnIndex: 1,
					assistantText: "Read the Retool app and verify the latest status.",
					toolResults: [
						{
							toolName: "retool_retool_read_react_app_files",
							toolCallId: "call-huge",
							isError: false,
							text: hugeToolText,
						},
					],
				},
			],
		};

		const judgePrompt = buildJudgePrompt(
			{
				candidateSummary: "summary",
				snapshot,
				continuation,
			},
			{ maxPromptChars: 80_000, continuationMaxChars: 6_000 },
		);
		const repairPrompt = buildRepairPrompt(
			"summary",
			{
				score: 0,
				decision: "reject",
				judgeStatus: "parse_error",
				missing: [],
				contradictions: [],
				diagnosis: "Could not parse judge response",
			},
			{ continuation },
			{ maxPromptChars: 80_000, continuationMaxChars: 6_000 },
		);

		for (const prompt of [judgePrompt, repairPrompt]) {
			assert.equal(prompt.length < 80_000, true);
			assert.match(prompt, /Tool result evidence is bounded/);
			assert.match(prompt, /retool_retool_read_react_app_files/);
			assert.match(prompt, /originalChars: 120023/);
			assert.match(prompt, /sha256: [a-f0-9]{64}/);
			assert.match(prompt, /IMPORTANT_TAIL_SENTINEL/);
			assert.doesNotMatch(prompt, /A{10000}/);
		}
	});

	it("omits continuation evidence when none mode is requested", () => {
		const continuation = {
			triggerEntryId: "a-short",
			turns: [
				{
					turnIndex: 1,
					assistantText: "short assistant text",
					toolResults: [],
				},
			],
		};

		const rendered = renderBoundedContinuationEvidence(continuation, {
			maxChars: 100,
			mode: "none",
		});

		assert.match(rendered, /Continuation evidence omitted/);
		assert.match(rendered, /turns: 1/);
		assert.doesNotMatch(rendered, /short assistant text/);
	});

	it("fails fast when fixed judge and repair prompt sections exceed the prompt cap", () => {
		assert.throws(
			() =>
				buildJudgePrompt(
					{
						candidateSummary: "S".repeat(20_000),
						snapshot,
						continuation: { turns: [] },
					},
					{ maxPromptChars: 10_000 },
				),
			/judge prompt fixed sections exceed maxPromptChars/,
		);
		assert.throws(
			() =>
				buildRepairPrompt(
					"S".repeat(20_000),
					{
						score: 0,
						decision: "reject",
						missing: [],
						contradictions: [],
						diagnosis: "too large",
					},
					{},
					{ maxPromptChars: 10_000 },
				),
			/repair prompt fixed sections exceed maxPromptChars/,
		);
	});

	it("judge prompt validates against continuation and manifest rather than task correctness", () => {
		const prompt = buildJudgePrompt({
			candidateSummary: "summary",
			snapshot,
			continuation: {
				turns: [{ turnIndex: 1, assistantText: "edited b", toolResults: [] }],
			},
		});
		assert.match(prompt, /continuation-quality reviewer/i);
		assert.match(prompt, /Do not judge whether the task solution is correct/i);
		assert.match(prompt, /Continuation evidence/);
		assert.match(prompt, /Protected critical literals/);
		assert.match(prompt, /Protected latest compacted updates/);
		assert.match(prompt, /Protected latest verification and risk signals/);
		assert.match(prompt, /verification_failure: npm test failed before repair/);
		assert.match(
			prompt,
			/Live\/manual\/browser\/API\/integration\/smoke validation outranks unit tests/,
		);
		assert.match(
			prompt,
			/Do not penalize summaries for omitting exact passing unit-test commands/,
		);
		assert.match(
			prompt,
			/attribute failing checks only when evidence supports it/,
		);
		assert.match(prompt, /Protected artifact references/);
		assert.match(prompt, /reserve gpt-5\.5 for manual checkpoints/);
		assert.match(prompt, /artifact:\/\/raw/);
		assert.match(prompt, /pointers only, not evidence substitutes/);
		assert.match(prompt, /what would the next agent get wrong/i);
		assert.match(prompt, /current-state, next-action, constraint/);
		assert.match(prompt, /stale\/superseded claims presented as current state/);
		assert.match(prompt, /repair-driving omissions/);
		assert.match(
			prompt,
			/unsafe, materially incomplete, or not production-ready/,
		);
		assert.match(prompt, /score 8 summaries may be accepted/);
		assert.match(
			prompt,
			/Compare the candidate summary against protected user assertions/,
		);
		assert.match(prompt, /omits high-value user intent/);
		assert.match(prompt, /revives stale user assertions as current work/);
		assert.match(prompt, /secret-shaped values/);
		assert.match(prompt, /auth, cert, key, deletion, or deploy state/);
		assert.match(prompt, /advisory, non-blocking improvements/);
		assert.match(prompt, /absent from the candidate summary text/);
		assert.match(prompt, /unresolved contradictions/);
	});

	it("judge treats raw git diff as writer-grounding, not protected evidence", () => {
		const prompt = buildJudgePrompt({
			candidateSummary: "summary",
			snapshot,
			continuation: { turns: [] },
			stateEvidence: {
				generatedAt: "2026-05-27T00:00:00.000Z",
				cwd: "/repo",
				git: {
					available: true,
					statusShort: " M src/b.ts",
					diffStat: "src/b.ts | 2 +-",
					diff: "+RAW_DIFF_ONLY_SENTINEL",
					errors: [],
				},
				session: {
					filesRead: [],
					filesModified: ["/repo/src/b.ts"],
					filesDeleted: [],
					unresolvedErrors: [],
					userDecisions: [],
					constraints: [],
					openLoops: [],
					recentVerification: [],
					latestUpdates: [],
					retainedTailUpdates: [],
					latestExchangeState: [],
					terminalFinalAnswerEvidence: [],
					latestSignals: [],
					staleSignals: [],
					criticalLiterals: [],
				},
			},
		});
		assert.match(prompt, /Protected distilled state evidence/);
		assert.match(prompt, /src\/b\.ts \| 2 \+-/);
		assert.doesNotMatch(prompt, /RAW_DIFF_ONLY_SENTINEL/);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: ["Missing raw git diff text for src/b.ts"],
					contradictions: [],
					diagnosis: "raw diff can be recovered from artifacts",
				},
				9,
			),
			true,
		);
	});

	it("builds a full rewrite repair prompt with protected context", () => {
		const prompt = buildRepairPrompt(
			"summary",
			{
				score: 3,
				decision: "reject",
				missing: ["x"],
				contradictions: ["stale claim"],
				diagnosis: "d",
			},
			{
				artifactRefs: ["artifact://repair"],
				continuation: {
					triggerEntryId: "a1",
					turns: [
						{
							turnIndex: 1,
							assistantText: "latest assistant update",
							toolResults: [],
						},
					],
				},
				stateEvidence: {
					generatedAt: "2026-05-27T00:00:00.000Z",
					cwd: "/repo",
					git: {
						available: true,
						statusShort: " M src/b.ts",
						diffStat: "src/b.ts | 2 +-",
						diff: "+RAW_DIFF_NOT_FOR_REPAIR_SENTINEL",
						errors: [],
						fullDiffArtifactPaths: ["artifact://git-diff-full-001.patch"],
					},
					session: {
						filesRead: [],
						filesModified: ["/repo/src/b.ts"],
						filesDeleted: [],
						unresolvedErrors: ["repair needs current failing test"],
						userDecisions: ["Use Slipstream"],
						constraints: ["Must preserve comments"],
						openLoops: ["Need implementation"],
						recentVerification: ["npm test failed"],
						latestUpdates: ["reserve gpt-5.5 for manual checkpoints"],
						retainedTailUpdates: ["latest assistant update"],
						latestExchangeState: [
							"Latest user request has a subsequent assistant response",
						],
						terminalFinalAnswerEvidence: [
							"Terminal latest assistant answer [a1] exact text:\nFinal verdict: repair must preserve current failing test risk.",
						],
						latestSignals: ["risk: repair needs current failing test"],
						staleSignals: ["old failure — later evidence passed"],
						userAssertionTrail: [
							"[u-assert-1] correction_supersession/intent_scope/stale=low — User asserted: User corrected that validation must pair with summary prompt improvement.",
						],
						criticalLiterals: ["E_RETRYABLE"],
					},
				},
			},
		);
		assert.match(
			prompt,
			/Rewrite the full summary into a clean revised checkpoint/i,
		);
		assert.match(prompt, /Do not append an addendum/i);
		assert.match(prompt, /Remove stale or superseded claims/i);
		assert.match(
			prompt,
			/Only the Continuation card and narrative sections are authoritative/,
		);
		assert.match(prompt, /raw\/historical evidence/);
		assert.match(prompt, /Redact secret-shaped values/);
		assert.match(prompt, /auth\/cert\/key\/deletion\/deploy/);
		assert.match(prompt, /model-facing handoff under roughly 100-150 lines/);
		assert.match(
			prompt,
			/Do not include both a verbatim terminal answer and a synthesized restatement/,
		);
		assert.match(prompt, /flatten copied markdown headings/);
		assert.match(prompt, /\| Check \| Status \| Freshness \| Relevance \|/);
		assert.match(prompt, /one active-file list/);
		assert.match(prompt, /## Trajectory Analysis/);
		assert.match(prompt, /## Session Findings/);
		assert.match(
			prompt,
			/exact heading "Continuation card:" as the first line/,
		);
		assert.match(
			prompt,
			/if your draft starts with ## Goal or any deterministic capsule/,
		);
		assert.match(prompt, /Next tool action:/);
		assert.match(prompt, /Stale branch to ignore:/);
		assert.match(prompt, /Protected repair context/i);
		assert.match(prompt, /Protected user assertions/);
		assert.match(prompt, /repair needs current failing test/);
		assert.match(prompt, /risk: repair needs current failing test/);
		assert.match(prompt, /repair must preserve current failing test risk/);
		assert.match(
			prompt,
			/Live\/manual\/browser\/API\/integration\/smoke validation/,
		);
		assert.match(prompt, /keep passing unit\/lint\/typecheck results terse/);
		assert.match(
			prompt,
			/caused by this session, pre-existing, superseded, or unknown/,
		);
		assert.match(
			prompt,
			/Normalize ## Verification \/ Evidence into a compact table/,
		);
		assert.match(prompt, /artifact:\/\/git-diff-full-001\.patch/);
		assert.match(prompt, /latest assistant update/);
		assert.doesNotMatch(prompt, /RAW_DIFF_NOT_FOR_REPAIR_SENTINEL/);
		assert.doesNotMatch(prompt, /Slipstream Repair Addendum/i);
	});
});
