export function getTerminalStatus(statuses: readonly string[]): string | null {
	if (statuses.length === 0) return null;
	const terminalStatus = statuses[statuses.length - 1];
	return terminalStatus && terminalStatus.trim().length > 0 ? terminalStatus : null;
}

function normalizeStatusForComparison(status: string | null | undefined): string {
	return (status ?? "").trim().toLowerCase();
}

export function isTerminalStatus(status: string | null | undefined, statuses: readonly string[]): boolean {
	const terminalStatus = getTerminalStatus(statuses);
	return (
		terminalStatus !== null && normalizeStatusForComparison(status) === normalizeStatusForComparison(terminalStatus)
	);
}

/** Status "Draft" means the drafts workflow unless the project configures a Draft status column. */
export function isDraftWorkflowStatus(
	status: string | null | undefined,
	statuses: readonly string[] | undefined,
): boolean {
	const key = normalizeStatusForComparison(status);
	return key === "draft" && !(statuses ?? []).some((configured) => normalizeStatusForComparison(configured) === key);
}
