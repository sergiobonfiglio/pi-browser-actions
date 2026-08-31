import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { renderedPageCaptureCode } from "./markdown.ts";

export const BROWSER_ACTIONS = [
	"open",
	"attach",
	"detach",
	"list_sessions",
	"goto",
	"snapshot",
	"extract_markdown",
	"find",
	"click",
	"dblclick",
	"fill",
	"type",
	"press",
	"hover",
	"select",
	"check",
	"uncheck",
	"upload",
	"mousewheel",
	"dialog_accept",
	"dialog_dismiss",
	"back",
	"forward",
	"reload",
	"resize",
	"wait",
	"eval",
	"run_code",
	"screenshot",
	"pdf",
	"console",
	"requests",
	"request",
	"tabs",
	"new_tab",
	"select_tab",
	"close_tab",
	"save_state",
	"load_state",
	"close",
] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export interface BrowserParams {
	action: BrowserAction;
	url?: string;
	name?: string;
	cdpEndpoint?: string;
	browserServerEndpoint?: string;
	attachViaExtension?: boolean;
	target?: string;
	text?: string;
	value?: string;
	key?: string;
	code?: string;
	filePath?: string;
	button?: "left" | "middle" | "right";
	browser?: "chrome" | "firefox" | "webkit" | "msedge";
	device?: string;
	headed?: boolean;
	mobile?: boolean;
	submit?: boolean;
	depth?: number;
	boxes?: boolean;
	regex?: boolean;
	fullPage?: boolean;
	hires?: boolean;
	width?: number;
	height?: number;
	index?: number;
	milliseconds?: number;
	deltaX?: number;
	deltaY?: number;
	level?: "debug" | "info" | "warning" | "error";
	filter?: string;
	includeStatic?: boolean;
	clear?: boolean;
	timeoutMs?: number;
}

export interface CliInvocation {
	args: string[];
	artifactRelativePath?: string;
	attachImage?: boolean;
	pageDataRelativePath?: string;
	extractMarkdown?: boolean;
}

export interface CliProcessResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type BrowserOwnership = "none" | "launched" | "attached";
export type BrowserReleaseAction = "close" | "detach";

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

function requireString(value: string | undefined, name: string): string {
	if (typeof value !== "string") throw new Error(`action requires \`${name}\``);
	return value;
}

function requireInteger(value: number | undefined, name: string): number {
	if (!Number.isInteger(value)) throw new Error(`action requires integer \`${name}\``);
	return value as number;
}

function requireNonEmptyString(value: string | undefined, name: string): string {
	const result = requireString(value, name).trim();
	if (!result) throw new Error(`action requires non-empty \`${name}\``);
	return result;
}

function projectFile(filePath: string | undefined, projectCwd: string): string {
	const normalized = requireString(filePath, "filePath").replace(/^@/, "");
	return isAbsolute(normalized) ? normalized : resolve(projectCwd, normalized);
}

function buildAttachArgs(params: BrowserParams): string[] {
	const targetCount = [params.name, params.cdpEndpoint, params.browserServerEndpoint].filter(
		(value) => value !== undefined,
	).length + (params.attachViaExtension ? 1 : 0);
	if (targetCount !== 1) {
		throw new Error(
			"attach requires exactly one of `name`, `cdpEndpoint`, `browserServerEndpoint`, or `attachViaExtension`",
		);
	}

	const args = ["attach"];
	if (params.name !== undefined) args.push(requireNonEmptyString(params.name, "name"));
	if (params.cdpEndpoint !== undefined) args.push(`--cdp=${requireNonEmptyString(params.cdpEndpoint, "cdpEndpoint")}`);
	if (params.browserServerEndpoint !== undefined) {
		args.push(`--endpoint=${requireNonEmptyString(params.browserServerEndpoint, "browserServerEndpoint")}`);
	}
	if (params.attachViaExtension) {
		if (params.browser === "firefox" || params.browser === "webkit") {
			throw new Error("extension attachment supports only Chrome or Microsoft Edge");
		}
		args.push(params.browser ? `--extension=${params.browser}` : "--extension");
	} else if (params.browser !== undefined) {
		throw new Error("`browser` is only valid for attach when `attachViaExtension` is true");
	}
	return args;
}

export function releaseActionForOwnership(ownership: BrowserOwnership): BrowserReleaseAction | undefined {
	if (ownership === "launched") return "close";
	if (ownership === "attached") return "detach";
	return undefined;
}

export function buildCliInvocation(params: BrowserParams, artifactId: number, projectCwd: string): CliInvocation {
	const artifact = (name: string, extension: string) => `artifacts/${name}-${artifactId}.${extension}`;

	switch (params.action) {
		case "open": {
			const args = ["open", params.url ?? "about:blank"];
			if (params.browser) args.push(`--browser=${params.browser}`);
			if (params.device) args.push(`--device=${params.device}`);
			if (params.headed) args.push("--headed");
			if (params.mobile) args.push("--mobile");
			return { args };
		}
		case "attach":
			return { args: buildAttachArgs(params) };
		case "detach":
			return { args: ["detach"] };
		case "list_sessions":
			return { args: ["list"] };
		case "goto":
			return { args: ["goto", requireString(params.url, "url")] };
		case "snapshot": {
			const args = ["snapshot"];
			if (params.target) args.push(params.target);
			if (params.depth !== undefined) args.push(`--depth=${params.depth}`);
			if (params.boxes) args.push("--boxes");
			return { args };
		}
		case "extract_markdown": {
			const pageDataRelativePath = artifact("rendered-page", "json");
			const artifactRelativePath = artifact("page", "md");
			return {
				args: [
					"eval",
					renderedPageCaptureCode(),
					`--filename=${pageDataRelativePath}`,
				],
				artifactRelativePath,
				pageDataRelativePath,
				extractMarkdown: true,
			};
		}
		case "find": {
			const args = ["find"];
			if (params.regex) args.push("--regex");
			args.push(requireString(params.text, "text"));
			return { args };
		}
		case "click":
		case "dblclick": {
			const args = [params.action, requireString(params.target, "target")];
			if (params.button) args.push(params.button);
			return { args };
		}
		case "fill": {
			const args = ["fill", requireString(params.target, "target"), requireString(params.text, "text")];
			if (params.submit) args.push("--submit");
			return { args };
		}
		case "type":
			return { args: ["type", requireString(params.text, "text")] };
		case "press":
			return { args: ["press", requireString(params.key, "key")] };
		case "hover":
		case "check":
		case "uncheck":
			return { args: [params.action, requireString(params.target, "target")] };
		case "select":
			return {
				args: ["select", requireString(params.target, "target"), requireString(params.value, "value")],
			};
		case "upload":
			return { args: ["upload", projectFile(params.filePath, projectCwd)] };
		case "mousewheel":
			return { args: ["mousewheel", String(params.deltaX ?? 0), String(params.deltaY ?? 0)] };
		case "dialog_accept": {
			const args = ["dialog-accept"];
			if (params.text !== undefined) args.push(params.text);
			return { args };
		}
		case "dialog_dismiss":
			return { args: ["dialog-dismiss"] };
		case "back":
			return { args: ["go-back"] };
		case "forward":
			return { args: ["go-forward"] };
		case "reload":
			return { args: ["reload"] };
		case "resize":
			return {
				args: ["resize", String(requireInteger(params.width, "width")), String(requireInteger(params.height, "height"))],
			};
		case "wait":
			return {
				args: ["run-code", `async (page) => { await page.waitForTimeout(${requireInteger(params.milliseconds, "milliseconds")}); }`],
			};
		case "eval": {
			const args = ["eval", requireString(params.code, "code")];
			if (params.target) args.push(params.target);
			return { args };
		}
		case "run_code":
			return { args: ["run-code", requireString(params.code, "code")] };
		case "screenshot": {
			const artifactRelativePath = artifact("screenshot", "png");
			const args = ["screenshot"];
			if (params.target) args.push(params.target);
			args.push(`--filename=${artifactRelativePath}`);
			if (params.fullPage) args.push("--full-page");
			if (params.hires) args.push("--hires");
			return { args, artifactRelativePath, attachImage: true };
		}
		case "pdf": {
			const artifactRelativePath = artifact("page", "pdf");
			return { args: ["pdf", `--filename=${artifactRelativePath}`], artifactRelativePath };
		}
		case "console": {
			const args = ["console"];
			if (params.level) args.push(params.level);
			if (params.clear) args.push("--clear");
			return { args };
		}
		case "requests": {
			const args = ["requests"];
			if (params.includeStatic) args.push("--static");
			if (params.filter) args.push(`--filter=${params.filter}`);
			if (params.clear) args.push("--clear");
			return { args };
		}
		case "request":
			return { args: ["request", String(requireInteger(params.index, "index"))] };
		case "tabs":
			return { args: ["tab-list"] };
		case "new_tab": {
			const args = ["tab-new"];
			if (params.url) args.push(params.url);
			return { args };
		}
		case "select_tab":
			return { args: ["tab-select", String(requireInteger(params.index, "index"))] };
		case "close_tab": {
			const args = ["tab-close"];
			if (params.index !== undefined) args.push(String(params.index));
			return { args };
		}
		case "save_state": {
			const artifactRelativePath = "artifacts/auth-state.json";
			return { args: ["state-save", artifactRelativePath], artifactRelativePath };
		}
		case "load_state":
			return { args: ["state-load", "artifacts/auth-state.json"] };
		case "close":
			return { args: ["close"] };
	}
}

export async function createBrowserWorkspace(): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-actions-"));
	await mkdir(join(workspace, "artifacts"), { recursive: true });
	return workspace;
}

export function cliEnvironment(workspace: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		NO_UPDATE_NOTIFIER: "1",
		PWTEST_DAEMON_SESSION_DIR: join(workspace, "daemon"),
	};
}

export function absolutizeArtifactLinks(output: string, workspace: string): string {
	return output.replace(/\]\((\.playwright-cli|artifacts)\/([^)]+)\)/g, (_match, directory, file) =>
		`](${join(workspace, directory, file)})`,
	);
}

export async function removeBrowserWorkspace(workspace: string): Promise<void> {
	await rm(workspace, { recursive: true, force: true });
}

export async function cleanupBrowserWorkspace(
	cliPath: string,
	session: string,
	workspace: string,
	releaseAction: BrowserReleaseAction | undefined,
): Promise<void> {
	if (releaseAction) {
		await runCliProcess(cliPath, [`-s=${session}`, releaseAction], workspace, { timeoutMs: 10_000 }).catch(
			() => undefined,
		);
	}
	await removeBrowserWorkspace(workspace);
}

export function runCliProcess(
	cliPath: string,
	args: string[],
	workspace: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CliProcessResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd: workspace,
			env: cliEnvironment(workspace),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let capturedBytes = 0;
		let killed = false;
		let settled = false;

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			callback();
		};
		const terminate = (reason: string) => {
			killed = true;
			child.kill("SIGTERM");
			finish(() => reject(new Error(reason)));
		};
		const collect = (chunks: Buffer[], chunk: Buffer) => {
			capturedBytes += chunk.length;
			if (capturedBytes > MAX_CAPTURE_BYTES) {
				terminate(`Playwright CLI output exceeded ${MAX_CAPTURE_BYTES} bytes`);
				return;
			}
			chunks.push(chunk);
		};
		const abort = () => terminate("Playwright command cancelled");
		const timeout = setTimeout(
			() => terminate(`Playwright command timed out after ${options.timeoutMs ?? 120_000}ms`),
			options.timeoutMs ?? 120_000,
		);

		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) {
			abort();
			return;
		}

		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code, signal) =>
			finish(() =>
				resolvePromise({
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					code: code ?? 1,
					killed: killed || signal !== null,
				}),
			),
		);
	});
}
