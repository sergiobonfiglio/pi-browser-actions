import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ToolExecutionMode,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseRenderedPageData, renderedPageToMarkdown } from "./markdown.ts";
import {
	formatSearchResults,
	googleExtractionCode,
	googlePreparationCode,
	googleSearchUrl,
	isGoogleBlocked,
	parseGoogleSearchPayload,
	searchDuckDuckGo,
	type SearchResult,
} from "./search.ts";
import {
	absolutizeArtifactLinks,
	BROWSER_ACTIONS,
	buildCliInvocation,
	createBrowserWorkspace,
	removeBrowserWorkspace,
	runCliProcess,
} from "./runtime.ts";

const require = createRequire(import.meta.url);
const playwrightCliPath = require.resolve("@playwright/cli/playwright-cli.js");
const MAX_INLINE_SCREENSHOT_BYTES = 10 * 1024 * 1024;

const SearchParameters = Type.Object({
	query: Type.String({ minLength: 1, description: "Web search query." }),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results; defaults to 8." })),
});
const BrowserParameters = Type.Object({
	action: StringEnum(BROWSER_ACTIONS, {
		description:
			"Browser operation. Start with open, use snapshot to obtain refs, interact with those refs, and close when finished.",
	}),
	url: Type.Optional(Type.String({ description: "URL for open, goto, or new_tab." })),
	target: Type.Optional(
		Type.String({ description: "Element ref from snapshot (for example e12) or a unique Playwright/CSS selector." }),
	),
	text: Type.Optional(Type.String({ description: "Text for fill, type, find, or dialog_accept." })),
	value: Type.Optional(Type.String({ description: "Option value for select." })),
	key: Type.Optional(Type.String({ description: "Key for press, for example Enter, Tab, or ArrowDown." })),
	code: Type.Optional(
		Type.String({
			description:
				"JavaScript function for eval or run_code. eval uses () => value or (element) => value; run_code uses async (page) => {...}.",
		}),
	),
	filePath: Type.Optional(
		Type.String({ description: "File to upload. Relative paths resolve against Pi's project cwd; the browser never writes there." }),
	),
	button: Type.Optional(StringEnum(["left", "middle", "right"] as const)),
	browser: Type.Optional(StringEnum(["chrome", "firefox", "webkit", "msedge"] as const)),
	device: Type.Optional(Type.String({ description: "Playwright device name for open, such as iPhone 15." })),
	mobile: Type.Optional(Type.Boolean({ description: "Use the CLI's lightweight mobile emulation for open." })),
	submit: Type.Optional(Type.Boolean({ description: "Press Enter after fill." })),
	depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum snapshot depth." })),
	boxes: Type.Optional(Type.Boolean({ description: "Include element bounding boxes in snapshot." })),
	regex: Type.Optional(Type.Boolean({ description: "Treat find text as a regular expression." })),
	fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page in screenshot." })),
	hires: Type.Optional(Type.Boolean({ description: "Capture screenshot using device pixels." })),
	width: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Viewport width for resize." })),
	height: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Viewport height for resize." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Request number or tab index, depending on action." })),
	milliseconds: Type.Optional(
		Type.Integer({ minimum: 0, maximum: 30000, description: "Delay for wait (maximum 30 seconds)." }),
	),
	deltaX: Type.Optional(Type.Integer({ description: "Horizontal mouse-wheel delta." })),
	deltaY: Type.Optional(Type.Integer({ description: "Vertical mouse-wheel delta." })),
	level: Type.Optional(StringEnum(["debug", "info", "warning", "error"] as const)),
	filter: Type.Optional(Type.String({ description: "URL regular expression for requests." })),
	includeStatic: Type.Optional(Type.Boolean({ description: "Include successful static resources in requests." })),
	clear: Type.Optional(Type.Boolean({ description: "Clear console or request history after reading it." })),
	timeoutMs: Type.Optional(
		Type.Integer({ minimum: 1000, maximum: 180000, description: "Command timeout; defaults to 120000 ms." }),
	),
});

interface BrowserDetails {
	action: string;
	workspace: string;
	artifactPath?: string;
	fullOutputPath?: string;
	truncated?: boolean;
}

interface SearchDetails {
	query: string;
	source: string;
	results: SearchResult[];
}

function sessionName(): string {
	return `pi-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export default function headlessBrowserExtension(pi: ExtensionAPI) {
	let workspace: string | undefined;
	let artifactId = 0;
	const cliSession = sessionName();

	async function ensureWorkspace(): Promise<string> {
		workspace ??= await createBrowserWorkspace();
		return workspace;
	}

	async function invokeCli(
		current: string,
		args: string[],
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<string> {
		const result = await runCliProcess(playwrightCliPath, [`-s=${cliSession}`, ...args], current, {
			signal,
			timeoutMs,
		});
		let output = result.stdout.trim();
		if (result.stderr.trim()) output += `${output ? "\n\n" : ""}### stderr\n${result.stderr.trim()}`;
		output = absolutizeArtifactLinks(output, current);
		if (result.code !== 0) throw new Error(output || `Playwright CLI exited with code ${result.code}`);
		return output;
	}

	async function ensureBrowserForSearch(current: string, signal?: AbortSignal): Promise<void> {
		try {
			await invokeCli(current, ["tab-list"], signal, 15_000);
		} catch {
			await invokeCli(current, ["open", "about:blank"], signal, 30_000);
		}
	}
	async function cleanup(): Promise<void> {
		if (!workspace) return;
		const current = workspace;
		workspace = undefined;
		await runCliProcess(playwrightCliPath, [`-s=${cliSession}`, "close"], current, { timeoutMs: 10_000 }).catch(
			() => undefined,
		);
		await runCliProcess(playwrightCliPath, ["kill-all"], current, { timeoutMs: 10_000 }).catch(() => undefined);
		await removeBrowserWorkspace(current);
	}

	pi.on("session_shutdown", cleanup);

	pi.registerTool({
		name: "headless_browser",
		label: "Headless Browser",
		description:
			"Control a stateful headless Playwright browser for frontend testing, web browsing, interaction, inspection, and rendering. Use action=open first; action=snapshot returns accessibility refs such as e12, while action=extract_markdown deterministically converts the current rendered page to readable Markdown using Readability and Turndown. Interaction actions accept refs or unique selectors. Screenshots return an inline image. PDFs, Markdown, auth state, automatic snapshots, browser profiles, logs, and all generated files stay in a private OS temporary directory deleted on Pi session shutdown. Relative upload paths are read from Pi's project cwd, but this tool never writes there. Output is truncated to 2000 lines or 50KB, with complete output retained only temporarily.",
		promptSnippet: "Browse, interact with, inspect, render, and extract Markdown from web pages in an isolated Playwright workspace",
		promptGuidelines: [
			"Use headless_browser for browser-rendered pages, frontend testing, screenshots, and web interactions; call open before other actions and snapshot before ref-based interaction.",
			"Use headless_browser action=extract_markdown when readable main-page content is more useful than an accessibility snapshot.",
			"All headless_browser artifacts are temporary. If the user needs a durable artifact, explicitly copy the returned temporary file only after asking where it should go.",
		],
		parameters: BrowserParameters,
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const current = await ensureWorkspace();
			const currentArtifactId = ++artifactId;
			const invocation = buildCliInvocation(params, currentArtifactId, ctx.cwd);
			const artifactPath = invocation.artifactRelativePath
				? join(current, invocation.artifactRelativePath)
				: undefined;

			if (params.action === "load_state") {
				await access(join(current, "artifacts/auth-state.json")).catch(() => {
					throw new Error("No temporary auth state exists. Call save_state first in this Pi session.");
				});
			}

			onUpdate?.({
				content: [{ type: "text", text: `Running headless browser action: ${params.action}` }],
				details: { action: params.action, workspace: current },
			});

			let output = await invokeCli(current, invocation.args, signal, params.timeoutMs);
			if (invocation.extractMarkdown && invocation.pageDataRelativePath && artifactPath) {
				const pageData = parseRenderedPageData(
					JSON.parse(await readFile(join(current, invocation.pageDataRelativePath), "utf8")),
				);
				const extraction = renderedPageToMarkdown(pageData);
				output = extraction.markdown;
				await writeFile(artifactPath, output, "utf8");
			}

			const truncation = truncateHead(output || "Command completed.", {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let text = truncation.content;
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				fullOutputPath = join(current, "artifacts", `cli-output-${currentArtifactId}.txt`);
				await writeFile(fullOutputPath, output, "utf8");
				text +=
					`\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines ` +
					`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
					`Full output: ${fullOutputPath}]`;
			}
			if (artifactPath) text += `\n\nTemporary artifact: ${artifactPath}`;

			const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
			if (invocation.attachImage && artifactPath) {
				const image = await readFile(artifactPath);
				if (image.length <= MAX_INLINE_SCREENSHOT_BYTES) {
					content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
				} else {
					content[0] = {
						type: "text",
						text: `${text}\n\n[The ${formatSize(image.length)} screenshot is too large to attach inline.]`,
					};
				}
			}

			return {
				content,
				details: {
					action: params.action,
					workspace: current,
					artifactPath,
					fullOutputPath,
					truncated: truncation.truncated,
				} satisfies BrowserDetails,
			};
		},

		renderCall(args, theme) {
			const destination = args.url ?? args.target ?? args.text ?? "";
			const suffix = destination ? ` ${destination}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("headless_browser ")) +
					theme.fg("muted", `${args.action}${suffix}`),
				0,
				0,
			);
		},

		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Running browser action…"), 0, 0);
			const details = result.details as BrowserDetails | undefined;
			const prefix = context.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
			let summary = `${prefix}${theme.fg("muted", details?.action ?? "browser action")}`;
			if (details?.artifactPath) summary += theme.fg("dim", ` → ${details.artifactPath}`);
			if (details?.truncated) summary += theme.fg("warning", " (truncated)");
			return new Text(summary, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the public web without an API key. Uses a disposable tab in the isolated headless browser for Google, detects blocked/CAPTCHA pages, then falls back to DuckDuckGo HTML. Returns structured titles, full URLs, and snippets. The previously active browser tab is preserved, and all intermediate data remains in the extension's temporary workspace.",
		promptSnippet: "Search the web for current pages and sources without leaving browser artifacts in the project",
		promptGuidelines: [
			"Use web_search for open-web discovery; use headless_browser to open, interact with, or extract Markdown from a selected result.",
		],
		parameters: SearchParameters,
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, signal, onUpdate) {
			const query = params.query.trim();
			if (!query) throw new Error("Search query must not be empty");
			const maxResults = params.maxResults ?? 8;
			const current = await ensureWorkspace();
			const currentArtifactId = ++artifactId;
			onUpdate?.({
				content: [{ type: "text", text: `Searching the web for: ${query}` }],
				details: { query, source: "pending", results: [] },
			});

			let source = "google";
			let results: SearchResult[] = [];
			let googleFailure = "Google returned no results";
			let disposableTabOpen = false;
			try {
				await ensureBrowserForSearch(current, signal);
				await invokeCli(current, ["tab-new", googleSearchUrl(query, maxResults)], signal, 30_000);
				disposableTabOpen = true;
				await invokeCli(current, ["run-code", googlePreparationCode()], signal, 20_000);
				const resultRelativePath = `artifacts/google-search-${currentArtifactId}.json`;
				await invokeCli(
					current,
					["eval", googleExtractionCode(maxResults), `--filename=${resultRelativePath}`],
					signal,
					20_000,
				);
				const payload = parseGoogleSearchPayload(
					JSON.parse(await readFile(join(current, resultRelativePath), "utf8")),
				);
				if (isGoogleBlocked(payload)) throw new Error("Google blocked automated access");
				if (payload.results.length === 0) throw new Error("Google returned no search results");
				results = payload.results.slice(0, maxResults);
			} catch (error) {
				googleFailure = error instanceof Error ? error.message : String(error);
			} finally {
				if (disposableTabOpen) {
					await invokeCli(current, ["tab-close"], undefined, 10_000).catch(() => undefined);
				}
			}

			let duckDuckGoFailure = "no results";
			if (results.length === 0) {
				source = "duckduckgo";
				try {
					results = await searchDuckDuckGo(query, maxResults, signal);
				} catch (error) {
					if (signal?.aborted) throw error;
					duckDuckGoFailure = error instanceof Error ? error.message : String(error);
				}
			}
			if (results.length === 0) {
				throw new Error(`Web search returned no results. Google: ${googleFailure}; DuckDuckGo: ${duckDuckGoFailure}`);
			}

			return {
				content: [{ type: "text", text: formatSearchResults(query, source, results) }],
				details: { query, source, results } satisfies SearchDetails,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("muted", args.query),
				0,
				0,
			);
		},

		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
			const details = result.details as SearchDetails | undefined;
			const prefix = context.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
			return new Text(
				`${prefix}${theme.fg("muted", `${details?.results.length ?? 0} results via ${details?.source ?? "search"}`)}`,
				0,
				0,
			);
		},
	});
}
