const SECRET_NAME_PATTERN =
	"[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|BEARER|CERTIFICATE|CERT)[A-Z0-9_]*";
const SECRET_KEYWORD_RE =
	/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|BEARER|CERTIFICATE|CERT)/i;
const SECRET_NAME_RE = new RegExp(SECRET_NAME_PATTERN, "gi");
const SECRET_ASSIGNMENT_RE =
	/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|BEARER|CERTIFICATE|CERT)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s'"`|;&]+)/gi;
const SECRET_COLON_RE =
	/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|BEARER|CERTIFICATE|CERT)[A-Z0-9_]*)\s*:\s*(?:"[^"]*"|'[^']*'|[^\s'"`|;&]+)/gi;
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const PEM_BLOCK_RE =
	/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/gi;
const SECRET_RETRIEVAL_TOOL_RE =
	/\b(?:grep|awk|sed|cut|printenv|env|echo|cat|aws\s+secretsmanager|op\s+read|security\s+find-generic-password|pass\s+show)\b/i;

function secretNames(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(SECRET_NAME_RE)) {
		if (match[0]) names.add(match[0].toUpperCase());
	}
	return [...names];
}

function redactLine(line: string): string {
	if (!SECRET_KEYWORD_RE.test(line)) return line;
	const names = secretNames(line);
	if (names.length > 0 && SECRET_RETRIEVAL_TOOL_RE.test(line)) {
		return `[REDACTED secret-retrieval command: ${names.join(", ")}]`;
	}
	return line
		.replace(BEARER_VALUE_RE, "Bearer [REDACTED]")
		.replace(SECRET_ASSIGNMENT_RE, (_match, name: string) => `${name}=[REDACTED]`)
		.replace(SECRET_COLON_RE, (_match, name: string) => `${name}: [REDACTED]`);
}

export function redactPromptSensitiveText(text: string): string {
	return text
		.replace(PEM_BLOCK_RE, "[REDACTED certificate/private-key block]")
		.split(/(\r?\n)/)
		.map(redactLine)
		.join("");
}
