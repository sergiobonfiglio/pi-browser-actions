import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import browserActionsExtension from "../src/index.ts";
import type { CliProcessResult } from "../src/runtime.ts";

interface RegisteredTool {
	name: string;
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
}

const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
});

function result(code: number, stdout = "", stderr = ""): CliProcessResult {
	return { code, stdout, stderr, killed: false };
}

function createHarness(): Harness {
	const tools: RegisteredTool[] = [];
	const calls: string[][] = [];
	let shutdown = async () => {};
	let sessionAvailable = false;
	let releaseResult = true;
	let nextFailure: { command: string; message: string; sessionRemains: boolean } | undefined;

	const api = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		on(event: string, handler: () => Promise<void>) {
			if (event === "session_shutdown") shutdown = handler;
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
	});

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
		]);
		const browserProperties = tool(harness, "browser").parameters?.properties ?? {};
		const sessionProperties = tool(harness, "browser_session").parameters?.properties ?? {};
		expect(browserProperties).not.toHaveProperty("name");
		expect(browserProperties).not.toHaveProperty("cdpEndpoint");
		expect(browserProperties).not.toHaveProperty("attachViaExtension");
		expect(browserProperties).not.toHaveProperty("browser");
		expect(sessionProperties).toHaveProperty("cdpEndpoint");
		expect(Object.keys(sessionProperties).length).toBeLessThanOrEqual(11);
		expect(harness.tools.flatMap((registered) => registered.promptGuidelines ?? []).join("\n")).not.toContain(
			"headless_browser",
		);
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
