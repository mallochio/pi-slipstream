import type { SlipstreamConfig } from "./config.ts";
import type { ProgressEvent, RuntimeState } from "./types.ts";

export const SLIPSTREAM_WIDGET_KEY = "slipstream";

export type WidgetModel = { provider: string; id: string };

export type WidgetTheme = {
	fg(color: string, text: string): string;
};

export type SlipstreamWidgetContext = {
	hasUI?: boolean;
	model?: WidgetModel;
	ui?: {
		theme?: WidgetTheme;
		setWidget?(
			key: string,
			lines: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
};

export type SlipstreamWidgetOptions = {
	progress?: Pick<
		ProgressEvent,
		"phase" | "message" | "elapsedMs" | "lastScore"
	>;
	model?: WidgetModel;
};

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function statusLabel(
	state: RuntimeState,
	progress?: Pick<
		ProgressEvent,
		"phase" | "message" | "elapsedMs" | "lastScore"
	>,
): string {
	if (progress) {
		if (progress.phase === "snapshot") return "snapshotting local state";
		if (progress.phase === "artifacts") return "writing artifacts";
		if (progress.phase === "state-evidence") return "collecting evidence";
		if (progress.phase === "summary") return "summarizing";
		if (progress.phase === "finalizing-summary")
			return "waiting for auto summary";
		if (progress.phase === "judging") return "checking summary";
		if (progress.phase === "repairing") return "repairing summary";
		if (progress.phase === "accepted") return "ready";
		return "summary rejected";
	}
	if (state.status === "idle") return "idle";
	if (state.status === "ready_to_adopt") return "ready";
	if (state.status === "awaiting_continuation") return "waiting for next turn";
	if (state.status === "summarizing") return "compacting";
	if (state.status === "finalizing_summary") return "waiting for auto summary";
	if (state.status === "judging") return "checking summary";
	if (state.status === "repairing") return "repairing summary";
	return state.status.replace(/_/g, " ");
}

function elapsedLabel(
	progress?: Pick<
		ProgressEvent,
		"phase" | "message" | "elapsedMs" | "lastScore"
	>,
): string | null {
	if (typeof progress?.elapsedMs !== "number") return null;
	if (progress.phase === "accepted" || progress.phase === "rejected")
		return null;
	return formatElapsed(progress.elapsedMs);
}

function scoreLabel(
	state: RuntimeState,
	label: string,
	progress?: Pick<
		ProgressEvent,
		"phase" | "message" | "elapsedMs" | "lastScore"
	>,
): string | null {
	const score =
		progress?.phase === "repairing"
			? progress.lastScore
			: state.lastJudge?.score;
	if (typeof score !== "number") return null;
	if (progress?.phase === "repairing") return `last score ${score}/10`;
	if (
		label === "ready" ||
		label === "summary rejected" ||
		label === "compacting"
	)
		return `score ${score}/10`;
	return null;
}

function statusColor(label: string): string {
	if (label === "ready") return "success";
	if (label === "repairing summary") return "warning";
	if (label === "checking summary") return "accent";
	if (label === "compacting") return "accent";
	return "muted";
}

function formatSlipstreamLine(line: string, theme?: WidgetTheme): string {
	if (!theme) return line;
	const prefix = "Slipstream: ";
	const body = line.startsWith(prefix) ? line.slice(prefix.length) : line;
	const [firstPart, ...rest] = body.split(" · ");
	const label = firstPart ?? body;
	return [
		theme.fg("accent", "Slipstream:"),
		theme.fg(statusColor(label), label),
		...rest.map((part) => theme.fg("muted", part)),
	].join(" ");
}

export function buildSlipstreamWidgetLines(
	state: RuntimeState,
	config: SlipstreamConfig,
	options: SlipstreamWidgetOptions = {},
): string[] {
	void config;
	void options.model;
	const label = statusLabel(state, options.progress);
	const parts = [
		`Slipstream: ${label}`,
		elapsedLabel(options.progress),
		scoreLabel(state, label, options.progress),
	].filter((part): part is string => part !== null);
	return [parts.join(" · ")];
}

function ignoreStaleContextError(error: unknown): void {
	if (
		error instanceof Error &&
		error.message.includes("extension ctx is stale")
	)
		return;
	throw error;
}

function shouldShowSlipstreamWidget(
	state: RuntimeState,
	progress?: Pick<
		ProgressEvent,
		"phase" | "message" | "elapsedMs" | "lastScore"
	>,
): boolean {
	if (progress) return true;
	return (
		state.status === "awaiting_continuation" ||
		state.status === "ready_to_adopt" ||
		state.status === "summarizing" ||
		state.status === "finalizing_summary" ||
		state.status === "judging" ||
		state.status === "repairing"
	);
}

export function updateSlipstreamWidget(
	ctx: SlipstreamWidgetContext,
	state: RuntimeState,
	config: SlipstreamConfig,
	options: SlipstreamWidgetOptions = {},
): void {
	if (ctx.hasUI === false) return;
	try {
		if (!shouldShowSlipstreamWidget(state, options.progress)) {
			ctx.ui?.setWidget?.(SLIPSTREAM_WIDGET_KEY, undefined);
			return;
		}
		ctx.ui?.setWidget?.(
			SLIPSTREAM_WIDGET_KEY,
			buildSlipstreamWidgetLines(state, config, {
				...options,
				model: options.model ?? ctx.model,
			}).map((line) => formatSlipstreamLine(line, ctx.ui?.theme)),
			{ placement: "aboveEditor" },
		);
	} catch (error) {
		ignoreStaleContextError(error);
	}
}

export function clearSlipstreamWidget(ctx: SlipstreamWidgetContext): void {
	if (ctx.hasUI === false) return;
	try {
		ctx.ui?.setWidget?.(SLIPSTREAM_WIDGET_KEY, undefined);
	} catch (error) {
		ignoreStaleContextError(error);
	}
}
