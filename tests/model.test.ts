import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSummaryCompleter } from "../src/model.ts";

describe("model completers", () => {
	it("fails directly when model auth has no api key or headers", async () => {
		const complete = createSummaryCompleter({
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({}),
			},
		});

		await assert.rejects(() => complete("prompt"), /No API key or headers/);
	});

	it("fails when configured model is not registered", async () => {
		const complete = createSummaryCompleter(
			{
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => undefined,
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
			},
			"missing/model",
		);

		await assert.rejects(
			() => complete("prompt"),
			/Configured model not found/,
		);
	});

	it("fails when no active or configured model is available", async () => {
		const complete = createSummaryCompleter({
			modelRegistry: {
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
		});

		await assert.rejects(() => complete("prompt"), /No active model/);
	});

	it("propagates explicit model auth failures", async () => {
		const complete = createSummaryCompleter({
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ ok: false, error: "denied" }),
			},
		});

		await assert.rejects(() => complete("prompt"), /Model auth failed: denied/);
	});
});
