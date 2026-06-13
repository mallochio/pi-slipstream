import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactPromptSensitiveText } from "../src/redaction.ts";

describe("prompt redaction", () => {
	it("redacts bearer headers, PEM blocks, and colon-delimited secret values", () => {
		const redacted = redactPromptSensitiveText(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456
apiKey: "sk-abcdefghijklmnopqrstuvwxyz"
-----BEGIN CERTIFICATE-----
MIIFAKECERTDATA0123456789
-----END CERTIFICATE-----`);

		assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz123456/);
		assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
		assert.doesNotMatch(redacted, /MIIFAKECERTDATA0123456789/);
		assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
		assert.match(redacted, /apiKey: \[REDACTED\]/);
		assert.match(redacted, /\[REDACTED certificate\/private-key block\]/);
	});

	it("redacts common secret-store retrieval commands", () => {
		const redacted = redactPromptSensitiveText(`aws secretsmanager get-secret-value --secret-id OPENAI_API_KEY
op read op://prod/openai/OPENAI_API_KEY
security find-generic-password -w -s OPENAI_API_KEY
pass show OPENAI_API_KEY`);

		assert.doesNotMatch(redacted, /aws secretsmanager/);
		assert.doesNotMatch(redacted, /op:\/\/prod/);
		assert.doesNotMatch(redacted, /security find-generic-password/);
		assert.doesNotMatch(redacted, /pass show/);
		assert.equal(
			(redacted.match(/\[REDACTED secret-retrieval command/g) ?? []).length,
			4,
		);
		assert.match(redacted, /OPENAI_API_KEY/);
	});
});
