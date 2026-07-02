import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildSnapshot,
	buildSnapshotAsync,
	extractText,
} from "../src/snapshot.ts";
import { buildSummaryPrompt } from "../src/summary.ts";
import type { AgentMessage, SessionEntry, Snapshot } from "../src/types.ts";

function msg(id: string, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-05-26T00:00:00.000Z",
		message,
	};
}

function normalizeSnapshot(snapshot: Snapshot): unknown {
	return {
		...snapshot,
		manifest: {
			...snapshot.manifest,
			knownFileRefs: [...snapshot.manifest.knownFileRefs].sort(),
		},
	};
}

describe("snapshot", () => {
	it("async snapshot matches sync snapshot output", async () => {
		const entries: SessionEntry[] = [
			msg("u1", {
				role: "user",
				content: "Goal: fix stale TASK-123. Constraint: preserve E_IMPORTANT.",
			}),
			msg("a1", {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: "/repo/src/a.ts" },
					},
				],
			}),
			msg("tr1", {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "E_IMPORTANT is in code" }],
				isError: false,
			}),
			msg("b1", {
				role: "bashExecution",
				command: "npm test",
				output: "failed then later passed",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			}),
			msg("u2", {
				role: "user",
				content: "TASK-123 is resolved now; next action is review.",
			}),
		];

		const input = {
			branchEntries: entries,
			keepRecentEntryCount: 1,
			sessionId: "s1",
			cwd: "/repo",
			tokensBefore: 10_000,
		};
		const syncSnapshot = buildSnapshot(input);
		const asyncSnapshot = await buildSnapshotAsync(input);

		assert.deepEqual(
			normalizeSnapshot(asyncSnapshot),
			normalizeSnapshot(syncSnapshot),
		);
	});

	it("async snapshot checkpoints during large compacted serialization", async () => {
		const entries: SessionEntry[] = [];
		for (let index = 0; index < 150; index += 1) {
			entries.push(
				msg(`u${index}`, {
					role: "user",
					content: `Need implementation item ${index} with TOKEN_${index}.`,
				}),
			);
			entries.push(
				msg(`a${index}`, {
					role: "assistant",
					content: `Completed item ${index}. ${"x".repeat(1_000)}`,
				}),
			);
		}
		let checkpoints = 0;
		const scheduler = {
			async checkpoint(): Promise<void> {
				checkpoints += 1;
				await new Promise<void>((resolve) => setImmediate(resolve));
			},
		};

		const snapshot = await buildSnapshotAsync(
			{ branchEntries: entries, keepRecentEntryCount: 1 },
			{ scheduler },
		);

		assert.equal(snapshot.summaryInputMessages.length > 0, true);
		assert.equal(checkpoints > 5, true);
	});

	it("carries previous compaction artifact references into the next snapshot", () => {
		const entries: SessionEntry[] = [
			msg("u1", { role: "user", content: "start" }),
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2026-05-26T00:01:00.000Z",
				summary: "previous summary",
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				details: { artifacts: ["/repo/.scratch/compactions/run-1"] },
			},
			msg("u2", { role: "user", content: "continue" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.deepEqual(snapshot.manifest.artifactRefs, [
			"/repo/.scratch/compactions/run-1",
		]);
		assert.equal(snapshot.manifest.previousSummary, "previous summary");
	});

	it("extracts full-path file operations from normal and parallel tool calls", () => {
		const entries: SessionEntry[] = [
			msg("u1", {
				role: "user",
				content: "Implement it. Must preserve comments.",
			}),
			msg("a1", {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: "/repo/src/SKILL.md" },
					},
					{
						type: "toolCall",
						id: "parallel-1",
						name: "multi_tool_use.parallel",
						arguments: {
							tool_uses: [
								{
									id: "edit-1",
									recipient_name: "functions.edit",
									parameters: { path: "/repo/docs/SKILL.md" },
								},
								{
									id: "write-1",
									recipient_name: "functions.write",
									parameters: { path: "/repo/src/new.ts" },
								},
							],
						},
					},
				],
			}),
			msg("tr1", {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			}),
			msg("te1", {
				role: "toolResult",
				toolCallId: "edit-1",
				toolName: "edit",
				content: [{ type: "text", text: "edited" }],
				isError: false,
			}),
			msg("tw1", {
				role: "toolResult",
				toolCallId: "write-1",
				toolName: "write",
				content: [{ type: "text", text: "wrote" }],
				isError: false,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.deepEqual(snapshot.manifest.filesRead, ["/repo/src/SKILL.md"]);
		assert.deepEqual(snapshot.manifest.filesModified, [
			"/repo/docs/SKILL.md",
			"/repo/src/new.ts",
		]);
		assert.equal(
			snapshot.manifest.constraints.some((c) =>
				c.text.includes("Must preserve comments"),
			),
			true,
		);
	});

	it("tracks unresolved errors, bash failures, previous summaries, and open loops", () => {
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: "2026-05-26T00:00:00.000Z",
				summary: "Earlier summary",
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
			},
			msg("u1", {
				role: "user",
				content: "Use Slipstream primary. Next step is implementation.",
			}),
			msg("b1", {
				role: "bashExecution",
				command: "npm test",
				output: "failed",
				exitCode: 1,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			}),
			msg("a1", {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "edit-1",
						name: "edit",
						arguments: { path: "/repo/src/index.ts" },
					},
				],
			}),
			msg("t1", {
				role: "toolResult",
				toolCallId: "edit-1",
				toolName: "edit",
				content: [{ type: "text", text: "oldText did not match" }],
				isError: true,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 2,
		});

		assert.equal(snapshot.manifest.previousSummary, "Earlier summary");
		assert.equal(snapshot.manifest.errors.length, 2);
		assert.equal(
			snapshot.manifest.errors.some((e) => e.message.includes("npm test")),
			true,
		);
		assert.equal(
			snapshot.manifest.errors.some((e) =>
				e.message.includes("oldText did not match"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.userDecisions.some((d) =>
				d.text.includes("Use Slipstream primary"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.openLoops.some((l) => l.summary.includes("Next step")),
			true,
		);
	});

	it("caps mined user intent text before storing protected manifest facts", () => {
		const middleConstraint = "Critical middle instruction: Must use WAL mode.";
		const hugeUserText = `Use Slipstream primary. Only use mature libs. Next step is implementation. ${"X".repeat(350_000)} ${middleConstraint} ${"X".repeat(350_000)} END_MARKER`;
		const snapshot = buildSnapshot({
			branchEntries: [msg("u1", { role: "user", content: hugeUserText })],
			keepRecentEntryCount: 0,
		});

		const minedTexts = [
			...snapshot.manifest.userDecisions.map((decision) => decision.text),
			...snapshot.manifest.constraints.map((constraint) => constraint.text),
			...snapshot.manifest.openLoops.map((loop) => loop.summary),
		];
		assert.equal(minedTexts.length, 3);
		for (const text of minedTexts) {
			assert.equal(text.length <= 1_000, true);
			assert.match(text, /Slipstream omitted/);
		}
		assert.equal(
			snapshot.manifest.constraints.some((constraint) =>
				constraint.text.includes(middleConstraint),
			),
			true,
		);
		const prompt = buildSummaryPrompt(snapshot, {
			maxConversationChars: 0,
			maxPromptChars: 20_000,
		});
		assert.match(prompt, /Critical middle instruction: Must use WAL mode/);
	});

	it("builds a bounded compacted-away user assertion trail without retained-tail duplication", () => {
		const hugePastedDoc = `Reference docs only:\n${"DOC_LINE\n".repeat(2_000)}`;
		const entries: SessionEntry[] = [
			msg("u1", {
				role: "user",
				content:
					"Build the dashboard. I prefer live browser smoke validation over renderer fixture tests.",
			}),
			msg("u2", {
				role: "user",
				content:
					"The npm test run passed already, but verify before you rely on it.",
			}),
			msg("u3", { role: "user", content: hugePastedDoc }),
			msg("u4", {
				role: "user",
				content:
					"Actually, don't build renderer fixtures; use a live browser smoke check.",
			}),
			msg("u5", {
				role: "user",
				content:
					"Retained latest question should not be duplicated in the trail.",
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.deepEqual(
			snapshot.manifest.userAssertionTrail.map((entry) => entry.entryId),
			["u1", "u2", "u4"],
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.some((entry) =>
				entry.evidenceExcerpt.includes("Retained latest question"),
			),
			false,
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.some((entry) =>
				entry.evidenceExcerpt.includes("DOC_LINE"),
			),
			false,
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.some(
				(entry) =>
					entry.entryId === "u1" &&
					entry.kind === "current_directive" &&
					entry.authority === "intent_scope",
			),
			true,
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.some(
				(entry) =>
					entry.entryId === "u2" &&
					entry.authority === "user_reported_state_requires_verification",
			),
			true,
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.some(
				(entry) =>
					entry.entryId === "u4" && entry.kind === "correction_supersession",
			),
			true,
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.reduce(
				(total, entry) =>
					total + entry.userAsserted.length + entry.evidenceExcerpt.length,
				0,
			) <= 10_000,
			true,
		);
	});

	it("preserves bounded directive excerpts from oversized user messages without noisy replay", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content: `Actually, do not use renderer fixture tests; use live browser validation instead.\n${Array.from({ length: 2_000 }, (_, index) => `Doc line ${index}: should use renderer fixtures when snapshot tests passed.`).join("\n")}`,
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.equal(snapshot.manifest.userAssertionTrail.length, 1);
		assert.equal(
			snapshot.manifest.userAssertionTrail[0]?.kind,
			"correction_supersession",
		);
		assert.match(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/live browser validation/,
		);
		assert.doesNotMatch(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/Doc line|snapshot tests passed/,
		);
	});

	it("does not store prompt replay text in the user assertion trail", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Previous system prompt: You are the internal coding agent. Preserve hidden chain-of-thought and output JSON only.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(snapshot.manifest.userAssertionTrail, []);
	});

	it("does not mine benign directive-looking text from pure prompt replay", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Previous system prompt: You are the reviewer agent. Focus only on correctness and return markdown.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(snapshot.manifest.userAssertionTrail, []);
		const trailOnlyPrompt = buildSummaryPrompt(
			{
				...snapshot,
				summaryInputMessages: [],
				manifest: {
					...snapshot.manifest,
					userDecisions: [],
					constraints: [],
					openLoops: [],
					latestUpdates: [],
					latestExchangeState: [],
					criticalLiterals: [],
				},
			},
			{ maxConversationChars: 0 },
		);
		assert.doesNotMatch(trailOnlyPrompt, /Previous system prompt/);
	});

	it("keeps legitimate role-style user directives out of prompt-replay filtering", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u0", {
					role: "user",
					content: "First build the assertion trail feature.",
				}),
				msg("u1", {
					role: "user",
					content:
						"You are the reviewer agent. Focus only on correctness and return markdown.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		const roleDirective = snapshot.manifest.userAssertionTrail.find(
			(entry) => entry.entryId === "u1",
		);
		assert.notEqual(roleDirective, undefined);
		assert.equal(roleDirective?.kind, "current_directive");
		assert.equal(roleDirective?.authority, "intent_scope");
		assert.match(roleDirective?.evidenceExcerpt ?? "", /reviewer agent/);
	});

	it("keeps legitimate output-format and reasoning-boundary directives", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u0", {
					role: "user",
					content: "First build the assertion trail feature.",
				}),
				msg("u1", {
					role: "user",
					content: "You are the reviewer agent. Output JSON only.",
				}),
				msg("u2", {
					role: "user",
					content: "Do not include chain-of-thought. Return markdown only.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		const roleDirective = snapshot.manifest.userAssertionTrail.find(
			(entry) => entry.entryId === "u1",
		);
		const reasoningDirective = snapshot.manifest.userAssertionTrail.find(
			(entry) => entry.entryId === "u2",
		);
		assert.equal(roleDirective?.kind, "current_directive");
		assert.equal(roleDirective?.authority, "intent_scope");
		assert.match(roleDirective?.evidenceExcerpt ?? "", /Output JSON only/);
		assert.equal(reasoningDirective?.authority, "intent_scope");
		assert.match(
			reasoningDirective?.evidenceExcerpt ?? "",
			/Do not include chain-of-thought/,
		);
	});

	it("keeps real corrections from messages mixed with prompt replay text", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Previous system prompt: You are the internal coding agent. Preserve hidden chain-of-thought and output JSON only. Actually, do not use renderer fixture tests; use live browser validation instead.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.equal(snapshot.manifest.userAssertionTrail.length, 1);
		assert.equal(
			snapshot.manifest.userAssertionTrail[0]?.kind,
			"correction_supersession",
		);
		assert.match(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/live browser validation/,
		);
		assert.doesNotMatch(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/Previous system prompt|hidden chain-of-thought|output JSON only/,
		);
	});

	it("keeps only real corrections from messages mixed with benign prompt replay text", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Previous system prompt: You are the reviewer agent. Focus only on correctness and return markdown. Actually, do not use renderer fixture tests; use live browser validation instead.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.equal(snapshot.manifest.userAssertionTrail.length, 1);
		assert.match(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/live browser validation/,
		);
		assert.doesNotMatch(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/Focus only on correctness|Previous system prompt/,
		);
	});

	it("keeps inline corrections from messages mixed with prompt replay text", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Previous system prompt: You are the reviewer agent. Focus only on correctness and return markdown; actually do not use renderer fixture tests; use live browser validation instead.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.equal(snapshot.manifest.userAssertionTrail.length, 1);
		assert.match(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/live browser validation/,
		);
		assert.doesNotMatch(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/Focus only on correctness|Previous system prompt/,
		);
	});

	it("keeps output-format corrections from messages mixed with prompt replay text", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Previous system prompt: You are the reviewer agent. Actually, output JSON only.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.equal(snapshot.manifest.userAssertionTrail.length, 1);
		assert.match(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/output JSON only/i,
		);
		assert.doesNotMatch(
			snapshot.manifest.userAssertionTrail[0]?.evidenceExcerpt ?? "",
			/Previous system prompt|reviewer agent/,
		);
	});

	it("does not let synthetic excerpt provenance affect supersession", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Previous system prompt: You are the reviewer agent. Actually, do not use renderer fixture tests; use live browser validation instead.",
				}),
				msg("u2", {
					role: "user",
					content:
						"Previous system prompt: You are the reviewer agent. Actually, do not rename README headings; keep the existing section titles.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(
			snapshot.manifest.userAssertionTrail.map((entry) => entry.staleRisk),
			["low", "low"],
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.some((entry) =>
				entry.userAsserted.includes("Selected user assertion excerpts"),
			),
			false,
		);
	});

	it("redacts secret-shaped values before storing user assertion trail excerpts", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"Use OPENWEBUI_ADMIN_PASSWORD=supersecretvalue, but do not print the password in prompts.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		const rendered = snapshot.manifest.userAssertionTrail
			.map((entry) => `${entry.userAsserted}\n${entry.evidenceExcerpt}`)
			.join("\n");
		assert.doesNotMatch(rendered, /supersecretvalue/);
		assert.match(rendered, /OPENWEBUI_ADMIN_PASSWORD=\[REDACTED\]/);
	});

	it("marks filesystem and path assertions as user-reported state requiring verification", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"The filesystem already contains docs/plan.md from the last run.",
				}),
				msg("u2", {
					role: "user",
					content: "README.md already exists in the repo.",
				}),
				msg("u3", {
					role: "user",
					content: "./src/index.ts changed already.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(
			snapshot.manifest.userAssertionTrail.map((entry) => entry.authority),
			[
				"user_reported_state_requires_verification",
				"user_reported_state_requires_verification",
				"user_reported_state_requires_verification",
			],
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.every(
				(entry) => entry.staleRisk === "medium",
			),
			true,
		);
	});

	it("does not mark generic path file or repository intent as verification-required state", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content: "The path forward is to refactor snapshot.ts first.",
				}),
				msg("u2", {
					role: "user",
					content: "File scope is limited to README updates.",
				}),
				msg("u3", {
					role: "user",
					content: "The repository is internal-only.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(
			snapshot.manifest.userAssertionTrail.map((entry) => entry.authority),
			["intent_scope", "intent_scope", "intent_scope"],
		);
	});

	it("does not mark modal path file or repository directives as verification-required state", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content: "The repository has to stay internal-only.",
				}),
				msg("u2", {
					role: "user",
					content: "The file has to stay in src/.",
				}),
				msg("u3", {
					role: "user",
					content: "The path has to be ./docs/plan.md.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(
			snapshot.manifest.userAssertionTrail.map((entry) => entry.authority),
			["intent_scope", "intent_scope", "intent_scope"],
		);
	});

	it("does not mark concrete file or path modal directives as verification-required state", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content: "README.md has to stay in docs/.",
				}),
				msg("u2", {
					role: "user",
					content: "./docs/plan.md has to stay checked in.",
				}),
				msg("u3", {
					role: "user",
					content: "src/index.ts has to stay untouched.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(
			snapshot.manifest.userAssertionTrail.map((entry) => entry.authority),
			["intent_scope", "intent_scope", "intent_scope"],
		);
	});

	it("marks mixed concrete state claims and modal directives as verification-required", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content:
						"README.md already exists in docs/ and has to stay checked in.",
				}),
				msg("u2", {
					role: "user",
					content: "README.md is in docs/ and has to stay checked in.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(
			snapshot.manifest.userAssertionTrail.map((entry) => entry.authority),
			[
				"user_reported_state_requires_verification",
				"user_reported_state_requires_verification",
			],
		);
		assert.equal(
			snapshot.manifest.userAssertionTrail.every(
				(entry) => entry.staleRisk === "medium",
			),
			true,
		);
	});

	it("marks older compacted-away user assertions superseded by later corrections", () => {
		const snapshot = buildSnapshot({
			branchEntries: [
				msg("u1", {
					role: "user",
					content: "Use renderer fixture tests for validation.",
				}),
				msg("u2", {
					role: "user",
					content:
						"Actually, do not use renderer fixture tests; use live browser validation instead.",
				}),
			],
			keepRecentEntryCount: 0,
		});

		const first = snapshot.manifest.userAssertionTrail.find(
			(entry) => entry.entryId === "u1",
		);
		assert.equal(first?.staleRisk, "high");
		assert.equal(first?.supersededByEntryId, "u2");
		assert.match(first?.staleReason ?? "", /superseded/i);
	});

	it("protects exact critical literals from tests and tool output", () => {
		const entries = [
			msg("u1", {
				role: "user",
				content:
					"Preserve NATURAL_PRODUCT_LEDGER, BIG_OUTPUT_SENTINEL_0000, and E_RETRYABLE behavior.",
			}),
			msg("t1", {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [
					{
						type: "text",
						text: 'assert.equal(summarizeItems(result), "TASK-1:high:alpha|shared|gamma\\nTASK-2:high:beta");',
					},
				],
				isError: false,
			}),
		];

		const snapshot = buildSnapshot({ branchEntries: entries });

		assert.equal(
			snapshot.manifest.criticalLiterals.includes("NATURAL_PRODUCT_LEDGER"),
			true,
		);
		assert.equal(
			snapshot.manifest.criticalLiterals.includes("BIG_OUTPUT_SENTINEL_0000"),
			true,
		);
		assert.equal(
			snapshot.manifest.criticalLiterals.includes("E_RETRYABLE"),
			true,
		);
		assert.equal(
			snapshot.manifest.criticalLiterals.includes(
				"TASK-1:high:alpha|shared|gamma",
			),
			true,
		);
		assert.equal(
			snapshot.manifest.criticalLiterals.includes("TASK-2:high:beta"),
			true,
		);
	});

	it("does not mark newer failures stale from older passing evidence", () => {
		const entries = [
			msg("a1", {
				role: "assistant",
				content: "Earlier verification: `npm test` passed.",
			}),
			msg("b1", {
				role: "bashExecution",
				command: "npm test",
				output: "failed",
				exitCode: 1,
				cancelled: false,
				truncated: false,
			}),
			msg("u1", { role: "user", content: "kept question" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(snapshot.manifest.staleSignals.length, 0);
		assert.equal(
			snapshot.manifest.recentVerification.some((verification) =>
				verification.includes("failed"),
			),
			true,
		);
	});

	it("marks conservative stale signals without removing original evidence", () => {
		const entries = [
			msg("u1", {
				role: "user",
				content: "Next step: run `npm test` before finishing.",
			}),
			msg("b1", {
				role: "bashExecution",
				command: "npm test",
				output: "failed",
				exitCode: 1,
				cancelled: false,
				truncated: false,
			}),
			msg("a1", {
				role: "assistant",
				content: "Completed verification: `npm test` passed after the fix.",
			}),
			msg("u2", { role: "user", content: "kept question" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.staleSignals.some((signal) =>
				signal.text.includes("npm test"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.openLoops.some((loop) =>
				loop.summary.includes("npm test"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.recentVerification.some((verification) =>
				verification.includes("failed"),
			),
			true,
		);
	});

	it("protects latest compacted updates before the kept boundary", () => {
		const entries = [
			msg("u1", { role: "user", content: "start" }),
			msg("a1", {
				role: "assistant",
				content:
					"Earlier work changed setup, but this should be less important than the final update.",
			}),
			msg("a2", {
				role: "assistant",
				content:
					"Final recommendation: switch auto summary to gpt-5.4-mini if timeouts recur and reserve gpt-5.5 for manual checkpoints.",
			}),
			msg("u2", { role: "user", content: "kept question" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(snapshot.firstKeptEntryId, "u2");
		assert.equal(
			snapshot.manifest.latestUpdates.some((update) =>
				update.includes("reserve gpt-5.5 for manual checkpoints"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestUpdates.some((update) =>
				update.includes("kept question"),
			),
			false,
		);
	});

	it("extracts newest verification and risk signals before the kept boundary", () => {
		const entries = [
			msg("u1", { role: "user", content: "start" }),
			msg("b1", {
				role: "bashExecution",
				command: "npm run check",
				output: "All checks passed! 0 errors, 0 warnings",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			}),
			msg("a1", {
				role: "assistant",
				content:
					"Review written. Primary blocker/risk: git status came from wrapper CWD, so verify repo state before editing.",
			}),
			msg("u2", { role: "user", content: "kept question" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.latestSignals.some(
				(signal) =>
					signal.kind === "verification_success" &&
					signal.text.includes("All checks passed"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestSignals.some(
				(signal) =>
					signal.kind === "delivered_output" &&
					signal.text.includes("Review written"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestSignals.some(
				(signal) =>
					signal.kind === "risk" && signal.text.includes("wrapper CWD"),
			),
			true,
		);
	});

	it("extracts final-delivered state without treating planned delivery as complete", () => {
		const entries = [
			msg("u1", { role: "user", content: "start audit" }),
			msg("a1", {
				role: "assistant",
				content:
					"I should deliver the final answer after checking one more file.",
			}),
			msg("a2", {
				role: "assistant",
				content:
					"Final audit answer was already sent to the user. No further action unless the user asks a follow-up.",
			}),
			msg("u2", { role: "user", content: "kept question" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.latestSignals.some(
				(signal) =>
					signal.kind === "final_delivered" &&
					signal.text.includes("Final audit answer was already sent"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestSignals.some((signal) =>
				signal.text.includes("I should deliver the final answer"),
			),
			false,
		);
	});

	it("extracts final-delivered state from the retained tail", () => {
		const entries = [
			msg("u1", { role: "user", content: "start audit" }),
			msg("a1", {
				role: "assistant",
				content:
					"I should deliver the final answer after checking one more file.",
			}),
			msg("a2", {
				role: "assistant",
				content:
					"Final audit answer was already sent to the user. No further action unless the user asks a follow-up.",
			}),
			msg("u2", { role: "user", content: "kept question" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 2,
		});

		assert.deepEqual(snapshot.summaryInputMessages, [
			"[user u1]: start audit",
			"[assistant a1]: I should deliver the final answer after checking one more file.",
		]);
		assert.equal(
			snapshot.manifest.latestSignals.some(
				(signal) =>
					signal.kind === "final_delivered" &&
					signal.text.includes("Final audit answer was already sent"),
			),
			true,
		);
	});

	it("summarizes the latest user assistant exchange state", () => {
		const entries = [
			msg("u1", { role: "user", content: "review deploy risk" }),
			msg("b1", {
				role: "bashExecution",
				command: "git diff --stat",
				output: "backend/docker-compose.yml | 2 +",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			}),
			msg("a1", {
				role: "assistant",
				content:
					"I would not deploy until the unrelated AWS_PROFILE compose change is removed or confirmed intentional.",
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 2,
		});

		assert.equal(
			snapshot.manifest.latestExchangeState.some((signal) =>
				signal.includes("Latest user request: [user u1]: review deploy risk"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestExchangeState.some((signal) =>
				signal.includes("has a subsequent assistant response"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestExchangeState.some((signal) =>
				signal.includes("Tool activity after latest assistant response: none"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestExchangeState.some((signal) =>
				signal.includes("treat that response as the terminal latest state"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestExchangeState.some((signal) =>
				signal.includes(
					"Tool activity after latest user request: bashExecution",
				),
			),
			true,
		);
	});

	it("does not treat a blank assistant placeholder as a response to the latest user", () => {
		const entries = [
			msg("u1", { role: "user", content: "please review the current state" }),
			msg("a1", { role: "assistant", content: "" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 2,
		});

		assert.equal(
			snapshot.manifest.latestExchangeState.some((signal) =>
				signal.includes("has no subsequent assistant response"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.latestExchangeState.some((signal) =>
				signal.includes("has a subsequent assistant response"),
			),
			false,
		);
		assert.equal(snapshot.manifest.terminalFinalAnswerEvidence.length, 0);
	});

	it("protects exact terminal assistant final-answer evidence beyond retained-tail truncation", () => {
		const longSetup = "Context line. ".repeat(90);
		const entries = [
			msg("u1", { role: "user", content: "can I commit this version?" }),
			msg("a1", {
				role: "assistant",
				content: `${longSetup}\nFinal verdict: commit only the nested pi-slipstream-compact package.\nRisk: do not commit root /home/orestes/.config/pi because unrelated dirty files are present.\nVerification caveat: npm run check passed with 87 tests and tsc --noEmit, but the remaining limitation is final-answer/source-tail retention.\nSafe next steps:\n1. Commit the stable package boundary.\n2. Then implement deterministic final-answer retention in a follow-up change.`,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.retainedTailUpdates.some((update) =>
				update.includes("Final verdict: commit only"),
			),
			false,
		);
		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes(
					"Final verdict: commit only the nested pi-slipstream-compact package",
				),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes("Risk: do not commit root /home/orestes/.config/pi"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes(
					"Verification caveat: npm run check passed with 87 tests",
				),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes(
					"2. Then implement deterministic final-answer retention",
				),
			),
			true,
		);
	});

	it("extracts markdown-emphasized decision-critical lines from very long terminal answers", () => {
		const middle = "Neutral analysis filler. ".repeat(350);
		const entries = [
			msg("u1", { role: "user", content: "deploy?" }),
			msg("a1", {
				role: "assistant",
				content: `Intro. ${"A".repeat(1300)}\n${middle}\n- Do **not** deploy until the unrelated AWS_PROFILE change is removed.\n- Verification caveat: checks passed, but deployment risk is not runtime-validated.\n${"Z".repeat(1300)}`,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes(
					"Do **not** deploy until the unrelated AWS_PROFILE change is removed",
				),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes("Verification caveat: checks passed"),
			),
			true,
		);
	});

	it("extracts mid-paragraph decision-critical sentences from very long terminal answers", () => {
		const entries = [
			msg("u1", { role: "user", content: "deploy?" }),
			msg("a1", {
				role: "assistant",
				content: `${"A".repeat(2500)} This is the key sentence: do not deploy until the scaling policy min=2/max=2 mismatch is reconciled with ECS running 1 task. ${"B".repeat(2500)} Another key sentence: verification caveat is that checks passed locally but live deployment state was not runtime-validated. ${"C".repeat(2500)}`,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes(
					"do not deploy until the scaling policy min=2/max=2 mismatch is reconciled",
				),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes("verification caveat is that checks passed locally"),
			),
			true,
		);
	});

	it("extracts implementation recommendations from very long terminal answers", () => {
		const entries = [
			msg("u1", { role: "user", content: "why not include both?" }),
			msg("a1", {
				role: "assistant",
				content: `${"A".repeat(2500)}\nCorrect design: do not recompute the index score inside the lambda from raw tasks.\nRecommended implementation:\n1. Store/upload the filtered FABv2 index final-view JSON alongside the full final-view JSON.\n2. Extend the shared lambda input layout to emit results.vals_index.\n${"B".repeat(2500)}`,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes(
					"Correct design: do not recompute the index score inside the lambda",
				),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.terminalFinalAnswerEvidence.some((evidence) =>
				evidence.includes(
					"Store/upload the filtered FABv2 index final-view JSON",
				),
			),
			true,
		);
	});

	it("does not protect an assistant tool-call turn as terminal final-answer evidence", () => {
		const entries = [
			msg("u1", { role: "user", content: "check this" }),
			msg("a1", {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I will inspect the file before giving a final verdict.",
					},
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: "/repo/file.ts" },
					},
				],
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.deepEqual(snapshot.manifest.terminalFinalAnswerEvidence, []);
	});

	it("does not protect an assistant answer as terminal when tool activity follows it", () => {
		const entries = [
			msg("u1", { role: "user", content: "is this done?" }),
			msg("a1", {
				role: "assistant",
				content:
					"Final verdict: maybe done, but I am about to run verification.",
			}),
			msg("b1", {
				role: "bashExecution",
				command: "npm run check",
				output: "tests failed",
				exitCode: 1,
				cancelled: false,
				truncated: false,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 0,
		});

		assert.deepEqual(snapshot.manifest.terminalFinalAnswerEvidence, []);
	});

	it("preserves bash execution outcome and empty output semantics", () => {
		const entries = [
			msg("u1", { role: "user", content: "copy this command" }),
			msg("b1", {
				role: "bashExecution",
				command:
					"printf '%s\\n' 'git config --global core.excludesFile ~/.gitignore_global' | wl-copy",
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 0,
		});

		assert.equal(
			snapshot.summaryInputMessages.some((message) =>
				message.includes("[Bash b1 exit=0 cancelled=false truncated=false]"),
			),
			true,
		);
		assert.equal(
			snapshot.summaryInputMessages.some((message) =>
				message.includes("[no stdout]"),
			),
			true,
		);
	});

	it("filters ambiguous latest risk chatter while preserving explicit blocker signals", () => {
		const entries = [
			msg("u1", { role: "user", content: "start" }),
			msg("a1", {
				role: "assistant",
				content:
					"This is a broad caveat: the code may be unverified and there might be risk somewhere, but no concrete blocker is known.",
			}),
			msg("a2", {
				role: "assistant",
				content:
					"Primary blocker/risk: git status came from wrapper CWD, so verify repo state before editing.",
			}),
			msg("u2", { role: "user", content: "kept question" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			snapshot.manifest.latestSignals.some((signal) =>
				signal.text.includes("broad caveat"),
			),
			false,
		);
		assert.equal(
			snapshot.manifest.latestSignals.some(
				(signal) =>
					signal.kind === "risk" && signal.text.includes("wrapper CWD"),
			),
			true,
		);
	});

	it("caps latest signals while preferring verification evidence over generic risk", () => {
		const entries: SessionEntry[] = [
			msg("u1", { role: "user", content: "start" }),
		];
		for (let index = 0; index < 12; index += 1) {
			entries.push(
				msg(`a-risk-${index}`, {
					role: "assistant",
					content: `Primary blocker/risk: concrete risk ${index} affects /repo/src/file-${index}.ts.`,
				}),
			);
		}
		entries.push(
			msg("b-pass", {
				role: "bashExecution",
				command: "npm run check",
				output: "All checks passed! 0 errors, 0 warnings",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			}),
		);
		entries.push(msg("u2", { role: "user", content: "kept question" }));

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(snapshot.manifest.latestSignals.length <= 8, true);
		assert.equal(
			snapshot.manifest.latestSignals.some(
				(signal) =>
					signal.kind === "verification_success" &&
					signal.text.includes("All checks passed"),
			),
			true,
		);
	});

	it("does not include kept messages in the compacted summary span", () => {
		const entries = [
			msg("u1", { role: "user", content: "first" }),
			msg("a1", { role: "assistant", content: "second" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 8,
		});

		assert.deepEqual(snapshot.summaryInputMessages, []);
		assert.equal(snapshot.firstKeptEntryId, "u1");
	});

	it("never chooses a tool result as the first kept entry", () => {
		const entries = [
			msg("u1", { role: "user", content: "start" }),
			msg("a1", {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "write-1",
						name: "write",
						arguments: { path: "state.txt", content: "x" },
					},
				],
			}),
			msg("t1", {
				role: "toolResult",
				toolCallId: "write-1",
				toolName: "write",
				content: [{ type: "text", text: "wrote" }],
				isError: false,
			}),
			msg("a2", { role: "assistant", content: "done" }),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 2,
		});

		assert.equal(snapshot.firstKeptEntryId, "a2");
		assert.equal(
			snapshot.summaryInputMessages.some((line) => line.includes("[Tool t1")),
			true,
		);
	});

	it("does not collapse hidden absolute paths into fabricated basename checks", () => {
		const entries: SessionEntry[] = [
			msg("a1", {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "read-1",
						name: "read",
						arguments: { path: "/home/orestes/.config/pi/settings.json" },
					},
				],
			}),
			msg("t1", {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			}),
		];

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 0,
		});
		assert.deepEqual(snapshot.manifest.filesRead, [
			"/home/orestes/.config/pi/settings.json",
		]);
		assert.equal(snapshot.manifest.knownFileRefs.has("settings.json"), false);
		assert.equal(
			snapshot.manifest.knownFileRefs.has(
				"/home/orestes/.config/pi/settings.json",
			),
			true,
		);
	});

	it("caps noisy manifest collections for huge historical sessions", () => {
		const entries: SessionEntry[] = [];
		for (let index = 0; index < 200; index += 1) {
			entries.push(
				msg(`u${index}`, {
					role: "user",
					content: `Must verify item ${index}. Next step is test ${index}.`,
				}),
			);
			entries.push({
				type: "compaction",
				id: `c${index}`,
				parentId: null,
				timestamp: "2026-05-26T00:00:00.000Z",
				summary: `Previous summary ${index} ${"x".repeat(500)}`,
				firstKeptEntryId: `u${index}`,
				tokensBefore: 1000,
			});
		}

		const snapshot = buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(snapshot.manifest.constraints.length <= 60, true);
		assert.equal(
			snapshot.manifest.constraints.some((constraint) =>
				constraint.text.includes("item 0"),
			),
			true,
		);
		assert.equal(
			snapshot.manifest.constraints.some((constraint) =>
				constraint.text.includes("item 199"),
			),
			true,
		);
		assert.equal(snapshot.manifest.openLoops.length <= 80, true);
		assert.equal(snapshot.manifest.recentVerification.length <= 80, true);
		assert.equal(
			(snapshot.manifest.previousSummary?.length ?? 0) <= 80_200,
			true,
		);
	});

	it("does not rescan the full compacted history for every stale-signal candidate", () => {
		let contentReads = 0;
		const entries: SessionEntry[] = [];
		for (let index = 0; index < 120; index += 1) {
			entries.push(
				msg(`failed-${index}`, {
					role: "assistant",
					get content() {
						contentReads += 1;
						return `Verification for \`npm test -- case-${index}\` failed and still needs follow-up.`;
					},
				}),
			);
			entries.push(
				msg(`passed-${index}`, {
					role: "assistant",
					get content() {
						contentReads += 1;
						return `Completed verification: \`npm test -- case-${index}\` passed after the fix.`;
					},
				}),
			);
		}

		buildSnapshot({
			branchEntries: entries,
			keepRecentEntryCount: 1,
		});

		assert.equal(
			contentReads < 2_000,
			true,
			`expected bounded content reads, got ${contentReads}`,
		);
	});

	it("extracts readable text from structured content without hidden thinking", () => {
		assert.equal(
			extractText([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "hidden" },
			]),
			"hello",
		);
	});
});
