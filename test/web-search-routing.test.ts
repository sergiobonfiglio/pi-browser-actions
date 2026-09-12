import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import browserActionsExtension from "../src/index.ts";

function registerWebSearch(options: Parameters<typeof browserActionsExtension>[1]) {
	let webSearch: any;
	const pi = {
		registerTool(tool: any) {
			if (tool.name === "web_search") webSearch = tool;
		},
		on() {},
	} as unknown as ExtensionAPI;
	browserActionsExtension(pi, options);
	return webSearch;
}

function context(provider?: string) {
	return {
		cwd: process.cwd(),
		model: provider
			? { provider, id: "gpt-test", baseUrl: "https://chatgpt.example/backend-api" }
			: undefined,
		modelRegistry: {
			async getProviderAuth() {
				return { auth: { apiKey: "token" } };
			},
		},
	};
}

const result = { title: "Example", url: "https://example.com", snippet: "Example result" };
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function rendered(component: { render(width: number): string[] }): string {
	return component.render(200).join("\n");
}

describe("web search routing", () => {
	it("uses native search for the openai-codex provider", async () => {
		const nativeSearch = vi.fn(async () => "Native summary https://example.com");
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchOpenAICodexNative: nativeSearch, searchDuckDuckGo: duckDuckGo });

		const response = await tool.execute("call", { query: "example", maxResults: 3 }, undefined, undefined, context("openai-codex"));

		expect(response.details.source).toBe("openai-codex-native");
		expect(response.content[0].text).toContain("Native summary");
		expect(nativeSearch).toHaveBeenCalledOnce();
		expect(duckDuckGo).not.toHaveBeenCalled();

		const renderContext = { isError: false };
		const collapsed = rendered(tool.renderResult(response, { expanded: false, isPartial: false }, theme, renderContext));
		const expanded = rendered(tool.renderResult(response, { expanded: true, isPartial: false }, theme, renderContext));
		expect(collapsed).not.toContain("https://example.com");
		expect(expanded).toContain("Native summary https://example.com");
	});

	it("falls back to DuckDuckGo when native search fails", async () => {
		const nativeSearch = vi.fn(async () => { throw new Error("native unavailable"); });
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchOpenAICodexNative: nativeSearch, searchDuckDuckGo: duckDuckGo });

		const response = await tool.execute("call", { query: "example" }, undefined, undefined, context("openai-codex"));

		expect(response.details.source).toBe("duckduckgo");
		expect(duckDuckGo).toHaveBeenCalledOnce();
	});

	it("uses DuckDuckGo directly for other providers", async () => {
		const nativeSearch = vi.fn(async () => "unused");
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchOpenAICodexNative: nativeSearch, searchDuckDuckGo: duckDuckGo });

		const response = await tool.execute("call", { query: "example" }, undefined, undefined, context("anthropic"));

		expect(response.details.source).toBe("duckduckgo");
		expect(nativeSearch).not.toHaveBeenCalled();
	});
});
