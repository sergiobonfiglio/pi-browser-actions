import { describe, expect, it } from "vitest";
import {
	extractDuckDuckGoResults,
	formatSearchResults,
	MAX_SEARCH_RESPONSE_BYTES,
	readResponseTextWithLimit,
} from "../src/search.ts";

describe("web search parsing", () => {
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
