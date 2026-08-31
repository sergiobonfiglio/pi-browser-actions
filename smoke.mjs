import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cli = require.resolve("@playwright/cli/playwright-cli.js");
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const forbiddenOutput = join(extensionDirectory, ".playwright-cli");
const existedBefore = existsSync(forbiddenOutput);
const workspace = mkdtempSync(join(tmpdir(), "pi-headless-browser-smoke-"));
const session = `smoke-${randomUUID().slice(0, 8)}`;
mkdirSync(join(workspace, "artifacts"), { recursive: true });

const env = {
	...process.env,
	NO_UPDATE_NOTIFIER: "1",
	PWTEST_DAEMON_SESSION_DIR: join(workspace, "daemon"),
};

function run(args) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd: workspace,
		env,
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.status !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`.trim() || `command failed: ${args.join(" ")}`);
	}
	return result.stdout;
}

try {
	run([`-s=${session}`, "open", "data:text/html,<button>Temporary browser</button>"]);
	const snapshot = run([`-s=${session}`, "snapshot"]);
	if (!snapshot.includes('button "Temporary browser"')) throw new Error("snapshot did not contain the test button");
	run([`-s=${session}`, "screenshot", "--filename=artifacts/smoke.png"]);
	if (!existsSync(join(workspace, "artifacts/smoke.png"))) throw new Error("screenshot was not created in temp workspace");
	if (!existsSync(join(workspace, ".playwright-cli"))) throw new Error("automatic snapshots were not created in temp workspace");
	if (!existedBefore && existsSync(forbiddenOutput)) throw new Error("Playwright polluted the extension directory");
	console.log(`ok: browser output stayed in ${workspace}`);
} finally {
	try {
		run([`-s=${session}`, "close"]);
	} catch {
		// Best-effort cleanup; removing the private daemon directory is still safe.
	}
	rmSync(workspace, { recursive: true, force: true });
}
