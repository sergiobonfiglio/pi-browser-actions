import { access, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	absolutizeArtifactLinks,
	BROWSER_ACTIONS,
	buildCliInvocation,
	cleanupBrowserWorkspace,
	cliEnvironment,
	createBrowserWorkspace,
	defaultTimeoutForAction,
	removeBrowserWorkspace,
	releaseActionForOwnership,
	releaseBrowserSession,
	runCliProcess,
	sanitizeCliError,
	sessionConfiguration,
	stripEchoedSource,
} from "../src/runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("browser workspace isolation", () => {
	it("runs child processes and daemon state inside an OS temporary workspace", async () => {
		const workspace = await createBrowserWorkspace();
		temporaryDirectories.push(workspace);
		const scriptPath = join(workspace, "fake-cli.mjs");
		const script = [
			'import fs from "node:fs";',
			'fs.mkdirSync(".playwright-cli", { recursive: true });',
			'fs.writeFileSync(".playwright-cli/probe.txt", "temporary");',
			'console.log(JSON.stringify({ cwd: process.cwd(), daemon: process.env.PWTEST_DAEMON_SESSION_DIR }));',
		].join("");
		await writeFile(scriptPath, script, "utf8");

		const result = await runCliProcess(scriptPath, [], workspace);
		const reported = JSON.parse(result.stdout) as { cwd: string; daemon: string };

		expect(result.code).toBe(0);
		expect(reported.cwd).toBe(await realpath(workspace));
		expect(reported.daemon).toBe(join(workspace, "daemon"));
		expect(await readFile(join(workspace, ".playwright-cli/probe.txt"), "utf8")).toBe("temporary");
	});

	it("removes the complete workspace", async () => {
		const workspace = await createBrowserWorkspace();
		await removeBrowserWorkspace(workspace);
		await expect(access(workspace)).rejects.toThrow();
	});

	it("releases only its named session before removing the workspace", async () => {
		const recorder = await createBrowserWorkspace();
		temporaryDirectories.push(recorder);
		const callsPath = join(recorder, "calls.jsonl");

		for (const releaseAction of ["close", "detach"] as const) {
			const workspace = await createBrowserWorkspace();
			temporaryDirectories.push(workspace);
			const scriptPath = join(workspace, "fake-cli.mjs");
			await writeFile(
				scriptPath,
				`import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
				"utf8",
			);

			await cleanupBrowserWorkspace(scriptPath, "pi-test-session", workspace, releaseAction);
			await expect(access(workspace)).rejects.toThrow();
		}

		const calls = (await readFile(callsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(calls).toEqual([
			["-s=pi-test-session", "close"],
			["-s=pi-test-session", "detach"],
		]);
	});

	it("reports whether scoped session release succeeded", async () => {
		const workspace = await createBrowserWorkspace();
		temporaryDirectories.push(workspace);
		const successfulCli = join(workspace, "successful-cli.mjs");
		const failingCli = join(workspace, "failing-cli.mjs");
		await writeFile(successfulCli, "", "utf8");
		await writeFile(failingCli, "process.exit(2);", "utf8");

		await expect(releaseBrowserSession(successfulCli, "session", workspace, "close")).resolves.toBe(true);
		await expect(releaseBrowserSession(failingCli, "session", workspace, "detach")).resolves.toBe(false);
	});

	it("redirects CLI daemon metadata without changing unrelated environment values", () => {
		const environment = cliEnvironment("/tmp/example");
		expect(environment.PWTEST_DAEMON_SESSION_DIR).toBe("/tmp/example/daemon");
		expect(environment.NO_UPDATE_NOTIFIER).toBe("1");
		expect(environment.PATH).toBe(process.env.PATH);
	});
});

describe("browser command mapping", () => {
	it("exposes request_details without the ambiguous request action", () => {
		expect(BROWSER_ACTIONS).toContain("request_details");
		expect(BROWSER_ACTIONS).not.toContain("request" as never);
	});

	it("maps snapshot and interaction options", () => {
		expect(
			buildCliInvocation({ action: "snapshot", target: "e4", depth: 7, boxes: true }, 1, "/project").args,
		).toEqual(["snapshot", "e4", "--depth=7", "--boxes"]);
		expect(
			buildCliInvocation({ action: "fill", target: "e8", text: "hello world", submit: true }, 2, "/project").args,
		).toEqual(["fill", "e8", "hello world", "--submit"]);
	});

	it("maps headed launch and all attachment modes", () => {
		expect(buildCliInvocation({ action: "open", headed: true }, 1, "/project").args).toEqual([
			"open",
			"about:blank",
			"--headed",
		]);
		expect(buildCliInvocation({ action: "attach", name: "shared-browser" }, 1, "/project").args).toEqual([
			"attach",
			"shared-browser",
		]);
		expect(
			buildCliInvocation({ action: "attach", cdpEndpoint: "http://localhost:9222" }, 1, "/project").args,
		).toEqual(["attach", "--cdp=http://localhost:9222"]);
		expect(
			buildCliInvocation({ action: "attach", browserServerEndpoint: "ws://localhost:3000" }, 1, "/project").args,
		).toEqual(["attach", "--endpoint=ws://localhost:3000"]);
		expect(
			buildCliInvocation({ action: "attach", attachViaExtension: true, browser: "chrome" }, 1, "/project").args,
		).toEqual(["attach", "--extension=chrome"]);
		expect(buildCliInvocation({ action: "detach" }, 1, "/project").args).toEqual(["detach"]);
		expect(buildCliInvocation({ action: "list_sessions" }, 1, "/project").args).toEqual(["list"]);
	});

	it("validates attachment targets and ownership release actions", () => {
		expect(() => buildCliInvocation({ action: "attach" }, 1, "/project")).toThrow("exactly one");
		expect(() =>
			buildCliInvocation({ action: "attach", name: "one", cdpEndpoint: "http://localhost:9222" }, 1, "/project"),
		).toThrow("exactly one");
		expect(() =>
			buildCliInvocation({ action: "attach", attachViaExtension: true, browser: "firefox" }, 1, "/project"),
		).toThrow("only Chrome or Microsoft Edge");
		expect(releaseActionForOwnership("none")).toBeUndefined();
		expect(releaseActionForOwnership("launched")).toBe("close");
		expect(releaseActionForOwnership("attached")).toBe("detach");
	});

	it("ignores empty and irrelevant model defaults when selecting an attachment target", () => {
		const params = {
			action: "attach" as const,
			name: "",
			cdpEndpoint: " http://localhost:9222 ",
			browserServerEndpoint: "   ",
			attachViaExtension: false,
			browser: "chrome" as const,
		};
		expect(buildCliInvocation(params, 1, "/project").args).toEqual(["attach", "--cdp=http://localhost:9222"]);
		expect(sessionConfiguration(params)).toBe(JSON.stringify(["--cdp=http://localhost:9222"]));
		expect(() =>
			buildCliInvocation({ ...params, name: "shared" }, 1, "/project"),
		).toThrow("exactly one non-empty target");
	});

	it("captures rendered HTML to a temporary intermediate file for Markdown conversion", () => {
		const invocation = buildCliInvocation({ action: "extract_markdown" }, 7, "/project");
		expect(invocation.args[0]).toBe("eval");
		expect(invocation.args).toContain("--filename=artifacts/rendered-page-7.json");
		expect(invocation.artifactRelativePath).toBe("artifacts/page-7.md");
		expect(invocation.pageDataRelativePath).toBe("artifacts/rendered-page-7.json");
		expect(invocation.extractMarkdown).toBe(true);
	});

	it("keeps generated output paths relative to the temporary CLI cwd", () => {
		const invocation = buildCliInvocation({ action: "screenshot", fullPage: true }, 12, "/project");
		expect(invocation).toEqual({
			args: ["screenshot", "--filename=artifacts/screenshot-12.jpeg", "--full-page"],
			artifactRelativePath: "artifacts/screenshot-12.jpeg",
			attachImage: true,
		});
	});

	it("resolves upload inputs against the project without using it for output", () => {
		const invocation = buildCliInvocation({ action: "upload", filePath: "@fixtures/photo.png" }, 1, "/project");
		expect(invocation.args).toEqual(["upload", resolve("/project", "fixtures/photo.png")]);
		expect(invocation.artifactRelativePath).toBeUndefined();
	});

	it("maps request_details and rejects missing action-specific arguments", () => {
		expect(buildCliInvocation({ action: "request_details", index: 3 }, 1, "/project").args).toEqual([
			"request",
			"3",
		]);
		expect(() => buildCliInvocation({ action: "request_details" }, 1, "/project")).toThrow(
			"Call requests first",
		);
		expect(() => buildCliInvocation({ action: "goto", url: "  " }, 1, "/project")).toThrow("`url`");
		expect(() => buildCliInvocation({ action: "click" }, 1, "/project")).toThrow("`target`");
		expect(() => buildCliInvocation({ action: "resize", width: 800 }, 1, "/project")).toThrow("`height`");
	});

	it("uses action-appropriate default timeouts", () => {
		expect(defaultTimeoutForAction("click")).toBe(20_000);
		expect(defaultTimeoutForAction("goto")).toBe(45_000);
		expect(defaultTimeoutForAction("open")).toBe(60_000);
		expect(defaultTimeoutForAction("wait", 30_000)).toBe(40_000);
	});

	it("removes echoed code and sanitizes CLI stack noise", () => {
		const output = [
			"### Result",
			'{\"ok\":true}',
			"### Ran Playwright code",
			"```js",
			"await page.evaluate('secret source');",
			"```",
		].join("\n");
		expect(stripEchoedSource(output)).toBe('### Result\n{\"ok\":true}');
		expect(sanitizeCliError("\u001b[31mFailure\u001b[0m\n    at node:internal/foo:1:2\nUseful hint")).toBe(
			"Failure\nUseful hint",
		);
	});

	it("removes Playwright source excerpts and standalone internal locations from errors", () => {
		const output = [
			"Error: locator.click: Target page, context or browser has been closed",
			"    at node_modules/@playwright/cli/lib/session.js:251:17",
			"node_modules/@playwright/cli/lib/session.js:251",
			"> 251 | await locator.click(options);",
			"      |       ^^^^^^^^^^^^^^^^^^^^^",
			"The browser is no longer available.",
		].join("\n");
		expect(sanitizeCliError(output)).toBe(
			"Error: locator.click: Target page, context or browser has been closed\nThe browser is no longer available.",
		);
	});

	it("turns relative CLI artifact links into absolute temporary paths", () => {
		const output = [
			"[Snapshot](.playwright-cli/page.yml)",
			"[Screenshot](artifacts/screenshot-1.jpeg)",
		].join("\n");
		expect(absolutizeArtifactLinks(output, "/tmp/browser")).toBe(
			["[Snapshot](/tmp/browser/.playwright-cli/page.yml)", "[Screenshot](/tmp/browser/artifacts/screenshot-1.jpeg)"].join(
				"\n",
			),
		);
	});
});
