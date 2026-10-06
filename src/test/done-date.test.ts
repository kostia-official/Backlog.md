import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { generateKanbanBoardWithMetadata } from "../board.ts";
import { Core } from "../core/backlog.ts";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
import type { Task } from "../types/index.ts";
import { prepareBoardColumns } from "../ui/board.ts";
import { sortTasksForStatus } from "../web/lib/lanes.ts";
import { taskFile, writeLinkedProject } from "./task-link-fixture.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

let root: string;
let core: Core;

beforeEach(async () => {
	root = createUniqueTestDir("done-date");
	await mkdir(root, { recursive: true });
	await writeLinkedProject(root);
	core = new Core(root);
	await Bun.write(`${root}/tm/board/tasks/d-1 - One.md`, taskFile("D-1", "One"));
});

afterEach(async () => {
	await safeCleanup(root);
});

const load = async () => (await core.filesystem.loadTask("D-1")) ?? Promise.reject(new Error("D-1 missing"));

describe("done_date", () => {
	it("is set when the status becomes the last status and cleared when it leaves it", async () => {
		await core.editTaskOrDraft("D-1", { status: "Done" }, false);
		const done = await load();
		expect(done.doneDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(done.doneDate).toBe(done.updatedDate as string);

		await core.editTaskOrDraft("D-1", { status: "In Progress" }, false);
		expect((await load()).doneDate).toBeUndefined();
	});

	it("is left alone by an edit that does not change the status", async () => {
		const withDate = taskFile("D-1", "One", "Done").replace("labels: []", "done_date: '2026-01-02 03:04'\nlabels: []");
		await Bun.write(`${root}/tm/board/tasks/d-1 - One.md`, withDate);
		await core.editTaskOrDraft("D-1", { title: "Renamed" }, false);
		const task = await load();
		expect(task.title).toBe("Renamed");
		expect(task.doneDate).toBe("2026-01-02 03:04");
	});

	it("is set on create in the last status, and only there", async () => {
		const { task: done } = await core.createTaskFromInput({ title: "Born done", status: "Done" }, false);
		expect(done.doneDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(done.doneDate).toBe(done.createdDate);
		expect((await core.filesystem.loadTask(done.id))?.doneDate).toBe(done.doneDate);

		const { task: todo } = await core.createTaskFromInput({ title: "Born in backlog", status: "Backlog" }, false);
		expect(todo.doneDate).toBeUndefined();
	});

	it("round-trips through serializeTask and parseTask, right after updated_date", () => {
		const text = serializeTask({ ...parseTask(taskFile("D-1", "One", "Done")), doneDate: "2026-09-30 12:00" });
		expect(text).toMatch(/updated_date: '2026-09-02 10:00'\ndone_date: '2026-09-30 12:00'\n/);
		expect(parseTask(text).doneDate).toBe("2026-09-30 12:00");
	});
});

describe("Done column order", () => {
	// D-1 was edited last but finished first; the ordinals would give D-1, D-3, D-2.
	const task = (id: string, ordinal: number, dates: Partial<Task>): Task => ({
		id,
		title: id,
		status: "Done",
		assignee: [],
		labels: [],
		dependencies: [],
		createdDate: "2026-09-01 10:00",
		ordinal,
		...dates,
	});
	const tasks = [
		task("D-1", 1, { doneDate: "2026-10-01 10:00", updatedDate: "2026-10-05 10:00" }),
		task("D-2", 3, { doneDate: "2026-10-03 10:00", updatedDate: "2026-10-03 10:00" }),
		task("D-3", 2, { updatedDate: "2026-10-02 10:00" }),
	];
	const expected = ["D-2", "D-3", "D-1"];

	it("is newest done first in the web board", () => {
		expect(sortTasksForStatus(tasks, "Done").map((t) => t.id)).toEqual(expected);
	});

	it("is newest done first in the TUI board", () => {
		const done = prepareBoardColumns(tasks, ["To Do", "Done"]).find((column) => column.status === "Done");
		expect(done?.tasks.map((t) => t.id)).toEqual(expected);
	});

	it("is newest done first in the exported board", () => {
		const lines = generateKanbanBoardWithMetadata(tasks, ["Done"], "P").split("\n");
		const row = (id: string) => lines.findIndex((line) => line.includes(id));
		expect(row("D-2")).toBeLessThan(row("D-3"));
		expect(row("D-3")).toBeLessThan(row("D-1"));
	});
});
