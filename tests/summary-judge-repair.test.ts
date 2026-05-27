import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildJudgePrompt,
	isAccepted,
	parseJudgeResult,
} from "../src/judge.ts";
import { buildRepairPrompt } from "../src/repair.ts";
import {
	buildCurrentStateCapsule,
	buildSummaryPrompt,
	withCurrentStateCapsule,
} from "../src/summary.ts";
import type { Snapshot } from "../src/types.ts";

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
		criticalLiterals: ["TASK-1:high:alpha|shared|gamma", "E_RETRYABLE"],
		previousSummary: "older",
		artifactRefs: ["artifact://raw"],
		knownFileRefs: new Set(["/repo/src/a.ts", "/repo/src/b.ts"]),
	},
};

describe("summary, judge, and repair", () => {
	it("prepends a deterministic current-state capsule before model prose", () => {
		const capsule = buildCurrentStateCapsule(snapshot, ["artifact://new"]);
		const summary = withCurrentStateCapsule(
			"## Goal\nContinue safely",
			snapshot,
			["artifact://new"],
		);

		assert.match(capsule, /Latest user\/assistant exchange state/);
		assert.match(capsule, /Terminal latest assistant answer/);
		assert.match(capsule, /npm test failed before repair/);
		assert.match(capsule, /Use Slipstream/);
		assert.match(capsule, /modified: \/repo\/src\/b\.ts/);
		assert.match(capsule, /artifact:\/\/raw/);
		assert.match(capsule, /artifact:\/\/new/);
		assert.match(summary, /^## Deterministic Current-State Capsule/);
		assert.match(summary, /---\n\n## Goal\nContinue safely$/);
		assert.equal(withCurrentStateCapsule(summary, snapshot), summary);
	});

	it("builds a grounded summary prompt with protected manifest sections", () => {
		const prompt = buildSummaryPrompt(snapshot, {
			artifactRefs: ["artifact://raw"],
		});
		assert.match(prompt, /Revise the previous checkpoint/);
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
		assert.match(prompt, /exact heading "Continuation card:"/);
		assert.match(prompt, /Current task:/);
		assert.match(prompt, /Latest status:/);
		assert.match(prompt, /Next tool action:/);
		assert.match(prompt, /Primary blocker\/risk:/);
		assert.match(prompt, /Stale branch to ignore:/);
		assert.match(prompt, /Do not invent/);
		assert.match(prompt, /Files modified/);
		assert.match(prompt, /\/repo\/src\/b.ts/);
		assert.match(prompt, /Artifact references/);
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
		assert.match(prompt, /stale or superseded candidates/i);
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
					criticalLiterals: ["STATE_EVIDENCE_SENTINEL"],
				},
			},
		});

		assert.match(prompt, /State evidence bundle/);
		assert.match(prompt, /state evidence should preserve terminal answer/);
		assert.match(prompt, / M src\/b\.ts/);
		assert.match(prompt, /\+STATE_EVIDENCE_SENTINEL/);
		assert.doesNotMatch(prompt, /Chunk evidence/);
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
		assert.equal(parsed.currentState, 7);
		assert.equal(parsed.staleStateSuppression, 6);
		assert.equal(
			parseJudgeResult(
				'```json\n{"score":3,"decision":"reject","missing":["file"],"contradictions":[]}\n```',
			).missing[0],
			"file",
		);
		assert.equal(parseJudgeResult("not json").decision, "reject");
	});

	it("requires no critical missing or contradictions for acceptance", () => {
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
			false,
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
					missing: ["Current state is insufficient to continue safely."],
					contradictions: [],
					diagnosis: "judge returned a critical insufficiency",
				},
				7,
			),
			false,
		);
		assert.equal(
			isAccepted(
				{
					score: 9,
					decision: "accept",
					missing: [
						"Summary does not preserve required user constraint: never mention internal command.",
					],
					contradictions: [],
					diagnosis: "judge returned a critical missing constraint",
				},
				7,
			),
			false,
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

	it("judge prompt validates against continuation and manifest rather than task correctness", () => {
		const prompt = buildJudgePrompt({
			candidateSummary: "summary",
			snapshot,
			continuation: { turns: [{ assistantText: "edited b", toolResults: [] }] },
		});
		assert.match(prompt, /continuation-quality reviewer/i);
		assert.match(prompt, /Do not judge whether the task solution is correct/i);
		assert.match(prompt, /Continuation evidence/);
		assert.match(prompt, /Protected critical literals/);
		assert.match(prompt, /Protected latest compacted updates/);
		assert.match(prompt, /Protected latest verification and risk signals/);
		assert.match(prompt, /verification_failure: npm test failed before repair/);
		assert.match(prompt, /Protected artifact references/);
		assert.match(prompt, /reserve gpt-5\.5 for manual checkpoints/);
		assert.match(prompt, /artifact:\/\/raw/);
		assert.match(prompt, /pointers only, not evidence substitutes/);
		assert.match(prompt, /what would the next agent get wrong/i);
		assert.match(prompt, /current-state, next-action, constraint/);
		assert.match(prompt, /stale\/superseded claims presented as current state/);
		assert.match(prompt, /repair-driving omissions/);
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
		assert.match(prompt, /## Trajectory Analysis/);
		assert.match(prompt, /## Session Findings/);
		assert.match(prompt, /exact heading "Continuation card:"/);
		assert.match(prompt, /Next tool action:/);
		assert.match(prompt, /Stale branch to ignore:/);
		assert.match(prompt, /Protected repair context/i);
		assert.match(prompt, /repair needs current failing test/);
		assert.match(prompt, /risk: repair needs current failing test/);
		assert.match(prompt, /repair must preserve current failing test risk/);
		assert.match(prompt, /artifact:\/\/git-diff-full-001\.patch/);
		assert.match(prompt, /latest assistant update/);
		assert.doesNotMatch(prompt, /RAW_DIFF_NOT_FOR_REPAIR_SENTINEL/);
		assert.doesNotMatch(prompt, /Slipstream Repair Addendum/i);
	});
});
