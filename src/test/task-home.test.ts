import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
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

	it("gives a new draft its own home, and promotion keeps it", async () => {
		const { task } = await core.createTaskFromInput({ title: "Idea", status: "Draft" }, false);
		const home = join(root, "tm", "DRAFT-1-idea", "task.md");
		expect(await linkText(join(root, "tm", "board", "drafts", "draft-1 - Idea.md"))).toBe("../../DRAFT-1-idea/task.md");

		await core.promoteDraft(task.id, false);
		expect(await linkText(join(root, "tm", "board", "tasks", "d-1 - Idea.md"))).toBe("../../DRAFT-1-idea/task.md");
		expect(await read(home)).toContain("id: D-1");
		expect(await exists(join(root, "tm", "D-1-idea"))).toBe(false);
	});

	it("gives a plain draft a home when it is promoted", async () => {
		await writeFile(join(root, "tm", "board", "drafts", "draft-1 - Plain.md"), taskFile("DRAFT-1", "Plain", "Draft"));
		await core.promoteDraft("DRAFT-1", false);
		expect(await linkText(join(root, "tm", "board", "tasks", "d-1 - Plain.md"))).toBe("../../D-1-plain/task.md");
		expect(await realFilesInBoard(root)).toEqual([]);
	});

	it("keeps the home directory when a linked task is demoted", async () => {
		const alpha = await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
		await core.demoteTask("D-1", false);
		expect(await linkText(join(root, "tm", "board", "drafts", "draft-1 - Alpha.md"))).toBe("../../D-1-alpha/task.md");
		expect(await read(alpha.real)).toContain("id: DRAFT-1");
		expect(await exists(join(root, "tm", "DRAFT-1-alpha"))).toBe(false);
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

	it("removes the home it made when the create is rolled back", async () => {
		await $`git init -q && git config user.email t@t && git config user.name t`.cwd(root).quiet();
		core.gitOps.addAndCommitTaskFile = async () => {
			throw new Error("commit failed");
		};
		await expect(core.createTaskFromInput({ title: "Doomed" }, true)).rejects.toThrow("commit failed");
		expect(await exists(join(root, "tm", "D-1-doomed"))).toBe(false);
		expect(await linkText(join(root, "tm", "board", "tasks", "d-1 - Doomed.md"))).toBeNull();
	});

	it("doctor finds a dangling link and a home that no link points to", async () => {
		await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
		await symlink("../../D-2-gone/task.md", join(root, "tm", "board", "tasks", "d-2 - Gone.md"));
		await mkdir(join(root, "tm", "D-3-lonely"), { recursive: true });
		await writeFile(join(root, "tm", "D-3-lonely", "task.md"), taskFile("D-3", "Lonely"));

		const findings = await diagnoseTaskLinks(root, core.filesystem.backlogDir, "tm/{ID}-{slug}/task.md");
		expect(findings).toEqual({
			danglingLinks: ["tm/board/tasks/d-2 - Gone.md"],
			unlinkedHomes: ["tm/D-3-lonely/task.md"],
		});

		const cli = await $`bun ${join(process.cwd(), "src", "cli.ts")} doctor`.cwd(root).quiet().nothrow();
		expect(cli.exitCode).toBe(1);
		expect(cli.stdout.toString()).toContain("tm/board/tasks/d-2 - Gone.md");
		expect(cli.stdout.toString()).toContain("tm/D-3-lonely/task.md");
	});
});
