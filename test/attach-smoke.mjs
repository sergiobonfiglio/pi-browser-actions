import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const cli = require.resolve("@playwright/cli/playwright-cli.js");
const workspace = await mkdtemp(join(tmpdir(), "pi-browser-actions-attach-smoke-"));
const session = `attach-smoke-${randomUUID().slice(0, 8)}`;
await mkdir(join(workspace, "artifacts"), { recursive: true });

const env = {
	...process.env,
	NO_UPDATE_NOTIFIER: "1",
	PWTEST_DAEMON_SESSION_DIR: join(workspace, "daemon"),
};

function run(args, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, ...args], {
			cwd: workspace,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`command timed out: ${args.join(" ")}`));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve(stdout);
			else reject(new Error(`${stdout}\n${stderr}`.trim() || `command failed: ${args.join(" ")}`));
		});
	});
}

const server = await chromium.launchServer({ headless: true });
try {
	await run([`-s=${session}`, "attach", `--endpoint=${server.wsEndpoint()}`]);
	await run([`-s=${session}`, "snapshot"]);
	await run([`-s=${session}`, "close"]);

	const probe = await chromium.connect(server.wsEndpoint());
	const context = await probe.newContext();
	const page = await context.newPage();
	await page.goto("data:text/html,<title>still-running</title>");
	if ((await page.title()) !== "still-running") throw new Error("external browser server did not survive release");
	await probe.close();

	console.log("ok: releasing an attachment did not close the external browser server");
} finally {
	await run([`-s=${session}`, "detach"]).catch(() => undefined);
	await server.close().catch(() => undefined);
	await rm(workspace, { recursive: true, force: true });
}
