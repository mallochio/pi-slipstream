import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fullDiffRecoveryStatus } from "../src/diff-recovery.ts";
import type { StateEvidenceBundle } from "../src/types.ts";

function evidence(git: Partial<StateEvidenceBundle["git"]>): StateEvidenceBundle {
	return {
		generatedAt: "2026-06-13T00:00:00.000Z",
		cwd: "/repo",
		git: {
			available: true,
			statusShort: "",
			diffStat: "",
			diff: "",
			errors: [],
			...git,
		},
		session: {
			filesRead: [],
			filesModified: [],
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
	};
}

describe("full diff recovery status", () => {
	it("distinguishes partial, unavailable, artifact-backed, and complete states", () => {
		assert.match(
			fullDiffRecoveryStatus(
				evidence({ fullDiffComplete: false, fullDiffPreserved: false }),
			),
			/partial/,
		);
		assert.match(
			fullDiffRecoveryStatus(
				evidence({ fullDiffComplete: true, fullDiffPreserved: false }),
			),
			/unavailable/,
		);
		assert.match(
			fullDiffRecoveryStatus(
				evidence({ fullDiffComplete: true, fullDiffPreserved: true, omittedDiffChars: 10 }),
			),
			/artifact-backed/,
		);
		assert.match(
			fullDiffRecoveryStatus(
				evidence({ fullDiffComplete: true, fullDiffPreserved: true }),
			),
			/prompt diff complete/,
		);
	});
});
