export const MAX_WEB_FETCH_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 30_000;

export type WebFetchFormat = "markdown" | "html";

export interface WebFetchOptions {
	url: string;
	format?: WebFetchFormat;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export interface WebFetchResult {
	requestedUrl: string;
	url: string;
	status: number;
	contentType?: string;
	format: WebFetchFormat;
	bytes: number;
	title?: string;
	content: string;
}

interface ResponseText {
	text: string;
	bytes: number;
}

function validatedUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("web_fetch requires a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch only supports http(s) URLs");
	}
	return url;
}

function responseCharset(response: Response): string {
	const contentType = response.headers.get("content-type") ?? "";
	const match = contentType.match(/;\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
	return match?.[1] ?? match?.[2] ?? match?.[3] ?? "utf-8";
}

async function readResponseText(response: Response, maxBytes = MAX_WEB_FETCH_RESPONSE_BYTES): Promise<ResponseText> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`Web fetch response exceeded ${maxBytes} bytes`);
	}
	if (!response.body) return { text: "", bytes: 0 };

	const reader = response.body.getReader();
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(responseCharset(response));
	} catch {
		decoder = new TextDecoder();
	}
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`Web fetch response exceeded ${maxBytes} bytes`);
		}
		chunks.push(value);
	}

	let text = "";
	for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
	text += decoder.decode();
	return { text, bytes };
}

function mediaType(response: Response): string | undefined {
	const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	return value || undefined;
}

function isHtmlResponse(contentType: string | undefined, body: string): boolean {
	if (contentType === "text/html" || contentType === "application/xhtml+xml") return true;
	return /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(body);
}

export async function fetchWebPage(options: WebFetchOptions): Promise<WebFetchResult> {
	const requested = options.url.trim();
	const url = validatedUrl(requested);
	const format = options.format ?? "markdown";
	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const fetcher = options.fetch ?? globalThis.fetch;
	if (!fetcher) throw new Error("web_fetch requires a runtime with fetch support");

	const response = await fetcher(url, {
		headers: {
			accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8",
		},
		signal,
	});
	if (!response.ok) throw new Error(`Web fetch returned HTTP ${response.status}`);

	const responseText = await readResponseText(response);
	const finalUrl = response.url || url.href;
	const contentType = mediaType(response);
	let content = responseText.text;
	let title: string | undefined;

	if (format === "markdown" && isHtmlResponse(contentType, responseText.text)) {
		const { renderedPageToMarkdown } = await import("./markdown.ts");
		const extraction = renderedPageToMarkdown({ html: responseText.text, url: finalUrl });
		content = extraction.markdown;
		title = extraction.title;
	}

	return {
		requestedUrl: url.href,
		url: finalUrl,
		status: response.status,
		contentType,
		format,
		bytes: responseText.bytes,
		title,
		content,
	};
}
