import { access, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	absolutizeArtifactLinks,
	buildCliInvocation,
	cleanupBrowserWorkspace,
	cliEnvironment,
	createBrowserWorkspace,
	removeBrowserWorkspace,
	runCliProcess,
} from "./runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("headless browser isolation", () => {
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

	it("closes only its named session before removing the workspace", async () => {
		const workspace = await createBrowserWorkspace();
		const recorder = await createBrowserWorkspace();
		temporaryDirectories.push(workspace, recorder);
		const callsPath = join(recorder, "calls.jsonl");
		const scriptPath = join(workspace, "fake-cli.mjs");
		await writeFile(
			scriptPath,
			`import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
			"utf8",
		);

		await cleanupBrowserWorkspace(scriptPath, "pi-test-session", workspace);

		await expect(access(workspace)).rejects.toThrow();
		const calls = (await readFile(callsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(calls).toEqual([["-s=pi-test-session", "close"]]);
	});

	it("redirects CLI daemon metadata without changing unrelated environment values", () => {
		const environment = cliEnvironment("/tmp/example");
		expect(environment.PWTEST_DAEMON_SESSION_DIR).toBe("/tmp/example/daemon");
		expect(environment.NO_UPDATE_NOTIFIER).toBe("1");
		expect(environment.PATH).toBe(process.env.PATH);
	});
});

describe("headless browser command mapping", () => {
	it("maps snapshot and interaction options", () => {
		expect(
			buildCliInvocation({ action: "snapshot", target: "e4", depth: 7, boxes: true }, 1, "/project").args,
		).toEqual(["snapshot", "e4", "--depth=7", "--boxes"]);
		expect(
			buildCliInvocation({ action: "fill", target: "e8", text: "hello world", submit: true }, 2, "/project").args,
		).toEqual(["fill", "e8", "hello world", "--submit"]);
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
			args: ["screenshot", "--filename=artifacts/screenshot-12.png", "--full-page"],
			artifactRelativePath: "artifacts/screenshot-12.png",
			attachImage: true,
		});
	});

	it("resolves upload inputs against the project without using it for output", () => {
		const invocation = buildCliInvocation({ action: "upload", filePath: "@fixtures/photo.png" }, 1, "/project");
		expect(invocation.args).toEqual(["upload", resolve("/project", "fixtures/photo.png")]);
		expect(invocation.artifactRelativePath).toBeUndefined();
	});

	it("rejects missing action-specific arguments", () => {
		expect(() => buildCliInvocation({ action: "goto" }, 1, "/project")).toThrow("`url`");
		expect(() => buildCliInvocation({ action: "click" }, 1, "/project")).toThrow("`target`");
		expect(() => buildCliInvocation({ action: "resize", width: 800 }, 1, "/project")).toThrow("`height`");
	});

	it("turns relative CLI artifact links into absolute temporary paths", () => {
		const output = [
			"[Snapshot](.playwright-cli/page.yml)",
			"[Screenshot](artifacts/screenshot-1.png)",
		].join("\n");
		expect(absolutizeArtifactLinks(output, "/tmp/browser")).toBe(
			["[Snapshot](/tmp/browser/.playwright-cli/page.yml)", "[Screenshot](/tmp/browser/artifacts/screenshot-1.png)"].join(
				"\n",
			),
		);
	});
});
