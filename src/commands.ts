import {
	access,
	readFile,
	readdir,
	realpath,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import {
	parseCommandArgs,
	type RejectedSummaryMode,
	type SlipstreamConfig,
} from "./config.ts";
import { buildContinuationFromBranch } from "./continuation.ts";
import { createJudgeCompleter, createSummaryCompleter } from "./model.ts";
import { sanitizePart } from "./artifact-store.ts";
import {
	runSlipstreamDryRun,
	runValidatedSlipstream,
	type ValidatedRunResult,
} from "./pipeline.ts";
import {
	adoptPending,
	storePendingValidated,
	type CompactCapableContext,
} from "./session-state.ts";
import type {
	CompleteJudgeFn,
	CompleteTextFn,
	ContextUsageSnapshot,
	ProgressEvent,
	ProgressSink,
	PendingValidatedCompaction,
	RuntimeState,
	SessionEntry,
} from "./types.ts";
import { formatElapsed, updateSlipstreamWidget } from "./ui.ts";

export type CommandResult = { ok: boolean; message: string };
export type CommandDeps = {
	createSummaryCompleter?: (
		ctx: {
			model?: { provider: string; id: string };
			modelRegistry: NonNullable<NotifyContext["modelRegistry"]>;
		},
		configuredModel?: string,
	) => CompleteTextFn;
	createJudgeCompleter?: (
		ctx: {
			model?: { provider: string; id: string };
			modelRegistry: NonNullable<NotifyContext["modelRegistry"]>;
		},
		configuredModel?: string,
	) => CompleteJudgeFn;
	now?: () => number;
};

const DEFAULT_COMMAND_DEPS: Required<CommandDeps> = {
	createSummaryCompleter,
	createJudgeCompleter,
	now: () => Date.now(),
};

function ignoreStaleContextError(error: unknown): void {
	if (
		error instanceof Error &&
		error.message.includes("extension ctx is stale")
	)
		return;
	throw error;
}

type ManagedProgressSink = ProgressSink & { clear(): void };

function makeProgressSink(
	ctx: NotifyContext,
	state: RuntimeState,
	config: SlipstreamConfig,
): ManagedProgressSink {
	let current: ProgressEvent | null = null;
	let phaseStartedAt = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;
	const clear = (): void => {
		if (timer) clearInterval(timer);
		timer = null;
	};
	const render = (): void => {
		if (!current) return;
		const event = { ...current, elapsedMs: Date.now() - phaseStartedAt };
		try {
			ctx.ui?.setStatus?.(
				"slipstream",
				`Slipstream: ${event.message} (${formatElapsed(event.elapsedMs)})`,
			);
			updateSlipstreamWidget(ctx, state, config, { progress: event });
		} catch (error) {
			ignoreStaleContextError(error);
		}
	};
	const sink = ((event: ProgressEvent): void => {
		if (!current || current.phase !== event.phase) phaseStartedAt = Date.now();
		current = event;
		render();
		if (event.phase === "accepted" || event.phase === "rejected") {
			clear();
			return;
		}
		if (!timer) timer = setInterval(render, 1_000);
	}) as ManagedProgressSink;
	sink.clear = clear;
	return sink;
}

function persistentStatusText(state: RuntimeState): string {
	if (state.status === "ready_to_adopt") return "slipstream: pending";
	if (state.status === "awaiting_continuation")
		return "slipstream: awaiting continuation";
	if (state.status === "summarizing") return "slipstream: compacting";
	if (state.status === "finalizing_summary")
		return "slipstream: waiting for auto summary";
	if (state.status === "judging" || state.status === "repairing")
		return `slipstream: ${state.status}`;
	return "slipstream: manual";
}

function restorePersistentStatus(
	ctx: NotifyContext,
	state: RuntimeState,
	config: SlipstreamConfig,
): void {
	try {
		ctx.ui?.setStatus?.("slipstream", persistentStatusText(state));
		updateSlipstreamWidget(ctx, state, config);
	} catch (error) {
		ignoreStaleContextError(error);
	}
}

export type ManualAcceptContext = {
	ui?: {
		select?(
			title: string,
			options: string[],
			config?: { timeout?: number; signal?: AbortSignal },
		): string | undefined | Promise<string | undefined>;
		confirm?(
			title: string,
			message: string,
			options?: { timeout?: number; signal?: AbortSignal },
		): boolean | Promise<boolean>;
	};
};

type NotifyContext = ManualAcceptContext & {
	ui?: ManualAcceptContext["ui"] & {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, text: string | undefined): void;
		setWidget?(
			key: string,
			lines: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
	compact?: CompactCapableContext["compact"];
	cwd?: string;
	model?: { provider: string; id: string };
	modelRegistry?: {
		find(
			provider: string,
			id: string,
		): { provider: string; id: string } | undefined;
		getApiKeyAndHeaders(model: { provider: string; id: string }): Promise<{
			ok?: boolean;
			error?: string;
			apiKey?: string;
			headers?: Record<string, string>;
		}>;
	};
	sessionManager?: { getBranch(): SessionEntry[]; getSessionId?(): string };
	getContextUsage?(): ContextUsageSnapshot;
	signal?: AbortSignal;
};

export function buildStatusText(state: RuntimeState): string {
	if (state.pending) {
		const judge = state.pending.details.judge as
			| { score?: number; diagnosis?: string }
			| undefined;
		const artifacts = state.pending.details.artifacts;
		const artifactText = Array.isArray(artifacts)
			? artifacts.join(", ")
			: "none";
		return `Slipstream status: pending validated summary, score ${judge?.score ?? "?"}, diagnosis ${judge?.diagnosis ?? "n/a"}, artifacts ${artifactText}`;
	}
	return `Slipstream status: ${state.status}`;
}

function withRestoredStatusCallbacks(
	state: RuntimeState,
	ctx: NotifyContext & { compact: CompactCapableContext["compact"] },
	config: SlipstreamConfig,
): CompactCapableContext {
	return {
		compact: (options) => {
			ctx.compact({
				...options,
				onComplete: (result) => {
					try {
						options?.onComplete?.(result);
					} finally {
						restorePersistentStatus(ctx, state, config);
					}
				},
				onError: (error) => {
					try {
						options?.onError?.(error);
					} finally {
						restorePersistentStatus(ctx, state, config);
					}
				},
			});
		},
	};
}

export function handleAdoptCommand(
	state: RuntimeState,
	ctx: CompactCapableContext,
	now = Date.now(),
	sessionId?: string,
	cwd?: string,
): CommandResult {
	const adopted = adoptPending(state, ctx, { now, sessionId, cwd });
	if (!adopted)
		return {
			ok: false,
			message:
				"No unexpired validated Slipstream summary is pending for this session.",
		};
	return {
		ok: true,
		message: "Queued compaction with validated Slipstream summary.",
	};
}

function summaryPreview(summary: string): string {
	const trimmed = summary.trim();
	const maxChars = 4_000;
	if (trimmed.length <= maxChars) return trimmed || "[empty summary]";
	return `${trimmed.slice(0, maxChars)}\n\n[summary preview truncated; full summary is stored in artifacts]`;
}

export function rejectedSummaryDecisionText(
	result: ValidatedRunResult,
): string {
	const missing = result.judge.missing.length
		? result.judge.missing.map((item) => `- ${item}`).join("\n")
		: "- None";
	const contradictions = result.judge.contradictions.length
		? result.judge.contradictions.map((item) => `- ${item}`).join("\n")
		: "- None";
	return `Slipstream rejected the summary after all repair attempts.\n\nScore: ${result.judge.score}/10\nDecision: ${result.judge.decision}\nDiagnosis: ${result.judge.diagnosis || "n/a"}\nArtifacts: ${result.artifactDir}\n\nMissing:\n${missing}\n\nContradictions:\n${contradictions}\n\nCompaction summary preview:\n\n${summaryPreview(result.summary)}\n\nAccept this rejected summary anyway?`;
}

function rejectedSummarySelectText(result: ValidatedRunResult): string {
	const missing = result.judge.missing.length
		? result.judge.missing.map((item) => `- ${item}`).join("\n")
		: "- None";
	const contradictions = result.judge.contradictions.length
		? result.judge.contradictions.map((item) => `- ${item}`).join("\n")
		: "- None";
	return `Accept rejected Slipstream summary?\n\nScore: ${result.judge.score}/10\nDecision: ${result.judge.decision}\nDiagnosis: ${result.judge.diagnosis || "n/a"}\nArtifacts: ${result.artifactDir}\n\nMissing:\n${missing}\n\nContradictions:\n${contradictions}\n\nFull summary is stored in artifacts. Accept anyway?`;
}

export type RejectedSummaryAcceptance = {
	accepted: boolean;
	confirmed: boolean;
	mode: RejectedSummaryMode;
};

export async function acceptRejectedSummaryByPolicy(
	ctx: ManualAcceptContext,
	result: ValidatedRunResult,
	mode: RejectedSummaryMode,
): Promise<RejectedSummaryAcceptance> {
	if (mode === "accept") return { accepted: true, confirmed: false, mode };
	if (mode === "reject") return { accepted: false, confirmed: false, mode };
	const title = `Accept rejected Slipstream summary? Score ${result.judge.score}/10`;
	const message = rejectedSummaryDecisionText(result);
	if (ctx.ui?.select) {
		const selection = await ctx.ui.select(
			rejectedSummarySelectText(result),
			["Accept", "Reject"],
			{ timeout: 120_000 },
		);
		return {
			accepted: selection !== "Reject",
			confirmed: selection === "Accept",
			mode,
		};
	}
	if (!ctx.ui?.confirm) return { accepted: true, confirmed: false, mode };
	const confirmed = await ctx.ui.confirm(title, message, { timeout: 120_000 });
	return { accepted: confirmed !== false, confirmed: confirmed === true, mode };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

async function realPathForContainment(path: string): Promise<string> {
	let existing = resolve(path);
	const missingParts: string[] = [];
	while (!(await pathExists(existing))) {
		const parent = dirname(existing);
		if (parent === existing) break;
		missingParts.unshift(basename(existing));
		existing = parent;
	}
	const realExisting = (await pathExists(existing))
		? await realpath(existing)
		: existing;
	return missingParts.length
		? resolve(realExisting, ...missingParts)
		: realExisting;
}

export async function resolveArtifactRoot(
	cwd: string,
	artifactRoot: string,
): Promise<string> {
	const root = resolve(cwd);
	const resolved = isAbsolute(artifactRoot)
		? resolve(artifactRoot)
		: resolve(root, artifactRoot);
	const realRoot = await realPathForContainment(root);
	const realResolved = await realPathForContainment(resolved);
	const rel = relative(realRoot, realResolved);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
		return resolved;
	throw new Error(
		`artifactRoot must resolve inside the current project directory: ${artifactRoot}`,
	);
}

const PENDING_ARTIFACT_NAME = "pending.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePendingArtifact(
	value: unknown,
): PendingValidatedCompaction | null {
	if (!isRecord(value) || !isRecord(value.details)) return null;
	const {
		sessionId,
		cwd,
		projectId,
		summary,
		firstKeptEntryId,
		validatedThroughEntryId,
		tokensBefore,
		expiresAt,
		details,
	} = value;
	if (
		typeof sessionId !== "string" ||
		typeof cwd !== "string" ||
		typeof projectId !== "string" ||
		typeof summary !== "string" ||
		typeof firstKeptEntryId !== "string" ||
		(typeof validatedThroughEntryId !== "string" &&
			validatedThroughEntryId !== null) ||
		(typeof tokensBefore !== "number" && tokensBefore !== null) ||
		typeof expiresAt !== "number"
	)
		return null;
	return {
		sessionId,
		cwd,
		projectId,
		summary,
		firstKeptEntryId,
		validatedThroughEntryId,
		tokensBefore,
		details,
		expiresAt,
	};
}

function createPendingValidatedCompaction({
	sessionId,
	cwd,
	result,
	rejectedAcceptance,
	expiresAt,
	validatedThroughEntryId,
	revalidatedFromEntryId,
}: {
	sessionId: string;
	cwd: string;
	result: ValidatedRunResult;
	rejectedAcceptance: RejectedSummaryAcceptance | null;
	expiresAt: number;
	validatedThroughEntryId: string | null;
	revalidatedFromEntryId?: string | null;
}): PendingValidatedCompaction {
	const details: Record<string, unknown> = {
		judge: result.judge,
		artifacts: [result.artifactDir],
		repaired: result.repaired,
		manualOverride: rejectedAcceptance?.confirmed ?? false,
		rejectedSummaryAccepted: !result.accepted,
		rejectedSummaryMode: rejectedAcceptance?.mode,
	};
	if (revalidatedFromEntryId !== undefined)
		details.revalidatedFromEntryId = revalidatedFromEntryId;
	return {
		sessionId,
		cwd,
		projectId: cwd,
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId ?? "",
		validatedThroughEntryId,
		tokensBefore: result.tokensBefore,
		details,
		expiresAt,
	};
}

export async function persistPendingArtifact(
	artifactDir: string,
	pending: PendingValidatedCompaction,
): Promise<void> {
	const path = join(artifactDir, PENDING_ARTIFACT_NAME);
	try {
		await writeFile(path, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
	} catch (error) {
		throw new Error(
			`Failed to persist pending Slipstream artifact at ${path}`,
			{
				cause: error,
			},
		);
	}
}

export async function clearPendingArtifact(
	pending: PendingValidatedCompaction,
): Promise<void> {
	const artifact = pending.details.artifacts;
	if (!Array.isArray(artifact) || typeof artifact[0] !== "string") return;
	const projectRoot = await realPathForContainment(pending.projectId);
	const artifactDir = await realPathForContainment(resolve(artifact[0]));
	const rel = relative(projectRoot, artifactDir);
	if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return;
	const path = join(artifactDir, PENDING_ARTIFACT_NAME);
	try {
		await unlink(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
		throw new Error(`Failed to clear pending Slipstream artifact at ${path}`, {
			cause: error,
		});
	}
}

export async function recoverPendingArtifact(
	artifactRoot: string,
	sessionId: string,
	cwd: string,
	now: number,
	pendingTtlMs: number,
): Promise<PendingValidatedCompaction | null> {
	if (!(await pathExists(artifactRoot))) return null;
	let entries;
	try {
		entries = await readdir(artifactRoot, { withFileTypes: true });
	} catch (error) {
		throw new Error(
			`Failed to scan pending Slipstream artifacts in ${artifactRoot}`,
			{ cause: error },
		);
	}
	const sessionPrefix = `${sanitizePart(sessionId)}-`;
	const candidates = entries
		.filter(
			(entry) => entry.isDirectory() && entry.name.startsWith(sessionPrefix),
		)
		.map((entry) => join(artifactRoot, entry.name, PENDING_ARTIFACT_NAME));
	let newest: PendingValidatedCompaction | null = null;
	for (const candidate of candidates) {
		let raw: string;
		try {
			raw = await readFile(candidate, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				continue;
			throw new Error(
				`Failed to read pending Slipstream artifact ${candidate}`,
				{
					cause: error,
				},
			);
		}
		let pending: PendingValidatedCompaction | null = null;
		try {
			pending = parsePendingArtifact(JSON.parse(raw));
		} catch {
			continue;
		}
		if (!pending) continue;
		if (
			pending.sessionId !== sessionId ||
			pending.cwd !== cwd ||
			now > pending.expiresAt ||
			pending.expiresAt - now > pendingTtlMs
		)
			continue;
		const containedPending = {
			...pending,
			details: {
				...pending.details,
				artifacts: [dirname(candidate)],
			},
		};
		if (!newest || containedPending.expiresAt > newest.expiresAt)
			newest = containedPending;
	}
	return newest;
}

export async function handleSlipstreamCommand(
	args: string,
	state: RuntimeState,
	config: SlipstreamConfig,
	ctx: NotifyContext,
	deps: CommandDeps = {},
): Promise<CommandResult> {
	try {
		return await handleSlipstreamCommandCore(args, state, config, ctx, deps);
	} finally {
		restorePersistentStatus(ctx, state, config);
	}
}

async function handleSlipstreamCommandCore(
	args: string,
	state: RuntimeState,
	config: SlipstreamConfig,
	ctx: NotifyContext,
	deps: CommandDeps = {},
): Promise<CommandResult> {
	const resolvedDeps = { ...DEFAULT_COMMAND_DEPS, ...deps };
	const parsed = parseCommandArgs(args);
	const strategyFlags = new Set(["direct"]);
	const actionFlags = new Set(["dry-run", "prepare", "adopt", "high-accuracy"]);
	const allowedFlags = new Set([...strategyFlags, ...actionFlags]);
	const unknownFlags = [...parsed.flags].filter(
		(flag) => !allowedFlags.has(flag),
	);
	const nonStrategyFlags = new Set(
		[...parsed.flags].filter((flag) => !strategyFlags.has(flag)),
	);
	if (parsed.action === "status")
		return { ok: true, message: buildStatusText(state) };
	if (parsed.action === "artifacts")
		return {
			ok: true,
			message: state.lastArtifactDir
				? `Latest artifacts: ${state.lastArtifactDir}`
				: "No Slipstream artifacts yet.",
		};
	if (parsed.flags.has("high-accuracy"))
		return {
			ok: false,
			message:
				"High-accuracy mode was removed. Use /slipstream compact, /slipstream compact --dry-run, or /slipstream compact --prepare.",
		};
	if (unknownFlags.length || parsed.rest.length)
		return {
			ok: false,
			message: `Unknown Slipstream compact argument(s): ${[...unknownFlags.map((flag) => `--${flag}`), ...parsed.rest].join(", ")}`,
		};
	if (parsed.action === "compact" && parsed.flags.has("adopt")) {
		if (!ctx.compact)
			return { ok: false, message: "This context cannot trigger compaction." };
		const now = resolvedDeps.now();
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
		const cwd = ctx.cwd ?? ".";
		const artifactRoot = await resolveArtifactRoot(cwd, config.artifactRoot);
		if (!state.pending || state.status !== "ready_to_adopt") {
			const recovered = await recoverPendingArtifact(
				artifactRoot,
				sessionId,
				cwd,
				now,
				config.pendingTtlMs,
			);
			if (recovered) storePendingValidated(state, recovered);
		}
		if (
			state.pending &&
			state.status === "ready_to_adopt" &&
			(state.pending.sessionId !== sessionId || state.pending.cwd !== cwd)
		) {
			state.pending = null;
			state.status = "idle";
			const recovered = await recoverPendingArtifact(
				artifactRoot,
				sessionId,
				cwd,
				now,
				config.pendingTtlMs,
			);
			if (recovered) storePendingValidated(state, recovered);
		}
		if (
			state.pending &&
			state.status === "ready_to_adopt" &&
			now > state.pending.expiresAt
		)
			return handleAdoptCommand(
				state,
				withRestoredStatusCallbacks(
					state,
					{ ...ctx, compact: ctx.compact.bind(ctx) },
					config,
				),
				now,
				sessionId,
				cwd,
			);
		const branchEntries = ctx.sessionManager?.getBranch() ?? [];
		const continuation = buildContinuationFromBranch(
			branchEntries,
			config.maxContinuationTurns,
		);
		if (
			state.pending &&
			state.status === "ready_to_adopt" &&
			continuation.triggerEntryId !== null &&
			state.pending.validatedThroughEntryId !== continuation.triggerEntryId
		) {
			if (!ctx.modelRegistry)
				return {
					ok: false,
					message:
						"Pending Slipstream summary is stale and cannot be revalidated because no model registry is available. Run /slipstream compact --prepare again.",
				};
			if (continuation.turns.length < config.minContinuationTurns)
				return {
					ok: false,
					message: `Pending Slipstream summary is stale and needs at least ${config.minContinuationTurns} continuation turn(s) before revalidation. Run /slipstream compact --prepare again.`,
				};
			const stalePending = state.pending;
			const contextUsage = ctx.getContextUsage?.();
			const progress = makeProgressSink(ctx, state, config);
			let result: ValidatedRunResult;
			try {
				result = await runValidatedSlipstream({
					branchEntries,
					sessionId,
					cwd,
					artifactRoot,
					tokensBefore: contextUsage?.tokens ?? null,
					contextUsage,
					continuation,
					completeSummary: resolvedDeps.createSummaryCompleter(
						{ model: ctx.model, modelRegistry: ctx.modelRegistry },
						config.summaryModel,
					),
					completeJudge: resolvedDeps.createJudgeCompleter(
						{ model: ctx.model, modelRegistry: ctx.modelRegistry },
						config.judgeModel,
					),
					judgeThreshold: config.judgeThreshold,
					repairAttempts: config.repairAttempts,
					statsFullPaths: config.statsFullPaths,
					onProgress: progress,
					signal: ctx.signal,
				});
			} finally {
				progress.clear();
			}
			state.lastArtifactDir = result.artifactDir;
			state.lastJudge = result.judge;
			const rejectedAcceptance =
				!result.accepted && result.firstKeptEntryId
					? await acceptRejectedSummaryByPolicy(
							ctx,
							result,
							config.rejectedSummaryMode,
						)
					: null;
			if (
				(!result.accepted && !rejectedAcceptance?.accepted) ||
				!result.firstKeptEntryId
			) {
				const reason = result.judge.diagnosis || `score ${result.judge.score}`;
				state.pending = null;
				state.status = "rejected";
				return {
					ok: false,
					message: `Pending Slipstream summary is stale and revalidation failed. Score ${result.judge.score}. ${reason}. Artifacts: ${result.artifactDir}`,
				};
			}
			const refreshedPending = createPendingValidatedCompaction({
				sessionId,
				cwd,
				result,
				rejectedAcceptance,
				validatedThroughEntryId: continuation.triggerEntryId,
				revalidatedFromEntryId: stalePending.validatedThroughEntryId,
				expiresAt: resolvedDeps.now() + config.pendingTtlMs,
			});
			await persistPendingArtifact(result.artifactDir, refreshedPending);
			storePendingValidated(state, refreshedPending);
		}
		return handleAdoptCommand(
			state,
			withRestoredStatusCallbacks(
				state,
				{ ...ctx, compact: ctx.compact.bind(ctx) },
				config,
			),
			now,
			sessionId,
			cwd,
		);
	}
	if (parsed.action === "compact" && parsed.flags.has("dry-run")) {
		const branchEntries = ctx.sessionManager?.getBranch() ?? [];
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
		const cwd = ctx.cwd ?? ".";
		const contextUsage = ctx.getContextUsage?.();
		const progress = makeProgressSink(ctx, state, config);
		let result;
		try {
			result = await runSlipstreamDryRun({
				branchEntries,
				sessionId,
				cwd,
				artifactRoot: await resolveArtifactRoot(cwd, config.artifactRoot),
				tokensBefore: contextUsage?.tokens ?? null,
				contextUsage,
				onProgress: progress,
				signal: ctx.signal,
			});
		} finally {
			progress.clear();
		}
		state.lastArtifactDir = result.artifactDir;
		return {
			ok: true,
			message: `Dry run wrote artifacts: ${result.artifactDir}`,
		};
	}
	const isOneShotCompact =
		parsed.action === "compact" &&
		!parsed.flags.has("prepare") &&
		!parsed.flags.has("dry-run") &&
		!parsed.flags.has("adopt") &&
		nonStrategyFlags.size === 0;
	if (
		parsed.action === "compact" &&
		(parsed.flags.has("prepare") || isOneShotCompact)
	) {
		if (isOneShotCompact && !ctx.compact)
			return { ok: false, message: "This context cannot trigger compaction." };
		if (!ctx.modelRegistry)
			return { ok: false, message: "No model registry is available." };
		const branchEntries = ctx.sessionManager?.getBranch() ?? [];
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
		const cwd = ctx.cwd ?? ".";
		const contextUsage = ctx.getContextUsage?.();
		const continuation = buildContinuationFromBranch(
			branchEntries,
			config.maxContinuationTurns,
		);
		if (continuation.turns.length < config.minContinuationTurns)
			return {
				ok: false,
				message: `Need at least ${config.minContinuationTurns} continuation turn(s) before preparing.`,
			};
		const progress = makeProgressSink(ctx, state, config);
		let result: ValidatedRunResult;
		try {
			result = await runValidatedSlipstream({
				branchEntries,
				sessionId,
				cwd,
				artifactRoot: await resolveArtifactRoot(cwd, config.artifactRoot),
				tokensBefore: contextUsage?.tokens ?? null,
				contextUsage,
				continuation,
				statsFullPaths: config.statsFullPaths,
				completeSummary: resolvedDeps.createSummaryCompleter(
					{ model: ctx.model, modelRegistry: ctx.modelRegistry },
					config.summaryModel,
				),
				completeJudge: resolvedDeps.createJudgeCompleter(
					{ model: ctx.model, modelRegistry: ctx.modelRegistry },
					config.judgeModel,
				),
				judgeThreshold: config.judgeThreshold,
				repairAttempts: config.repairAttempts,
				onProgress: progress,
				signal: ctx.signal,
			});
		} finally {
			progress.clear();
		}
		state.lastArtifactDir = result.artifactDir;
		state.lastJudge = result.judge;
		const rejectedAcceptance =
			!result.accepted && result.firstKeptEntryId
				? await acceptRejectedSummaryByPolicy(
						ctx,
						result,
						config.rejectedSummaryMode,
					)
				: null;
		if (
			(!result.accepted && !rejectedAcceptance?.accepted) ||
			!result.firstKeptEntryId
		) {
			const reason = result.judge.diagnosis || `score ${result.judge.score}`;
			state.pending = null;
			state.status = "rejected";
			return {
				ok: false,
				message: `Slipstream could not prepare a compaction summary. Score ${result.judge.score}. ${reason}. Artifacts: ${result.artifactDir}`,
			};
		}
		const pending = createPendingValidatedCompaction({
			sessionId,
			cwd,
			result,
			rejectedAcceptance,
			validatedThroughEntryId: continuation.triggerEntryId,
			expiresAt: resolvedDeps.now() + config.pendingTtlMs,
		});
		await persistPendingArtifact(result.artifactDir, pending);
		storePendingValidated(state, pending);
		if (isOneShotCompact && ctx.compact)
			return handleAdoptCommand(
				state,
				withRestoredStatusCallbacks(
					state,
					{ ...ctx, compact: ctx.compact.bind(ctx) },
					config,
				),
				resolvedDeps.now(),
				sessionId,
				cwd,
			);
		const preparedKind = result.accepted
			? "validated"
			: rejectedAcceptance?.confirmed
				? "manually accepted rejected"
				: "policy-accepted rejected";
		return {
			ok: true,
			message: `Prepared ${preparedKind} Slipstream summary (score ${result.judge.score}). Run /slipstream compact --adopt to apply.`,
		};
	}
	return {
		ok: false,
		message:
			"Usage: /slipstream status | artifacts | compact [--direct] | compact --dry-run | compact --prepare | compact --adopt",
	};
}
