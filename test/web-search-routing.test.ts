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
	return component.render(200).join("\n").trimEnd();
}

describe("web search routing", () => {
	it("allows independent searches to execute in parallel", () => {
		const tool = registerWebSearch({});
		expect(tool.executionMode).toBe("parallel");
	});

	it("uses explicitly selected native search for the openai-codex provider", async () => {
		const nativeSearch = vi.fn(async () => "Native summary https://example.com");
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchOpenAICodexNative: nativeSearch, searchDuckDuckGo: duckDuckGo });

		const response = await tool.execute(
			"call",
			{ query: "example", maxResults: 3, provider: "native" },
			undefined,
			undefined,
			context("openai-codex"),
		);

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

	it("updates the renderer when native search falls back to DuckDuckGo", async () => {
		const nativeSearch = vi.fn(async () => { throw new Error("native unavailable"); });
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({
			searchOpenAICodexNative: nativeSearch,
			searchDuckDuckGo: duckDuckGo,
			braveApiKey: "",
		});
		const updates: any[] = [];

		const response = await tool.execute(
			"call",
			{ query: "example" },
			undefined,
			(update: any) => updates.push(update),
			context("openai-codex"),
		);

		expect(response.details.source).toBe("duckduckgo");
		expect(duckDuckGo).toHaveBeenCalledOnce();
		expect(updates.map((update) => update.details.source)).toEqual(["openai-codex-native", "duckduckgo"]);
		expect(updates.map((update) => rendered(
			tool.renderResult(update, { expanded: false, isPartial: true }, theme, { isError: false }),
		))).toEqual(["Searching via OpenAI Codex…", "Searching via DuckDuckGo…"]);
	});

	it("uses Brave before DuckDuckGo in auto mode", async () => {
		const brave = vi.fn(async () => [result]);
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchBrave: brave, searchDuckDuckGo: duckDuckGo, braveApiKey: "secret" });

		const response = await tool.execute("call", { query: "example" }, undefined, undefined, context("anthropic"));

		expect(response.details.source).toBe("brave");
		expect(brave).toHaveBeenCalledWith("example", 8, "secret", undefined);
		expect(duckDuckGo).not.toHaveBeenCalled();
	});

	it("updates the renderer when Brave falls back to DuckDuckGo", async () => {
		const brave = vi.fn(async () => { throw new Error("brave unavailable"); });
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchBrave: brave, searchDuckDuckGo: duckDuckGo, braveApiKey: "secret" });
		const updates: any[] = [];

		const response = await tool.execute(
			"call",
			{ query: "example" },
			undefined,
			(update: any) => updates.push(update),
			context("anthropic"),
		);

		expect(response.details.source).toBe("duckduckgo");
		expect(brave).toHaveBeenCalledOnce();
		expect(duckDuckGo).toHaveBeenCalledOnce();
		expect(updates.map((update) => update.details.source)).toEqual(["brave", "duckduckgo"]);
		expect(updates.map((update) => rendered(
			tool.renderResult(update, { expanded: false, isPartial: true }, theme, { isError: false }),
		))).toEqual(["Searching via Brave…", "Searching via DuckDuckGo…"]);
	});

	it("uses an explicitly selected DuckDuckGo without calling Brave", async () => {
		const brave = vi.fn(async () => [result]);
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchBrave: brave, searchDuckDuckGo: duckDuckGo, braveApiKey: "secret" });

		const response = await tool.execute(
			"call",
			{ query: "example", provider: "duckduckgo" },
			undefined,
			undefined,
			context("anthropic"),
		);

		expect(response.details.source).toBe("duckduckgo");
		expect(brave).not.toHaveBeenCalled();
	});

	it("does not fall back when Brave is explicitly selected", async () => {
		const brave = vi.fn(async () => { throw new Error("brave unavailable"); });
		const duckDuckGo = vi.fn(async () => [result]);
		const tool = registerWebSearch({ searchBrave: brave, searchDuckDuckGo: duckDuckGo, braveApiKey: "secret" });

		await expect(tool.execute(
			"call",
			{ query: "example", provider: "brave" },
			undefined,
			undefined,
			context("anthropic"),
		)).rejects.toThrow("brave unavailable");
		expect(duckDuckGo).not.toHaveBeenCalled();
	});

	it("rejects explicit native search for non-Codex providers", async () => {
		const tool = registerWebSearch({});
		await expect(tool.execute(
			"call",
			{ query: "example", provider: "native" },
			undefined,
			undefined,
			context("anthropic"),
		)).rejects.toThrow("Native search requires the openai-codex provider");
	});
});
