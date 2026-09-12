import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractBraveResults,
	extractDuckDuckGoResults,
	formatSearchResults,
	MAX_SEARCH_RESPONSE_BYTES,
	readResponseTextWithLimit,
	searchBrave,
} from "../src/search.ts";

afterEach(() => vi.unstubAllGlobals());

describe("web search parsing", () => {
	it("extracts and limits Brave API results", () => {
		expect(extractBraveResults({
			web: {
				results: [
					{ title: "Example docs", url: "https://example.com/docs", description: "Documentation snippet." },
					{ title: "Example article", url: "https://example.org/article", description: "Article snippet." },
				],
			},
		}, 1)).toEqual([
			{
				title: "Example docs",
				url: "https://example.com/docs",
				snippet: "Documentation snippet.",
			},
		]);
	});

	it("calls the Brave Search API with its subscription token", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			web: { results: [{ title: "Example", url: "https://example.com", description: "Snippet" }] },
		})));
		vi.stubGlobal("fetch", fetchMock);

		await expect(searchBrave("example query", 3, "secret")).resolves.toHaveLength(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(url)).toBe("https://api.search.brave.com/res/v1/web/search?q=example+query&count=3");
		expect(init).toEqual(expect.objectContaining({
			headers: { accept: "application/json", "x-subscription-token": "secret" },
		}));
	});

	it("extracts DuckDuckGo HTML results and unwraps redirect URLs", () => {
		const html = `
			<div class="result">
				<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example docs</a>
				<div class="result__snippet">Documentation snippet.</div>
			</div>
			<div class="result">
				<a class="result__a" href="https://example.org/article">Example article</a>
				<div class="result__snippet">Article snippet.</div>
			</div>`;

		expect(extractDuckDuckGoResults(html, 1)).toEqual([
			{
				title: "Example docs",
				url: "https://example.com/docs",
				snippet: "Documentation snippet.",
			},
		]);
	});

	it("formats numbered results with source URLs", () => {
		const text = formatSearchResults("example", "duckduckgo", [
			{ title: "Example", url: "https://example.com", snippet: "A snippet" },
		]);
		expect(text).toContain("# Web search: example");
		expect(text).toContain("Source: duckduckgo");
		expect(text).toContain("## 1. Example");
		expect(text).toContain("URL: https://example.com");
	});

	it("rejects oversized search responses", async () => {
		const response = new Response("x".repeat(MAX_SEARCH_RESPONSE_BYTES + 1));
		await expect(readResponseTextWithLimit(response)).rejects.toThrow("Search response exceeded");
	});
});
