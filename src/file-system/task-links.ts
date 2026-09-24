import { type FSWatcher, watch as fsWatch } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { Task } from "../types/index.ts";
import { escapeRegex } from "../utils/prefix-config.ts";

/*
 * A task file in the backlog tree may be a symlink to a real file elsewhere in the project (its
 * "home"). These helpers move, write and watch such links so the real file stays the only copy.
 */

export async function isSymlink(path: string): Promise<boolean> {
	return (await lstat(path).catch(() => null))?.isSymbolicLink() ?? false;
}

async function linkTo(targetPath: string, linkPath: string): Promise<void> {
	await symlink(relative(await realpath(dirname(linkPath)), await realpath(targetPath)), linkPath);
}

/** Moves a task file. A symlink is recreated at `dest` with a target relative to its new place. */
export async function moveTaskFile(src: string, dest: string): Promise<void> {
	if (!(await isSymlink(src))) {
		await rename(src, dest);
		return;
	}
	await mkdir(dirname(dest), { recursive: true });
	await linkTo(src, dest);
	await unlink(src);
}

/** Writes a task file. With a home and nothing at `path` yet, the home gets the content and `path` links to it. */
export async function writeTaskFile(path: string, content: string, homePath?: string | null): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	if (!homePath || (await lstat(path).catch(() => null))) {
		await Bun.write(path, content);
		return;
	}
	await mkdir(dirname(homePath), { recursive: true });
	await writeFile(homePath, content, { flag: "wx" });
	await linkTo(homePath, path);
}

/** Removes the home directory made by a rolled-back create, and the link to it. */
export async function removeCreatedTaskHome(linkPath: string, homeDir: string): Promise<void> {
	if (await isSymlink(linkPath)) await unlink(linkPath);
	await rm(homeDir, { recursive: true, force: true });
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Kebab-case of the title's first six words. */
export function slugFromTitle(title: string): string {
	const words = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	return words.slice(0, 6).join("-") || "task";
}

export function assertValidTaskSlug(slug: string): void {
	if (!SLUG_PATTERN.test(slug)) {
		throw new Error(`Invalid slug "${slug}": use lowercase letters, digits and single hyphens.`);
	}
}

/** Project-relative home path for a task id, from a `task_home` pattern with `{ID}` and `{slug}`. */
export function taskHomePath(rootDir: string, pattern: string, id: string, slug: string): string {
	return join(rootDir, pattern.replaceAll("{ID}", id).replaceAll("{slug}", slug));
}

/** Home file for a task id, or null when `task_home` is not set. */
export function resolveTaskHome(
	rootDir: string,
	pattern: string | undefined,
	id: string,
	task: Pick<Task, "slug" | "title">,
): string | null {
	if (!pattern) return null;
	const slug = task.slug ?? slugFromTitle(task.title);
	assertValidTaskSlug(slug);
	return taskHomePath(rootDir, pattern, id, slug);
}

interface RecordWriter {
	saveTask(task: Task): Promise<string>;
	saveDraft(task: Task): Promise<string>;
	getTaskWritePath(task: Task, isDraft?: boolean): Promise<string>;
}

/**
 * Saves a record under a new id (promote, demote, migration). A linked source moves its link and
 * the record is written through it, so its home stays as it is. A plain source is written anew;
 * `moved: false` tells the caller to remove it.
 */
export async function saveRelocatedRecord(
	fs: RecordWriter,
	record: Task,
	sourcePath: string,
	isDraft: boolean,
): Promise<{ savedPath: string; moved: boolean }> {
	const save = (task: Task) => (isDraft ? fs.saveDraft(task) : fs.saveTask(task));
	if (!(await isSymlink(sourcePath))) return { savedPath: await save(record), moved: false };
	const dest = await fs.getTaskWritePath({ ...record, filePath: undefined }, isDraft);
	await moveTaskFile(sourcePath, dest);
	return { savedPath: await save({ ...record, filePath: dest }), moved: true };
}

function homeGlob(pattern: string): string {
	return pattern.replaceAll("{ID}", "*").replaceAll("{slug}", "*");
}

/** Ids of the task homes on disk with this prefix. A home keeps its id taken even with no link. */
export async function listTaskHomeIds(rootDir: string, pattern: string, prefix: string): Promise<string[]> {
	const idPattern = `(${escapeRegex(prefix)}-\\d+(?:\\.\\d+)*)`;
	const matcher = new RegExp(
		`^${escapeRegex(pattern).replaceAll(escapeRegex("{ID}"), idPattern).replaceAll(escapeRegex("{slug}"), "[^/]+")}$`,
		"i",
	);
	const ids: string[] = [];
	for await (const path of new Bun.Glob(homeGlob(pattern)).scan({ cwd: rootDir })) {
		const id = path.split("\\").join("/").match(matcher)?.[1];
		if (id) ids.push(id.toUpperCase());
	}
	return ids;
}

/** Adds the real file behind every symlinked path, so a commit carries the link and its content. */
export async function withLinkTargets(paths: string[]): Promise<string[]> {
	const expanded: string[] = [];
	for (const path of paths) {
		expanded.push(path);
		if (await isSymlink(path)) {
			const target = await realpath(path).catch(() => null);
			if (target) expanded.push(target);
		}
	}
	return expanded;
}

export interface TaskLinkFindings {
	danglingLinks: string[];
	unlinkedHomes: string[];
}

/** Links in the backlog tree that resolve to nothing, and homes that no link points to. */
export async function diagnoseTaskLinks(
	rootDir: string,
	backlogDir: string,
	pattern: string | undefined,
): Promise<TaskLinkFindings> {
	const entries = await readdir(backlogDir, { recursive: true, withFileTypes: true }).catch(() => []);
	const danglingLinks: string[] = [];
	const linked = new Set<string>();
	for (const entry of entries) {
		if (!entry.isSymbolicLink()) continue;
		const path = join(entry.parentPath, entry.name);
		const target = await realpath(path).catch(() => null);
		if (target) linked.add(target);
		else danglingLinks.push(relative(rootDir, path));
	}
	const unlinkedHomes: string[] = [];
	if (pattern) {
		for await (const home of new Bun.Glob(homeGlob(pattern)).scan({ cwd: rootDir })) {
			const real = await realpath(join(rootDir, home)).catch(() => null);
			if (real && !linked.has(real)) unlinkedHomes.push(home);
		}
	}
	return { danglingLinks: danglingLinks.sort(), unlinkedHomes: unlinkedHomes.sort() };
}

export function printTaskLinkReport(findings: TaskLinkFindings): void {
	if (findings.danglingLinks.length > 0) {
		console.log("\nTask links that point to nothing:");
		for (const path of findings.danglingLinks) console.log(`  - ${path}`);
		console.log("Point each link at its task file again, or remove it.");
	}
	if (findings.unlinkedHomes.length > 0) {
		console.log("\nTask files under task_home that no link points to:");
		for (const path of findings.unlinkedHomes) console.log(`  - ${path}`);
		console.log("Link each one from the backlog tree, or remove it.");
	}
}

export function hasTaskLinkFindings(findings: TaskLinkFindings): boolean {
	return findings.danglingLinks.length > 0 || findings.unlinkedHomes.length > 0;
}

export interface TaskLinkWatcher {
	/** Re-reads the links in the directory; call it after any event there. */
	refresh(): Promise<void>;
	stop(): void;
}

/**
 * Watches the real directory of every symlinked `.md` file in `dir`, because a watch on `dir`
 * does not see an edit to a link's target. `onChange` gets the link's file name.
 */
export function watchTaskLinkTargets(dir: string, onChange: (linkName: string) => void): TaskLinkWatcher {
	// Real directory -> (real file name -> link names in `dir`).
	let targets = new Map<string, Map<string, string[]>>();
	const watchers = new Map<string, FSWatcher>();
	let stopped = false;

	const refresh = async () => {
		const next = new Map<string, Map<string, string[]>>();
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isSymbolicLink() || !entry.name.endsWith(".md")) continue;
			const target = await realpath(join(dir, entry.name)).catch(() => null);
			if (!target) continue;
			const files = next.get(dirname(target)) ?? new Map<string, string[]>();
			files.set(basename(target), [...(files.get(basename(target)) ?? []), entry.name]);
			next.set(dirname(target), files);
		}
		if (stopped) return;
		targets = next;
		for (const [targetDir, watcher] of watchers) {
			if (next.has(targetDir)) continue;
			watcher.close();
			watchers.delete(targetDir);
		}
		for (const targetDir of next.keys()) {
			if (watchers.has(targetDir)) continue;
			try {
				const watcher = fsWatch(targetDir, { recursive: false }, (_eventType, filename) => {
					const names = filename ? targets.get(targetDir)?.get(String(filename)) : undefined;
					for (const name of names ?? []) onChange(name);
				});
				watcher.on("error", () => {});
				watchers.set(targetDir, watcher);
			} catch {
				// A directory that vanished between the scan and the watch is picked up by the next refresh.
			}
		}
	};

	void refresh();
	return {
		refresh,
		stop() {
			stopped = true;
			for (const watcher of watchers.values()) watcher.close();
			watchers.clear();
		},
	};
}
