import { extractText } from "./snapshot.ts";
import type {
	AgentMessage,
	ContinuationSnapshot,
	ContinuationToolResult,
	MessageEntry,
	SessionEntry,
	ToolResultMessage,
} from "./types.ts";

export type ContinuationBufferOptions = { minTurns: number; maxTurns: number };
export type TurnEndLike = {
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
};

function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		entry.type === "message" &&
		typeof entry.id === "string" &&
		typeof entry.message === "object" &&
		entry.message !== null
	);
}

function hasAssistantText(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	if (typeof message.content === "string") return message.content.trim() !== "";
	return message.content.some(
		(block) =>
			block.type === "text" &&
			typeof block.text === "string" &&
			block.text.trim() !== "",
	);
}

export class ContinuationBuffer {
	private triggerEntryId: string | null = null;
	private turns: ContinuationSnapshot["turns"] = [];
	readonly minTurns: number;
	readonly maxTurns: number;

	constructor(options: ContinuationBufferOptions) {
		this.minTurns = options.minTurns;
		this.maxTurns = options.maxTurns;
	}

	start(triggerEntryId: string | null): void {
		this.triggerEntryId = triggerEntryId;
		this.turns = [];
	}

	appendTurn(event: TurnEndLike): void {
		if (this.triggerEntryId === null || this.turns.length >= this.maxTurns)
			return;
		const assistantText =
			"content" in event.message ? extractText(event.message.content) : "";
		const toolResults: ContinuationToolResult[] = event.toolResults.map(
			(result) => ({
				toolName: result.toolName,
				toolCallId: result.toolCallId,
				isError: result.isError,
				text: extractText(result.content),
			}),
		);
		this.turns.push({ turnIndex: event.turnIndex, assistantText, toolResults });
	}

	isReady(): boolean {
		return this.turns.length >= this.minTurns;
	}

	isFull(): boolean {
		return this.turns.length >= this.maxTurns;
	}

	snapshot(): ContinuationSnapshot {
		return { triggerEntryId: this.triggerEntryId, turns: [...this.turns] };
	}
}

export function buildContinuationFromBranch(
	branchEntries: SessionEntry[],
	maxTurns: number,
): ContinuationSnapshot {
	const messageEntries = branchEntries.filter(isMessageEntry);
	const turns: ContinuationSnapshot["turns"] = [];
	let current: ContinuationSnapshot["turns"][number] | null = null;
	let turnIndex = 0;

	for (const entry of messageEntries) {
		const message = entry.message;
		if (message.role === "assistant" && hasAssistantText(message)) {
			if (current) turns.push(current);
			turnIndex += 1;
			current = {
				turnIndex,
				assistantText: extractText(message.content),
				toolResults: [],
			};
		} else if (message.role === "toolResult" && current) {
			current.toolResults.push({
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				isError: message.isError,
				text: extractText(message.content),
			});
		}
	}
	if (current) turns.push(current);

	return {
		triggerEntryId: messageEntries[messageEntries.length - 1]?.id ?? null,
		turns: turns.slice(-Math.max(1, maxTurns)),
	};
}
