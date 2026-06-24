import { createHash } from "node:crypto";
import type { ContinuationSnapshot, ContinuationToolResult } from "./types.ts";

export type PromptBudgetOptions = {
	maxPromptChars?: number;
	continuationMaxChars?: number;
};

type RenderPromptOptions = Required<PromptBudgetOptions>;

type ContinuationRenderMode = "standard" | "minimal" | "none";

type ContinuationRenderOptions = {
	maxChars: number;
	mode?: ContinuationRenderMode;
};

export const DEFAULT_MAX_JUDGE_PROMPT_CHARS = 650_000;
export const DEFAULT_MAX_REPAIR_PROMPT_CHARS = 650_000;
export const DEFAULT_MAX_CONTINUATION_EVIDENCE_CHARS = 80_000;

const STANDARD_HEAD_CHARS = 900;
const STANDARD_TAIL_CHARS = 900;
const MINIMAL_HEAD_CHARS = 160;
const MINIMAL_TAIL_CHARS = 160;
const MINIMAL_ASSISTANT_CHARS = 400;

export function normalizePromptBudgetOptions(
	options: PromptBudgetOptions | undefined,
	defaultMaxPromptChars: number,
): RenderPromptOptions {
	return {
		maxPromptChars: options?.maxPromptChars ?? defaultMaxPromptChars,
		continuationMaxChars:
			options?.continuationMaxChars ?? DEFAULT_MAX_CONTINUATION_EVIDENCE_CHARS,
	};
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function boundedMiddle(
	text: string,
	headChars: number,
	tailChars: number,
): string {
	if (text.length <= headChars + tailChars + 80) return text;
	const omitted = text.length - headChars - tailChars;
	return `${text.slice(0, headChars)}\n...[omitted ${omitted} chars; sha256: ${sha256(text)}]...\n${text.slice(-tailChars)}`;
}

function renderToolResult(
	result: ContinuationToolResult,
	mode: Exclude<ContinuationRenderMode, "none">,
): string {
	const headChars =
		mode === "minimal" ? MINIMAL_HEAD_CHARS : STANDARD_HEAD_CHARS;
	const tailChars =
		mode === "minimal" ? MINIMAL_TAIL_CHARS : STANDARD_TAIL_CHARS;
	const preview = boundedMiddle(result.text, headChars, tailChars);
	return [
		`- toolName: ${result.toolName}`,
		result.toolCallId ? `  toolCallId: ${result.toolCallId}` : null,
		`  isError: ${result.isError}`,
		`  originalChars: ${result.text.length}`,
		`  sha256: ${sha256(result.text)}`,
		"  Tool result evidence is bounded; full raw continuation remains in local continuation artifacts.",
		`  preview:\n${preview}`,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

function renderTurn(
	turn: ContinuationSnapshot["turns"][number],
	index: number,
	mode: Exclude<ContinuationRenderMode, "none">,
): string {
	const assistantText =
		mode === "minimal"
			? boundedMiddle(
					turn.assistantText,
					MINIMAL_ASSISTANT_CHARS,
					MINIMAL_ASSISTANT_CHARS,
				)
			: turn.assistantText;
	const toolResults = turn.toolResults.length
		? turn.toolResults
				.map((result) => renderToolResult(result, mode))
				.join("\n")
		: "- None";
	return `Turn ${index + 1}: ${assistantText}\nTool results:\n${toolResults}`;
}

function renderContinuationInternal(
	continuation: ContinuationSnapshot,
	mode: ContinuationRenderMode,
): string {
	if (continuation.turns.length === 0) return "None";
	if (mode === "none") {
		const toolResultCount = continuation.turns.reduce(
			(count, turn) => count + turn.toolResults.length,
			0,
		);
		const toolTextChars = continuation.turns.reduce(
			(count, turn) =>
				count +
				turn.toolResults.reduce((sum, result) => sum + result.text.length, 0),
			0,
		);
		return `Continuation evidence omitted from model prompt to stay within budget. Raw continuation remains in local continuation artifacts. turns: ${continuation.turns.length}; toolResults: ${toolResultCount}; toolTextChars: ${toolTextChars}.`;
	}
	return continuation.turns
		.map((turn, index) => renderTurn(turn, index, mode))
		.join("\n\n");
}

export function renderBoundedContinuationEvidence(
	continuation: ContinuationSnapshot,
	options: ContinuationRenderOptions,
): string {
	const requestedMode = options.mode ?? "standard";
	const rendered = renderContinuationInternal(continuation, requestedMode);
	if (requestedMode === "none") return rendered;
	if (rendered.length <= options.maxChars) return rendered;
	if (requestedMode === "standard") {
		const minimal = renderContinuationInternal(continuation, "minimal");
		if (minimal.length <= options.maxChars) return minimal;
	}
	return renderContinuationInternal(continuation, "none");
}

export function fitPromptWithDegradableSection(input: {
	render: (section: string) => string;
	degradableStandard: string;
	degradableMinimal: string;
	degradableOmitted: string;
	maxPromptChars: number;
	fixedSectionName: string;
}): string {
	const standard = input.render(input.degradableStandard);
	if (standard.length <= input.maxPromptChars) return standard;
	const minimal = input.render(input.degradableMinimal);
	if (minimal.length <= input.maxPromptChars) return minimal;
	const omitted = input.render(input.degradableOmitted);
	if (omitted.length <= input.maxPromptChars) return omitted;
	throw new Error(
		`${input.fixedSectionName} fixed sections exceed maxPromptChars (${omitted.length} > ${input.maxPromptChars}); reduce protected manifest/state evidence before retrying.`,
	);
}
