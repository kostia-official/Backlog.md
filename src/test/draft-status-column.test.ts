import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { McpServer } from "../mcp/server.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { sortByOrdinal } from "../utils/task-sorting.ts";
import { linkText, writeLinkedProject } from "./task-link-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, isWindows, safeCleanup } from "./test-utils.ts";

/* A configured "Draft" status is a plain column: tasks keep their D-<n> id and task_home file. */

const CLI_PATH = getTestCliPath();
let root: string;

async function cli(...args: string[]) {
	const result = await $`bun ${CLI_PATH} ${args}`.cwd(root).nothrow().quiet();
	return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

async function column(status: string): Promise<string[]> {
	const tasks = await new Core(root).filesystem.listTasks();
	return sortByOrdinal(tasks.filter((task) => task.status === status)).map((task) => task.id);
}

const boardDir = (sub: string) => readdir(join(root, "tm", "board", sub));

afterEach(async () => {
	await safeCleanup(root);
});

(isWindows() ? describe.skip : describe)("Draft configured as a status", () => {
	beforeEach(async () => {
		root = createUniqueTestDir("draft-status-column");
		await mkdir(root, { recursive: true });
		await writeLinkedProject(root, { taskHome: true, statuses: ["Draft", "Backlog", "In Progress", "Done"] });
		await appendFile(join(root, "backlog.config.yml"), 'default_status: "Backlog"\n');
	});

	it("creates, moves and places tasks in the Draft column without the drafts workflow", async () => {
		expect((await cli("task", "create", "A", "-s", "draft")).code).toBe(0);
		const created = await new Core(root).filesystem.loadTask("D-1");
		expect(created?.status).toBe("Draft");
		expect(created?.ordinal).toBeDefined();
		expect(await linkText(join(root, "tm", "board", "tasks", (await boardDir("tasks"))[0] ?? ""))).toContain(
			"D-1-a/task.md",
		);
		expect(await boardDir("drafts")).toEqual([]);

		expect((await cli("task", "edit", "D-1", "-s", "Backlog")).code).toBe(0);
		expect(await column("Backlog")).toEqual(["D-1"]);
		expect((await cli("task", "edit", "D-1", "-s", "DRAFT")).code).toBe(0);
		expect(await column("Draft")).toEqual(["D-1"]);
		expect(await boardDir("drafts")).toEqual([]);
		expect(await boardDir("tasks")).toHaveLength(1);

		expect((await cli("task", "create", "B", "-s", "Draft", "--top")).code).toBe(0);
		expect(await column("Draft")).toEqual(["D-2", "D-1"]);
		const placed = await cli("task", "edit", "D-1", "--before", "D-2", "-s", "Draft");
		expect(placed.code).toBe(0);
		expect(placed.out).toContain("Placed");
		expect(await column("Draft")).toEqual(["D-1", "D-2"]);

		const ready = await cli("task", "list", "--plain", "--ready");
		expect(ready.out).toContain("D-1");
		expect(ready.out).toContain("D-2");
		expect(await boardDir("drafts")).toEqual([]);
	}, 60_000);

	it("keeps the id on the core edit path used by MCP and the server", async () => {
		expect((await cli("task", "create", "A", "-s", "Backlog")).code).toBe(0);
		const { task: edited } = await new Core(root).editTaskOrDraft("D-1", { status: "Draft" });
		expect(edited.id).toBe("D-1");
		expect(await column("Draft")).toEqual(["D-1"]);
		expect(await boardDir("drafts")).toEqual([]);
	});

	it("lists and searches Draft-status tasks through MCP", async () => {
		expect((await cli("task", "create", "A", "-s", "Draft")).code).toBe(0);
		const server = new McpServer(root, "Test instructions");
		try {
			const config = await server.filesystem.loadConfig();
			if (!config) throw new Error("no config");
			registerTaskTools(server, config);
			const result = await server.testInterface.callTool({
				params: { name: "task_list", arguments: { status: "Draft" } },
			});
			expect((result.content?.[0] as { text?: string } | undefined)?.text ?? "").toContain("D-1");
			const search = await server.testInterface.callTool({
				params: { name: "task_search", arguments: { query: "A", status: "Draft" } },
			});
			expect((search.content?.[0] as { text?: string } | undefined)?.text ?? "").toContain("D-1");
		} finally {
			await server.stop();
		}
	});
});

describe("Draft not configured", () => {
	it("keeps the drafts workflow for status draft", async () => {
		root = createUniqueTestDir("draft-status-control");
		await mkdir(root, { recursive: true });
		await initializeFilesystemTestProject(new Core(root), "Control");
		const result = await cli("task", "create", "C", "-s", "draft");
		expect(result.code).toBe(0);
		expect(result.out).toContain("DRAFT-1");
		expect(await readdir(join(root, "backlog", "drafts"))).toHaveLength(1);
	});
});
