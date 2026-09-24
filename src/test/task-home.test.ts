import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { migrateDraftPrefixes } from "../core/prefix-migration.ts";
import { diagnoseTaskLinks, slugFromTitle } from "../file-system/task-links.ts";
import { addLinkedTask, linkText, read, realFilesInBoard, taskFile, writeLinkedProject } from "./task-link-fixture.ts";
import { createUniqueTestDir, isWindows, safeCleanup } from "./test-utils.ts";

const describeIfSymlinks = isWindows() ? describe.skip : describe;
const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

describeIfSymlinks("task_home", () => {
	let root: string;
	let core: Core;

	beforeEach(async () => {
		root = createUniqueTestDir("test-task-home");
		await mkdir(root, { recursive: true });
		await writeLinkedProject(root, { taskHome: true });
		core = new Core(root);
	});

	afterEach(async () => {
		await safeCleanup(root);
	});

	it("creates the real file in the task's home and links it from tasks/", async () => {
		const { task, filePath } = await core.createTaskFromInput(
			{ title: "Create forward handle", slug: "forward-handle", description: "Body text" },
			false,
		);
		expect(task.id).toBe("D-1");
		const home = join(root, "tm", "D-1-forward-handle", "task.md");
		expect(filePath).toBe(join(root, "tm", "board", "tasks", "d-1 - Create-forward-handle.md"));
		expect(await linkText(filePath as string)).toBe("../../D-1-forward-handle/task.md");
		const content = await read(home);
		expect(content).toContain("<!-- SECTION:DESCRIPTION:BEGIN -->\nBody text\n<!-- SECTION:DESCRIPTION:END -->");
		expect(content).not.toContain("slug");
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("takes the slug from the first six words of the title", async () => {
		expect(slugFromTitle("Fix: the DM's roll — loop, when it hangs forever")).toBe("fix-the-dm-s-roll-loop");
		await core.createTaskFromInput({ title: "Reaction window" }, false);
		expect(await exists(join(root, "tm", "D-1-reaction-window", "task.md"))).toBe(true);
	});

	it("rejects a slug that is not kebab-case", async () => {
		await expect(core.createTaskFromInput({ title: "Bad", slug: "../escape" }, false)).rejects.toThrow("Invalid slug");
		expect(await exists(join(root, "tm", "board", "tasks", "d-1 - Bad.md"))).toBe(false);
	});

	it("keeps a draft a plain file and gives it a home named for its task id on promotion", async () => {
		const { task, filePath } = await core.createTaskFromInput({ title: "Idea", status: "Draft" }, false);
		expect(await linkText(filePath as string)).toBeNull();
		expect(await exists(join(root, "tm", "DRAFT-1-idea"))).toBe(false);

		await core.promoteDraft(task.id, false);
		expect(await linkText(join(root, "tm", "board", "tasks", "d-1 - Idea.md"))).toBe("../../D-1-idea/task.md");
		expect(await read(join(root, "tm", "D-1-idea", "task.md"))).toContain("id: D-1");
		expect(await exists(filePath as string)).toBe(false);
		expect(await realFilesInBoard(root)).toEqual([]);

		await writeFile(join(root, "tm", "board", "drafts", "draft-2 - Plain.md"), taskFile("DRAFT-2", "Plain", "Draft"));
		await core.editTaskOrDraft("DRAFT-2", { status: "Backlog" }, false);
		expect(await linkText(join(root, "tm", "board", "tasks", "d-2 - Plain.md"))).toBe("../../D-2-plain/task.md");
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("refuses to demote a task, which would leave its home named for another id", async () => {
		const alpha = await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
		const before = await read(alpha.real);
		await expect(core.demoteTask("D-1", false)).rejects.toThrow("task_home");
		await expect(core.editTaskOrDraft("D-1", { status: "Draft" }, false)).rejects.toThrow("task_home");
		await expect(core.filesystem.demoteTask("D-1")).rejects.toThrow("task_home");
		expect(await read(alpha.real)).toBe(before);
		expect(await linkText(alpha.link)).toBe("../../D-1-alpha/task.md");
		expect(await readdir(join(root, "tm", "board", "drafts"))).toEqual([]);
	});

	it("refuses the draft prefix migration", async () => {
		await expect(migrateDraftPrefixes(core.filesystem)).rejects.toThrow("task_home");
	});

	it("never reuses an id held by a home directory with no link", async () => {
		await mkdir(join(root, "tm", "D-7-orphan"), { recursive: true });
		await writeFile(join(root, "tm", "D-7-orphan", "task.md"), taskFile("D-7", "Orphan"));
		const { task } = await core.createTaskFromInput({ title: "Next" }, false);
		expect(task.id).toBe("D-8");
	});

	it("keeps task_home when the config is saved", async () => {
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("missing config");
		expect(config.taskHome).toBe("tm/{ID}-{slug}/task.md");
		await core.filesystem.saveConfig({ ...config, projectName: "Renamed" });
		const saved = await readFile(join(root, "backlog.config.yml"), "utf8");
		expect(saved).toContain('task_home: "tm/{ID}-{slug}/task.md"');
		core.filesystem.invalidateConfigCache();
		expect((await core.filesystem.loadConfig())?.taskHome).toBe("tm/{ID}-{slug}/task.md");
	});

	it("unstages and removes the home when the create commit fails after staging", async () => {
		await $`git init -q && git config user.email t@t && git config user.name t`.cwd(root).quiet();
		core.gitOps.commitFiles = async () => {
			throw new Error("commit failed");
		};
		await expect(core.createTaskFromInput({ title: "Doomed" }, true)).rejects.toThrow("commit failed");
		expect(await exists(join(root, "tm", "D-1-doomed"))).toBe(false);
		expect((await $`git ls-files --stage`.cwd(root).quiet()).stdout.toString()).toBe("");
	});

	it("removes the home it made when the create is rolled back", async () => {
		await $`git init -q && git config user.email t@t && git config user.name t`.cwd(root).quiet();
		core.gitOps.addAndCommitTaskFile = async () => {
			throw new Error("commit failed");
		};
		await expect(core.createTaskFromInput({ title: "Doomed" }, true)).rejects.toThrow("commit failed");
		expect(await exists(join(root, "tm", "D-1-doomed"))).toBe(false);
		expect(await linkText(join(root, "tm", "board", "tasks", "d-1 - Doomed.md"))).toBeNull();
	});

	it("doctor finds a dangling link, a home no link points to, and a home named for another id", async () => {
		await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
		await symlink("../../D-2-gone/task.md", join(root, "tm", "board", "tasks", "d-2 - Gone.md"));
		await mkdir(join(root, "tm", "D-3-lonely"), { recursive: true });
		await writeFile(join(root, "tm", "D-3-lonely", "task.md"), taskFile("D-3", "Lonely"));
		await addLinkedTask(root, "D-4-drifted", taskFile("D-5", "Drifted"), "d-5 - Drifted.md");

		const findings = await diagnoseTaskLinks(root, core.filesystem.backlogDir, "tm/{ID}-{slug}/task.md");
		expect(findings).toEqual({
			danglingLinks: ["tm/board/tasks/d-2 - Gone.md"],
			unlinkedHomes: ["tm/D-3-lonely/task.md"],
			mismatchedHomes: ["tm/D-4-drifted/task.md (id: D-5)"],
		});

		const cli = await $`bun ${join(process.cwd(), "src", "cli.ts")} doctor`.cwd(root).quiet().nothrow();
		expect(cli.exitCode).toBe(1);
		expect(cli.stdout.toString()).toContain("tm/board/tasks/d-2 - Gone.md");
		expect(cli.stdout.toString()).toContain("tm/D-3-lonely/task.md");
		expect(cli.stdout.toString()).toContain("tm/D-4-drifted/task.md (id: D-5)");
	});
});
