import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	collectStateEvidence,
	collectStateEvidenceWithRaw,
} from "../src/state-evidence.ts";
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
		userDecisions: [{ text: "Use state evidence", entryId: "u1" }],
		constraints: [{ text: "Do not mutate git", entryId: "u1" }],
		openLoops: [
			{ summary: "Need verification", entryId: "u1", priority: "high" },
		],
		recentVerification: ["npm test failed"],
		latestUpdates: ["Latest: implement state evidence first"],
		retainedTailUpdates: ["[Assistant a2]: Final answer already sent"],
		latestExchangeState: [
			"Latest user request has a subsequent assistant response: [assistant a2]: Final answer already sent",
		],
		terminalFinalAnswerEvidence: [
			"Terminal latest assistant answer [a2] exact text:\nFinal answer already sent. Risk: keep root dirty-state caveat.",
		],
		latestSignals: [
			{
				kind: "verification_failure",
				text: "npm test failed",
				entryId: "b1",
			},
		],
		staleSignals: [],
		userAssertionTrail: [
			{
				entryId: "u-assert-1",
				kind: "approval_scope",
				authority: "intent_scope",
				userAsserted: "User approved internal-only state evidence changes.",
				evidenceExcerpt: "ok, do the internal-only state evidence change",
				staleRisk: "low",
			},
		],
		criticalLiterals: ["STATE_EVIDENCE_SENTINEL"],
		previousSummary: "older",
		artifactRefs: [],
		knownFileRefs: new Set(["/repo/src/a.ts", "/repo/src/b.ts"]),
	},
};

describe("state evidence", () => {
	it("collects session manifest facts and read-only git evidence", async () => {
		const calls: string[][] = [];
		const evidence = await collectStateEvidence({
			snapshot,
			cwd: "/repo",
			executeGit: async (args) => {
				calls.push(args);
				if (args.includes("status"))
					return { stdout: " M src/b.ts\n", stderr: "" };
				if (args.includes("--stat"))
					return { stdout: " src/b.ts | 2 +-\n", stderr: "" };
				return {
					stdout:
						"diff --git a/src/b.ts b/src/b.ts\n+STATE_EVIDENCE_SENTINEL\n",
					stderr: "",
				};
			},
		});

		assert.deepEqual(calls, [
			["status", "--short"],
			["diff", "--no-ext-diff", "--stat", "--"],
			["diff", "--no-ext-diff", "-U20", "--"],
		]);
		assert.equal(evidence.git.available, true);
		assert.match(evidence.git.statusShort, /src\/b\.ts/);
		assert.match(evidence.git.diff, /STATE_EVIDENCE_SENTINEL/);
		assert.deepEqual(evidence.session.filesModified, ["/repo/src/b.ts"]);
		assert.deepEqual(evidence.session.recentVerification, ["npm test failed"]);
		assert.deepEqual(evidence.session.terminalFinalAnswerEvidence, [
			"Terminal latest assistant answer [a2] exact text:\nFinal answer already sent. Risk: keep root dirty-state caveat.",
		]);
		assert.deepEqual(evidence.session.latestSignals, [
			"verification_failure: npm test failed",
		]);
		assert.deepEqual(evidence.session.userAssertionTrail, [
			"[u-assert-1] approval_scope/intent_scope/stale=low — User asserted: User approved internal-only state evidence changes. Evidence excerpt: ok, do the internal-only state evidence change",
		]);
		assert.deepEqual(evidence.session.criticalLiterals, [
			"STATE_EVIDENCE_SENTINEL",
		]);
	});

	it("returns raw full diff separately from bounded prompt evidence", async () => {
		const fullDiff = `diff --git a/src/b.ts b/src/b.ts\n${"+FULL_DIFF_SENTINEL\n".repeat(20)}`;
		const collected = await collectStateEvidenceWithRaw({
			snapshot,
			cwd: "/repo",
			maxGitDiffChars: 80,
			executeGit: async (args) => {
				if (args.includes("status"))
					return { stdout: " M src/b.ts\n", stderr: "" };
				if (args.includes("--stat"))
					return { stdout: " src/b.ts | 2 +-\n", stderr: "" };
				return { stdout: fullDiff, stderr: "" };
			},
		});

		assert.equal(collected.rawGit.fullDiff, fullDiff);
		const fullDiffSha256 = collected.evidence.git.fullDiffSha256;
		assert.ok(fullDiffSha256);
		assert.equal(fullDiffSha256.length, 64);
		assert.equal(
			collected.evidence.git.fullDiffBytes,
			Buffer.byteLength(fullDiff),
		);
		assert.match(collected.evidence.git.diff, /Slipstream omitted/);
	});

	it("marks full diff incomplete when git reports a diff collection error", async () => {
		const collected = await collectStateEvidenceWithRaw({
			snapshot,
			cwd: "/repo",
			executeGit: async (args) => {
				if (args.includes("status"))
					return { stdout: " M src/b.ts\n", stderr: "" };
				if (args.includes("--stat"))
					return { stdout: " src/b.ts | 2 +-\n", stderr: "" };
				return {
					stdout: "partial diff",
					stderr: "stdout maxBuffer length exceeded",
				};
			},
		});

		assert.equal(collected.rawGit.fullDiffComplete, false);
		assert.equal(collected.evidence.git.fullDiffComplete, false);
		assert.match(collected.evidence.git.errors.join("\n"), /maxBuffer/);
	});

	it("records git unavailability without failing compaction", async () => {
		const evidence = await collectStateEvidence({
			snapshot,
			cwd: "/repo",
			executeGit: async () => {
				throw new Error("not a git repository");
			},
		});

		assert.equal(evidence.git.available, false);
		assert.match(evidence.git.errors.join("\n"), /not a git repository/);
		assert.deepEqual(evidence.session.filesRead, ["/repo/src/a.ts"]);
	});
});
