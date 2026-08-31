import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import browserActionsExtension from "../src/index.ts";

describe("extension boundary", () => {
	it("registers browser and web_search without the old headless_browser alias", () => {
		const tools: Array<{ name: string; promptGuidelines?: string[] }> = [];
		const events: string[] = [];
		const api = {
			registerTool(tool: { name: string; promptGuidelines?: string[] }) {
				tools.push(tool);
			},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		browserActionsExtension(api);

		expect(tools.map((tool) => tool.name)).toEqual(["browser", "web_search"]);
		expect(tools.some((tool) => tool.name === "headless_browser")).toBe(false);
		expect(tools.flatMap((tool) => tool.promptGuidelines ?? []).join("\n")).not.toContain("headless_browser");
		expect(events).toContain("session_shutdown");
	});
});
