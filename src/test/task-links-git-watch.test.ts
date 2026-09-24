import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { BranchTaskLoader } from "../core/task-loader.ts";
import { watchTaskLinkTargets } from "../file-system/task-links.ts";
import { GitOperations } from "../git/operations.ts";
import { watchTasks } from "../utils/task-watcher.ts";
import { addLinkedTask, read, taskFile, writeLinkedProject } from "./task-link-fixture.ts";
import { createUniqueTestDir, isWindows, safeCleanup, sleep } from "./test-utils.ts";

const describeIfSymlinks = isWindows() ? describe.skip : describe;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(50);
	}
	throw new Error("condition not met in time");
}

async function lastCommitEntries(root: string): Promise<string> {
	return (await $`git show --raw --format= HEAD`.cwd(root).quiet()).stdout.toString();
}

describeIfSymlinks("symlinked tasks in git and watchers", () => {
	let root: string;

	beforeEach(async () => {
		root = createUniqueTestDir("test-task-links-git");
		await mkdir(root, { recursive: true });
		await $`git init -q -b main && git config user.email t@t && git config user.name t`.cwd(root).quiet();
	});

	afterEach(async () => {
		await safeCleanup(root);
	});

	it("auto-commit stages the link and the real file on create", async () => {
		await writeLinkedProject(root, { taskHome: true, autoCommit: true });
		await $`git add -A && git commit -qm init`.cwd(root).quiet();
		const core = new Core(root);
		await core.createTaskFromInput({ title: "Linked", slug: "linked" });
		const entries = await lastCommitEntries(root);
		expect(entries).toMatch(/000000 120000 .*\ttm\/board\/tasks\/d-1 - Linked\.md/);
		expect(entries).toMatch(/000000 100644 .*\ttm\/D-1-linked\/task\.md/);
	});

	it("auto-commit stages the real file on an edit and the link on a move", async () => {
		await writeLinkedProject(root, { autoCommit: true });
		await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
		await $`git add -A && git commit -qm init`.cwd(root).quiet();
		const core = new Core(root);

		await core.updateTaskFromInput("D-1", { status: "In Progress" });
		expect(await lastCommitEntries(root)).toMatch(/100644 100644 .* M\ttm\/D-1-alpha\/task\.md/);

		await core.completeTask("D-1");
		const moved = await lastCommitEntries(root);
		expect(moved).toMatch(
			/120000 120000 .* R100\ttm\/board\/tasks\/d-1 - Alpha\.md\ttm\/board\/completed\/d-1 - Alpha\.md/,
		);
		expect((await $`git status --porcelain`.cwd(root).quiet()).stdout.toString()).toBe("");
	});

	it("loads a linked task from another branch through its target blob", async () => {
		await writeLinkedProject(root);
		await $`git add -A && git commit -qm init`.cwd(root).quiet();
		const mainCommit = (await $`git rev-parse HEAD`.cwd(root).quiet()).stdout.toString().trim();
		await $`git switch -qc feature`.cwd(root).quiet();
		await addLinkedTask(root, "D-5-five", taskFile("D-5", "Five"), "d-5 - Five.md");
		await $`git add -A && git commit -qm five`.cwd(root).quiet();
		const featureCommit = (await $`git rev-parse HEAD`.cwd(root).quiet()).stdout.toString().trim();
		await $`git switch -q main`.cwd(root).quiet();

		const core = new Core(root);
		const config = await core.filesystem.loadConfig();
		const result = await new BranchTaskLoader(new GitOperations(root, config)).load(
			[
				{ name: "main", commit: mainCommit, current: true },
				{ name: "feature", commit: featureCommit, current: false },
			],
			{ ...config, checkActiveBranches: true } as NonNullable<typeof config>,
			[],
			false,
			"tm/board",
			undefined,
			"main",
		);
		const five = result.entries.find((entry) => entry.id === "D-5");
		expect(five?.task).toMatchObject({ id: "D-5", title: "Five", status: "Backlog" });
	});

	it("notices an edit to a link's target and follows links added later", async () => {
		const dir = join(root, "links");
		await mkdir(dir, { recursive: true });
		const seen: string[] = [];
		const watcher = watchTaskLinkTargets(dir, (name) => seen.push(name));
		try {
			await writeLinkedProject(root);
			const alpha = await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
			await $`ln -s ${alpha.real} ${join(dir, "d-1 - Alpha.md")}`.quiet();
			await watcher.refresh();
			await writeFile(alpha.real, taskFile("D-1", "Alpha edited"));
			await waitFor(() => seen.includes("d-1 - Alpha.md"));
		} finally {
			watcher.stop();
		}
	});

	it("the task watcher and the content store see an edit made to the real file", async () => {
		await writeLinkedProject(root);
		const alpha = await addLinkedTask(root, "D-1-alpha", taskFile("D-1", "Alpha"), "d-1 - Alpha.md");
		const core = new Core(root, { enableWatchers: true });
		const store = await core.getContentStore();
		const changed: string[] = [];
		const watcher = watchTasks(core, { onTaskChanged: (task) => void changed.push(task.title) }, [
			...(await core.filesystem.listTasks()),
		]);
		try {
			await sleep(200);
			await writeFile(alpha.real, taskFile("D-1", "Alpha edited"));
			await waitFor(() => changed.includes("Alpha edited"));
			await waitFor(() => store.getTasks().some((task) => task.title === "Alpha edited"));
			expect(await read(alpha.link)).toContain("Alpha edited");
		} finally {
			watcher.stop();
			store.dispose();
		}
	});
});
