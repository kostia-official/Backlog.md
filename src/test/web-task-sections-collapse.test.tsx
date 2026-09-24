import { afterEach, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { Task } from "../types/index.ts";
import { CollapsibleSection } from "../web/components/CollapsibleSection.tsx";
import { TaskDetailsModal } from "../web/components/TaskDetailsModal.tsx";
import { ThemeProvider } from "../web/contexts/ThemeContext.tsx";

const STORAGE_KEY = "backlog.taskSections.open";
let activeRoot: Root | null = null;

function setupDom(): HTMLElement {
	const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	globalThis.window = dom.window as unknown as Window & typeof globalThis;
	globalThis.document = dom.window.document as unknown as typeof globalThis.document;
	globalThis.navigator = dom.window.navigator as unknown as Navigator;
	globalThis.localStorage = dom.window.localStorage;
	if (!window.matchMedia) {
		window.matchMedia = (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as never;
	}
	return dom.window.document.getElementById("root") as unknown as HTMLElement;
}

const task: Task = {
	id: "TASK-1",
	title: "Sections",
	status: "To Do",
	assignee: [],
	createdDate: "2026-09-01",
	labels: [],
	dependencies: [],
	references: ["README.md"],
	implementationPlan: "",
};

/** aria-expanded of the header button for `name`, read from rendered HTML. */
function expanded(html: string, name: string): string | undefined {
	const dom = new JSDOM(html);
	const button = [...dom.window.document.querySelectorAll("button[aria-expanded]")].find(
		(node) => node.textContent?.trim() === name,
	);
	if (!button) return undefined;
	const body = dom.window.document.getElementById(button.getAttribute("aria-controls") ?? "");
	expect(body?.hasAttribute("hidden")).toBe(button.getAttribute("aria-expanded") === "false");
	return button.getAttribute("aria-expanded") ?? undefined;
}

const renderModal = () =>
	renderToString(
		<ThemeProvider>
			<TaskDetailsModal task={task} isOpen={true} onClose={() => {}} />
		</ThemeProvider>,
	);

describe("collapsible task sections", () => {
	afterEach(() => {
		if (activeRoot) act(() => activeRoot?.unmount());
		activeRoot = null;
	});

	it("opens a section with content and collapses an empty one", () => {
		setupDom();
		const html = renderModal();
		expect(expanded(html, "References")).toBe("true");
		expect(expanded(html, "Implementation Plan")).toBe("false");
		expect(expanded(html, "Assignee")).toBe("false");
		expect(expanded(html, "Description")).toBeUndefined();
	});

	it("uses the state the viewer chose for a section name", () => {
		setupDom();
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ References: false, "Implementation Plan": true }));
		const html = renderModal();
		expect(expanded(html, "References")).toBe("false");
		expect(expanded(html, "Implementation Plan")).toBe("true");
	});

	it("toggles on click, stores the choice, and falls back to the defaults without storage", async () => {
		const container = setupDom();
		activeRoot = createRoot(container);
		await act(async () => {
			activeRoot?.render(
				<CollapsibleSection name="Notes" hasContent={false}>
					<p>body</p>
				</CollapsibleSection>,
			);
		});
		const button = container.querySelector("button") as HTMLButtonElement;
		expect(button.getAttribute("aria-expanded")).toBe("false");
		await act(async () => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({ Notes: true });

		const storage = localStorage;
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get: () => {
				throw new Error("storage blocked");
			},
		});
		try {
			const section = (hasContent: boolean) =>
				renderToString(
					<CollapsibleSection name="Notes" hasContent={hasContent}>
						<p>body</p>
					</CollapsibleSection>,
				);
			expect(expanded(section(true), "Notes")).toBe("true");
			expect(expanded(section(false), "Notes")).toBe("false");
		} finally {
			Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
		}
	});
});
