import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	formatSize,
	keyHint,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { BrowserOwnership, BrowserParams, BrowserReleaseAction } from "./runtime.ts";

export type BrowserPhase =
	| "launching"
	| "attaching"
	| "navigating"
	| "waiting"
	| "capturing snapshot"
	| "capturing screenshot"
	| "extracting Markdown"
	| "inspecting console"
	| "inspecting requests"
	| "recovering"
	| "running";

export interface BrowserDetails {
	action: BrowserParams["action"];
	workspace?: string;
	phase?: BrowserPhase;
	durationMs?: number;
	page?: { title?: string; url?: string };
	ownership?: BrowserOwnership;
	release?: BrowserReleaseAction;
	artifactPath?: string;
	fullOutputPath?: string;
	output?: {
		lines: number;
		bytes: number;
		shownLines: number;
		shownBytes: number;
		truncated: boolean;
	};
	screenshot?: {
		format: "jpeg";
		fullWidth: number;
		fullHeight: number;
		previewWidth?: number;
		previewHeight?: number;
		bytes: number;
		previewBytes?: number;
		attached: boolean;
	};
	console?: { total: number; errors?: number; warnings?: number };
	requests?: { count: number };
	tabs?: { count: number };
	recovery?: string;
}

interface BrowserRenderContext {
	args: BrowserParams;
	lastComponent?: Component;
	isError: boolean;
}

const ACTION_LABELS: Record<BrowserParams["action"], string> = {
	open: "Opening browser",
	attach: "Attaching to browser",
	detach: "Detaching browser",
	list_sessions: "Listing browser sessions",
	goto: "Navigating",
	snapshot: "Snapshotting page",
	extract_markdown: "Extracting Markdown",
	find: "Finding on page",
	click: "Clicking",
	dblclick: "Double-clicking",
	fill: "Filling field",
	type: "Typing",
	press: "Pressing key",
	hover: "Hovering",
	select: "Selecting option",
	check: "Checking",
	uncheck: "Unchecking",
	upload: "Uploading file",
	mousewheel: "Scrolling",
	dialog_accept: "Accepting dialog",
	dialog_dismiss: "Dismissing dialog",
	back: "Going back",
	forward: "Going forward",
	reload: "Reloading page",
	resize: "Resizing viewport",
	wait: "Waiting",
	eval: "Evaluating JavaScript",
	run_code: "Running browser code",
	screenshot: "Capturing screenshot",
	pdf: "Saving PDF",
	console: "Inspecting console",
	requests: "Inspecting requests",
	request_details: "Inspecting request details",
	tabs: "Listing tabs",
	new_tab: "Opening tab",
	select_tab: "Selecting tab",
	close_tab: "Closing tab",
	save_state: "Saving browser state",
	load_state: "Loading browser state",
	close: "Closing browser",
};

export function phaseForAction(action: BrowserParams["action"]): BrowserPhase {
	switch (action) {
		case "open":
			return "launching";
		case "attach":
			return "attaching";
		case "goto":
		case "back":
		case "forward":
		case "reload":
		case "new_tab":
			return "navigating";
		case "wait":
			return "waiting";
		case "snapshot":
			return "capturing snapshot";
		case "screenshot":
			return "capturing screenshot";
		case "extract_markdown":
			return "extracting Markdown";
		case "console":
			return "inspecting console";
		case "requests":
		case "request_details":
			return "inspecting requests";
		default:
			return "running";
	}
}

function truncate(value: string, maximum: number): string {
	const characters = Array.from(value);
	return characters.length <= maximum ? value : `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

export function abbreviateUrl(value: string, maximumPath = 48): string {
	try {
		const url = new URL(value);
		if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
			return `${url.host}${truncate(url.pathname === "/" ? "" : url.pathname, maximumPath)}`;
		}
		return truncate(`${url.protocol}${url.pathname}`, maximumPath + 24);
	} catch {
		return truncate(value, maximumPath + 24);
	}
}

function quoted(value: string, maximum = 60): string {
	return `“${truncate(value.replace(/\s+/g, " ").trim(), maximum)}”`;
}

export function relevantArguments(args: BrowserParams): string[] {
	const values: string[] = [];
	const url = args.url ? abbreviateUrl(args.url) : undefined;
	switch (args.action) {
		case "open":
			if (url && args.url !== "about:blank") values.push(url);
			if (args.browser) values.push(args.browser);
			if (args.device) values.push(args.device);
			if (args.headed) values.push("headed");
			if (args.mobile) values.push("mobile");
			break;
		case "attach":
			if (args.name) values.push(args.name);
			if (args.cdpEndpoint) values.push(abbreviateUrl(args.cdpEndpoint));
			if (args.browserServerEndpoint) values.push(abbreviateUrl(args.browserServerEndpoint));
			if (args.attachViaExtension) values.push(`${args.browser ?? "browser"} extension`);
			break;
		case "goto":
		case "new_tab":
			if (url) values.push(url);
			break;
		case "snapshot":
			if (args.target) values.push(args.target);
			if (args.depth !== undefined) values.push(`depth ${args.depth}`);
			if (args.boxes) values.push("with boxes");
			break;
		case "find":
			if (args.text) values.push(quoted(args.text));
			if (args.regex) values.push("regex");
			break;
		case "click":
		case "dblclick":
			if (args.target) values.push(args.target);
			if (args.button && args.button !== "left") values.push(args.button);
			break;
		case "fill":
			if (args.target) values.push(args.target);
			if (args.text) values.push(quoted(args.text));
			if (args.submit) values.push("submit");
			break;
		case "type":
			if (args.text) values.push(quoted(args.text));
			break;
		case "press":
			if (args.key) values.push(args.key);
			break;
		case "hover":
		case "check":
		case "uncheck":
		case "screenshot":
			if (args.target) values.push(args.target);
			if (args.fullPage) values.push("full page");
			if (args.hires) values.push("hi-res");
			break;
		case "select":
			if (args.target) values.push(args.target);
			if (args.value) values.push(quoted(args.value));
			break;
		case "upload":
			if (args.filePath) values.push(args.filePath);
			break;
		case "mousewheel":
			if (args.deltaX) values.push(`x ${args.deltaX}`);
			if (args.deltaY) values.push(`y ${args.deltaY}`);
			break;
		case "dialog_accept":
			if (args.text) values.push(quoted(args.text));
			break;
		case "resize":
			if (args.width !== undefined && args.height !== undefined) values.push(`${args.width}×${args.height}`);
			break;
		case "wait":
			if (args.milliseconds !== undefined) values.push(`${args.milliseconds} ms`);
			break;
		case "eval":
		case "run_code":
			if (args.target) values.push(args.target);
			if (args.code) values.push(quoted(args.code));
			break;
		case "console":
			if (args.level) values.push(args.level);
			if (args.clear) values.push("clear");
			break;
		case "requests":
			if (args.filter) values.push(quoted(args.filter));
			if (args.includeStatic) values.push("include static");
			if (args.clear) values.push("clear");
			break;
		case "request_details":
		case "select_tab":
		case "close_tab":
			if (args.index !== undefined) values.push(`#${args.index}`);
			break;
	}
	if (args.timeoutMs !== undefined) values.push(`timeout ${args.timeoutMs} ms`);
	return values;
}

function textContent(result: AgentToolResult<BrowserDetails | undefined>): string {
	return result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function sanitizeError(text: string): string {
	const cleaned = text
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.split("\n")
		.map((line) => line.replace(/^#+\s*/, "").trim())
		.find((line) => line.length > 0 && !/^(?:stderr|error|result)$/i.test(line));
	return truncate((cleaned ?? "Browser action failed").replace(/^Error:\s*/i, ""), 240);
}

function recoveryFromError(error: string): string | undefined {
	const call = error.match(/\bCall ([^.]+)\.?/i)?.[1];
	if (call) return `Recovery: call ${call}.`;
	if (/timed out/i.test(error)) return "Recovery: retry with a larger timeoutMs or inspect the current page state.";
	if (/cancelled|aborted/i.test(error)) return "Recovery: inspect the current page state before retrying.";
	return undefined;
}

function formatDuration(milliseconds?: number): string | undefined {
	if (milliseconds === undefined) return undefined;
	return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function lineAndByteCount(output: string): { lines: number; bytes: number } {
	return { lines: output ? output.split("\n").length : 0, bytes: Buffer.byteLength(output) };
}

export function collectOutputMetadata(
	output: string,
	shownOutput: string,
	truncated: boolean,
	action?: BrowserParams["action"],
): Pick<BrowserDetails, "page" | "output" | "console" | "requests" | "tabs"> {
	const pageUrl = output.match(/^- Page URL:\s*(.+)$/m)?.[1]?.trim();
	const pageTitle = output.match(/^- Page Title:\s*(.+)$/m)?.[1]?.trim();
	const total = lineAndByteCount(output);
	const shown = lineAndByteCount(shownOutput);
	const consoleMatch = output.match(/Total messages:\s*(\d+)(?:\s*\(Errors:\s*(\d+),\s*Warnings:\s*(\d+)\))?/i);
	const resultSection = output.split(/^### Result\s*$/m)[1] ?? "";
	const listCount = resultSection.split("\n").filter((line) => /^-\s+/.test(line)).length;
	return {
		page: pageUrl || pageTitle ? { url: pageUrl, title: pageTitle } : undefined,
		output: {
			lines: total.lines,
			bytes: total.bytes,
			shownLines: shown.lines,
			shownBytes: shown.bytes,
			truncated,
		},
		console: consoleMatch
			? { total: Number(consoleMatch[1]), errors: Number(consoleMatch[2] ?? 0), warnings: Number(consoleMatch[3] ?? 0) }
			: undefined,
		requests: action === "requests" ? { count: listCount } : undefined,
		tabs: action === "tabs" ? { count: listCount } : undefined,
	};
}

function updateText(context: BrowserRenderContext, value: string): Text {
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(value);
	return component;
}

export function renderBrowserCall(args: BrowserParams, theme: Theme, context: BrowserRenderContext): Text {
	const argumentsText = relevantArguments(args);
	let value = theme.fg("toolTitle", theme.bold(ACTION_LABELS[args.action] ?? "Browser action"));
	if (argumentsText.length) value += ` ${theme.fg("muted", argumentsText.join(" · "))}`;
	return updateText(context, value);
}

class BrowserResultComponent extends Container {}

function collapsedSummary(details: BrowserDetails | undefined, args: BrowserParams, theme: Theme): string {
	const action = ACTION_LABELS[details?.action ?? args.action] ?? "Browser action";
	const duration = formatDuration(details?.durationMs);
	const metadata: string[] = [];
	if (details?.page?.title) metadata.push(quoted(details.page.title, 52));
	if (details?.page?.url) metadata.push(abbreviateUrl(details.page.url));
	if (details?.screenshot) {
		const shot = details.screenshot;
		const full = `${shot.fullWidth}×${shot.fullHeight}`;
		const preview = shot.previewWidth && shot.previewHeight ? `${shot.previewWidth}×${shot.previewHeight}` : undefined;
		metadata.push(preview && preview !== full ? `JPEG ${full} → preview ${preview}` : `JPEG screenshot ${full}`);
	}
	if (details?.console) metadata.push(`${details.console.total} console message${details.console.total === 1 ? "" : "s"}`);
	if (details?.requests) metadata.push(`${details.requests.count} request${details.requests.count === 1 ? "" : "s"}`);
	if (details?.tabs) metadata.push(`${details.tabs.count} tab${details.tabs.count === 1 ? "" : "s"}`);
	if (details?.release) metadata.push(details.release === "close" ? "browser closed" : "browser detached");
	else if (details?.ownership === "launched") metadata.push("browser launched");
	else if (details?.ownership === "attached") metadata.push("browser attached");
	if (details?.output && !details.page && !details.screenshot && !details.console && !details.requests && !details.tabs) {
		metadata.push(`${details.output.shownLines} lines · ${formatSize(details.output.shownBytes)}`);
	}
	if (details?.output?.truncated) metadata.push(`truncated from ${details.output.lines} lines · ${formatSize(details.output.bytes)}`);
	const first = `${theme.fg("success", "✓")} ${theme.fg("muted", `${action}${duration ? ` · ${duration}` : ""}`)}`;
	return metadata.length ? `${first}\n${theme.fg("dim", metadata.join(" · "))}` : first;
}

function detailLine(label: string, value: string, theme: Theme): Text {
	return new Text(`${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", value)}`, 0, 0);
}

export function renderBrowserResult(
	result: AgentToolResult<BrowserDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: BrowserRenderContext,
): Container {
	const component = context.lastComponent instanceof BrowserResultComponent ? context.lastComponent : new BrowserResultComponent();
	component.clear();
	const details = result.details;
	const output = textContent(result);

	if (options.isPartial) {
		const phase = details?.phase ?? phaseForAction(context.args.action);
		component.addChild(new Text(theme.fg("warning", `${phase[0]?.toUpperCase()}${phase.slice(1)}…`), 0, 0));
		return component;
	}

	if (context.isError) {
		const error = sanitizeError(output);
		component.addChild(new Text(theme.fg("error", `✗ ${error}`), 0, 0));
		const recovery = details?.recovery ?? recoveryFromError(error);
		if (recovery) component.addChild(new Text(theme.fg("warning", recovery), 0, 0));
		if (options.expanded && output && output !== error) {
			component.addChild(new Text(`\n${theme.fg("toolOutput", output)}`, 0, 0));
		}
		return component;
	}

	let summary = collapsedSummary(details, context.args, theme);
	if (!options.expanded && (output || details?.artifactPath || details?.fullOutputPath)) {
		summary += theme.fg("dim", ` · ${keyHint("app.tools.expand", "to expand")}`);
	}
	component.addChild(new Text(summary, 0, 0));
	if (!options.expanded) return component;

	const args = relevantArguments(context.args);
	if (args.length) component.addChild(detailLine("Arguments", args.join(" · "), theme));
	if (details?.page?.title) component.addChild(detailLine("Page title", details.page.title, theme));
	if (details?.page?.url) component.addChild(detailLine("Page URL", details.page.url, theme));
	if (details?.ownership) component.addChild(detailLine("Browser state", details.ownership, theme));
	if (details?.workspace) component.addChild(detailLine("Session workspace", details.workspace, theme));
	if (details?.durationMs !== undefined) component.addChild(detailLine("Duration", formatDuration(details.durationMs)!, theme));
	if (details?.output) {
		const stats = details.output;
		component.addChild(
			detailLine(
				"Output",
				`${stats.shownLines} lines · ${formatSize(stats.shownBytes)}${stats.truncated ? ` shown of ${stats.lines} lines · ${formatSize(stats.bytes)}` : ""}`,
				theme,
			),
		);
	}
	if (details?.screenshot) {
		const shot = details.screenshot;
		let dimensions = `JPEG ${shot.fullWidth}×${shot.fullHeight} · ${formatSize(shot.bytes)}`;
		if (shot.previewWidth && shot.previewHeight) {
			dimensions += ` · preview ${shot.previewWidth}×${shot.previewHeight}`;
			if (shot.previewBytes !== undefined) dimensions += ` · ${formatSize(shot.previewBytes)}`;
		}
		component.addChild(detailLine("Screenshot", dimensions, theme));
	}
	if (details?.artifactPath) component.addChild(detailLine("Artifact", details.artifactPath, theme));
	if (details?.fullOutputPath) component.addChild(detailLine("Full output", details.fullOutputPath, theme));
	if (output) component.addChild(new Text(`\n${theme.fg("toolOutput", output)}`, 0, 0));
	return component;
}
