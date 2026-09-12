export interface OpenAICodexNativeSearchOptions {
	modelId: string;
	apiKey: string;
	baseUrl?: string;
	query: string;
	maxResults: number;
	signal?: AbortSignal;
	headers?: Record<string, string | null>;
	fetch?: typeof fetch;
}

function decodeAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function codexResponsesUrl(baseUrl = "https://chatgpt.com/backend-api"): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function eventData(chunk: string): string | undefined {
	const data = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	return data && data !== "[DONE]" ? data : undefined;
}

export async function searchOpenAICodexNative(options: OpenAICodexNativeSearchOptions): Promise<string> {
	const accountId = options.headers?.["chatgpt-account-id"] ?? decodeAccountId(options.apiKey);
	if (!accountId) throw new Error("Could not determine the ChatGPT account ID for native search");

	const requestHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		if (value !== null) requestHeaders[name] = value;
	}
	Object.assign(requestHeaders, {
		authorization: `Bearer ${options.apiKey}`,
		"chatgpt-account-id": accountId,
		"content-type": "application/json",
		accept: "text/event-stream",
		"OpenAI-Beta": "responses=experimental",
		originator: "pi-browser-actions",
	});

	const response = await (options.fetch ?? fetch)(codexResponsesUrl(options.baseUrl), {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({
			model: options.modelId,
			store: false,
			stream: true,
			instructions:
				"You are a concise web research assistant. Include full canonical URLs for key findings and call out conflicting sources.",
			input: [
				{
					role: "user",
					content: `Search the internet for: ${options.query}\n\nReturn up to ${options.maxResults} relevant findings with titles, concise explanations, and full source URLs.`,
				},
			],
			tools: [{ type: "web_search" }],
			tool_choice: "auto",
		}),
		signal: options.signal,
	});
	if (!response.ok) {
		throw new Error(`OpenAI Codex native search failed (${response.status}): ${await response.text()}`);
	}
	if (!response.body) throw new Error("OpenAI Codex native search returned no response body");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let completedText = "";

	const consume = (chunk: string) => {
		const data = eventData(chunk);
		if (!data) return;
		let event: any;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
		if (event.type === "response.output_item.done" && event.item?.type === "message") {
			completedText = (event.item.content ?? [])
				.filter((part: any) => part.type === "output_text" && typeof part.text === "string")
				.map((part: any) => part.text)
				.join("\n");
		}
		if (event.type === "error") throw new Error(event.message || "OpenAI Codex native search stream failed");
		if (event.type === "response.failed") {
			throw new Error(event.response?.error?.message || "OpenAI Codex native search response failed");
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const chunks = buffer.split(/\r?\n\r?\n/);
		buffer = chunks.pop() ?? "";
		for (const chunk of chunks) consume(chunk);
	}
	buffer += decoder.decode();
	if (buffer.trim()) consume(buffer);

	const result = (text || completedText).trim();
	if (!result) throw new Error("OpenAI Codex native search returned an empty response");
	return result;
}
