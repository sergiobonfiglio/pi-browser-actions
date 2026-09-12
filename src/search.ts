export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function readResponseTextWithLimit(
	response: Response,
	maxBytes = MAX_SEARCH_RESPONSE_BYTES,
): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`Search response exceeded ${maxBytes} bytes`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`Search response exceeded ${maxBytes} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function parseSearchResult(value: unknown): SearchResult | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.title !== "string" || typeof candidate.url !== "string") return undefined;
	const title = candidate.title.trim().slice(0, 300);
	const url = candidate.url.trim();
	if (!title || !/^https?:\/\//.test(url)) return undefined;
	return {
		title,
		url,
		snippet: typeof candidate.snippet === "string" ? candidate.snippet.trim().slice(0, 1000) : "",
	};
}

export function extractBraveResults(value: unknown, limit: number): SearchResult[] {
	if (!value || typeof value !== "object") return [];
	const web = (value as Record<string, unknown>).web;
	if (!web || typeof web !== "object") return [];
	const results = (web as Record<string, unknown>).results;
	if (!Array.isArray(results)) return [];

	return results
		.map((result) => {
			if (!result || typeof result !== "object") return undefined;
			const candidate = result as Record<string, unknown>;
			return parseSearchResult({
				title: candidate.title,
				url: candidate.url,
				snippet: candidate.description,
			});
		})
		.filter((result): result is SearchResult => result !== undefined)
		.slice(0, limit);
}

export async function searchBrave(
	query: string,
	limit: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(limit));
	const timeout = AbortSignal.timeout(10_000);
	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			"x-subscription-token": apiKey,
		},
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) throw new Error(`Brave Search API returned HTTP ${response.status}`);
	return extractBraveResults(JSON.parse(await readResponseTextWithLimit(response)), limit);
}

function unwrapDuckDuckGoUrl(href: string): string {
	try {
		const url = new URL(href, "https://duckduckgo.com");
		return url.searchParams.get("uddg") || url.href;
	} catch {
		return href;
	}
}

export async function extractDuckDuckGoResults(html: string, limit: number): Promise<SearchResult[]> {
	const { JSDOM } = await import("jsdom");
	const document = new JSDOM(html, { url: "https://html.duckduckgo.com" }).window.document;
	const results: SearchResult[] = [];

	for (const element of document.querySelectorAll(".result")) {
		if (results.length >= limit) break;
		const anchor = element.querySelector<HTMLAnchorElement>(".result__a");
		const title = anchor?.textContent?.trim() || "";
		const url = anchor?.getAttribute("href") ? unwrapDuckDuckGoUrl(anchor.getAttribute("href") as string) : "";
		const snippet = element.querySelector(".result__snippet")?.textContent?.trim() || "";
		const result = parseSearchResult({ title, url, snippet });
		if (result && !result.url.includes("duckduckgo.com")) results.push(result);
	}

	if (results.length > 0) return results;

	for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a.result-link")) {
		if (results.length >= limit) break;
		const row = anchor.closest("tr");
		const snippet = row?.nextElementSibling?.querySelector(".result-snippet")?.textContent?.trim() || "";
		const result = parseSearchResult({
			title: anchor.textContent?.trim() || "",
			url: unwrapDuckDuckGoUrl(anchor.getAttribute("href") || ""),
			snippet,
		});
		if (result) results.push(result);
	}

	return results;
}

export async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const headers = {
		"user-agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
		accept: "text/html,application/xhtml+xml",
	};
	for (const endpoint of ["https://html.duckduckgo.com/html/", "https://duckduckgo.com/lite/"]) {
		const timeout = AbortSignal.timeout(10_000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			const url = `${endpoint}?q=${encodeURIComponent(query)}`;
			const response = await fetch(url, { headers, signal: combinedSignal });
			if (!response.ok || response.status === 202) continue;
			const results = await extractDuckDuckGoResults(await readResponseTextWithLimit(response), limit);
			if (results.length > 0) return results;
		} catch (error) {
			if (signal?.aborted) throw error;
		}
	}
	return [];
}

export function formatSearchResults(query: string, source: string, results: SearchResult[]): string {
	const lines = [`# Web search: ${query}`, `Source: ${source}`, ""];
	for (const [index, result] of results.entries()) {
		lines.push(`## ${index + 1}. ${result.title}`, `URL: ${result.url}`);
		if (result.snippet) lines.push(result.snippet);
		lines.push("");
	}
	return lines.join("\n").trim();
}
