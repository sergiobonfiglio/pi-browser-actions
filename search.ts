import { JSDOM } from "jsdom";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface GoogleSearchPayload {
	url: string;
	title: string;
	text: string;
	hasCaptcha: boolean;
	results: SearchResult[];
}

const GOOGLE_BLOCK_SIGNALS = [
	"unusual traffic",
	"before you continue",
	"not a robot",
	"verify you are human",
	"captcha",
];

export function googleSearchUrl(query: string, limit: number): string {
	const params = new URLSearchParams({ q: query, num: String(limit), hl: "en" });
	return `https://www.google.com/search?${params.toString()}`;
}

export function googlePreparationCode(): string {
	return `async (page) => {
		if (page.url().includes('consent.google.com')) {
			for (const selector of ['button#L2AGLb', "button:has-text('I agree')", "button:has-text('Accept all')", "button:has-text('Accept')"]) {
				const button = page.locator(selector).first();
				if (await button.count()) {
					await button.click({ timeout: 5000, force: true }).catch(() => {});
					await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
					break;
				}
			}
		}
		await page.waitForSelector('body', { timeout: 10000 });
		await Promise.race([
			page.waitForSelector('h3', { timeout: 5000 }).catch(() => {}),
			page.waitForTimeout(5000),
		]);
	}`;
}

export function googleExtractionCode(limit: number): string {
	return `() => {
		const results = [];
		for (const heading of document.querySelectorAll('h3')) {
			if (results.length >= ${limit}) break;
			const anchor = heading.closest('a[href]');
			const title = heading.textContent?.trim() || '';
			let url = anchor?.href || '';
			if (!title || !url) continue;
			try {
				const parsed = new URL(url, location.href);
				if (parsed.pathname === '/url') url = parsed.searchParams.get('q') || url;
			} catch {}
			if (!/^https?:\\/\\//.test(url) || /(^|\\.)google\\./i.test(new URL(url).hostname)) continue;
			const container = anchor.closest('div.MjjYud, div.g, div[data-snf], div[data-sncf]') || anchor.parentElement?.parentElement;
			const snippetElement = container?.querySelector('.VwiC3b, .yXK7lf, .lEBKkf, span.aCOpRe');
			let snippet = snippetElement?.textContent?.trim() || '';
			if (!snippet && container) {
				snippet = Array.from(container.querySelectorAll('span'))
					.map(element => element.textContent?.trim() || '')
					.find(text => text.length > 40 && text !== title) || '';
			}
			results.push({ title, url, snippet });
		}
		return {
			url: location.href,
			title: document.title || '',
			text: document.body?.innerText?.slice(0, 4000) || '',
			hasCaptcha: Boolean(document.querySelector("#captcha-form, form[action*='sorry'], .g-recaptcha, iframe[src*='recaptcha']")),
			results,
		};
	}`;
}

export function parseGoogleSearchPayload(value: unknown): GoogleSearchPayload {
	if (!value || typeof value !== "object") throw new Error("Google returned invalid search data");
	const candidate = value as Record<string, unknown>;
	const results = Array.isArray(candidate.results) ? candidate.results.map(parseSearchResult).filter(Boolean) : [];
	return {
		url: typeof candidate.url === "string" ? candidate.url : "",
		title: typeof candidate.title === "string" ? candidate.title : "",
		text: typeof candidate.text === "string" ? candidate.text : "",
		hasCaptcha: candidate.hasCaptcha === true,
		results: results as SearchResult[],
	};
}

export function isGoogleBlocked(payload: GoogleSearchPayload): boolean {
	const haystack = `${payload.url}\n${payload.title}\n${payload.text}`.toLowerCase();
	return payload.hasCaptcha || GOOGLE_BLOCK_SIGNALS.some((signal) => haystack.includes(signal));
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

function unwrapDuckDuckGoUrl(href: string): string {
	try {
		const url = new URL(href, "https://duckduckgo.com");
		return url.searchParams.get("uddg") || url.href;
	} catch {
		return href;
	}
}

export function extractDuckDuckGoResults(html: string, limit: number): SearchResult[] {
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
			const results = extractDuckDuckGoResults(await response.text(), limit);
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
