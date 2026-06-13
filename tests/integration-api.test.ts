import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	slipstreamStyleValidateAndRepair,
	type ValidateOnlyInput,
} from "pi-slipstream-compact/integration-api";

function input(overrides: Partial<ValidateOnlyInput> = {}): ValidateOnlyInput {
	return {
		candidate: "## Goal\nContinue the integration work.",
		sourceEvidence: {
			sourceMessageExcerpts: [
				"User approved adding replaceDefaultCompact and integration-api.",
			],
			filesModified: ["src/integration-api.ts"],
			unresolvedErrors: [],
			userDecisions: ["Keep the API artifact-free by default."],
			constraints: ["Do not call ctx.compact from the integration API."],
		},
		continuation: ["Next: implement tests first."],
		completeText: async () =>
			JSON.stringify({
				score: 9,
				decision: "accept",
				missing: [],
				contradictions: [],
				diagnosis: "ready",
			}),
		...overrides,
	};
}

describe("integration api", () => {
	it("accepts a caller-provided candidate without writing artifacts", async () => {
		const prompts: string[] = [];
		const result = await slipstreamStyleValidateAndRepair(
			input({
				completeText: async (prompt) => {
					prompts.push(prompt);
					return JSON.stringify({
						score: 8,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "candidate preserves the evidence",
					});
				},
			}),
		);

		assert.equal(result.accepted, true);
		assert.equal(result.repaired, false);
		assert.equal(result.repairCount, 0);
		assert.equal(result.score, 8);
		assert.equal(result.summary, "## Goal\nContinue the integration work.");
		assert.equal(prompts.length, 1);
		assert.match(prompts[0] ?? "", /artifact-free integration API/);
		assert.match(prompts[0] ?? "", /safe score-8/);
		assert.match(prompts[0] ?? "", /Live\/manual\/browser\/API\/integration\/smoke/);
		assert.match(prompts[0] ?? "", /secret-shaped/);
		assert.match(prompts[0] ?? "", /auth\/cert\/key\/deletion\/deploy/);
		assert.match(prompts[0] ?? "", /wrong current dirty-state/);
		assert.match(prompts[0] ?? "", /terminal-vs-pending/);
		assert.match(prompts[0] ?? "", /stale current-state/);
		assert.match(prompts[0] ?? "", /src\/integration-api\.ts/);
	});

	it("redacts secret retrieval commands and env values from external judge prompts", async () => {
		const prompts: string[] = [];
		await slipstreamStyleValidateAndRepair(
			input({
				sourceEvidence: {
					sourceMessageExcerpts: [
						"Run grep '^OPENWEBUI_ADMIN_PASSWORD=' .env | cut -d= -f2- | wl-copy.",
					],
					latestUpdates: ["WEBUI_SECRET_KEY=dev-smoke-secret"],
				},
				candidate:
					"Continuation card:\n- Current task: Continue.\n\nOPENWEBUI_ADMIN_PASSWORD=supersecretvalue",
				completeText: async (prompt) => {
					prompts.push(prompt);
					return JSON.stringify({
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ready",
					});
				},
			}),
		);

		assert.equal(prompts.length > 0, true);
		const combinedPrompts = prompts.join("\n---\n");
		assert.doesNotMatch(combinedPrompts, /wl-copy/);
		assert.doesNotMatch(combinedPrompts, /dev-smoke-secret/);
		assert.doesNotMatch(combinedPrompts, /supersecretvalue/);
		assert.match(combinedPrompts, /OPENWEBUI_ADMIN_PASSWORD=\[REDACTED\]/);
		assert.match(combinedPrompts, /WEBUI_SECRET_KEY=\[REDACTED\]/);
	});

	it("repairs and rejudges a rejected external candidate", async () => {
		let calls = 0;
		const result = await slipstreamStyleValidateAndRepair(
			input({
				completeText: async (prompt) => {
					calls += 1;
					if (calls === 1) {
						assert.match(prompt, /Judge the candidate summary/);
						return JSON.stringify({
							score: 4,
							decision: "reject",
							missing: ["Missing artifact-free constraint"],
							contradictions: [],
							diagnosis: "too sparse",
						});
					}
					if (calls === 2) {
						assert.match(prompt, /Rewrite the full candidate summary/);
						assert.match(prompt, /Missing artifact-free constraint/);
						assert.match(prompt, /Live\/manual\/browser\/API\/integration\/smoke/);
						assert.match(prompt, /Redact secret-shaped values/);
						assert.match(prompt, /auth\/cert\/key\/deletion\/deploy/);
						assert.match(prompt, /wrong current dirty-state/);
						assert.match(prompt, /terminal-vs-pending/);
						assert.match(prompt, /stale current-state/);
						assert.match(prompt, /Continuation card:/);
						assert.match(prompt, /if your draft starts with ## Goal or any deterministic capsule/);
						assert.match(prompt, /model-facing handoff under roughly 100-150 lines/);
						assert.match(prompt, /Do not include both a verbatim terminal answer and a synthesized restatement/);
						assert.match(prompt, /flatten copied markdown headings/);
						assert.match(prompt, /\| Check \| Status \| Freshness \| Relevance \|/);
						return "Continuation card:\n- Current task: Continue.\n\n## Goal\nContinue.\n\n## Constraints\n- Do not call ctx.compact from the integration API.";
					}
					assert.match(prompt, /Do not call ctx\.compact/);
					return JSON.stringify({
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "repair preserved the constraint",
					});
				},
				config: { judgeThreshold: 7, repairAttempts: 2 },
			}),
		);

		assert.equal(result.accepted, true);
		assert.equal(result.repaired, true);
		assert.equal(result.repairCount, 1);
		assert.equal(result.score, 9);
		assert.match(result.summary, /^Continuation card:/);
		assert.match(result.summary, /Do not call ctx\.compact/);
		assert.equal(calls, 3);
	});

	it("hard-rejects secret-shaped candidate text even when judge accepts", async () => {
		const result = await slipstreamStyleValidateAndRepair(
			input({
				candidate:
					'Continuation card:\n- Current task: Continue.\n\nSynthetic secret example: OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz"',
				completeText: async () =>
					JSON.stringify({
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "judge missed candidate secret",
					}),
				config: { repairAttempts: 0 },
			}),
		);

		assert.equal(result.accepted, false);
		assert.equal(result.repaired, false);
		assert.equal(result.score, 9);
	});

	it("respects repairAttempts zero", async () => {
		let calls = 0;
		const result = await slipstreamStyleValidateAndRepair(
			input({
				completeText: async () => {
					calls += 1;
					return JSON.stringify({
						score: 4,
						decision: "reject",
						missing: ["needs repair"],
						contradictions: [],
						diagnosis: "below threshold",
					});
				},
				config: { repairAttempts: 0 },
			}),
		);

		assert.equal(result.accepted, false);
		assert.equal(result.repaired, false);
		assert.equal(result.repairCount, 0);
		assert.equal(result.score, 4);
		assert.equal(calls, 1);
	});

	it("respects repairEnabled false", async () => {
		let calls = 0;
		const result = await slipstreamStyleValidateAndRepair(
			input({
				completeText: async () => {
					calls += 1;
					return JSON.stringify({
						score: 4,
						decision: "reject",
						missing: ["needs repair"],
						contradictions: [],
						diagnosis: "below threshold",
					});
				},
				config: { repairEnabled: false, repairAttempts: 3 },
			}),
		);

		assert.equal(result.accepted, false);
		assert.equal(result.repaired, false);
		assert.equal(result.repairCount, 0);
		assert.equal(result.score, 4);
		assert.equal(calls, 1);
	});
});
