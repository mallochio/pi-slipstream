import type { StateEvidenceBundle } from "./types.ts";

export function fullDiffRecoveryStatus(evidence: StateEvidenceBundle): string {
	if (evidence.git.fullDiffComplete === false)
		return "Full git diff recovery: partial; git diff collection reported errors, so rerun git diff from the repo before relying on patch details.";
	if (evidence.git.fullDiffPreserved === false)
		return "Full git diff recovery: unavailable; full diff was not preserved in artifacts, so rerun git diff from the repo if exact patch recovery is needed.";
	if (evidence.git.omittedDiffChars && evidence.git.omittedDiffChars > 0)
		return "Full git diff recovery: artifact-backed; bounded prompt diff omitted content, recover exact patch from full diff artifacts or rerun git diff.";
	return "Full git diff recovery: prompt diff complete for captured git output.";
}
