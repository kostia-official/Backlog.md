import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { McpServer } from "../mcp/server.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import { sortByOrdinal } from "../utils/task-sorting.ts";
import { addLinkedTask, linkText, taskFile, writeLinkedProject } from "./task-link-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { createUniqueTestDir, isWindows, safeCleanup } from "./test-utils.ts";

const CLI_PATH = getTestCliPath();
let root: string;

const withOrdinal = (content: string, ordinal?: number) =>
	ordinal === undefined ? content : content.replace("labels: []", `ordinal: ${ordinal}\nlabels: []`);

async function addTask(id: string, status = "Backlog", ordinal?: number) {
	const path = join(root, "tm", "board", "tasks", `${id.toLowerCase()} - Task-${id}.md`);
	await writeFile(path, withOrdinal(taskFile(id, `Task ${id}`, status), ordinal));
}

async function addTasks(status: string, ids: string[], start = 1000) {
	for (const [index, id] of ids.entries()) await addTask(id, status, start + index * 1000);
}

async function column(status: string): Promise<string[]> {
	const tasks = await new Core(root).filesystem.listTasks();
	return sortByOrdinal(tasks.filter((task) => task.status === status)).map((task) => task.id);
}

async function statusOf(id: string): Promise<string | undefined> {
	return (await new Core(root).filesystem.loadTask(id))?.status;
}

async function snapshot(): Promise<Record<string, string>> {
	const dir = join(root, "tm");
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	const files: Record<string, string> = {};
	for (const entry of entries.filter((item) => item.isFile())) {
		const path = join(entry.parentPath, entry.name);
		files[relative(dir, path)] = await readFile(path, "utf8");
	}
	return files;
}

async function cli(...args: string[]) {
	const result = await $`bun ${CLI_PATH} ${args}`.cwd(root).nothrow().quiet();
	return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

beforeEach(async () => {
	root = createUniqueTestDir("task-position");
	await mkdir(root, { recursive: true });
	await writeLinkedProject(root);
	await appendFile(join(root, "backlog.config.yml"), 'default_status: "Backlog"\n');
});

afterEach(async () => {
	await safeCleanup(root);
});

describe("task edit placement", () => {
	it("puts the listed tasks at the top in the given order", async () => {
		await addTasks("Backlog", ["D-1", "D-2", "D-3", "D-4"]);
		const result = await cli("task", "edit", "D-3", "D-1", "D-2", "--top");
		expect(result.code).toBe(0);
		expect(result.out).toContain('Placed D-3, D-1, D-2 at top of "Backlog"');
		expect(await column("Backlog")).toEqual(["D-3", "D-1", "D-2", "D-4"]);
	});

	it("puts the listed tasks at the bottom, after ordinal-less tasks, and lists them as written", async () => {
		await addTasks("Backlog", ["D-1", "D-2", "D-3"]);
		await addTask("D-4", "Backlog");
		const result = await cli("task", "edit", "D-1", "D-2", "--bottom");
		expect(result.code).toBe(0);
		expect(await column("Backlog")).toEqual(["D-3", "D-4", "D-1", "D-2"]);
		expect(result.out).toMatch(/Wrote .*D-4/);
	});

	it("places before and after an anchor and takes the anchor's status", async () => {
		await addTasks("Backlog", ["D-1", "D-2"]);
		await addTask("D-4", "In Progress", 1000);
		await addTask("D-5", "Done", 1000);
		await addTask("D-6", "In Progress", 2000);
		expect((await cli("task", "edit", "D-4", "D-5", "--after", "D-1")).code).toBe(0);
		expect(await column("Backlog")).toEqual(["D-1", "D-4", "D-5", "D-2"]);
		expect((await cli("task", "edit", "D-6", "--before", "D-1")).code).toBe(0);
		expect(await column("Backlog")).toEqual(["D-6", "D-1", "D-4", "D-5", "D-2"]);
		expect(await statusOf("D-6")).toBe("Backlog");
	});

	it("refuses a status that is not the anchor's and changes no file", async () => {
		await addTasks("Backlog", ["D-1", "D-2"]);
		await addTask("D-3", "In Progress", 1000);
		const before = await snapshot();
		const result = await cli("task", "edit", "D-3", "-s", "In Progress", "--after", "D-1");
		expect(result.code).toBe(1);
		expect(result.out).toContain('Anchor D-1 is in "Backlog", not "In Progress".');
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a bad list and changes no file", async () => {
		await addTasks("Backlog", ["D-1", "D-2", "D-3"]);
		const before = await snapshot();
		const cases: Array<[string[], string]> = [
			[["D-1", "D-2", "--after", "D-2"], "Anchor D-2 is one of the tasks being placed."],
			[["D-1", "D-01", "--top"], "Duplicate task ID D-1 in the placement list."],
			[["1", "D-1", "--top"], "Duplicate task ID D-1 in the placement list."],
			[["D-1", "D-99", "--top"], "Task D-99 not found."],
			[["D-1", "--after", "D-99"], "Task D-99 not found."],
			[["D-1", "--top", "--bottom"], "Use only one of --top, --bottom, --before, --after."],
			[["D-1", "D-2", "--ordinal", "5", "--top"], "--ordinal cannot be combined with --top/--bottom/--before/--after."],
		];
		for (const [args, message] of cases) {
			const result = await cli("task", "edit", ...args);
			expect(result.code).toBe(1);
			expect(result.out).toContain(message);
		}
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a draft in the list or as the anchor", async () => {
		await addTasks("Backlog", ["D-1"]);
		await writeFile(join(root, "tm", "board", "drafts", "draft-1 - Idea.md"), taskFile("DRAFT-1", "Idea", "Draft"));
		for (const args of [
			["DRAFT-1", "--top"],
			["D-1", "--after", "DRAFT-1"],
		]) {
			const result = await cli("task", "edit", ...args);
			expect(result.code).toBe(1);
			expect(result.out).toContain("DRAFT-1 is a draft; drafts have no board column.");
		}
	});

	it("refuses placement into Done but still moves a task there without a placement flag", async () => {
		await addTasks("Backlog", ["D-1"]);
		const result = await cli("task", "edit", "D-1", "--top", "-s", "Done");
		expect(result.code).toBe(1);
		expect(result.out).toContain('Placement into "Done" is not supported; that column sorts by date.');
		expect(await statusOf("D-1")).toBe("Backlog");
		expect((await cli("task", "edit", "D-1", "-s", "Done")).code).toBe(0);
		expect(await statusOf("D-1")).toBe("Done");
	});

	it("refuses top without -s when the tasks are in different statuses", async () => {
		await addTask("D-1", "Backlog", 1000);
		await addTask("D-4", "In Progress", 1000);
		const result = await cli("task", "edit", "D-1", "D-4", "--top");
		expect(result.code).toBe(1);
		expect(result.out).toContain("Tasks are in different statuses (D-1: Backlog, D-4: In Progress); pass -s.");
	});

	it("writes nothing when the tasks are already in place", async () => {
		await addTasks("Backlog", ["D-1", "D-2", "D-3"]);
		const before = await snapshot();
		const result = await cli("task", "edit", "D-1", "D-2", "--top");
		expect(result.code).toBe(0);
		expect(result.out).toContain('D-1, D-2 already at top of "Backlog"');
		expect(await snapshot()).toEqual(before);
	});

	it("rebalances a gap too tight for the block and lists every written task", async () => {
		await addTask("D-1", "Backlog", 1000);
		await addTask("D-2", "Backlog", 1000.000001);
		await addTask("D-3", "Backlog", 5000);
		const result = await cli("task", "edit", "D-3", "--after", "D-1");
		expect(result.code).toBe(0);
		expect(await column("Backlog")).toEqual(["D-1", "D-3", "D-2"]);
		expect(result.out).toContain("Wrote D-3, D-2");
	});

	it("applies field edits and the placement together, and a pure placement prints no Updated lines", async () => {
		await addTasks("Backlog", ["D-1", "D-2"]);
		await addTasks("In Progress", ["D-3"]);
		const result = await cli("task", "edit", "D-1", "D-2", "--top", "--priority", "high", "-s", "In Progress");
		expect(result.code).toBe(0);
		expect(await column("In Progress")).toEqual(["D-1", "D-2", "D-3"]);
		expect((await new Core(root).filesystem.loadTask("D-2"))?.priority).toBe("high");

		const pure = await cli("task", "edit", "D-3", "--top", "-s", "Backlog");
		expect(pure.code).toBe(0);
		expect(pure.out).not.toContain("Updated task");
		expect(await column("Backlog")).toEqual(["D-3"]);
	});

	(isWindows() ? it.skip : it)("writes a task_home task through its link", async () => {
		await writeLinkedProject(root, { taskHome: true });
		await appendFile(join(root, "backlog.config.yml"), 'default_status: "Backlog"\n');
		const one = await addLinkedTask(root, "D-1-one", withOrdinal(taskFile("D-1", "One"), 1000), "d-1 - One.md");
		const two = await addLinkedTask(root, "D-2-two", withOrdinal(taskFile("D-2", "Two"), 2000), "d-2 - Two.md");
		const result = await cli("task", "edit", "D-2", "--top");
		expect(result.code).toBe(0);
		expect(await linkText(one.link)).not.toBeNull();
		expect(await linkText(two.link)).not.toBeNull();
		expect(await column("Backlog")).toEqual(["D-2", "D-1"]);
		expect(await readFile(two.real, "utf8")).toMatch(/ordinal: /);
	});

	it("names the reason when the listed tasks have no status", async () => {
		await addTask("D-1", "", 1000);
		const result = await cli("task", "edit", "D-1", "--top");
		expect(result.code).toBe(1);
		expect(result.out).toContain("Tasks have no status; pass -s.");
	});

	it("prints only the placement and the task view for a single --plain edit", async () => {
		await addTasks("Backlog", ["D-1", "D-2"]);
		const result = await cli("task", "edit", "D-2", "--top", "--priority", "high", "--plain");
		expect(result.code).toBe(0);
		expect(result.out).not.toContain("Updated task");
		expect(result.out.indexOf("Placed D-2")).toBeGreaterThanOrEqual(0);
		expect(result.out.indexOf("Placed D-2")).toBeLessThan(result.out.indexOf("Task D-2 - Task D-2"));
	});

	it("places a single task with only a placement flag", async () => {
		await addTasks("Backlog", ["D-1", "D-2"]);
		const result = await cli("task", "edit", "D-2", "--top");
		expect(result.code).toBe(0);
		expect(await column("Backlog")).toEqual(["D-2", "D-1"]);
	});
});

describe("task create placement", () => {
	it("creates at the top or after an anchor", async () => {
		await addTasks("Backlog", ["D-1", "D-2"]);
		await addTasks("In Progress", ["D-3", "D-4"]);
		const top = await cli("task", "create", "New top", "--top");
		expect(top.code).toBe(0);
		expect(top.out).toContain("Created task D-5");
		expect(await column("Backlog")).toEqual(["D-5", "D-1", "D-2"]);
		expect((await cli("task", "create", "Mid", "-s", "In Progress", "--after", "D-3")).code).toBe(0);
		expect(await column("In Progress")).toEqual(["D-3", "D-6", "D-4"]);
	});

	it("creates the task straight in the anchor's status, with no status change", async () => {
		await appendFile(join(root, "backlog.config.yml"), "on_status_change: 'echo \"$TASK_ID\" >> hook.log'\n");
		await addTasks("In Progress", ["D-3", "D-4"]);
		const result = await cli("task", "create", "Mid", "--after", "D-3");
		expect(result.code).toBe(0);
		expect(await column("In Progress")).toEqual(["D-3", "D-5", "D-4"]);
		const hookRan = await stat(join(root, "hook.log")).then(
			() => true,
			() => false,
		);
		expect(hookRan).toBe(false);
	});

	it("prints the placement before the --plain task view", async () => {
		await addTasks("Backlog", ["D-1"]);
		const result = await cli("task", "create", "Fresh", "--top", "--plain");
		expect(result.code).toBe(0);
		expect(result.out.indexOf("Placed D-2")).toBeGreaterThanOrEqual(0);
		expect(result.out.indexOf("Placed D-2")).toBeLessThan(result.out.indexOf("Task D-2 - Fresh"));
	});

	it("refuses a bad placement before creating anything", async () => {
		await addTasks("Backlog", ["D-1"]);
		await addTasks("In Progress", ["D-3"]);
		const before = await snapshot();
		const cases: Array<[string[], string]> = [
			[["-s", "Backlog", "--after", "D-3"], 'Anchor D-3 is in "In Progress", not "Backlog".'],
			[["--draft", "--top"], "Drafts have no board column; drop the placement flag."],
			[["-s", "Draft", "--top"], "Drafts have no board column; drop the placement flag."],
			[["--ordinal", "5", "--top"], "--ordinal cannot be combined with --top/--bottom/--before/--after."],
		];
		for (const [args, message] of cases) {
			const result = await cli("task", "create", "Nope", ...args);
			expect(result.code).toBe(1);
			expect(result.out).toContain(message);
		}
		expect(await snapshot()).toEqual(before);
		expect((await cli("task", "create", "Next")).out).toContain("Created task D-4");
	});

	it("bottom prints only the create lines, and no flag still lands at the bottom", async () => {
		await addTasks("Backlog", ["D-1", "D-2"]);
		const bottom = await cli("task", "create", "Last", "--bottom");
		expect(bottom.code).toBe(0);
		expect(bottom.out).not.toContain("Placed");
		expect(bottom.out).not.toContain("already");
		await cli("task", "create", "Plain");
		expect(await column("Backlog")).toEqual(["D-1", "D-2", "D-3", "D-4"]);
	});
});

describe("MCP position", () => {
	let server: McpServer;

	beforeEach(async () => {
		server = new McpServer(root, "Test instructions");
		const config = await server.filesystem.loadConfig();
		if (!config) throw new Error("no config");
		registerTaskTools(server, config);
	});

	afterEach(async () => {
		await server.stop();
	});

	const call = (name: string, args: Record<string, unknown>) =>
		server.testInterface.callTool({ params: { name, arguments: args } });
	const text = (result: { content?: unknown[] }) => (result.content?.[0] as { text?: string } | undefined)?.text ?? "";

	it("places on task_edit and task_create", async () => {
		await addTasks("Backlog", ["D-1", "D-2", "D-3"]);
		expect((await call("task_edit", { id: "D-1", position: "after:D-2" })).isError).not.toBe(true);
		expect(await column("Backlog")).toEqual(["D-2", "D-1", "D-3"]);
		expect((await call("task_create", { title: "Fresh", position: "top" })).isError).not.toBe(true);
		expect(await column("Backlog")).toEqual(["D-4", "D-2", "D-1", "D-3"]);
	});

	it("names the created task when the placement fails after task_create wrote it", async () => {
		await addTasks("Backlog", ["D-1"]);
		spyOn(server, "moveTasksToStatus").mockResolvedValue({
			movedTasks: [],
			changedTasks: [],
			failures: [{ taskId: "D-2", reason: "Task D-2 not found." }],
		});
		const result = await call("task_create", { title: "Racy", position: "top" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Created task D-2, but placement failed: Task D-2 not found.");
		expect(text(result)).toContain('task_edit { id: "D-2", position: "top" }');
		expect(await new Core(root).filesystem.loadTask("D-2")).not.toBeNull();
	});

	it("rejects position with ordinal and a bad position", async () => {
		await addTasks("Backlog", ["D-1"]);
		const withOrdinalResult = await call("task_edit", { id: "D-1", position: "top", ordinal: 5 });
		expect(withOrdinalResult.isError).toBe(true);
		expect(text(withOrdinalResult)).toContain("position cannot be combined with ordinal");
		const bad = await call("task_create", { title: "X", position: "middle" });
		expect(bad.isError).toBe(true);
		expect(text(bad)).toContain('Invalid position "middle"');
		expect(await column("Backlog")).toEqual(["D-1"]);
	});
});
