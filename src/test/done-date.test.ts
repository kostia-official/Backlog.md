import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { Core } from "../core/backlog.ts";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
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

	it("round-trips through serializeTask and parseTask, right after updated_date", () => {
		const text = serializeTask({ ...parseTask(taskFile("D-1", "One", "Done")), doneDate: "2026-09-30 12:00" });
		expect(text).toMatch(/updated_date: '2026-09-02 10:00'\ndone_date: '2026-09-30 12:00'\n/);
		expect(parseTask(text).doneDate).toBe("2026-09-30 12:00");
	});
});
