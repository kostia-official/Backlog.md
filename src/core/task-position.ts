import { FALLBACK_STATUS } from "../constants/index.ts";
import { BacklogToolError } from "../mcp/errors/mcp-errors.ts";
import type { JsonSchema } from "../mcp/validation/validators.ts";
import type { Task } from "../types/index.ts";
import { getCanonicalStatus } from "../utils/status.ts";
import { AmbiguousTaskIdError } from "../utils/task-path.ts";
import { sortByOrdinal } from "../utils/task-sorting.ts";
import type { Core } from "./backlog.ts";

/* Places a block of tasks in a board column, in the order given; the ordinals come from moveTasksToStatus. */

export type Placement = { at: "top" } | { at: "bottom" } | { before: string } | { after: string };

export type PlacementPlan = { targetStatus: string; placedIds: string[]; orderedTaskIds: string[]; unchanged: boolean };

export type PlacementResult = { targetStatus: string; placedIds: string[]; writtenIds: string[]; where: string };

const PLACEMENT_FLAGS = ["top", "bottom", "before", "after"] as const;

export function parsePlacement(value: string): Placement {
	const trimmed = value.trim();
	if (trimmed === "top" || trimmed === "bottom") return { at: trimmed };
	const match = trimmed.match(/^(before|after):(.+)$/);
	const id = match?.[2]?.trim();
	if (match?.[1] === "before" && id) return { before: id };
	if (match?.[1] === "after" && id) return { after: id };
	throw new Error(`Invalid position "${value}". Use top, bottom, before:<ID> or after:<ID>.`);
}

const givenFlags = (options: Record<string, unknown>) =>
	PLACEMENT_FLAGS.filter((flag) => options[flag] !== undefined && options[flag] !== false);

export const hasPlacementFlag = (options: Record<string, unknown>): boolean => givenFlags(options).length > 0;

/** Reads --top/--bottom/--before/--after; throws when they conflict with each other or with --ordinal. */
export function placementFromCliOptions(options: Record<string, unknown>): Placement | undefined {
	const given = givenFlags(options);
	if (given.length === 0) return undefined;
	if (options.ordinal !== undefined) {
		throw new Error("--ordinal cannot be combined with --top/--bottom/--before/--after.");
	}
	if (given.length > 1) throw new Error("Use only one of --top, --bottom, --before, --after.");
	const flag = given[0];
	if (flag === "top" || flag === "bottom") return { at: flag };
	return flag === "before" ? { before: String(options.before) } : { after: String(options.after) };
}

export function placementFlag(placement: Placement): string {
	if ("at" in placement) return `--${placement.at}`;
	return "before" in placement ? `--before ${placement.before}` : `--after ${placement.after}`;
}

const anchorOf = (placement: Placement) =>
	"before" in placement ? placement.before : "after" in placement ? placement.after : undefined;

function describe(placement: Placement, anchorId: string | undefined): string {
	if ("at" in placement) return `at ${placement.at} of`;
	return `${"before" in placement ? "before" : "after"} ${anchorId} in`;
}

/**
 * Resolves the tasks and the anchor, applies every placement rule, and returns the column's new
 * order. Throws one Error whose message has a line per problem; nothing is written here.
 * `taskIds` is empty on create, before the task exists.
 */
export async function checkPlacement(
	core: Core,
	args: { taskIds: string[]; placement: Placement; status?: string },
): Promise<PlacementPlan & { where: string }> {
	const store = await core.getContentStore();
	await store.refreshTasks();
	const problems: string[] = [];
	const resolve = async (id: string): Promise<Task | undefined> => {
		const resolution = store.resolveTaskForMutation(id);
		if (resolution.status === "found") return resolution.task;
		if (resolution.status === "ambiguous") {
			problems.push(new AmbiguousTaskIdError(id, resolution.candidates).message);
		} else if (await core.filesystem.loadDraft(id)) {
			problems.push(`${id} is a draft; drafts have no board column.`);
		} else {
			problems.push(`Task ${id} not found.`);
		}
		return undefined;
	};

	const tasks: Task[] = [];
	for (const id of args.taskIds) {
		const task = await resolve(id);
		if (!task) continue;
		if (tasks.some((seen) => seen.id === task.id)) problems.push(`Duplicate task ID ${task.id} in the placement list.`);
		else tasks.push(task);
	}
	const anchorId = anchorOf(args.placement);
	const anchor = anchorId ? await resolve(anchorId) : undefined;
	if (anchor && tasks.some((task) => task.id === anchor.id)) {
		problems.push(`Anchor ${anchor.id} is one of the tasks being placed.`);
	}

	// A task about to be created goes to the default status unless an anchor names the column.
	const defaultStatus = (await core.filesystem.loadConfig())?.defaultStatus || FALLBACK_STATUS;
	const status = args.status ?? (args.taskIds.length === 0 && !anchorId ? defaultStatus : undefined);
	let targetStatus: string | undefined;
	if (status?.trim().toLowerCase() === "draft") {
		problems.push("Drafts have no board column; drop the placement flag.");
	} else if (status) {
		targetStatus = (await getCanonicalStatus(status, core)) ?? undefined;
		if (!targetStatus) problems.push(`Invalid status: ${status}.`);
	}
	if (anchor && targetStatus && anchor.status !== targetStatus) {
		problems.push(`Anchor ${anchor.id} is in "${anchor.status}", not "${targetStatus}".`);
	}
	if (!status && anchor) targetStatus = anchor.status;
	if (!status && !anchorId) {
		const statuses = [...new Set(tasks.map((task) => task.status))];
		if (statuses.length > 1) {
			const list = tasks.map((task) => `${task.id}: ${task.status}`).join(", ");
			problems.push(`Tasks are in different statuses (${list}); pass -s.`);
		}
		targetStatus = statuses[0];
	}
	// Done columns sort by done date on the board, so an ordinal there would not show.
	if (targetStatus && /done|complete/i.test(targetStatus)) {
		problems.push(`Placement into "${targetStatus}" is not supported; that column sorts by date.`);
	}
	if (problems.length === 0 && !targetStatus) problems.push("Tasks have no status; pass -s.");
	if (problems.length > 0 || !targetStatus) throw new Error(problems.join("\n"));

	const placedIds = tasks.map((task) => task.id);
	const column = sortByOrdinal(store.getTasks({ status: targetStatus })).map((task) => task.id);
	const rest = column.filter((id) => !placedIds.includes(id));
	const anchorIndex = anchor ? rest.indexOf(anchor.id) : -1;
	const at = "at" in args.placement ? (args.placement.at === "top" ? 0 : rest.length) : anchorIndex;
	const index = "after" in args.placement ? at + 1 : at;
	const orderedTaskIds = [...rest.slice(0, index), ...placedIds, ...rest.slice(index)];
	const unchanged =
		placedIds.length > 0 &&
		tasks.every((task) => task.status === targetStatus) &&
		orderedTaskIds.join("\n") === column.join("\n");
	return { targetStatus, placedIds, orderedTaskIds, unchanged, where: describe(args.placement, anchor?.id) };
}

/**
 * Places the tasks; `writtenIds` is empty when they were already in place. The column is read,
 * planned and written under the board's placement lock, so a concurrent placement sees this write.
 */
export async function placeTasks(
	core: Core,
	args: { taskIds: string[]; placement: Placement; status?: string; autoCommit?: boolean },
): Promise<PlacementResult> {
	return await core.filesystem.withPlacementLock(async () => {
		const plan = await checkPlacement(core, args);
		const result = { targetStatus: plan.targetStatus, placedIds: plan.placedIds, where: plan.where };
		if (plan.unchanged) return { ...result, writtenIds: [] };
		const moved = await core.moveTasksToStatus({
			taskIds: plan.placedIds,
			targetStatus: plan.targetStatus,
			orderedTaskIds: plan.orderedTaskIds,
			autoCommit: args.autoCommit,
		});
		if (moved.failures.length > 0) throw new Error(moved.failures.map((failure) => failure.reason).join("\n"));
		return { ...result, writtenIds: moved.changedTasks.map((task) => task.id) };
	});
}

export function printPlacement(result: PlacementResult): void {
	const ids = result.placedIds.join(", ");
	if (result.writtenIds.length === 0) {
		console.log(`${ids} already ${result.where} "${result.targetStatus}"`);
		return;
	}
	console.log(`Placed ${ids} ${result.where} "${result.targetStatus}"`);
	console.log(`Wrote ${result.writtenIds.join(", ")}`);
}

export const MCP_POSITION_FIELD: JsonSchema = {
	type: "string",
	maxLength: 60,
	description:
		"Place the task in its column: top, bottom, before:<ID>, after:<ID>. The server computes the ordinal; prefer this over ordinal.",
};

/** The placement an MCP call asks for, or a VALIDATION_ERROR. */
export function mcpPlacement(args: { position?: unknown; ordinal?: unknown }): Placement | undefined {
	if (args.position === undefined) return undefined;
	if (args.ordinal !== undefined)
		throw new BacklogToolError("position cannot be combined with ordinal.", "VALIDATION_ERROR");
	try {
		return parsePlacement(String(args.position));
	} catch (error) {
		throw new BacklogToolError(error instanceof Error ? error.message : String(error), "VALIDATION_ERROR");
	}
}

/** The created task's file exists already, so a failed placement names it rather than invite a duplicate create. */
export async function placeCreatedMcpTask(core: Core, id: string, placement: Placement, status: string): Promise<void> {
	try {
		await placeTasks(core, { taskIds: [id], placement, status });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const position = "at" in placement ? placement.at : placementFlag(placement).slice(2).replace(" ", ":");
		const hint = `Place it with task_edit { id: "${id}", position: "${position}" }.`;
		throw new BacklogToolError(`Created task ${id}, but placement failed: ${reason} ${hint}`, "OPERATION_FAILED");
	}
}
