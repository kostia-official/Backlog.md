import React, { useId, useState } from "react";

const STORAGE_KEY = "backlog.taskSections.open";

/** Open state the viewer chose per section name, or {} when storage is missing or unreadable. */
export function readStoredSections(): Record<string, boolean> {
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function storeSection(name: string, open: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStoredSections(), [name]: open }));
	} catch {
		// Without storage the choice lasts until the view closes.
	}
}

/** A section the viewer toggled keeps that choice; any other starts open only when it has content. */
export function isSectionOpen(choice: unknown, hasContent: boolean): boolean {
	return typeof choice === "boolean" ? choice : hasContent;
}

export const CollapsibleSection: React.FC<{
	name: string;
	title?: string;
	hasContent: boolean;
	right?: React.ReactNode;
	children: React.ReactNode;
}> = ({ name, title = name, hasContent, right, children }) => {
	const [choice, setChoice] = useState<unknown>(() => readStoredSections()[name]);
	const open = isSectionOpen(choice, hasContent);
	const bodyId = useId();
	const toggle = () => {
		setChoice(!open);
		storeSection(name, !open);
	};
	return (
		<>
			<div className={`flex items-center justify-between ${open ? "mb-3" : ""}`}>
				<h3 className="flex-1 text-sm font-semibold tracking-tight text-gray-900 dark:text-gray-100">
					<button
						type="button"
						onClick={toggle}
						aria-expanded={open}
						aria-controls={bodyId}
						className="flex w-full items-center gap-1.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
					>
						<svg
							className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 dark:text-gray-400 ${open ? "rotate-90" : ""}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
						</svg>
						{title}
					</button>
				</h3>
				{right && open ? <div className="ml-2 text-xs text-gray-500 dark:text-gray-400">{right}</div> : null}
			</div>
			<div id={bodyId} hidden={!open}>
				{children}
			</div>
		</>
	);
};
