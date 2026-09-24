import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../core/backlog.ts";
import { applyDuplicateTaskIdRepair } from "../core/duplicate-task-repair.ts";
import { migrateDraftPrefixes } from "../core/prefix-migration.ts";
import { saveRelocatedRecord } from "../file-system/task-links.ts";
import {
	addLinkedTask,
	BODY,
	linkText,
	read,
	realFilesInBoard,
	taskFile,
	writeLinkedProject,
} from "./task-link-fixture.ts";
import { createUniqueTestDir, isWindows, safeCleanup } from "./test-utils.ts";

const describeIfSymlinks = isWindows() ? describe.skip : describe;

describeIfSymlinks("symlinked task files", () => {
	let root: string;
	let core: Core;
	let alpha: { real: string; link: string };

	beforeEach(async () => {
		root = createUniqueTestDir("test-task-links");
		await mkdir(root, { recursive: true });
		await writeLinkedProject(root);
		alpha = await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
		core = new Core(root);
	});

	afterEach(async () => {
		await safeCleanup(root);
	});

	it("keeps the body byte-identical through a status change and a reorder", async () => {
		await addLinkedTask(root, "D-2-beta", taskFile("D-2", "Beta"), "d-2 - Beta.md");
		await core.updateTaskFromInput("D-1", { status: "In Progress" }, false);
		await core.reorderTask({ taskId: "D-1", targetStatus: "In Progress", orderedTaskIds: ["D-1"], autoCommit: false });
		const content = await read(alpha.real);
		expect(content.endsWith(`---\n\n${BODY}`)).toBe(true);
		expect(content).toContain("status: In Progress");
		expect(await linkText(alpha.link)).toBe("../../D-1-alpha/task.md");
		expect((await core.getTask("D-1"))?.description).toContain("## Heading A");
	});

	it("completes a task by moving the link", async () => {
		expect(await core.completeTask("D-1", false)).toBe(true);
		const moved = join(root, "tm", "board", "completed", "d-1 - Alpha.md");
		expect(await linkText(moved)).toBe("../../D-1-alpha/task.md");
		expect(await linkText(alpha.link)).toBeNull();
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("archives a task with a link that still resolves one level deeper", async () => {
		const result = await core.archiveTask("D-1", false);
		expect(result.success).toBe(true);
		const moved = join(root, "tm", "board", "archive", "tasks", "d-1 - Alpha.md");
		expect(await linkText(moved)).toBe("../../../D-1-alpha/task.md");
		expect(await read(moved)).toBe(await read(alpha.real));
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("demotes and promotes through the same real file", async () => {
		await core.demoteTask("D-1", false);
		const draftLink = join(root, "tm", "board", "drafts", "draft-1 - Alpha.md");
		expect(await linkText(draftLink)).toBe("../../D-1-alpha/task.md");
		expect(await read(alpha.real)).toContain("id: DRAFT-1");
		expect(await linkText(alpha.link)).toBeNull();

		expect(await core.promoteDraft("DRAFT-1", false)).toBe(true);
		expect(await linkText(alpha.link)).toBe("../../D-1-alpha/task.md");
		expect(await read(alpha.real)).toContain("id: D-1");
		expect(await read(alpha.real)).toContain(BODY);
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("demotes and promotes through edit status changes", async () => {
		await core.editTaskOrDraft("D-1", { status: "Draft" }, false);
		expect(await read(alpha.real)).toContain("id: DRAFT-1");
		await core.editTaskOrDraft("DRAFT-1", { status: "Backlog" }, false);
		expect(await read(alpha.real)).toContain("id: D-1");
		expect(await linkText(alpha.link)).toBe("../../D-1-alpha/task.md");
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("renames a linked draft's link on a title change and archives it as a link", async () => {
		const draft = await addLinkedTask(
			root,
			"DRAFT-1-idea",
			taskFile("DRAFT-1", "Idea", "Draft"),
			"draft-1 - Idea.md",
			"drafts",
		);
		await core.editTaskOrDraft("DRAFT-1", { title: "Better idea" }, false);
		const renamed = join(root, "tm", "board", "drafts", "draft-1 - Better-idea.md");
		expect(await linkText(renamed)).toBe("../../DRAFT-1-idea/task.md");
		expect(await linkText(draft.link)).toBeNull();
		expect(await read(draft.real)).toContain("title: Better idea");

		expect(await core.archiveDraft("DRAFT-1", false)).toBe(true);
		const archived = join(root, "tm", "board", "archive", "drafts", "draft-1 - Better-idea.md");
		expect(await linkText(archived)).toBe("../../../DRAFT-1-idea/task.md");
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("moves the link when a save gives a task a new filename", async () => {
		const task = await core.getTask("D-1");
		if (!task) throw new Error("missing task");
		const saved = await core.filesystem.saveTask({ ...task, title: "Renamed", filePath: undefined });
		expect(saved).toBe(join(root, "tm", "board", "tasks", "d-1 - Renamed.md"));
		expect(await linkText(saved)).toBe("../../D-1-alpha/task.md");
		expect(await linkText(alpha.link)).toBeNull();
		expect(await read(alpha.real)).toContain("title: Renamed");
	});

	it("repairs a duplicate id by rewriting the real file and moving only the link", async () => {
		const other = await addLinkedTask(root, "D-1-other", taskFile("D-1", "Other"), "d-1 - Other.md");
		const plan = await core.previewDuplicateTaskIdRepair();
		expect(plan.repairable).toBe(true);
		const result = await core.repairDuplicateTaskIds(plan.fingerprint);
		expect(result.repairedFiles).toBe(1);
		const [change] = result.changes;
		if (!change) throw new Error("missing change");
		const repairedLink = join(root, change.targetPath);
		const repairedReal = change.title === "Other" ? other.real : alpha.real;
		expect(await linkText(repairedLink)).toBe(`../../${change.title === "Other" ? "D-1-other" : "D-1-alpha"}/task.md`);
		expect(await read(repairedReal)).toContain(`id: ${change.newId}`);
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("restores the real file when a repair fails, unless someone changed it since", async () => {
		const other = await addLinkedTask(root, "D-1-other", taskFile("D-1", "Other"), "d-1 - Other.md");
		const originals = [await read(alpha.real), await read(other.real)];
		const failInstall = async () => {
			throw new Error("install failed");
		};
		let plan = await core.previewDuplicateTaskIdRepair();
		await expect(applyDuplicateTaskIdRepair(core, plan.fingerprint, { installFile: failInstall })).rejects.toThrow(
			"install failed",
		);
		expect([await read(alpha.real), await read(other.real)]).toEqual(originals);

		plan = await core.previewDuplicateTaskIdRepair();
		const concurrent = async () => {
			for (const real of [alpha.real, other.real]) await writeFile(real, taskFile("D-1", "Concurrent"));
			throw new Error("install failed");
		};
		await expect(applyDuplicateTaskIdRepair(core, plan.fingerprint, { installFile: concurrent })).rejects.toThrow(
			"changed after the repair rewrote it",
		);
		expect(await read(alpha.real)).toContain("title: Concurrent");
		expect(await read(other.real)).toContain("title: Concurrent");
	});

	it("moves a relocated link back when the save fails", async () => {
		const task = await core.getTask("D-1");
		if (!task) throw new Error("missing task");
		const failingWriter = {
			loadConfig: () => core.filesystem.loadConfig(),
			getTaskWritePath: (record: typeof task, isDraft?: boolean) => core.filesystem.getTaskWritePath(record, isDraft),
			saveTask: async () => {
				throw new Error("save failed");
			},
			saveDraft: async () => {
				throw new Error("save failed");
			},
		};
		const draft = { ...task, id: "DRAFT-1", status: "Draft" };
		await expect(saveRelocatedRecord(failingWriter, draft, alpha.link, true)).rejects.toThrow("save failed");
		expect(await linkText(alpha.link)).toBe("../../D-1-alpha/task.md");
		expect(await linkText(join(root, "tm", "board", "drafts", "draft-1 - Alpha.md"))).toBeNull();
	});

	it("migrates a linked task- draft to a draft- link", async () => {
		const legacy = await addLinkedTask(
			root,
			"DRAFT-9-legacy",
			taskFile("task-9", "Legacy", "Draft"),
			"task-9 - Legacy.md",
			"drafts",
		);
		await migrateDraftPrefixes(core.filesystem);
		expect(await linkText(legacy.link)).toBeNull();
		expect(await linkText(join(root, "tm", "board", "drafts", "draft-1 - Legacy.md"))).toBe(
			"../../DRAFT-9-legacy/task.md",
		);
		expect(await read(legacy.real)).toContain("id: DRAFT-1");
	});
});
