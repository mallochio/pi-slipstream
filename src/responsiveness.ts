export type CooperativeScheduler = {
	checkpoint(force?: boolean): Promise<void>;
};

export type CooperativeSchedulerOptions = {
	intervalMs?: number;
	signal?: AbortSignal;
};

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Operation aborted");
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortReason(signal);
}

export function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const handle = setImmediate(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		});
		const onAbort = () => {
			clearImmediate(handle);
			reject(signal ? abortReason(signal) : new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function createCooperativeScheduler(
	options: CooperativeSchedulerOptions = {},
): CooperativeScheduler {
	const intervalMs = options.intervalMs ?? 12;
	let lastYieldAt = Date.now();
	return {
		async checkpoint(force = false): Promise<void> {
			throwIfAborted(options.signal);
			const now = Date.now();
			if (!force && now - lastYieldAt < intervalMs) return;
			await yieldToEventLoop(options.signal);
			lastYieldAt = Date.now();
		},
	};
}
