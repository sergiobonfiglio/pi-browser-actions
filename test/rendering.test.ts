import { initTheme, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	abbreviateUrl,
	collectOutputMetadata,
	renderBrowserCall,
	renderBrowserResult,
	type BrowserDetails,
} from "../src/rendering.ts";
import type { BrowserParams } from "../src/runtime.ts";

initTheme("dark", false);

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function context(args: BrowserParams, overrides: Record<string, unknown> = {}) {
	return {
		args,
		lastComponent: undefined,
		state: {},
		executionStarted: true,
		isError: false,
		...overrides,
	};
}

function result(content: string, details?: BrowserDetails): AgentToolResult<BrowserDetails | undefined> {
	return { content: [{ type: "text", text: content }], details };
}

function rendered(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

describe("browser tool rendering", () => {
	it("humanizes collapsed calls and includes only relevant non-default arguments", () => {
		const args: BrowserParams = {
			action: "open",
			url: "https://example.com/products/very/long/path?campaign=browser-rendering",
			headed: true,
			mobile: false,
			timeoutMs: 60_000,
		};
		const lines = rendered(renderBrowserCall(args, theme, context(args)));

		expect(lines.join("\n")).toContain(
			"Opening browser example.com/products/very/long/path · headed · timeout 60000 ms",
		);
		expect(lines.join("\n")).not.toContain("mobile");
	});

	it("renders meaningful structured partial phases and reuses its component", () => {
		const args: BrowserParams = { action: "snapshot" };
		const partial = result("Running browser action: snapshot", {
			action: "snapshot",
			phase: "capturing snapshot",
		});
		const first = renderBrowserResult(partial, { expanded: false, isPartial: true }, theme, context(args));
		const second = renderBrowserResult(
			{ ...partial, details: { action: "snapshot", phase: "recovering" } },
			{ expanded: false, isPartial: true },
			theme,
			context(args, { lastComponent: first }),
		);

		expect(second).toBe(first);
		expect(rendered(second)).toEqual(["Recovering…"]);
	});

	it("keeps successful collapsed results compact while showing useful metadata", () => {
		const args: BrowserParams = { action: "goto", url: "https://example.com/docs" };
		const component = renderBrowserResult(
			result("### Page\n- Page URL: https://example.com/docs\n- Page Title: Documentation", {
				action: "goto",
				durationMs: 1234,
				page: { title: "Documentation", url: "https://example.com/docs" },
				ownership: "launched",
			}),
			{ expanded: false, isPartial: false },
			theme,
			context(args),
		);
		const lines = rendered(component);

		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines.join("\n")).toContain("Navigating · 1.2s");
		expect(lines.join("\n")).toContain("Documentation");
		expect(lines.join("\n")).toContain("example.com/docs");
		expect(lines.join("\n")).toMatch(/expand/i);
	});

	it("shows sanitized thrown errors and inferred recovery without details", () => {
		const args: BrowserParams = { action: "attach", name: "shared" };
		const component = renderBrowserResult(
			result("### stderr\n\u001b[31mError: No attached browser session exists. Call browser_session attach first.\u001b[0m"),
			{ expanded: false, isPartial: false },
			theme,
			context(args, { isError: true }),
		);
		const lines = rendered(component);

		expect(lines).toEqual([
			"✗ No attached browser session exists. Call browser_session attach first.",
			"Recovery: call browser_session attach first.",
		]);
	});

	it("abbreviates URLs safely and remains width-safe in narrow terminals", () => {
		const url = "https://user:secret@example.com/" + "深い/".repeat(40) + "end?q=private";
		const abbreviated = abbreviateUrl(url, 20);
		const args: BrowserParams = { action: "goto", url };
		const lines = rendered(renderBrowserCall(args, theme, context(args)), 22);

		expect(abbreviated).toMatch(/^example\.com\//);
		expect(abbreviated).not.toContain("secret");
		expect(abbreviated).not.toContain("private");
		expect(abbreviated.endsWith("…")).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
	});

	it("renders expanded arguments, statistics, artifact paths, and exact model-facing text", () => {
		const args: BrowserParams = { action: "extract_markdown" };
		const modelText = "# Rendered article\n\nActual model-facing output.";
		const toolResult = result(modelText, {
			action: "extract_markdown",
			durationMs: 87,
			artifactPath: "/tmp/browser/page-4.md",
			fullOutputPath: "/tmp/browser/cli-output-4.txt",
			output: { lines: 2400, bytes: 80_000, shownLines: 2000, shownBytes: 50_000, truncated: true },
		});
		const before = structuredClone(toolResult);
		const lines = rendered(
			renderBrowserResult(toolResult, { expanded: true, isPartial: false }, theme, context(args)),
		).join("\n");

		expect(lines).toContain("Output: 2000 lines");
		expect(lines).toContain("Artifact: /tmp/browser/page-4.md");
		expect(lines).toContain("Full output: /tmp/browser/cli-output-4.txt");
		expect(lines).toContain(modelText);
		expect(toolResult).toEqual(before);
	});

	it("renders JPEG full-resolution and preview metadata while leaving image content intact", () => {
		const jpeg = Buffer.from("jpeg-preview");
		const args: BrowserParams = { action: "screenshot", fullPage: true };
		const toolResult: AgentToolResult<BrowserDetails> = {
			content: [
				{ type: "text", text: "Temporary full-resolution artifact: /tmp/screenshot.jpeg" },
				{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
			],
			details: {
				action: "screenshot",
				durationMs: 300,
				artifactPath: "/tmp/screenshot.jpeg",
				screenshot: {
					format: "jpeg",
					fullWidth: 2400,
					fullHeight: 1500,
					previewWidth: 1600,
					previewHeight: 1000,
					bytes: 240_000,
					previewBytes: jpeg.length,
					attached: true,
				},
			},
		};
		const before = structuredClone(toolResult.content);
		const lines = rendered(
			renderBrowserResult(toolResult, { expanded: true, isPartial: false }, theme, context(args)),
		).join("\n");

		expect(lines).toContain("Screenshot: JPEG 2400×1500");
		expect(lines).toContain("preview 1600×1000");
		expect(toolResult.content).toEqual(before);
		expect(toolResult.content[1]?.type).toBe("image");
	});
});

describe("browser output metadata", () => {
	it("parses stable page, console, request, and truncation metadata without changing output", () => {
		const output = "### Page\n- Page URL: https://example.com/a\n- Page Title: A\n### Result\n- one\n- two";
		const before = output;
		const metadata = collectOutputMetadata(output, output.slice(0, 30), true, "requests");

		expect(metadata.page).toEqual({ title: "A", url: "https://example.com/a" });
		expect(metadata.requests).toEqual({ count: 2 });
		expect(metadata.output?.truncated).toBe(true);
		expect(output).toBe(before);
	});

	it("counts the same fallback text that is sent to the model for empty CLI output", () => {
		const fallback = "Command completed.";
		const metadata = collectOutputMetadata(fallback, fallback, false, "close");
		expect(metadata.output).toMatchObject({ lines: 1, shownLines: 1, bytes: Buffer.byteLength(fallback) });
	});
});
