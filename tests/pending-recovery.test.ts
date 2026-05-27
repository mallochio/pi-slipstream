import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	handleSlipstreamCommand,
	recoverPendingArtifact,
} from "../src/commands.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createRuntimeState } from "../src/session-state.ts";

const cwd = process.cwd();

function message(id: string, role: "user" | "assistant", content: string) {
	return {
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "t",
		message: { role, content },
	};
}

async function makeRoot(): Promise<string> {
	const parent = join(cwd, ".scratch", "test-tmp");
	await mkdir(parent, { recursive: true });
	return mkdtemp(join(parent, "slipstream-recovery-"));
}

async function writePending(root: string, dirName: string, value: unknown) {
	const dir = join(root, dirName);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "pending.json"),
		`${JSON.stringify(value, null, 2)}\n`,
	);
}

function pending(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "s-recover",
		cwd,
		projectId: cwd,
		summary: "## Goal\nRecovered",
		firstKeptEntryId: "a1",
		validatedThroughEntryId: "a1",
		tokensBefore: 100,
		details: { judge: { score: 9 }, artifacts: [] },
		expiresAt: 1_500,
		...overrides,
	};
}

async function adopt(root: string) {
	const state = createRuntimeState({ now: 1_000 });
	let compactCalls = 0;
	const result = await handleSlipstreamCommand(
		"compact --adopt",
		state,
		{
			...DEFAULT_CONFIG,
			artifactRoot: root,
			pendingTtlMs: 1_000,
		},
		{
			cwd,
			compact: () => {
				compactCalls += 1;
			},
			sessionManager: {
				getSessionId: () => "s-recover",
				getBranch: () => [
					message("u1", "user", "old"),
					message("a1", "assistant", "head"),
				],
			},
		},
		{ now: () => 1_000 },
	);
	return { result, state, compactCalls };
}

describe("pending artifact recovery", () => {
	it("recovers artifact directories that use sanitized session id prefixes", async () => {
		const root = await makeRoot();
		try {
			const sessionId = "session/with:bad";
			await writePending(
				root,
				"session-with-bad-current",
				pending({ sessionId }),
			);

			const recovered = await recoverPendingArtifact(
				root,
				sessionId,
				cwd,
				1_000,
				1_000,
			);

			assert.equal(recovered?.sessionId, sessionId);
			assert.equal(recovered?.summary, "## Goal\nRecovered");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers pending artifacts with unknown token counts", async () => {
		const root = await makeRoot();
		try {
			await writePending(
				root,
				"s-recover-null-tokens",
				pending({ tokensBefore: null }),
			);

			const recovered = await recoverPendingArtifact(
				root,
				"s-recover",
				cwd,
				1_000,
				1_000,
			);

			assert.equal(recovered?.tokensBefore, null);
			assert.equal(recovered?.firstKeptEntryId, "a1");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores recovered artifacts whose JSON sessionId does not match", async () => {
		const root = await makeRoot();
		try {
			await writePending(
				root,
				"s-recover-wrong-json",
				pending({ sessionId: "other" }),
			);

			const { result, compactCalls } = await adopt(root);

			assert.equal(result.ok, false);
			assert.equal(compactCalls, 0);
			assert.match(result.message, /No unexpired validated Slipstream summary/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores recovered artifacts with malformed field shapes", async () => {
		const root = await makeRoot();
		try {
			await writePending(
				root,
				"s-recover-details-string",
				pending({ details: "bad" }),
			);
			await writePending(
				root,
				"s-recover-expires-string",
				pending({ expiresAt: "1500" }),
			);
			await writePending(
				root,
				"s-recover-head-number",
				pending({ validatedThroughEntryId: 12 }),
			);
			await writePending(
				root,
				"s-recover-summary-null",
				pending({ summary: null }),
			);

			const { result, compactCalls } = await adopt(root);

			assert.equal(result.ok, false);
			assert.equal(compactCalls, 0);
			assert.match(result.message, /No unexpired validated Slipstream summary/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers the newest valid artifact by expiresAt while ignoring expired and future-ttl candidates", async () => {
		const root = await makeRoot();
		try {
			await writePending(
				root,
				"s-recover-old",
				pending({
					summary: "## Goal\nOld",
					validatedThroughEntryId: "old-head",
					expiresAt: 1_100,
				}),
			);
			await writePending(
				root,
				"s-recover-expired",
				pending({ summary: "## Goal\nExpired", expiresAt: 900 }),
			);
			await writePending(
				root,
				"s-recover-future",
				pending({ summary: "## Goal\nFuture", expiresAt: 2_001 }),
			);
			await writePending(
				root,
				"s-recover-newest",
				pending({ summary: "## Goal\nNewest", expiresAt: 1_900 }),
			);

			const { result, state, compactCalls } = await adopt(root);

			assert.equal(result.ok, true);
			assert.equal(compactCalls, 1);
			assert.equal(state.status, "summarizing");
			assert.equal(state.pending?.summary, "## Goal\nNewest");
			assert.match(
				result.message,
				/Queued compaction with validated Slipstream summary/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
