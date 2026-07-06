import { parseJudgeResult } from "./judge.ts";
import type { CompleteJudgeFn, CompleteTextFn } from "./types.ts";

type ModelLike = { provider: string; id: string };
type ModelRegistryLike = {
	find(provider: string, id: string): ModelLike | undefined;
	getApiKeyAndHeaders(model: ModelLike): Promise<{
		ok?: boolean;
		error?: string;
		apiKey?: string;
		headers?: Record<string, string>;
	}>;
};
type ModelContext = { model?: ModelLike; modelRegistry: ModelRegistryLike };

const MODEL_CALL_TIMEOUT_MS = 300_000;

type CompleteModule = {
	complete(
		model: ModelLike,
		body: {
			messages: Array<{
				role: "user";
				content: Array<{ type: "text"; text: string }>;
			}>;
		},
		options: {
			apiKey?: string;
			headers?: Record<string, string>;
			maxTokens: number;
			signal?: AbortSignal;
		},
	): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

function resolveModel(ctx: ModelContext, configuredModel?: string): ModelLike {
	if (configuredModel) {
		const [provider, ...rest] = configuredModel.split("/");
		const id = rest.join("/");
		if (!provider || !id)
			throw new Error(
				`Configured model must be provider/id: ${configuredModel}`,
			);
		const found = ctx.modelRegistry.find(provider, id);
		if (!found)
			throw new Error(`Configured model not found: ${configuredModel}`);
		return found;
	}
	if (!ctx.model)
		throw new Error("No active model available for Slipstream compaction");
	return ctx.model;
}

async function completePrompt(
	ctx: ModelContext,
	configuredModel: string | undefined,
	prompt: string,
	signal?: AbortSignal,
): Promise<string> {
	const model = resolveModel(ctx, configuredModel);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false)
		throw new Error(`Model auth failed: ${auth.error ?? "unknown error"}`);
	if (
		!auth.apiKey &&
		(!auth.headers || Object.keys(auth.headers).length === 0)
	) {
		throw new Error(
			`No API key or headers available for ${model.provider}/${model.id}`,
		);
	}
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) abortFromParent();
		else signal.addEventListener("abort", abortFromParent, { once: true });
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const mod = (await import("@earendil-works/pi-ai/compat")) as CompleteModule;
		const response = await Promise.race([
			mod.complete(
				model,
				{
					messages: [
						{ role: "user", content: [{ type: "text", text: prompt }] },
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 8192,
					signal: controller.signal,
				},
			),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					controller.abort(
						new Error(
							`Slipstream model call timed out after ${MODEL_CALL_TIMEOUT_MS}ms`,
						),
					);
					reject(
						new Error(
							`Slipstream model call timed out after ${MODEL_CALL_TIMEOUT_MS}ms`,
						),
					);
				}, MODEL_CALL_TIMEOUT_MS);
			}),
		]);
		return response.content
			.filter(
				(block): block is { type: "text"; text: string } =>
					block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join("\n")
			.trim();
	} finally {
		if (timeout) clearTimeout(timeout);
		if (signal) signal.removeEventListener("abort", abortFromParent);
	}
}

export function createSummaryCompleter(
	ctx: ModelContext,
	configuredModel?: string,
): CompleteTextFn {
	return (prompt, signal) =>
		completePrompt(ctx, configuredModel, prompt, signal);
}

export function createJudgeCompleter(
	ctx: ModelContext,
	configuredModel?: string,
): CompleteJudgeFn {
	return async (prompt, signal) => {
		const rawText = await completePrompt(ctx, configuredModel, prompt, signal);
		return { rawText, result: parseJudgeResult(rawText) };
	};
}
