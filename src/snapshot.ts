import type {
	AgentMessage,
	AssistantMessage,
	BashExecutionMessage,
	ContentBlock,
	MessageContent,
	LatestSignal,
	MessageEntry,
	SessionEntry,
	Snapshot,
	SnapshotManifest,
	ToolCallBlock,
	ToolResultMessage,
	UserAssertionAuthority,
	UserAssertionKind,
	UserAssertionTrailEntry,
} from "./types.ts";
import { redactPromptSensitiveText } from "./redaction.ts";
import {
	createCooperativeScheduler,
	type CooperativeScheduler,
} from "./responsiveness.ts";

type ToolCallRecord = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	msgIndex: number;
};

type BuildSnapshotInput = {
	branchEntries: SessionEntry[];
	keepRecentEntryCount?: number;
	keepRecentTokens?: number;
	firstKeptEntryId?: string | null;
	sessionId?: string;
	cwd?: string;
	tokensBefore?: number | null;
};

export type BuildSnapshotAsyncOptions = {
	scheduler?: CooperativeScheduler;
	signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentBlock(value: unknown): value is ContentBlock {
	return isRecord(value) && typeof value.type === "string";
}

function isToolCallBlock(value: unknown): value is ToolCallBlock {
	return (
		isContentBlock(value) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string"
	);
}

function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
	return (
		isRecord(entry) &&
		entry.type === "message" &&
		isRecord(entry.message) &&
		typeof entry.id === "string"
	);
}

function isToolResultMessage(
	message: AgentMessage,
): message is ToolResultMessage {
	return message.role === "toolResult";
}

function isBashExecutionMessage(
	message: AgentMessage,
): message is BashExecutionMessage {
	return message.role === "bashExecution";
}

function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return message.role === "assistant";
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function addUnique(target: string[], value: string | null): void {
	if (!value) return;
	if (!target.includes(value)) target.push(value);
}

function boundedMatchWindow(
	text: string,
	matchIndex: number,
	maxChars: number,
): string {
	const sentence = sentenceWindow(text, matchIndex);
	if (sentence.length <= maxChars) return sentence;
	const start = Math.max(0, matchIndex - Math.floor(maxChars * 0.35));
	return text.slice(start, start + maxChars).trim();
}

function globalMatcher(pattern: RegExp): RegExp {
	return new RegExp(
		pattern.source,
		pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
	);
}

function intentExcerpts(text: string, pattern: RegExp): string[] {
	const normalized = text.replace(/\\n/g, "\n");
	const excerpts: string[] = [];
	const matcher = globalMatcher(pattern);
	let match: RegExpExecArray | null;
	while ((match = matcher.exec(normalized))) {
		addUnique(excerpts, boundedMatchWindow(normalized, match.index, 220));
		if (excerpts.length >= 3) break;
		if (match[0].length === 0) matcher.lastIndex += 1;
	}
	return excerpts;
}

const MINED_USER_INTENT_OMISSION_MARKER =
	"\n\n[... Slipstream omitted source text from oversized mined user intent. ...]";
const USER_ASSERTION_TRAIL_MAX_CHARS = 10_000;
const USER_ASSERTION_SIGNAL_RE =
	/\b(?:actually|correction|wrong|instead|rather|supersede|ignore previous|ignore that|not that|don'?t|do not|stop|wait|hold on|approve|approved|approval|ok|yes|do it|go ahead|scope|only|permission|allowed|not allowed|don'?t touch|do not touch|please|can you|could you|implement|fix|add|change|review|analy[sz]e|use|prefer|must|should|need|want|has to|have to|test|passed|failed|verify|validation|live|browser|fixture)\b/i;

function boundWithOmissionMarker(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = MINED_USER_INTENT_OMISSION_MARKER;
	if (maxChars <= marker.length) return marker.slice(0, maxChars);
	const available = maxChars - marker.length;
	const headChars = Math.floor(available * 0.65);
	const tailChars = available - headChars;
	const tail = tailChars > 0 ? text.slice(-tailChars) : "";
	return `${text.slice(0, headChars)}${marker}${tail}`;
}

function boundManifestFactText(
	text: string,
	pattern: RegExp,
	maxChars = 1_000,
): string {
	if (text.length <= maxChars) return text;
	const excerpts = intentExcerpts(text, pattern);
	if (excerpts.length === 0) return boundWithOmissionMarker(text, maxChars);
	return boundWithOmissionMarker(
		`Selected intent excerpts from oversized user message:\n${excerpts.map((excerpt) => `- ${excerpt}`).join("\n")}${MINED_USER_INTENT_OMISSION_MARKER}`,
		maxChars,
	);
}

function addRecentVerification(
	manifest: SnapshotManifest,
	verificationIndex: Map<string, number>,
	text: string,
	messageIndex: number,
): void {
	const value = text.slice(0, 300);
	if (!value || manifest.recentVerification.includes(value)) return;
	manifest.recentVerification.push(value);
	verificationIndex.set(value, messageIndex);
}

function addLatestSignal(
	manifest: SnapshotManifest,
	kind: LatestSignal["kind"],
	text: string | null,
	entryId?: string,
): void {
	if (!text) return;
	const normalized = text.trim().replace(/\s+/g, " ").slice(0, 500);
	if (!normalized) return;
	if (
		manifest.latestSignals.some(
			(signal) => signal.kind === kind && signal.text === normalized,
		)
	)
		return;
	manifest.latestSignals.push({ kind, text: normalized, entryId });
}

function addUniqueByText<T extends { text: string }>(
	target: T[],
	value: T,
): void {
	if (!target.some((item) => item.text === value.text)) target.push(value);
}

function hasConcreteSignalAnchor(text: string): boolean {
	return /`[^`\n]{3,160}`|(?:\.?\.?\/|\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|\b(?:npm|pnpm|node|python|pytest|ruff|tsc|uv|basedpyright|git)\s+[A-Za-z0-9:_./-]+|\b(?:wrapper CWD|git status|dirty state|dirty-state|file modified since read|ambiguous edit)\b/i.test(
		text,
	);
}

function isExplicitRiskSignal(text: string): boolean {
	if (!hasConcreteSignalAnchor(text)) return false;
	return /\b(?:Primary blocker\/risk|RISK:|blocker:|blocked by|dirty state|dirty-state|stale branch|stale-state|file modified since read|ambiguous edit|do not trust)\b/i.test(
		text,
	);
}

function isPlannedDelivery(text: string): boolean {
	return /\b(?:need to|should|todo|plan to|will|would)\b/i.test(text);
}

function isExplicitFinalDeliveredSignal(text: string): boolean {
	if (isPlannedDelivery(text)) return false;
	return (
		/\bfinal\b.{0,80}\b(?:answer|audit|review|response|report)\b.{0,80}\b(?:already\s+)?(?:sent|delivered|posted|reported)\b/i.test(
			text,
		) ||
		/\b(?:answer|audit|review|response|report)\b.{0,80}\b(?:already\s+)?(?:sent|delivered|posted|reported)\b/i.test(
			text,
		) ||
		/\b(?:no further action unless|wait(?:ing)? for (?:the )?user follow-up|no active (?:code )?(?:request|task))\b/i.test(
			text,
		)
	);
}

function isExplicitDeliverySignal(text: string): boolean {
	if (isPlannedDelivery(text)) return false;
	return /\b(?:review written|final answer|reported|delivered|posted|commented)\b/i.test(
		text,
	);
}

function latestSignalPriority(kind: LatestSignal["kind"]): number {
	if (kind === "final_delivered") return 0;
	if (kind === "verification_failure") return 1;
	if (kind === "verification_success") return 2;
	if (kind === "delivered_output") return 3;
	return 4;
}

function capLatestSignals(
	signals: LatestSignal[],
	maxItems: number,
): LatestSignal[] {
	if (signals.length <= maxItems) return signals;
	return signals
		.map((signal, index) => ({ signal, index }))
		.sort((left, right) => {
			const priorityDelta =
				latestSignalPriority(left.signal.kind) -
				latestSignalPriority(right.signal.kind);
			if (priorityDelta !== 0) return priorityDelta;
			return right.index - left.index;
		})
		.slice(0, maxItems)
		.sort((left, right) => left.index - right.index)
		.map((item) => item.signal);
}

function contentBlocks(content: MessageContent): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter(isContentBlock);
}

export function extractText(content: MessageContent): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string")
			parts.push(block.text);
		if (block.type === "toolCall" && typeof block.name === "string")
			parts.push(`[toolCall] ${block.name}`);
	}
	return parts.join("\n");
}

function serializeMessage(entry: MessageEntry): string {
	const message = entry.message;
	if (message.role === "bashExecution") {
		const status = [
			`exit=${message.exitCode ?? "unknown"}`,
			`cancelled=${message.cancelled === true}`,
			`truncated=${message.truncated === true}`,
		].join(" ");
		return `[Bash ${entry.id} ${status}]: ${message.command}\n${message.output?.trim() ? message.output : "[no stdout]"}`;
	}
	if (message.role === "toolResult")
		return `[Tool ${entry.id} ${message.toolName}${message.isError ? " ERROR" : ""}]: ${extractText(message.content)}`;
	if (message.role === "custom")
		return `[Custom ${entry.id} ${message.customType}]: ${extractText(message.content)}`;
	if (message.role === "branchSummary")
		return `[Branch summary ${entry.id}]: ${message.summary}`;
	if (message.role === "compactionSummary")
		return `[Compaction summary ${entry.id}]: ${message.summary}`;
	return `[${message.role} ${entry.id}]: ${extractText(message.content)}`;
}

function normalizeToolName(name: string): string {
	return name.replace(/^functions\./, "");
}

function collectNestedToolCalls(
	block: ToolCallBlock,
	msgIndex: number,
): ToolCallRecord[] {
	const args = isRecord(block.arguments) ? block.arguments : {};
	if (block.name !== "multi_tool_use.parallel")
		return [
			{
				id: block.id,
				name: normalizeToolName(block.name),
				arguments: args,
				msgIndex,
			},
		];
	const toolUses = Array.isArray(args.tool_uses) ? args.tool_uses : [];
	const records: ToolCallRecord[] = [];
	for (let index = 0; index < toolUses.length; index += 1) {
		const use = toolUses[index];
		if (!isRecord(use)) continue;
		const recipient =
			stringValue(use.recipient_name) ?? stringValue(use.name) ?? "unknown";
		const params = isRecord(use.parameters)
			? use.parameters
			: isRecord(use.arguments)
				? use.arguments
				: {};
		const id = stringValue(use.id) ?? `${block.id}_${index}`;
		records.push({
			id,
			name: normalizeToolName(recipient),
			arguments: params,
			msgIndex,
		});
	}
	return records;
}

function buildToolCallIndex(
	messages: MessageEntry[],
): Map<string, ToolCallRecord> {
	const index = new Map<string, ToolCallRecord>();
	for (let msgIndex = 0; msgIndex < messages.length; msgIndex += 1) {
		const message = messages[msgIndex]?.message;
		if (!message || !isAssistantMessage(message)) continue;
		for (const block of contentBlocks(message.content)) {
			if (!isToolCallBlock(block)) continue;
			for (const record of collectNestedToolCalls(block, msgIndex))
				index.set(record.id, record);
		}
	}
	return index;
}

function pathFromArgs(args: Record<string, unknown>): string | null {
	return (
		stringValue(args.path) ??
		stringValue(args.file_path) ??
		stringValue(args.filePath)
	);
}

function classifyToolOps(
	messages: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	const toolIndex = buildToolCallIndex(messages);
	const deleted = new Set<string>();

	for (const record of toolIndex.values()) {
		const tool = record.name.toLowerCase();
		const filePath = pathFromArgs(record.arguments);
		if (tool === "read") addUnique(manifest.filesRead, filePath);
		if (tool === "write" || tool === "edit")
			addUnique(manifest.filesModified, filePath);
		if ((tool === "grep" || tool === "find" || tool === "ls") && filePath)
			addUnique(manifest.filesRead, filePath);
		const command = stringValue(record.arguments.command);
		if (tool === "bash" && command && /\brm\s+(-\S*\s+)?/.test(command)) {
			const match = command.match(/\brm\s+(?:-\S+\s+)?([^;&|]+)/);
			if (match?.[1]) deleted.add(match[1].trim());
		}
	}

	for (const path of deleted) addUnique(manifest.filesDeleted, path);

	for (const entry of messages) {
		const message = entry.message;
		if (!isToolResultMessage(message)) continue;
		const record = toolIndex.get(message.toolCallId);
		if (record) {
			const tool = record.name.toLowerCase();
			const filePath = pathFromArgs(record.arguments);
			if (tool === "read") addUnique(manifest.filesRead, filePath);
			if (tool === "write" || tool === "edit")
				addUnique(manifest.filesModified, filePath);
		}
		if (message.isError) {
			manifest.errors.push({
				source: "tool",
				entryId: entry.id,
				unresolved: true,
				message: extractText(message.content).slice(0, 500),
			});
		}
	}
}

function mineTextFacts(
	messages: MessageEntry[],
	manifest: SnapshotManifest,
	verificationIndex: Map<string, number>,
): void {
	const decisionRe =
		/\b(use|prefer|avoid|don'?t use|go with|approved|decided|greenfield|instead|primary)\b/i;
	const constraintRe =
		/\b(must|never|always|do not|don'?t|preserve|no |only|require|constraint|should not)\b/i;
	const loopRe =
		/\b(next step|todo|still need|blocked|open loop|follow[- ]?up|in progress|continue|need implementation)\b/i;
	const verificationRe =
		/\b(test|typecheck|lint|verify|verification|passed|failed|exit code|npm test|node --test)\b/i;

	for (
		let messageIndex = 0;
		messageIndex < messages.length;
		messageIndex += 1
	) {
		const entry = messages[messageIndex];
		if (!entry) continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = extractText(message.content).trim();
			if (decisionRe.test(text))
				manifest.userDecisions.push({
					text: boundManifestFactText(text, decisionRe),
					entryId: entry.id,
				});
			if (constraintRe.test(text))
				manifest.constraints.push({
					text: boundManifestFactText(text, constraintRe),
					entryId: entry.id,
				});
			if (loopRe.test(text))
				manifest.openLoops.push({
					summary: boundManifestFactText(text, loopRe),
					entryId: entry.id,
					priority: /blocked|must|next step/i.test(text) ? "high" : "medium",
				});
		}

		if ("content" in message) {
			const text = extractText(message.content).trim();
			if (verificationRe.test(text))
				addRecentVerification(manifest, verificationIndex, text, messageIndex);
		}
	}
}

function isLikelyPastedBlob(text: string): boolean {
	if (text.length > 6_000) return true;
	const lineCount = text.split(/\r?\n/).length;
	if (lineCount > 80) return true;
	return /```|diff --git|BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)|<html|\{\s*"|^\s*(?:INFO|DEBUG|ERROR|WARN)\b/im.test(
		text,
	);
}

function isLikelyPromptReplay(text: string): boolean {
	return /\b(?:previous|prior|original|old)?\s*(?:system|developer|assistant)\s+prompt\b|\bhidden (?:instruction|instructions|prompt)\b/i.test(
		text,
	);
}

function userAssertionCandidateUnits(text: string): string[] {
	const units: string[] = [];
	for (const line of text.split(/\r?\n+/)) {
		const normalizedLine = normalizeUserAssertion(line);
		if (!normalizedLine) continue;
		const sentenceUnits = normalizedLine.split(/(?<=[.!?])\s+/);
		for (const sentence of sentenceUnits) {
			const normalizedSentence = normalizeUserAssertion(sentence);
			if (!normalizedSentence) continue;
			if (normalizedSentence.length <= 1_000) {
				units.push(normalizedSentence);
				continue;
			}
			for (const excerpt of intentExcerpts(
				normalizedSentence,
				USER_ASSERTION_SIGNAL_RE,
			))
				units.push(normalizeUserAssertion(excerpt));
		}
	}
	return units;
}

function isPromptReplayCorrectionBoundary(text: string): boolean {
	return /^\s*(?:actually|correction|wrong|instead|rather|ignore previous|ignore that|not that|don'?t|do not|stop|wait|hold on)\b/i.test(
		text,
	);
}

function isLikelyPastedReferenceUnit(text: string): boolean {
	return /^\s*(?:doc(?:ument)?|reference|example|section|chapter|line)\b.{0,80}\b(?:should|must|passed|failed|use|prefer)\b/i.test(
		text,
	);
}

function correctionClauseFromPromptReplayUnit(unit: string): string | null {
	if (isPromptReplayCorrectionBoundary(unit)) return unit;
	const match =
		/[;,]\s*(?:actually|correction|wrong|instead|rather|ignore previous|ignore that|not that|don'?t|do not|stop|wait|hold on)\b/i.exec(
			unit,
		);
	if (!match) return null;
	return normalizeUserAssertion(
		unit.slice(match.index).replace(/^[;,]\s*/, ""),
	);
}

function selectedUserAssertionExcerpts(
	text: string,
	options: { promptReplay: boolean; oversized: boolean },
): string[] {
	const excerpts = userAssertionCandidateUnits(text)
		.map((unit) =>
			options.promptReplay ? correctionClauseFromPromptReplayUnit(unit) : unit,
		)
		.filter((unit): unit is string => unit !== null)
		.filter((unit) => USER_ASSERTION_SIGNAL_RE.test(unit))
		.filter((unit) => !isLikelyPromptReplay(unit))
		.filter((unit) => !/\breference docs only\b/i.test(unit))
		.filter((unit) => !isLikelyPastedReferenceUnit(unit));
	return excerpts.slice(0, options.oversized ? 1 : 3);
}

function extractUserAssertionSignalText(rawText: string): string | null {
	const redacted = redactPromptSensitiveText(rawText);
	const normalized = normalizeUserAssertion(redacted);
	if (!normalized) return null;
	const promptReplay = isLikelyPromptReplay(normalized);
	const oversized = isLikelyPastedBlob(redacted);
	if (!promptReplay && !oversized) return normalized;
	const excerpts = selectedUserAssertionExcerpts(redacted, {
		promptReplay,
		oversized,
	});
	if (excerpts.length === 0) return null;
	return excerpts.join(" ");
}

function isUserReportedStateClaim(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ");
	const subjectRe =
		/\b(?:test|typecheck|lint|build|git|filesystem|file|directory|folder|path|repo|repository|server|runtime|command|output|error|diff)\b|\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b|(?:\.\.?\/|\/|[A-Za-z0-9_.-]+\/)\S{2,180}/i;
	const observedStateRe =
		/\b(?:already|currently|now|from the last run|from last run)\b.{0,120}\b(?:passed|failed|succeeded|errored|exists|exist|changed|created|deleted|removed|renamed|contains|shows|says|clean|dirty|missing|running|started|stopped)\b|\b(?:passed|failed|succeeded|errored|exists|exist|changed|created|deleted|removed|renamed|contains|shows|says|clean|dirty|missing|running|started|stopped)\b.{0,80}\b(?:already|currently|now|from the last run|from last run)\b/i;
	const concreteLocationStateRe =
		/\b(?:is|are|was|were)\s+(?:in|under|inside|checked in|present|located|at)\b/i;
	if (subjectRe.test(normalized) && observedStateRe.test(normalized))
		return true;
	if (subjectRe.test(normalized) && concreteLocationStateRe.test(normalized))
		return true;
	if (
		/\b(?:filesystem|file|directory|folder|path|repo|repository)\b.{0,80}\b(?:has to|have to|needs? to|must|should|is to|are to)\b|(?:\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b|(?:\.\.?\/|\/|[A-Za-z0-9_.-]+\/)\S{2,180}).{0,80}\b(?:has to|have to|needs? to|must|should|is to|are to)\b/i.test(
			normalized,
		)
	)
		return false;
	return /\b(?:test|typecheck|lint|build|git|filesystem|file|directory|folder|path|repo|repository|server|runtime|command|output|error|diff)\b.{0,140}\b(?:passed|failed|succeeded|errored|exists|exist|changed|created|deleted|removed|renamed|contains|has|shows|says|clean|dirty|missing|running|started|stopped)\b|\b(?:\.\.?\/|\/|[A-Za-z0-9_.-]+\/)\S{2,180}.{0,140}\b(?:exists|exist|changed|created|deleted|removed|renamed|contains|has|clean|dirty|missing)\b|\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b.{0,140}\b(?:exists|exist|changed|created|deleted|removed|renamed|contains|has|clean|dirty|missing)\b|\b(?:passed|failed|succeeded|errored|clean|dirty|missing|running|started|stopped)\b.{0,140}\b(?:test|typecheck|lint|build|command|run|git|filesystem|file|directory|folder|path|repo|repository|server|runtime)\b/i.test(
		normalized,
	);
}

function userAssertionKind(
	text: string,
	isInitialUserMessage: boolean,
): UserAssertionKind {
	if (isLikelyPastedBlob(text)) return "likely_stale_noisy";
	if (
		/\b(?:actually|correction|wrong|instead|rather|supersede|ignore previous|ignore that|not that|don'?t|do not|stop|wait|hold on)\b/i.test(
			text,
		)
	)
		return "correction_supersession";
	if (
		/\b(?:approve|approved|approval|ok|yes|do it|go ahead|scope|permission|allowed|not allowed|don'?t touch|do not touch)\b|\bonly\b.{0,40}\b(?:scope|file|files|path|paths|repo|repository|touch|change|allowed|permission)\b|\b(?:scope|file|files|path|paths|repo|repository)\b.{0,40}\bonly\b/i.test(
			text,
		)
	)
		return "approval_scope";
	if (
		isInitialUserMessage ||
		/\b(?:please|can you|could you|do|implement|fix|add|change|review|analy[sz]e|use|prefer|must|should|need|want|has to|have to|let'?s|make)\b|\byou are (?:the|an?|a) .{0,80}\bagent\b|\bfocus\b.{0,120}\breturn\b/i.test(
			text,
		)
	)
		return "current_directive";
	return "historical_background";
}

function userAssertionAuthority(
	text: string,
	kind: UserAssertionKind,
): UserAssertionAuthority {
	if (kind === "likely_stale_noisy") return "historical_context";
	if (isUserReportedStateClaim(text))
		return "user_reported_state_requires_verification";
	if (kind === "historical_background") return "historical_context";
	return "intent_scope";
}

function normalizeUserAssertion(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function boundUserAssertionText(text: string, maxChars: number): string {
	const redacted = redactPromptSensitiveText(text);
	const normalized = normalizeUserAssertion(redacted);
	if (normalized.length <= maxChars) return normalized;
	const excerpts = intentExcerpts(normalized, USER_ASSERTION_SIGNAL_RE);
	const selected = excerpts.length > 0 ? excerpts.join(" ") : normalized;
	return boundWithOmissionMarker(selected, maxChars);
}

function buildUserAssertionEntry(
	entry: MessageEntry,
	isInitialUserMessage: boolean,
): UserAssertionTrailEntry | null {
	if (entry.message.role !== "user") return null;
	const rawText = extractText(entry.message.content).trim();
	if (!rawText) return null;
	const assertionText = extractUserAssertionSignalText(rawText);
	if (assertionText === null) return null;
	const kind = userAssertionKind(assertionText, isInitialUserMessage);
	if (kind === "likely_stale_noisy") return null;
	const authority = userAssertionAuthority(assertionText, kind);
	const staleRisk =
		authority === "user_reported_state_requires_verification"
			? "medium"
			: "low";
	return {
		entryId: entry.id,
		kind,
		authority,
		userAsserted: boundUserAssertionText(assertionText, 320),
		evidenceExcerpt: boundUserAssertionText(assertionText, 700),
		staleRisk,
		...(authority === "user_reported_state_requires_verification"
			? {
					staleReason:
						"User-reported runtime, filesystem, git, or verification state requires fresh verification before acting.",
				}
			: {}),
	};
}

function entryRenderLength(entry: UserAssertionTrailEntry): number {
	return [
		entry.entryId,
		entry.kind,
		entry.authority,
		entry.userAsserted,
		entry.evidenceExcerpt,
		entry.staleRisk,
		entry.staleReason ?? "",
		entry.supersededByEntryId ?? "",
	].join(" ").length;
}

function assertionPriority(
	entry: UserAssertionTrailEntry,
	index: number,
	lastIndex: number,
): number {
	if (entry.kind === "correction_supersession") return 0;
	if (entry.kind === "approval_scope") return 1;
	if (index === 0) return 2;
	if (entry.kind === "current_directive") return 3;
	if (entry.authority === "user_reported_state_requires_verification") return 4;
	if (entry.kind === "historical_background") return 5;
	return lastIndex - index + 6;
}

function significantAssertionTokens(text: string): Set<string> {
	const stopWords = new Set([
		"actually",
		"before",
		"instead",
		"should",
		"would",
		"could",
		"please",
		"validation",
	]);
	return new Set(
		text
			.toLowerCase()
			.match(/[a-z][a-z0-9_-]{3,}/g)
			?.filter((token) => !stopWords.has(token)) ?? [],
	);
}

function sharesUserAssertionTopic(left: string, right: string): boolean {
	if (sharesOverlapKey(left, right)) return true;
	const leftTokens = significantAssertionTokens(left);
	const rightTokens = significantAssertionTokens(right);
	let shared = 0;
	for (const token of leftTokens) {
		if (!rightTokens.has(token)) continue;
		shared += 1;
		if (shared >= 2) return true;
	}
	return false;
}

function markSupersededUserAssertions(
	entries: UserAssertionTrailEntry[],
): void {
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!entry) continue;
		for (
			let laterIndex = index + 1;
			laterIndex < entries.length;
			laterIndex += 1
		) {
			const later = entries[laterIndex];
			if (!later || later.kind !== "correction_supersession") continue;
			if (!sharesUserAssertionTopic(entry.userAsserted, later.userAsserted))
				continue;
			entry.staleRisk = "high";
			entry.staleReason = `Superseded by later user correction ${later.entryId}.`;
			entry.supersededByEntryId = later.entryId;
			break;
		}
	}
}

function mineUserAssertionTrail(
	compactedEntries: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	const firstUserIndex = compactedEntries.findIndex(
		(entry) => entry.message.role === "user",
	);
	const candidates = compactedEntries
		.map((entry, index) => ({
			entry: buildUserAssertionEntry(entry, index === firstUserIndex),
			index,
		}))
		.filter(
			(item): item is { entry: UserAssertionTrailEntry; index: number } =>
				item.entry !== null,
		);
	markSupersededUserAssertions(candidates.map((candidate) => candidate.entry));
	const lastIndex = compactedEntries.length - 1;
	const selected: Array<{ entry: UserAssertionTrailEntry; index: number }> = [];
	let usedChars = 0;
	for (const candidate of [...candidates].sort((left, right) => {
		const priorityDelta =
			assertionPriority(left.entry, left.index, lastIndex) -
			assertionPriority(right.entry, right.index, lastIndex);
		if (priorityDelta !== 0) return priorityDelta;
		return right.index - left.index;
	})) {
		const cost = entryRenderLength(candidate.entry);
		if (usedChars + cost > USER_ASSERTION_TRAIL_MAX_CHARS) continue;
		selected.push(candidate);
		usedChars += cost;
	}
	manifest.userAssertionTrail = selected
		.sort((left, right) => left.index - right.index)
		.map((candidate) => candidate.entry);
}

function mineBash(
	messages: MessageEntry[],
	manifest: SnapshotManifest,
	verificationIndex: Map<string, number>,
): void {
	for (
		let messageIndex = 0;
		messageIndex < messages.length;
		messageIndex += 1
	) {
		const entry = messages[messageIndex];
		if (!entry) continue;
		const message = entry.message;
		if (!isBashExecutionMessage(message)) continue;
		const label =
			`${message.command}${message.output ? `: ${message.output}` : ""}`.slice(
				0,
				500,
			);
		if (message.exitCode !== 0 && message.exitCode !== undefined) {
			manifest.errors.push({
				source: "bash",
				entryId: entry.id,
				unresolved: true,
				message: label,
			});
		}
		if (
			/\b(test|lint|typecheck|verify|pytest|node --test|npm test|pnpm test)\b/i.test(
				message.command,
			)
		) {
			addRecentVerification(manifest, verificationIndex, label, messageIndex);
		}
	}
}

function artifactRefsFromDetails(details: unknown): string[] {
	if (!isRecord(details)) return [];
	const artifacts = details.artifacts;
	if (!Array.isArray(artifacts)) return [];
	return artifacts.filter(
		(value): value is string => typeof value === "string",
	);
}

function previousArtifactRefs(entries: SessionEntry[]): string[] {
	const refs: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type !== "compaction" && entry.type !== "branch_summary")
			continue;
		for (const artifact of artifactRefsFromDetails(entry.details))
			addUnique(refs, artifact);
	}
	return refs.slice(-12);
}

function previousSummary(entries: SessionEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			isRecord(entry) &&
			(entry.type === "compaction" || entry.type === "branch_summary") &&
			typeof entry.summary === "string"
		) {
			return entry.summary;
		}
	}
	return null;
}

function knownRefs(manifest: SnapshotManifest): Set<string> {
	return new Set([
		...manifest.filesRead,
		...manifest.filesModified,
		...manifest.filesDeleted,
	]);
}

function addCriticalLiteralsFromText(
	manifest: SnapshotManifest,
	text: string,
): void {
	const normalizedText = text.replace(/\\n/g, "\n");
	const patterns = [
		/\b[A-Z][A-Z0-9_]*(?:SENTINEL[A-Z0-9_]*|_LEDGER)\b/g,
		/\b(?:TASK-[A-Z0-9_-]+|E_[A-Z0-9_]+)\b/g,
		/\b[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_|-]+\b/g,
		/\b[A-Za-z0-9_-]+\|[A-Za-z0-9_|-]+\b/g,
	];
	for (const pattern of patterns) {
		for (const match of normalizedText.matchAll(pattern))
			addUnique(manifest.criticalLiterals, match[0]);
	}

	const quoted = normalizedText.matchAll(/["'`]([^"'`\n]{3,180})["'`]/g);
	for (const match of quoted) {
		const literal = match[1];
		if (literal && /(?:TASK-|E_[A-Z0-9_]+|SENTINEL|_LEDGER|\|)/.test(literal)) {
			addUnique(manifest.criticalLiterals, literal);
		}
	}
	if (manifest.criticalLiterals.length > 80)
		manifest.criticalLiterals.length = 80;
}

function mineCriticalLiterals(
	messages: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	for (const entry of messages) {
		const message = entry.message;
		if ("content" in message)
			addCriticalLiteralsFromText(manifest, extractText(message.content));
		if (isBashExecutionMessage(message))
			addCriticalLiteralsFromText(
				manifest,
				`${message.command}\n${message.output ?? ""}`,
			);
	}
}

function addErrorOpenLoops(manifest: SnapshotManifest): void {
	for (const error of manifest.errors) {
		if (
			!manifest.openLoops.some((loop) =>
				loop.summary.includes(error.message.slice(0, 40)),
			)
		) {
			manifest.openLoops.push({
				summary: `Resolve error: ${error.message}`,
				entryId: error.entryId,
				priority: "high",
			});
		}
	}
}

function hasStaleLanguage(text: string): boolean {
	return /\b(fail(?:ed|ing)?|error|blocked|unresolved|need(?:s|ed)?|todo|next step|still need|must run|should run|required)\b/i.test(
		text,
	);
}

function hasResolvingLanguage(text: string): boolean {
	return /\b(pass(?:ed|es|ing)?|done|completed|fixed|verified|resolved|green|accepted|implemented)\b/i.test(
		text,
	);
}

function extractOverlapKeys(text: string): Set<string> {
	const keys = new Set<string>();
	const patterns = [
		/`([^`\n]{3,160})`/g,
		/\b(?:npm|pnpm|node|python|pytest|ruff|tsc|uv)\s+[A-Za-z0-9:_./-]+/g,
		/(?:^|\s)((?:\.?\.?\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_.-]+)?)/g,
		/\b[A-Z][A-Z0-9_]*(?:SENTINEL[A-Z0-9_]*|_LEDGER)\b/g,
		/\b(?:TASK-[A-Z0-9_-]+|E_[A-Z0-9_]+)\b/g,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const raw = match[1] ?? match[0];
			const normalized = raw.trim().toLowerCase();
			if (normalized.length >= 3) keys.add(normalized);
		}
	}
	return keys;
}

function sharesOverlapKey(left: string, right: string): boolean {
	const leftKeys = extractOverlapKeys(left);
	if (leftKeys.size === 0) return false;
	const rightKeys = extractOverlapKeys(right);
	for (const key of leftKeys) {
		if (rightKeys.has(key)) return true;
	}
	return false;
}

function entryIndexById(messages: MessageEntry[]): Map<string, number> {
	return new Map(messages.map((entry, index) => [entry.id, index]));
}

function evidenceIndex(
	serializedMessages: readonly string[],
	text: string,
): number | null {
	for (let index = 0; index < serializedMessages.length; index += 1) {
		const serialized = serializedMessages[index];
		if (serialized?.includes(text)) return index;
	}
	const keys = extractOverlapKeys(text);
	if (keys.size === 0) return null;
	for (let index = 0; index < serializedMessages.length; index += 1) {
		const serialized = serializedMessages[index];
		if (serialized && sharesOverlapKey(text, serialized)) return index;
	}
	return null;
}

function indexedEvidenceIndex(
	verificationIndex: ReadonlyMap<string, number>,
	serializedMessages: readonly string[],
	text: string,
): number | null {
	const indexed = verificationIndex.get(text);
	if (indexed !== undefined && indexed < serializedMessages.length)
		return indexed;
	return evidenceIndex(serializedMessages, text);
}

function addStaleSignals(
	manifest: SnapshotManifest,
	compactedEntries: MessageEntry[],
	serializedCompactedEntries: readonly string[],
	verificationIndex: ReadonlyMap<string, number>,
): void {
	const byId = entryIndexById(compactedEntries);
	const candidates: Array<{
		text: string;
		entryId?: string;
		index: number | null;
	}> = [
		...manifest.openLoops.map((loop) => ({
			text: loop.summary,
			entryId: loop.entryId,
			index: loop.entryId ? (byId.get(loop.entryId) ?? null) : null,
		})),
		...manifest.errors.map((error) => ({
			text: error.message,
			entryId: error.entryId,
			index: error.entryId ? (byId.get(error.entryId) ?? null) : null,
		})),
		...manifest.recentVerification.map((text) => ({
			text,
			index: indexedEvidenceIndex(
				verificationIndex,
				serializedCompactedEntries,
				text,
			),
		})),
	];
	const laterEvidence = [
		...manifest.latestUpdates.map((text) => ({
			text,
			index: evidenceIndex(serializedCompactedEntries, text),
		})),
		...manifest.recentVerification.map((text) => ({
			text,
			index: indexedEvidenceIndex(
				verificationIndex,
				serializedCompactedEntries,
				text,
			),
		})),
	];
	for (const candidate of candidates) {
		if (!hasStaleLanguage(candidate.text)) continue;
		const candidateIndex = candidate.index;
		if (candidateIndex === null) continue;
		const resolver = laterEvidence.find(
			(evidence) =>
				evidence.index !== null &&
				evidence.index > candidateIndex &&
				evidence.text !== candidate.text &&
				hasResolvingLanguage(evidence.text) &&
				sharesOverlapKey(candidate.text, evidence.text),
		);
		if (!resolver) continue;
		addUniqueByText(manifest.staleSignals, {
			text: candidate.text.slice(0, 500),
			reason: `Later evidence appears to supersede this item: ${resolver.text.slice(0, 300)}`,
			entryId: candidate.entryId,
		});
	}
}

async function evidenceIndexAsync(
	serializedMessages: readonly string[],
	text: string,
	scheduler: CooperativeScheduler,
): Promise<number | null> {
	for (let index = 0; index < serializedMessages.length; index += 1) {
		if (index % 25 === 0) await scheduler.checkpoint();
		const serialized = serializedMessages[index];
		if (serialized?.includes(text)) return index;
	}
	const keys = extractOverlapKeys(text);
	if (keys.size === 0) return null;
	for (let index = 0; index < serializedMessages.length; index += 1) {
		if (index % 25 === 0) await scheduler.checkpoint();
		const serialized = serializedMessages[index];
		if (serialized && sharesOverlapKey(text, serialized)) return index;
	}
	return null;
}

async function indexedEvidenceIndexAsync(
	verificationIndex: ReadonlyMap<string, number>,
	serializedMessages: readonly string[],
	text: string,
	scheduler: CooperativeScheduler,
): Promise<number | null> {
	const indexed = verificationIndex.get(text);
	if (indexed !== undefined && indexed < serializedMessages.length)
		return indexed;
	return evidenceIndexAsync(serializedMessages, text, scheduler);
}

async function addStaleSignalsAsync(
	manifest: SnapshotManifest,
	compactedEntries: MessageEntry[],
	serializedCompactedEntries: readonly string[],
	verificationIndex: ReadonlyMap<string, number>,
	scheduler: CooperativeScheduler,
): Promise<void> {
	const byId = entryIndexById(compactedEntries);
	const candidates: Array<{
		text: string;
		entryId?: string;
		index: number | null;
	}> = [];
	for (const loop of manifest.openLoops) {
		candidates.push({
			text: loop.summary,
			entryId: loop.entryId,
			index: loop.entryId ? (byId.get(loop.entryId) ?? null) : null,
		});
	}
	for (const error of manifest.errors) {
		candidates.push({
			text: error.message,
			entryId: error.entryId,
			index: error.entryId ? (byId.get(error.entryId) ?? null) : null,
		});
	}
	for (const text of manifest.recentVerification) {
		candidates.push({
			text,
			index: await indexedEvidenceIndexAsync(
				verificationIndex,
				serializedCompactedEntries,
				text,
				scheduler,
			),
		});
	}
	const laterEvidence: Array<{ text: string; index: number | null }> = [];
	for (const text of manifest.latestUpdates) {
		laterEvidence.push({
			text,
			index: await evidenceIndexAsync(
				serializedCompactedEntries,
				text,
				scheduler,
			),
		});
	}
	for (const text of manifest.recentVerification) {
		laterEvidence.push({
			text,
			index: await indexedEvidenceIndexAsync(
				verificationIndex,
				serializedCompactedEntries,
				text,
				scheduler,
			),
		});
	}
	for (let index = 0; index < candidates.length; index += 1) {
		if (index % 10 === 0) await scheduler.checkpoint();
		const candidate = candidates[index];
		if (candidate === undefined || !hasStaleLanguage(candidate.text)) continue;
		const candidateIndex = candidate.index;
		if (candidateIndex === null) continue;
		const resolver = laterEvidence.find(
			(evidence) =>
				evidence.index !== null &&
				evidence.index > candidateIndex &&
				evidence.text !== candidate.text &&
				hasResolvingLanguage(evidence.text) &&
				sharesOverlapKey(candidate.text, evidence.text),
		);
		if (!resolver) continue;
		addUniqueByText(manifest.staleSignals, {
			text: candidate.text.slice(0, 500),
			reason: `Later evidence appears to supersede this item: ${resolver.text.slice(0, 300)}`,
			entryId: candidate.entryId,
		});
	}
}

function mineLatestSignals(
	compactedEntries: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	for (const entry of compactedEntries.slice(-24)) {
		const message = entry.message;
		if (isBashExecutionMessage(message)) {
			const label = `${message.command}${message.output ? `: ${message.output}` : ""}`;
			if (
				message.exitCode === 0 &&
				/\b(test|lint|typecheck|check|pytest|ruff|tsc|basedpyright)\b/i.test(
					message.command,
				)
			) {
				addLatestSignal(manifest, "verification_success", label, entry.id);
			}
			if (message.exitCode !== 0 && message.exitCode !== undefined) {
				addLatestSignal(manifest, "verification_failure", label, entry.id);
			}
		}

		const text = serializeMessage(entry).trim();
		if (!text) continue;
		if (/\b(All checks passed|0 errors|passed|tests? passed)\b/i.test(text)) {
			addLatestSignal(manifest, "verification_success", text, entry.id);
		}
		if (/\b(FAILED|failed|exit code [1-9]|TypeError|Traceback)\b/i.test(text)) {
			addLatestSignal(manifest, "verification_failure", text, entry.id);
		}
		if (isExplicitFinalDeliveredSignal(text)) {
			addLatestSignal(manifest, "final_delivered", text, entry.id);
		} else if (isExplicitDeliverySignal(text)) {
			addLatestSignal(manifest, "delivered_output", text, entry.id);
		}
		if (isExplicitRiskSignal(text)) {
			addLatestSignal(manifest, "risk", text, entry.id);
		}
	}
}

function addBoundedUpdate(target: string[], entry: MessageEntry): void {
	const text = serializeMessage(entry).trim();
	if (!text) return;
	addUnique(
		target,
		text.length > 800 ? `${text.slice(0, 800)}… [truncated]` : text,
	);
}

function mineLatestUpdates(
	compactedEntries: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	for (const entry of compactedEntries.slice(-12))
		addBoundedUpdate(manifest.latestUpdates, entry);
}

function mineRetainedTailUpdates(
	retainedEntries: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	for (const entry of retainedEntries.slice(-8))
		addBoundedUpdate(manifest.retainedTailUpdates, entry);
}

function boundExchangeText(entry: MessageEntry): string {
	const text = serializeMessage(entry).trim();
	return text.length > 500 ? `${text.slice(0, 500)}… [truncated]` : text;
}

function isToolActivity(entry: MessageEntry): boolean {
	return ["bashExecution", "toolResult", "custom"].includes(entry.message.role);
}

function assistantHasToolCall(entry: MessageEntry): boolean {
	return (
		isAssistantMessage(entry.message) &&
		contentBlocks(entry.message.content).some(isToolCallBlock)
	);
}

function isSubstantiveAssistantResponse(entry: MessageEntry): boolean {
	return (
		isAssistantMessage(entry.message) &&
		extractText(entry.message.content).trim().length > 0
	);
}

function latestTerminalAssistantAfterLatestUser(
	messageEntries: MessageEntry[],
): MessageEntry | null {
	let latestUserIndex = -1;
	for (let index = messageEntries.length - 1; index >= 0; index -= 1) {
		if (messageEntries[index]?.message.role === "user") {
			latestUserIndex = index;
			break;
		}
	}
	if (latestUserIndex < 0) return null;

	const afterUser = messageEntries.slice(latestUserIndex + 1);
	let assistantResponse: MessageEntry | undefined;
	let assistantResponseOffset = -1;
	for (let index = afterUser.length - 1; index >= 0; index -= 1) {
		const entry = afterUser[index];
		if (entry && isSubstantiveAssistantResponse(entry)) {
			assistantResponse = entry;
			assistantResponseOffset = index;
			break;
		}
	}
	if (!assistantResponse || assistantHasToolCall(assistantResponse))
		return null;
	const afterAssistant = afterUser.slice(assistantResponseOffset + 1);
	return afterAssistant.some(isToolActivity) ? null : assistantResponse;
}

const DECISION_CRITICAL_LINE_RE =
	/^(?:[-*]\s*)?(?:final verdict|verdict|recommendation|recommended implementation|correct design|implementation|decision|risk|primary blocker\/risk|blocker|verification|verified|unverified|caveat|safe next steps?|next steps?|next action|do\s+\*{0,2}not|don'?t|must|should|commit only|don'?t commit|do\s+\*{0,2}not\s+commit|\d+\.)\b/i;
const DECISION_CRITICAL_INLINE_RE =
	/\b(?:final verdict|verdict|recommendation|recommended implementation|correct design|implementation|decision|risk|primary blocker\/risk|blocker|verification caveat|verified|unverified|caveat|safe next steps?|next steps?|next action|do\s+\*{0,2}not|don'?t|must|should|commit only|don'?t commit|do\s+\*{0,2}not\s+commit)\b/gi;

function sentenceWindow(line: string, index: number): string {
	const before = line.slice(0, index);
	const after = line.slice(index);
	const previousBoundary = Math.max(
		before.lastIndexOf(". "),
		before.lastIndexOf("! "),
		before.lastIndexOf("? "),
		before.lastIndexOf("; "),
	);
	const start = previousBoundary >= 0 ? previousBoundary + 2 : 0;
	const nextMatches = [". ", "! ", "? ", "; "]
		.map((token) => after.indexOf(token))
		.filter((value) => value >= 0);
	const nextBoundary = nextMatches.length ? Math.min(...nextMatches) : -1;
	const end = nextBoundary >= 0 ? index + nextBoundary + 1 : line.length;
	const sentence = line.slice(start, end).trim();
	if (sentence.length <= 1_000) return sentence;
	const center = index - start;
	const windowStart = Math.max(0, center - 500);
	return sentence.slice(windowStart, windowStart + 1_000).trim();
}

function decisionCriticalFinalAnswerLines(text: string): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const critical: string[] = [];
	for (const line of lines) {
		if (DECISION_CRITICAL_LINE_RE.test(line)) {
			critical.push(line);
			continue;
		}
		DECISION_CRITICAL_INLINE_RE.lastIndex = 0;
		for (const match of line.matchAll(DECISION_CRITICAL_INLINE_RE)) {
			if (match.index !== undefined)
				addUnique(critical, sentenceWindow(line, match.index));
		}
	}
	return critical;
}

function boundTerminalFinalAnswerText(entry: MessageEntry): string | null {
	if (!isAssistantMessage(entry.message)) return null;
	const text = extractText(entry.message.content).trim();
	if (!text) return null;
	if (text.length <= 6_000)
		return `Terminal latest assistant answer [${entry.id}] exact text:\n${text}`;

	const criticalLines = decisionCriticalFinalAnswerLines(text).join("\n");
	const head = text.slice(0, 1_200);
	const tail = text.slice(-1_200);
	const body = criticalLines
		? `Decision-critical lines extracted exactly:\n${criticalLines.slice(0, 3_600)}`
		: "No decision-critical lines matched; preserve head/tail and recover full retained answer if needed.";
	return `Terminal latest assistant answer [${entry.id}] bounded exact text:\n${head}\n\n${body}\n\n${tail}`;
}

function mineTerminalFinalAnswerEvidence(
	messageEntries: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	const terminalAssistant =
		latestTerminalAssistantAfterLatestUser(messageEntries);
	if (!terminalAssistant) return;
	addUnique(
		manifest.terminalFinalAnswerEvidence,
		boundTerminalFinalAnswerText(terminalAssistant),
	);
}

function mineLatestExchangeState(
	messageEntries: MessageEntry[],
	manifest: SnapshotManifest,
): void {
	let latestUserIndex = -1;
	for (let index = messageEntries.length - 1; index >= 0; index -= 1) {
		if (messageEntries[index]?.message.role === "user") {
			latestUserIndex = index;
			break;
		}
	}
	if (latestUserIndex < 0) return;
	const latestUser = messageEntries[latestUserIndex];
	if (latestUser)
		addUnique(
			manifest.latestExchangeState,
			`Latest user request: ${boundExchangeText(latestUser)}`,
		);
	const afterUser = messageEntries.slice(latestUserIndex + 1);
	let assistantResponse: MessageEntry | undefined;
	let assistantResponseOffset = -1;
	for (let index = afterUser.length - 1; index >= 0; index -= 1) {
		const entry = afterUser[index];
		if (entry && isSubstantiveAssistantResponse(entry)) {
			assistantResponse = entry;
			assistantResponseOffset = index;
			break;
		}
	}
	if (assistantResponse) {
		addUnique(
			manifest.latestExchangeState,
			`Latest user request has a subsequent assistant response: ${boundExchangeText(assistantResponse)}`,
		);
		const afterAssistant = afterUser.slice(assistantResponseOffset + 1);
		const toolRolesAfterAssistant = afterAssistant
			.filter((entry) =>
				["bashExecution", "toolResult", "custom"].includes(entry.message.role),
			)
			.map((entry) => entry.message.role);
		addUnique(
			manifest.latestExchangeState,
			`Tool activity after latest assistant response: ${toolRolesAfterAssistant.length > 0 ? [...new Set(toolRolesAfterAssistant)].join(", ") : "none"}`,
		);
		if (toolRolesAfterAssistant.length === 0) {
			addUnique(
				manifest.latestExchangeState,
				"No tool activity after latest assistant response; treat that response as the terminal latest state unless later user evidence reopens the task.",
			);
		}
	} else {
		addUnique(
			manifest.latestExchangeState,
			"Latest user request has no subsequent assistant response in the retained exchange.",
		);
	}
	const toolRoles = afterUser
		.filter((entry) =>
			["bashExecution", "toolResult", "custom"].includes(entry.message.role),
		)
		.map((entry) => entry.message.role);
	addUnique(
		manifest.latestExchangeState,
		`Tool activity after latest user request: ${toolRoles.length > 0 ? [...new Set(toolRoles)].join(", ") : "none"}`,
	);
}

function capArray<T>(items: T[], maxItems: number): T[] {
	return items.length > maxItems ? items.slice(-maxItems) : items;
}

function capArrayPreserveEdges<T>(items: T[], maxItems: number): T[] {
	if (items.length <= maxItems) return items;
	const headCount = Math.max(1, Math.floor(maxItems * 0.25));
	const tailCount = maxItems - headCount;
	return [...items.slice(0, headCount), ...items.slice(-tailCount)];
}

function capManifest(manifest: SnapshotManifest): void {
	manifest.filesRead = capArray(manifest.filesRead, 160);
	manifest.filesModified = capArray(manifest.filesModified, 160);
	manifest.filesDeleted = capArray(manifest.filesDeleted, 80);
	manifest.errors = capArray(manifest.errors, 80);
	manifest.userDecisions = capArrayPreserveEdges(manifest.userDecisions, 60);
	manifest.constraints = capArrayPreserveEdges(manifest.constraints, 60);
	manifest.openLoops = capArray(manifest.openLoops, 80);
	manifest.recentVerification = capArray(manifest.recentVerification, 80);
	manifest.latestUpdates = capArray(manifest.latestUpdates, 12);
	manifest.retainedTailUpdates = capArray(manifest.retainedTailUpdates, 8);
	manifest.latestExchangeState = capArray(manifest.latestExchangeState, 6);
	manifest.terminalFinalAnswerEvidence = capArray(
		manifest.terminalFinalAnswerEvidence,
		4,
	);
	manifest.latestSignals = capLatestSignals(manifest.latestSignals, 8);
	manifest.staleSignals = capArray(manifest.staleSignals, 40);
	manifest.userAssertionTrail = capArray(manifest.userAssertionTrail, 40);
	manifest.criticalLiterals = capArray(manifest.criticalLiterals, 80);
	if (manifest.previousSummary && manifest.previousSummary.length > 80_000) {
		const headChars = 24_000;
		const tailChars = 56_000;
		const omitted = manifest.previousSummary.length - headChars - tailChars;
		manifest.previousSummary = `${manifest.previousSummary.slice(0, headChars)}\n\n[... Slipstream omitted ${omitted.toLocaleString()} characters from the middle of the previous summary. ...]\n\n${manifest.previousSummary.slice(-tailChars)}`;
	}
}

function canStartKeptContext(entry: MessageEntry | undefined): boolean {
	if (!entry) return false;
	return !isToolResultMessage(entry.message);
}

function findSafeKeepFromIndex(
	messageEntries: MessageEntry[],
	preferredIndex: number,
): number {
	for (let index = preferredIndex; index < messageEntries.length; index += 1) {
		if (canStartKeptContext(messageEntries[index])) return index;
	}
	return messageEntries.length;
}

function estimateEntryTokens(entry: MessageEntry): number {
	return Math.ceil(serializeMessage(entry).length / 4);
}

function tokenTailKeepFromIndex(
	messageEntries: MessageEntry[],
	keepRecentTokens: number,
): number {
	let accumulatedTokens = 0;
	for (let index = messageEntries.length - 1; index >= 0; index -= 1) {
		const entry = messageEntries[index];
		if (!entry) continue;
		accumulatedTokens += estimateEntryTokens(entry);
		if (accumulatedTokens >= keepRecentTokens) return index;
	}
	return 0;
}

async function tokenTailKeepFromIndexAsync(
	messageEntries: MessageEntry[],
	keepRecentTokens: number,
	scheduler: CooperativeScheduler,
): Promise<number> {
	let accumulatedTokens = 0;
	for (let index = messageEntries.length - 1; index >= 0; index -= 1) {
		if (index % 25 === 0) await scheduler.checkpoint();
		const entry = messageEntries[index];
		if (!entry) continue;
		accumulatedTokens += estimateEntryTokens(entry);
		if (accumulatedTokens >= keepRecentTokens) return index;
	}
	return 0;
}

async function serializeMessagesAsync(
	entries: MessageEntry[],
	scheduler: CooperativeScheduler,
): Promise<string[]> {
	const serialized: string[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		if (index % 25 === 0) await scheduler.checkpoint();
		const entry = entries[index];
		if (entry) serialized.push(serializeMessage(entry));
	}
	return serialized;
}

export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
	const messageEntries = input.branchEntries.filter(isMessageEntry);
	const keepCount = Math.max(0, input.keepRecentEntryCount ?? 8);
	const requestedKeepFromIndex = input.firstKeptEntryId
		? messageEntries.findIndex((entry) => entry.id === input.firstKeptEntryId)
		: -1;
	const preferredKeepFromIndex =
		requestedKeepFromIndex >= 0
			? requestedKeepFromIndex
			: typeof input.keepRecentTokens === "number"
				? tokenTailKeepFromIndex(
						messageEntries,
						Math.max(0, input.keepRecentTokens),
					)
				: Math.max(0, messageEntries.length - keepCount);
	const keepFromIndex = findSafeKeepFromIndex(
		messageEntries,
		preferredKeepFromIndex,
	);
	const compactedEntries = messageEntries.slice(0, keepFromIndex);
	const retainedEntries = messageEntries.slice(keepFromIndex);
	const firstKeptEntryId = messageEntries[keepFromIndex]?.id ?? null;
	const triggerEntryId = messageEntries[messageEntries.length - 1]?.id ?? null;

	const manifest: SnapshotManifest = {
		filesRead: [],
		filesModified: [],
		filesDeleted: [],
		errors: [],
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
		userAssertionTrail: [],
		criticalLiterals: [],
		previousSummary: previousSummary(input.branchEntries),
		artifactRefs: previousArtifactRefs(input.branchEntries),
		knownFileRefs: new Set<string>(),
	};

	const verificationIndex = new Map<string, number>();
	classifyToolOps(messageEntries, manifest);
	mineTextFacts(messageEntries, manifest, verificationIndex);
	mineBash(messageEntries, manifest, verificationIndex);
	mineCriticalLiterals(messageEntries, manifest);
	mineLatestSignals(messageEntries, manifest);
	mineLatestUpdates(compactedEntries, manifest);
	mineUserAssertionTrail(compactedEntries, manifest);
	mineRetainedTailUpdates(retainedEntries, manifest);
	mineLatestExchangeState(messageEntries, manifest);
	mineTerminalFinalAnswerEvidence(messageEntries, manifest);
	addErrorOpenLoops(manifest);
	const serializedCompactedEntries = compactedEntries.map(serializeMessage);
	addStaleSignals(
		manifest,
		compactedEntries,
		serializedCompactedEntries,
		verificationIndex,
	);
	capManifest(manifest);
	manifest.knownFileRefs = knownRefs(manifest);

	return {
		sessionId: input.sessionId ?? "unknown",
		cwd: input.cwd ?? ".",
		triggerEntryId,
		firstKeptEntryId,
		tokensBefore: input.tokensBefore ?? null,
		summaryInputMessages: serializedCompactedEntries,
		keptBoundary: { keepFromIndex, firstKeptEntryId },
		manifest,
	};
}

export async function buildSnapshotAsync(
	input: BuildSnapshotInput,
	options: BuildSnapshotAsyncOptions = {},
): Promise<Snapshot> {
	const scheduler =
		options.scheduler ?? createCooperativeScheduler({ signal: options.signal });
	const messageEntries = input.branchEntries.filter(isMessageEntry);
	await scheduler.checkpoint(true);
	const keepCount = Math.max(0, input.keepRecentEntryCount ?? 8);
	const requestedKeepFromIndex = input.firstKeptEntryId
		? messageEntries.findIndex((entry) => entry.id === input.firstKeptEntryId)
		: -1;
	const preferredKeepFromIndex =
		requestedKeepFromIndex >= 0
			? requestedKeepFromIndex
			: typeof input.keepRecentTokens === "number"
				? await tokenTailKeepFromIndexAsync(
						messageEntries,
						Math.max(0, input.keepRecentTokens),
						scheduler,
					)
				: Math.max(0, messageEntries.length - keepCount);
	await scheduler.checkpoint();
	const keepFromIndex = findSafeKeepFromIndex(
		messageEntries,
		preferredKeepFromIndex,
	);
	const compactedEntries = messageEntries.slice(0, keepFromIndex);
	const retainedEntries = messageEntries.slice(keepFromIndex);
	const firstKeptEntryId = messageEntries[keepFromIndex]?.id ?? null;
	const triggerEntryId = messageEntries[messageEntries.length - 1]?.id ?? null;

	const manifest: SnapshotManifest = {
		filesRead: [],
		filesModified: [],
		filesDeleted: [],
		errors: [],
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
		userAssertionTrail: [],
		criticalLiterals: [],
		previousSummary: previousSummary(input.branchEntries),
		artifactRefs: previousArtifactRefs(input.branchEntries),
		knownFileRefs: new Set<string>(),
	};

	const verificationIndex = new Map<string, number>();
	classifyToolOps(messageEntries, manifest);
	await scheduler.checkpoint();
	mineTextFacts(messageEntries, manifest, verificationIndex);
	await scheduler.checkpoint();
	mineBash(messageEntries, manifest, verificationIndex);
	await scheduler.checkpoint();
	mineCriticalLiterals(messageEntries, manifest);
	await scheduler.checkpoint();
	mineLatestSignals(messageEntries, manifest);
	await scheduler.checkpoint();
	mineLatestUpdates(compactedEntries, manifest);
	mineUserAssertionTrail(compactedEntries, manifest);
	mineRetainedTailUpdates(retainedEntries, manifest);
	await scheduler.checkpoint();
	mineLatestExchangeState(messageEntries, manifest);
	mineTerminalFinalAnswerEvidence(messageEntries, manifest);
	addErrorOpenLoops(manifest);
	await scheduler.checkpoint();
	const serializedCompactedEntries = await serializeMessagesAsync(
		compactedEntries,
		scheduler,
	);
	await addStaleSignalsAsync(
		manifest,
		compactedEntries,
		serializedCompactedEntries,
		verificationIndex,
		scheduler,
	);
	capManifest(manifest);
	manifest.knownFileRefs = knownRefs(manifest);

	return {
		sessionId: input.sessionId ?? "unknown",
		cwd: input.cwd ?? ".",
		triggerEntryId,
		firstKeptEntryId,
		tokensBefore: input.tokensBefore ?? null,
		summaryInputMessages: serializedCompactedEntries,
		keptBoundary: { keepFromIndex, firstKeptEntryId },
		manifest,
	};
}
