import type { PendingValidatedCompaction, RuntimeState } from "./types.ts";

export type CreateRuntimeStateOptions = { now?: number };
export type PendingMatch = {
	sessionId?: string;
	cwd?: string;
	preparationFirstKeptEntryId?: string;
	validatedThroughEntryId?: string | null;
	now: number;
};
export type CompactCapableContext = {
	compact(options?: {
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}): void;
};

export function createRuntimeState(
	_options: CreateRuntimeStateOptions = {},
): RuntimeState {
	return {
		pending: null,
		autoJob: null,
		activePromise: null,
		compactionWanted: false,
		lastArtifactDir: null,
		lastJudge: null,
		status: "idle",
	};
}

export function storePendingValidated(
	state: RuntimeState,
	pending: PendingValidatedCompaction,
): void {
	state.pending = pending;
	state.status = "ready_to_adopt";
	const judge = pending.details.judge;
	state.lastJudge =
		typeof judge === "object" && judge !== null
			? (judge as RuntimeState["lastJudge"])
			: state.lastJudge;
	const artifacts = pending.details.artifacts;
	if (Array.isArray(artifacts) && typeof artifacts[0] === "string")
		state.lastArtifactDir = artifacts[0];
}

export function consumePendingForCompaction(
	state: RuntimeState,
	match: PendingMatch,
):
	| {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number | null;
			details: Record<string, unknown>;
	  }
	| undefined {
	const pending = state.pending;
	if (!pending) return undefined;
	if (match.now > pending.expiresAt) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	if (match.sessionId && pending.sessionId !== match.sessionId) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	if (match.cwd && pending.cwd !== match.cwd) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	if (
		match.validatedThroughEntryId !== undefined &&
		match.validatedThroughEntryId !== null &&
		pending.validatedThroughEntryId !== match.validatedThroughEntryId
	) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	state.pending = null;
	state.status = "idle";
	return {
		summary: pending.summary,
		firstKeptEntryId: pending.firstKeptEntryId,
		tokensBefore: pending.tokensBefore,
		details: pending.details,
	};
}

export function adoptPending(
	state: RuntimeState,
	ctx: CompactCapableContext,
	match: PendingMatch = { now: Date.now() },
): "slipstream" | null {
	const pending = state.pending;
	if (!pending || state.status !== "ready_to_adopt") return null;
	if (match.now > pending.expiresAt) {
		state.pending = null;
		state.status = "idle";
		return null;
	}
	if (match.sessionId && pending.sessionId !== match.sessionId) {
		state.pending = null;
		state.status = "idle";
		return null;
	}
	if (match.cwd && pending.cwd !== match.cwd) {
		state.pending = null;
		state.status = "idle";
		return null;
	}
	state.status = "summarizing";
	try {
		ctx.compact({
			customInstructions:
				"Use validated Slipstream summary from pi-slipstream-compact",
			onComplete: () => {
				state.status = "idle";
			},
			onError: () => {
				state.status = state.pending ? "ready_to_adopt" : "idle";
			},
		});
	} catch (error) {
		state.status = "ready_to_adopt";
		throw error;
	}
	return "slipstream";
}

export function trackPromise<T>(
	state: RuntimeState,
	promise: Promise<T>,
): Promise<T> {
	state.activePromise = promise;
	void promise.then(
		() => {
			if (state.activePromise === promise) state.activePromise = null;
		},
		() => {
			if (state.activePromise === promise) state.activePromise = null;
		},
	);
	return promise;
}
