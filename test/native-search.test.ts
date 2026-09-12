import { describe, expect, it, vi } from "vitest";
import { searchOpenAICodexNative } from "../src/native-search.ts";

function token(accountId = "account-123"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("OpenAI Codex native search", () => {
	it("requests native web search and collects streamed text", async () => {
		const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
			new Response(
				'data: {"type":"response.output_text.delta","delta":"Finding "}\n\n' +
					'data: {"type":"response.output_text.delta","delta":"https://example.com"}\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);

		const result = await searchOpenAICodexNative({
			modelId: "gpt-test",
			apiKey: token(),
			baseUrl: "https://chatgpt.example/backend-api",
			query: "example query",
			maxResults: 3,
			fetch: fetchMock as typeof fetch,
		});

		expect(result).toBe("Finding https://example.com");
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		if (!init) throw new Error("Expected fetch request options");
		expect(url).toBe("https://chatgpt.example/backend-api/codex/responses");
		expect(init.headers).toMatchObject({ "chatgpt-account-id": "account-123" });
		expect(JSON.parse(init.body as string)).toMatchObject({
			model: "gpt-test",
			tools: [{ type: "web_search" }],
		});
	});

	it("rejects credentials without a ChatGPT account ID", async () => {
		await expect(
			searchOpenAICodexNative({
				modelId: "gpt-test",
				apiKey: "not-a-jwt",
				query: "example",
				maxResults: 3,
			}),
		).rejects.toThrow("ChatGPT account ID");
	});
});
