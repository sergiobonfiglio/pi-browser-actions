import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MAX_RENDERED_HTML_BYTES,
	MAX_RENDERED_PAGE_DATA_BYTES,
	parseRenderedPageData,
	readRenderedPageDataFile,
	renderedPageToMarkdown,
} from "../src/markdown.ts";

const ARTICLE_HTML = `<!doctype html>
<html>
<head><title>Fallback title</title></head>
<body>
<nav>Navigation that should not be part of the article</nav>
<main>
  <article>
    <h1>Deterministic extraction</h1>
    <p>This is a substantial article paragraph with enough descriptive prose for Readability to identify the main content reliably. It explains how browser-rendered HTML becomes stable Markdown.</p>
    <p>A second substantial paragraph contains <strong>bold text</strong> and <a href="https://example.com/reference">a useful reference</a> while adding enough content for article detection.</p>
  </article>
</main>
<script>window.unwanted = true</script>
</body>
</html>`;

describe("rendered page Markdown extraction", () => {
	it("uses Readability and Turndown deterministically", () => {
		const page = parseRenderedPageData({
			html: ARTICLE_HTML,
			url: "https://example.com/article",
			title: "Browser title",
		});
		const first = renderedPageToMarkdown(page);
		const second = renderedPageToMarkdown(page);

		expect(second).toEqual(first);
		expect(first.title).toBe("Fallback title");
		expect(first.markdown).toContain("# Fallback title");
		expect(first.markdown).toContain("# Deterministic extraction");
		expect(first.markdown).toContain("Source: https://example.com/article");
		expect(first.markdown).toContain("**bold text**");
		expect(first.markdown).toContain("[a useful reference](https://example.com/reference)");
		expect(first.markdown).not.toContain("Navigation that should not be part of the article");
		expect(first.markdown).not.toContain("window.unwanted");
	});

	it("rejects malformed browser data", () => {
		expect(() => parseRenderedPageData({ url: "https://example.com" })).toThrow("rendered HTML");
		expect(() => parseRenderedPageData({ html: "<p>x</p>" })).toThrow("page URL");
		expect(() =>
			parseRenderedPageData({ html: "x".repeat(MAX_RENDERED_HTML_BYTES + 1), url: "https://example.com" }),
		).toThrow("5 MB extraction limit");
	});

	it("rejects oversized capture files before parsing JSON", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-browser-actions-markdown-test-"));
		const path = join(directory, "rendered-page.json");
		try {
			await writeFile(path, "x".repeat(MAX_RENDERED_PAGE_DATA_BYTES + 1));
			await expect(readRenderedPageDataFile(path)).rejects.toThrow("12 MB extraction limit");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
