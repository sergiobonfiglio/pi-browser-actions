import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_WEB_FETCH_TIMEOUT_MS,
	fetchWebPage,
	MAX_WEB_FETCH_RESPONSE_BYTES,
} from "../src/web-fetch.ts";

const HTML = `<!doctype html>
<html>
<head><title>Fetched document</title></head>
<body>
<nav>Navigation</nav>
<main>
  <article>
    <h1>Direct URL fetching</h1>
    <p>This is enough substantial prose for Readability to identify the fetched document as its main article content. It demonstrates that a known URL can be fetched without a browser session.</p>
    <p>A second paragraph provides additional context and a <a href="https://example.com/reference">reference link</a>.</p>
  </article>
</main>
<script>window.unwanted = true</script>
</body>
</html>`;

function response(body: string, contentType = "text/html; charset=utf-8"): Response {
	return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("web fetch", () => {
	it("fetches a known HTML URL and converts it to Markdown by default", async () => {
		const fetchMock = vi.fn(async () => response(HTML));
		const result = await fetchWebPage({ url: "https://example.com/article", fetch: fetchMock as typeof fetch });

		expect(result).toMatchObject({
			requestedUrl: "https://example.com/article",
			url: "https://example.com/article",
			status: 200,
			contentType: "text/html",
			format: "markdown",
			title: "Fetched document",
		});
		expect(result.bytes).toBe(Buffer.byteLength(HTML));
		expect(result.content).toContain("# Fetched document");
		expect(result.content).toContain("# Direct URL fetching");
		expect(result.content).toContain("Source: https://example.com/article");
		expect(result.content).not.toContain("Navigation");
		expect(result.content).not.toContain("window.unwanted");
		expect(fetchMock).toHaveBeenCalledWith(
			new URL("https://example.com/article"),
			expect.objectContaining({
				headers: expect.objectContaining({ accept: expect.stringContaining("text/html") }),
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("returns the raw response body for the HTML format", async () => {
		const fetchMock = vi.fn(async () => response(HTML));
		const result = await fetchWebPage({
			url: "https://example.com/article",
			format: "html",
			fetch: fetchMock as typeof fetch,
		});

		expect(result.format).toBe("html");
		expect(result.content).toBe(HTML);
	});

	it("returns non-HTML text unchanged in Markdown mode", async () => {
		const body = "# Plain text\n\nThis is already Markdown.";
		const result = await fetchWebPage({
			url: "https://example.com/readme.txt",
			fetch: vi.fn(async () => response(body, "text/plain")) as typeof fetch,
		});

		expect(result.content).toBe(body);
		expect(result.contentType).toBe("text/plain");
	});

	it("decodes the charset declared by the response", async () => {
		const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
		const fetchMock = vi.fn(async () => new Response(body, {
			status: 200,
			headers: { "content-type": "text/plain; charset=windows-1252" },
		}));
		const result = await fetchWebPage({
			url: "https://example.com/latin1.txt",
			fetch: fetchMock as typeof fetch,
		});

		expect(result.content).toBe("café");
	});

	it("validates URL schemes and response status", async () => {
		await expect(fetchWebPage({ url: "file:///tmp/example" })).rejects.toThrow("only supports http(s)");
		await expect(fetchWebPage({ url: "not a URL" })).rejects.toThrow("valid URL");

		const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
		await expect(fetchWebPage({ url: "https://example.com/missing", fetch: fetchMock as typeof fetch })).rejects.toThrow(
			"HTTP 404",
		);
	});

	it("enforces the response-size limit before reading an oversized response", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream({ cancel });
		const fetchMock = vi.fn(async () => new Response(body, {
			status: 200,
			headers: { "content-length": String(MAX_WEB_FETCH_RESPONSE_BYTES + 1) },
		}));
		await expect(fetchWebPage({ url: "https://example.com/large", fetch: fetchMock as typeof fetch })).rejects.toThrow(
			"Web fetch response exceeded",
		);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("uses the documented default timeout and combines caller cancellation", async () => {
		const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return response("ok", "text/plain");
		});
		const signal = new AbortController().signal;
		await fetchWebPage({ url: "https://example.com", signal, fetch: fetchMock as typeof fetch });

		const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(init.signal).not.toBe(signal);
		expect(DEFAULT_WEB_FETCH_TIMEOUT_MS).toBe(30_000);
	});
});
