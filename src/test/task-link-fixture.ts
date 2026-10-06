import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/* A project whose backlog tree lives at tm/board and whose tasks live at tm/D-<n>-<slug>/task.md. */

export const BODY = [
	"## Description",
	"",
	"<!-- SECTION:DESCRIPTION:BEGIN -->",
	"Intro line.",
	"",
	"## Heading A",
	"",
	"- item `code`",
	"",
	"```ts",
	"const x = 'y';",
	"```",
	"<!-- SECTION:DESCRIPTION:END -->",
	"",
].join("\n");

export async function writeLinkedProject(root: string, options: { taskHome?: boolean; autoCommit?: boolean } = {}) {
	await mkdir(join(root, "tm", "board", "tasks"), { recursive: true });
	await mkdir(join(root, "tm", "board", "drafts"), { recursive: true });
	await writeFile(
		join(root, "backlog.config.yml"),
		[
			'project_name: "Links"',
			'statuses: ["Backlog", "In Progress", "Done"]',
			'task_prefix: "D"',
			`auto_commit: ${options.autoCommit ?? false}`,
			"check_active_branches: false",
			'backlog_directory: "tm/board"',
			...(options.taskHome ? ['task_home: "tm/{ID}-{slug}/task.md"'] : []),
			"",
		].join("\n"),
	);
}

export function taskFile(id: string, title: string, status = "Backlog"): string {
	return [
		"---",
		`id: ${id}`,
		`title: ${title}`,
		`status: ${status}`,
		"assignee: []",
		"created_date: '2026-09-01 10:00'",
		"updated_date: '2026-09-02 10:00'",
		"labels: []",
		"dependencies: []",
		"---",
		"",
		BODY,
	].join("\n");
}

/** Writes tm/<dir>/task.md and links it from tm/board/<sub>/<linkName>. */
export async function addLinkedTask(
	root: string,
	dir: string,
	content: string,
	linkName: string,
	sub = "tasks",
): Promise<{ real: string; link: string }> {
	const real = join(root, "tm", dir, "task.md");
	const link = join(root, "tm", "board", sub, linkName);
	await mkdir(dirname(real), { recursive: true });
	await mkdir(dirname(link), { recursive: true });
	await writeFile(real, content);
	await symlink(relative(dirname(link), real), link);
	return { real, link };
}

/** The link's own target text, or null when the path is not a symlink. */
export async function linkText(path: string): Promise<string | null> {
	const stats = await lstat(path).catch(() => null);
	return stats?.isSymbolicLink() ? await readlink(path) : null;
}

/** Every file under the backlog tree that is not a symlink: a real copy of a linked task shows up here. */
export async function realFilesInBoard(root: string): Promise<string[]> {
	const board = join(root, "tm", "board");
	const entries = await readdir(board, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => relative(board, join(entry.parentPath, entry.name)));
}

export async function read(path: string): Promise<string> {
	return await readFile(path, "utf8");
}
