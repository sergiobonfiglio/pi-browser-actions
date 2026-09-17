import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import browserActionsExtension, { type BrowserActionsExtensionOptions } from "../src/index.ts";
import type { CliProcessResult } from "../src/runtime.ts";

interface RegisteredTool {
	name: string;
	description?: string;
	parameters?: { properties?: Record<string, unknown> };
	promptGuidelines?: string[];
	execute?: (...args: any[]) => Promise<any>;
}

interface Harness {
	tools: RegisteredTool[];
	calls: string[][];
	shutdown: () => Promise<void>;
	setSessionAvailable(value: boolean): void;
	failNext(command: string, message: string, sessionRemains?: boolean): void;
	setReleaseResult(value: boolean): void;
	getActiveTools(): string[];
}

const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
});

function result(code: number, stdout = "", stderr = ""): CliProcessResult {
	return { code, stdout, stderr, killed: false };
}

function createHarness(fetchWebPage?: BrowserActionsExtensionOptions["fetchWebPage"]): Harness {
	const tools: RegisteredTool[] = [];
	const calls: string[][] = [];
	let activeTools: string[] = [];
	let shutdown = async () => {};
	let sessionStart = () => {};
	let sessionAvailable = false;
	let releaseResult = true;
	let nextFailure: { command: string; message: string; sessionRemains: boolean } | undefined;

	const api = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
			activeTools.push(tool.name);
		},
		on(event: string, handler: any) {
			if (event === "session_shutdown") shutdown = handler;
			if (event === "session_start") sessionStart = handler;
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...new Set(names)];
		},
	} as unknown as ExtensionAPI;

	browserActionsExtension(api, {
		async runCliProcess(_cliPath, args) {
			const commandArgs = args.slice(1);
			calls.push(commandArgs);
			const command = commandArgs[0];
			if (nextFailure?.command === command) {
				const failure = nextFailure;
				nextFailure = undefined;
				sessionAvailable = failure.sessionRemains;
				return result(1, "", failure.message);
			}
			if (command === "open" || command === "attach") {
				sessionAvailable = true;
				return result(0, `### Browser opened\n### Page\n- Page URL: ${commandArgs[1] ?? "about:blank"}`);
			}
			if (command === "close" || command === "detach") {
				sessionAvailable = false;
				return result(0, "Browser released");
			}
			if (!sessionAvailable && command !== "list") {
				return result(1, "", "The browser is not open");
			}
			if (command === "eval" || command === "run-code") {
				return result(0, '### Result\n"ok"\n### Ran Playwright code\n```js\nawait page.evaluate("source");\n```');
			}
			return result(0, command === "tab-list" ? "### Tabs\n- 0: test" : "Command completed");
		},
		async releaseBrowserSession(_cliPath, _session, _workspace, action) {
			calls.push([`release:${action}`]);
			if (releaseResult) sessionAvailable = false;
			return releaseResult;
		},
		fetchWebPage,
	});
	sessionStart();

	const cleanup = async () => {
		const handler = shutdown;
		shutdown = async () => {};
		await handler();
	};
	shutdowns.push(cleanup);
	return {
		tools,
		calls,
		shutdown: cleanup,
		setSessionAvailable(value) {
			sessionAvailable = value;
		},
		failNext(command, message, sessionRemains = false) {
			nextFailure = { command, message, sessionRemains };
		},
		setReleaseResult(value) {
			releaseResult = value;
		},
		getActiveTools() {
			return [...activeTools];
		},
	};
}

function tool(harness: Harness, name: string): RegisteredTool {
	const registered = harness.tools.find((candidate) => candidate.name === name);
	if (!registered?.execute) throw new Error(`Missing tool ${name}`);
	return registered;
}

function execute(registered: RegisteredTool, params: Record<string, unknown>) {
	return registered.execute?.("test-call", params, undefined, undefined, { cwd: process.cwd() });
}

describe("extension boundary", () => {
	it("separates compact session parameters from ordinary browser actions", () => {
		const harness = createHarness();
		expect(harness.tools.map((registered) => registered.name)).toEqual([
			"browser_session",
			"browser",
			"web_search",
			"web_fetch",
		]);
		const browserProperties = tool(harness, "browser").parameters?.properties ?? {};
		const sessionProperties = tool(harness, "browser_session").parameters?.properties ?? {};
		expect(browserProperties).not.toHaveProperty("name");
		expect(browserProperties).not.toHaveProperty("cdpEndpoint");
		expect(browserProperties).not.toHaveProperty("attachViaExtension");
		expect(browserProperties).not.toHaveProperty("browser");
		expect(sessionProperties).toHaveProperty("cdpEndpoint");
		expect(Object.keys(sessionProperties).length).toBeLessThanOrEqual(11);
		expect(Object.values(sessionProperties).filter((property) => typeof (property as any).description === "string")).toHaveLength(3);
		expect(harness.tools.flatMap((registered) => registered.promptGuidelines ?? []).join("\n")).not.toContain(
			"headless_browser",
		);
		expect(tool(harness, "browser").promptGuidelines).toBeUndefined();
		expect(tool(harness, "browser_session").promptGuidelines?.join("\n")).toContain("browser_session with action=open");
		expect(tool(harness, "browser_session").promptGuidelines?.join("\n")).toContain("browser_session with action=list_sessions");
		expect(tool(harness, "browser_session").description).toContain("Playwright");
	});

	it("activates browser controls after opening a session", async () => {
		const harness = createHarness();
		expect(harness.getActiveTools()).toEqual(["browser_session", "web_search", "web_fetch"]);

		await execute(tool(harness, "browser_session"), { action: "open" });

		expect(harness.getActiveTools()).toEqual(["browser_session", "web_search", "web_fetch", "browser"]);
	});

	it("truncates oversized fetch output and preserves the full result in a temporary artifact", async () => {
		const fullContent = "x".repeat(60 * 1024);
		const harness = createHarness(async ({ url, format }) => ({
			requestedUrl: url,
			url,
			status: 200,
			contentType: format === "html" ? "text/html" : "text/plain",
			format: format ?? "markdown",
			bytes: Buffer.byteLength(fullContent),
			content: fullContent,
		}));

		const response = await execute(tool(harness, "web_fetch"), {
			url: "https://example.com/large",
			format: "html",
		});
		const artifactPath = response.details.artifactPath as string;

		expect(response.content[0].text).toContain("Output truncated");
		expect(response.content[0].text).toContain(artifactPath);
		expect(response.details.output.truncated).toBe(true);
		expect(await readFile(artifactPath, "utf8")).toBe(fullContent);
	});

	it("reuses a compatible open and navigates instead of reopening", async () => {
		const harness = createHarness();
		const session = tool(harness, "browser_session");
		await execute(session, { action: "open", url: "https://one.test" });
		await execute(session, { action: "open", url: "https://two.test" });
		expect(harness.calls.slice(0, 2)).toEqual([
			["open", "https://one.test"],
			["goto", "https://two.test"],
		]);
	});

	it("rejects incompatible repeated launch configuration without touching the CLI", async () => {
		const harness = createHarness();
		const session = tool(harness, "browser_session");
		await execute(session, { action: "open" });
		await expect(execute(session, { action: "open", headed: true })).rejects.toThrow("different open options");
		expect(harness.calls).toEqual([["open", "about:blank"]]);
	});

	it("reconciles ownership when startup reports failure but the session remains active", async () => {
		const harness = createHarness();
		const session = tool(harness, "browser_session");
		harness.setReleaseResult(false);
		harness.failNext("open", "startup transport failed", true);
		await expect(execute(session, { action: "open" })).rejects.toThrow("startup may have completed");
		await execute(session, { action: "open", url: "https://recovered.test" });
		expect(harness.calls).toEqual([
			["open", "about:blank"],
			["release:close"],
			["tab-list"],
			["goto", "https://recovered.test"],
		]);
	});

	it("makes close and detach idempotent", async () => {
		const harness = createHarness();
		const session = tool(harness, "browser_session");
		await execute(session, { action: "close" });
		await execute(session, { action: "open" });
		await execute(session, { action: "close" });
		await execute(session, { action: "close" });
		await execute(session, { action: "attach", name: "shared" });
		await execute(session, { action: "detach" });
		await execute(session, { action: "detach" });
		expect(harness.calls).toEqual([
			["open", "about:blank"],
			["close"],
			["attach", "shared"],
			["detach"],
		]);
	});

	it("strips successful eval source without exposing a diagnostics artifact", async () => {
		const harness = createHarness();
		await execute(tool(harness, "browser_session"), { action: "open" });
		const response = await execute(tool(harness, "browser"), { action: "eval", code: "() => 'ok'" });
		expect(response.content[0].text).toBe('### Result\n"ok"');
		expect(response.details.fullOutputPath).toBeUndefined();
	});

	it("recovers after daemon or session loss", async () => {
		const harness = createHarness();
		const session = tool(harness, "browser_session");
		const browser = tool(harness, "browser");
		await execute(session, { action: "open" });
		harness.failNext("goto", "daemon connection lost");
		harness.setSessionAvailable(false);
		await expect(execute(browser, { action: "goto", url: "https://lost.test" })).rejects.toThrow(
			"call open or attach to recover",
		);
		await execute(session, { action: "open", url: "https://new.test" });
		expect(harness.calls.slice(-3)).toEqual([
			["goto", "https://lost.test"],
			["tab-list"],
			["open", "https://new.test"],
		]);
	});
});
