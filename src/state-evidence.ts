import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type {
	Snapshot,
	StateEvidenceBundle,
	UserAssertionTrailEntry,
} from "./types.ts";

export type GitExecutionResult = { stdout: string; stderr: string };
export type ExecuteGitFn = (
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
) => Promise<GitExecutionResult>;

export type CollectStateEvidenceInput = {
	snapshot: Snapshot;
	cwd: string;
	now?: () => Date;
	executeGit?: ExecuteGitFn;
	signal?: AbortSignal;
	maxGitDiffChars?: number;
};

export type RawGitEvidence = {
	statusShort: string;
	diffStat: string;
	fullDiff: string;
	fullDiffComplete: boolean;
};

export type CollectedStateEvidence = {
	evidence: StateEvidenceBundle;
	rawGit: RawGitEvidence;
};

const DEFAULT_MAX_GIT_DIFF_CHARS = 180_000;

function defaultExecuteGit(
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): Promise<GitExecutionResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd: options.cwd,
				timeout: 2_500,
				maxBuffer: 512 * 1024,
				signal: options.signal,
			},
			(error, stdout, stderr) => {
				if (error) {
					resolve({ stdout, stderr: stderr || error.message });
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function boundText(
	text: string,
	maxChars: number,
): { text: string; omitted: number } {
	if (text.length <= maxChars) return { text, omitted: 0 };
	const headChars = Math.floor(maxChars * 0.35);
	const tailChars = maxChars - headChars;
	const omitted = text.length - maxChars;
	return {
		text: `${text.slice(0, headChars)}\n\n[... Slipstream omitted ${omitted.toLocaleString()} characters from the middle of read-only git diff evidence. Full diff should be recovered with git diff if needed. ...]\n\n${text.slice(-tailChars)}`,
		omitted,
	};
}

function renderUserAssertionTrailEntry(entry: UserAssertionTrailEntry): string {
	const stale = entry.staleReason ? ` (${entry.staleReason})` : "";
	const superseded = entry.supersededByEntryId
		? ` Superseded by: ${entry.supersededByEntryId}.`
		: "";
	return `[${entry.entryId}] ${entry.kind}/${entry.authority}/stale=${entry.staleRisk} — User asserted: ${entry.userAsserted} Evidence excerpt: ${entry.evidenceExcerpt}${stale}${superseded}`;
}

function sessionEvidence(snapshot: Snapshot): StateEvidenceBundle["session"] {
	const manifest = snapshot.manifest;
	return {
		filesRead: manifest.filesRead,
		filesModified: manifest.filesModified,
		filesDeleted: manifest.filesDeleted,
		unresolvedErrors: manifest.errors
			.filter((error) => error.unresolved)
			.map((error) => error.message),
		userDecisions: manifest.userDecisions.map((decision) => decision.text),
		constraints: manifest.constraints.map((constraint) => constraint.text),
		openLoops: manifest.openLoops.map((loop) => loop.summary),
		recentVerification: manifest.recentVerification,
		latestUpdates: manifest.latestUpdates,
		retainedTailUpdates: manifest.retainedTailUpdates,
		latestExchangeState: manifest.latestExchangeState,
		terminalFinalAnswerEvidence: manifest.terminalFinalAnswerEvidence,
		latestSignals: manifest.latestSignals.map(
			(signal) => `${signal.kind}: ${signal.text}`,
		),
		staleSignals: manifest.staleSignals.map(
			(signal) => `${signal.text} — ${signal.reason}`,
		),
		userAssertionTrail: manifest.userAssertionTrail.map(
			renderUserAssertionTrailEntry,
		),
		criticalLiterals: manifest.criticalLiterals,
	};
}

async function gitStep(
	executeGit: ExecuteGitFn,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<GitExecutionResult> {
	try {
		return await executeGit(args, { cwd, signal });
	} catch (error) {
		return {
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function collectStateEvidenceWithRaw(
	input: CollectStateEvidenceInput,
): Promise<CollectedStateEvidence> {
	const executeGit = input.executeGit ?? defaultExecuteGit;
	const errors: string[] = [];
	const status = await gitStep(
		executeGit,
		["status", "--short"],
		input.cwd,
		input.signal,
	);
	if (status.stderr.trim())
		errors.push(`git status --short: ${status.stderr.trim()}`);

	const diffStat = await gitStep(
		executeGit,
		["diff", "--no-ext-diff", "--stat", "--"],
		input.cwd,
		input.signal,
	);
	if (diffStat.stderr.trim())
		errors.push(`git diff --no-ext-diff --stat --: ${diffStat.stderr.trim()}`);

	const diff = await gitStep(
		executeGit,
		["diff", "--no-ext-diff", "-U20", "--"],
		input.cwd,
		input.signal,
	);
	if (diff.stderr.trim())
		errors.push(`git diff --no-ext-diff -U20 --: ${diff.stderr.trim()}`);
	const boundedDiff = boundText(
		diff.stdout,
		input.maxGitDiffChars ?? DEFAULT_MAX_GIT_DIFF_CHARS,
	);

	const fullDiff = diff.stdout;
	const fullDiffComplete = diff.stderr.trim() === "";
	const evidence: StateEvidenceBundle = {
		generatedAt: (input.now?.() ?? new Date()).toISOString(),
		cwd: input.cwd,
		git: {
			available: errors.length === 0,
			statusShort: status.stdout.trimEnd(),
			diffStat: diffStat.stdout.trimEnd(),
			diff: boundedDiff.text.trimEnd(),
			errors,
			fullDiffSha256: sha256(fullDiff),
			fullDiffBytes: Buffer.byteLength(fullDiff),
			fullDiffComplete,
			...(boundedDiff.omitted > 0
				? { omittedDiffChars: boundedDiff.omitted }
				: {}),
		},
		session: sessionEvidence(input.snapshot),
	};
	return {
		evidence,
		rawGit: {
			statusShort: status.stdout,
			diffStat: diffStat.stdout,
			fullDiff,
			fullDiffComplete,
		},
	};
}

export async function collectStateEvidence(
	input: CollectStateEvidenceInput,
): Promise<StateEvidenceBundle> {
	return (await collectStateEvidenceWithRaw(input)).evidence;
}
