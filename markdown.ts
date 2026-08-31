import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export interface RenderedPageData {
	html: string;
	url: string;
	title?: string;
}

export interface MarkdownExtraction {
	title: string;
	url: string;
	markdown: string;
}

export function parseRenderedPageData(value: unknown): RenderedPageData {
	if (!value || typeof value !== "object") throw new Error("Browser returned invalid rendered page data");
	const candidate = value as Partial<RenderedPageData>;
	if (typeof candidate.html !== "string") throw new Error("Browser result is missing rendered HTML");
	if (typeof candidate.url !== "string") throw new Error("Browser result is missing the page URL");
	return {
		html: candidate.html,
		url: candidate.url,
		title: typeof candidate.title === "string" ? candidate.title : undefined,
	};
}

export function renderedPageToMarkdown(page: RenderedPageData): MarkdownExtraction {
	const dom = new JSDOM(page.html, { url: page.url || "about:blank" });
	const document = dom.window.document;
	const article = new Readability(document.cloneNode(true) as Document).parse();
	const html = article?.content || document.body?.innerHTML || page.html;
	const title = (article?.title || page.title || document.title || page.url).trim();
	const turndown = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "_",
		strongDelimiter: "**",
	});
	turndown.remove(["script", "style", "noscript", "template"]);
	const body = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
	const markdown = [`# ${title}`, `Source: ${page.url}`, body].filter(Boolean).join("\n\n");
	return { title, url: page.url, markdown };
}
