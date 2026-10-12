/**
 * Dependency-free test harness for dsh-right-click-menu.
 *
 * Run it with `npm test`. There is no test framework and no build step: the
 * plugin's only artifact is a hand-authored client bundle, so this file loads
 * that bundle exactly the way the DSH client module system does and then
 * exercises it.
 *
 * 1. Loads lib/client.js the way the module system does
 *    (`window.__ModuleLoader__.load({ id, factory })`) with stubbed platform
 *    modules, then asserts the factory face and runs `apply` against a stub
 *    context to check the slot and dictionary registrations.
 * 2. Extracts the bundle's own pure sections and exercises `resolveContextTarget`
 *    and `menuRowsFor` against a simulated DOM built from the markup each DSH
 *    surface actually renders.
 *
 * The extraction in (2) is deliberate: it tests the shipped code rather than a
 * copy of it, so the harness cannot drift from the bundle.
 */
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ---------------------------------------------------------------- fake DOM ---
class FakeElement {
	constructor(tagName, attrs = {}, children = []) {
		this.tagName = tagName.toUpperCase();
		this.attrs = attrs;
		this.children = children;
		for (const child of children) if (typeof child !== "string") child.parentElement = this;
	}
	getAttribute(name) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
	}
	get textContent() {
		return this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
	}
}
class FakeSvgElement extends FakeElement {}

/** Build an element chain and return the deepest node. */
function chain(...elements) {
	for (let index = 0; index < elements.length - 1; index++) elements[index].parentElement = elements[index + 1];
	return elements[0];
}

// ------------------------------------------------------- module system stub ---
let registration;
globalThis.window = {
	__ModuleLoader__: {
		load(row) {
			registration = row;
		}
	}
};
globalThis.Element = FakeElement;

const stubModules = {
	"react": {
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn
	},
	"react/jsx-runtime": {
		jsx: (type, props) => ({ type, props }),
		jsxs: (type, props) => ({ type, props }),
		Fragment: Symbol("Fragment")
	},
	"@deepseek-ai/dsh-client-ui-primitives": new Proxy({}, {
		get: (_target, key) => (key === "Menu" || key === "Toast" ? function Stub() {} : function Icon() {})
	})
};

// Evaluate the bundle as the module system would: a plain script that registers
// a factory.
new Function("window", SOURCE)(globalThis.window);

const failures = [];
const check = (name, actual, expected) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
	else console.log(`  ok  ${name}`);
};

console.log("\n[1] bundle registration");
check("registered id", registration?.id, "dsh-right-click-menu");
check("factory is a function", typeof registration?.factory, "function");

const exports_ = registration.factory((specifier) => {
	if (!(specifier in stubModules)) throw new Error(`unexpected require("${specifier}")`);
	return stubModules[specifier];
});
check("exports.apply", typeof exports_.apply, "function");
check("exports.inject", exports_.inject, ["slots", "locale", "remote", "remote.session", "sessions", "workspaces"]);

console.log("\n[2] apply() registrations");
const seen = { localeNs: null, dicts: null, effects: 0, injectKeys: [], entry: null, component: null };
const stubCtx = {
	effect(callback) {
		seen.effects += 1;
		return callback();
	},
	locale: {
		register(ns, dicts) {
			seen.localeNs = ns;
			seen.dicts = dicts;
			return () => {};
		},
		bind: () => (key) => key
	},
	slots: {
		inject(key, callback) {
			seen.injectKeys.push(key);
			return callback();
		},
		register(entry, component) {
			seen.entry = entry;
			seen.component = component;
			return () => {};
		}
	},
	sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
	workspaces: {
		list: {
			getSnapshot: () => ({
				items: [
					{ workspaceId: "ws-test", path: "E:\\Code\\Test", title: "Test", sessionIds: [] },
					{ workspaceId: "ws-other", path: "D:\\Work\\proj", title: "proj", sessionIds: [] }
				]
			})
		}
	},
	remote: { session: { canOpenWorkspacePath: async () => ({ ok: true, value: true }) } }
};
exports_.apply(stubCtx);
check("effect count", seen.effects, 1);
check("locale namespace", seen.localeNs, "right-click-menu");
check("dictionary locales", Object.keys(seen.dicts), ["zh", "en"]);
check("dictionary key sets match", Object.keys(seen.dicts.zh).sort(), Object.keys(seen.dicts.en).sort());
check("slot injected into", seen.injectKeys, ["shell.overlay"]);
check("slot entry name", seen.entry?.name, "shell.overlay");
check("slot entry id", seen.entry?.id, "right-click-menu");
check("component registered", typeof seen.component, "function");

// --------------------------------------------- detection logic under test ---
const region = (name) => {
	const start = SOURCE.indexOf(`//#region ${name}`);
	const end = SOURCE.indexOf("//#endregion", start);
	if (start < 0 || end < 0) throw new Error(`region not found: ${name}`);
	return SOURCE.slice(start, end);
};
const detection = new Function(
	"Element",
	`${region("path helpers")}\n${region("element classification")}\n${region("menu rows")}\n` +
	"return { resolveContextTarget, resolveWorkspacePath, normalizePathCandidate, isUsablePath, menuRowsFor };"
)(FakeElement);

console.log("\n[3] DOM detection");
const FILE_TREE_ROW = () => {
	const label = new FakeElement("span", {}, ["index.ts"]);
	const button = new FakeElement("button", { class: "_row_abc_1", type: "button" }, [label]);
	return new FakeElement("li", { "data-files-entry": "file", "data-files-path": "E:/Code/Test/src/index.ts" }, [button]);
};
const FILE_TREE_DIRECTORY_ROW = () => {
	const label = new FakeElement("span", {}, ["src"]);
	const button = new FakeElement("button", { class: "_row_abc_1", type: "button" }, [label]);
	return new FakeElement("li", { "data-files-entry": "directory", "data-files-path": "E:/Code/Test/src" }, [button]);
};
const FILE_TREE_HEADER = () => {
	const label = new FakeElement("span", { "data-files-path": "", title: "E:/Code/Test" }, ["E:/Code/Test"]);
	return new FakeElement("div", { "data-files-state": "tree", "data-files-root": "E:/Code/Test" }, [label]);
};
/** One left-sidebar project row, exactly as `ProjectRowItem` renders it. */
const PROJECT_ROW = (rowKey) => {
	const folderIcon = new FakeElement("span", { class: "_slot_x _folder_x" }, [new FakeElement("svg", {}, [])]);
	const chevron = new FakeElement("span", { class: "_slot_x _chevron_x" }, []);
	const title = new FakeElement("span", { class: "_title_x" }, ["Test"]);
	const text = new FakeElement("span", { class: "_projectText_x" }, [title]);
	const newSession = new FakeElement("button", { class: "_iconButton_x", "aria-label": "New session in Test" }, []);
	const actions = new FakeElement("span", { class: "_rowActions_x" }, [newSession]);
	const row = new FakeElement("div", { class: "_projectRow_x", "data-row-key": rowKey, role: "treeitem" }, [
		folderIcon, chevron, text, actions
	]);
	const list = new FakeElement("ul", { class: "_level_x" }, [row]);
	return { row, title, newSession, list };
};

const cases = [
	{
		name: "Markdown HTTP link",
		target: () => chain(new FakeElement("svg", {}, []), new FakeElement("a", { href: "https://example.com/a?b=1", target: "_blank", rel: "noopener noreferrer" })),
		expected: { kind: "url", value: "https://example.com/a?b=1", directory: false }
	},
	{
		name: "Markdown file link (relative, tooltip)",
		target: () => chain(
			new FakeElement("svg", {}, []),
			new FakeElement("button", { class: "_fileMention_1ypvv_85 _fileLink_1ypvv_59", title: "src/index.ts" }, [])
		),
		expected: { kind: "file", value: "src/index.ts", directory: false }
	},
	{
		name: "Markdown file link (absolute, label only)",
		target: () => new FakeElement("button", { class: "_fileMention_1ypvv_85 _fileLink_1ypvv_59" }, ["E:\\Code\\Test\\docs\\plan.md"]),
		expected: { kind: "file", value: "E:\\Code\\Test\\docs\\plan.md", directory: false }
	},
	{
		name: "Markdown file link keeps only the path from a #L fragment",
		target: () => new FakeElement("button", { class: "_fileLink_1ypvv_59", title: "@file-reference" }, ["src/app.ts#L24-L30"]),
		expected: { kind: "file", value: "src/app.ts", directory: false }
	},
	{
		name: "@ file reference chip (quoted, with spaces)",
		target: () => new FakeElement("button", { class: "_refChip_x _fileMention_1ypvv_85", "data-ref-chip": "file", title: "@\"E:\\Code\\Test\\my docs\\a b.txt\"" }, ["a b.txt"]),
		expected: { kind: "file", value: "E:\\Code\\Test\\my docs\\a b.txt", directory: false }
	},
	{
		name: "@ folder reference chip is a directory",
		target: () => new FakeElement("button", { class: "_refChip_x _fileMention_1ypvv_85", "data-ref-chip": "folder", title: "@\"E:\\Code\\Test\\docs\"" }, ["docs"]),
		expected: { kind: "file", value: "E:\\Code\\Test\\docs", directory: true }
	},
	{
		name: "@ session chip is not a file",
		target: () => new FakeElement("span", { class: "_refChip_x", "data-ref-chip": "session", title: "@session-5f871ffa-d024" }, ["5f871ffa"]),
		expected: null
	},
	{
		name: "slash-command chip is not a file",
		target: () => new FakeElement("span", { class: "_refChip_x _slashChip_1", "data-ref-chip": "skill", title: "/office" }, ["/office"]),
		expected: null
	},
	{
		name: "left sidebar project row (workspace id -> directory)",
		target: () => PROJECT_ROW("workspace:ws-test").row,
		expected: { kind: "file", value: "E:\\Code\\Test", directory: true }
	},
	{
		name: "project name text under the row resolves the same directory",
		target: () => PROJECT_ROW("workspace:ws-test").title,
		expected: { kind: "file", value: "E:\\Code\\Test", directory: true }
	},
	{
		name: "project row action button resolves its own workspace",
		target: () => PROJECT_ROW("workspace:ws-other").newSession,
		expected: { kind: "file", value: "D:\\Work\\proj", directory: true }
	},
	{
		name: "ungrouped sidebar bucket is not a directory",
		target: () => PROJECT_ROW("workspace:").title,
		expected: null
	},
	{
		name: "unknown workspace id is not a directory",
		target: () => PROJECT_ROW("workspace:ws-gone").title,
		expected: null
	},
	{
		name: "right Sidebar file tree row",
		target: () => FILE_TREE_ROW().children[0].children[0],
		expected: { kind: "file", value: "E:/Code/Test/src/index.ts", directory: false }
	},
	{
		name: "right Sidebar file tree directory row is a directory",
		target: () => FILE_TREE_DIRECTORY_ROW().children[0].children[0],
		expected: { kind: "file", value: "E:/Code/Test/src", directory: true }
	},
	{
		name: "right Sidebar file tree header resolves the directory",
		target: () => FILE_TREE_HEADER().children[0],
		expected: { kind: "file", value: "E:/Code/Test", directory: true }
	},
	{
		name: "delivery card preview button (absolute tooltip)",
		target: () => new FakeElement("button", { class: "_cardPreview_x", title: "E:\\Code\\Test\\out\\report.md", "aria-label": "Preview report.md" }, []),
		expected: { kind: "file", value: "E:\\Code\\Test\\out\\report.md", directory: false }
	},
	{
		name: "JSON copy button tooltip is not a path",
		target: () => new FakeElement("button", { "data-json-copy-button": "", title: "Copy value" }, []),
		expected: null
	},
	{
		name: "ordinary titled button is not a path",
		target: () => new FakeElement("button", { title: "Open settings" }, ["Settings"]),
		expected: null
	},
	{
		name: "relative anchor without a path tooltip is ignored",
		target: () => new FakeElement("a", { href: "/api/gateway" }, ["gateway"]),
		expected: null
	},
	{
		name: "plain prose has no target",
		target: () => new FakeElement("p", {}, ["nothing here"]),
		expected: null
	},
	{
		name: "code block has no target",
		target: () => chain(new FakeElement("code", {}, ["const a = 1"]), new FakeElement("pre", {}, []), new FakeElement("div", {}, [])),
		expected: null
	},
	{
		name: "URL anchor inside a titled card wins over the card",
		target: () => chain(
			new FakeElement("a", { href: "http://127.0.0.1:19387/x" }, []),
			new FakeElement("div", { title: "E:\\Code\\Test\\a.txt" }, [])
		),
		expected: { kind: "url", value: "http://127.0.0.1:19387/x", directory: false }
	}
];

for (const testCase of cases) {
	let actual;
	try {
		actual = detection.resolveContextTarget(testCase.target(), stubCtx);
	} catch (error) {
		failures.push(`${testCase.name}\n    threw ${error?.message}`);
		continue;
	}
	check(testCase.name, actual, testCase.expected);
}

console.log("\n[4] menu rows");
const identityT = (key) => key;
check(
	"no target offers no rows",
	detection.menuRowsFor(null, identityT),
	[]
);
check(
	"URL target rows",
	detection.menuRowsFor({ kind: "url", value: "https://x.test/", directory: false }, identityT),
	[{ id: "url.open", label: "url.open" }, { id: "url.copy", label: "url.copy" }]
);
check(
	"file target rows name a file path",
	detection.menuRowsFor({ kind: "file", value: "E:\\Code\\Test\\a.txt", directory: false }, identityT),
	[{ id: "file.open", label: "file.open" }, { id: "file.copy", label: "file.copy" }]
);
check(
	"directory target rows name a folder path",
	detection.menuRowsFor({ kind: "file", value: "E:\\Code\\Test", directory: true }, identityT),
	[{ id: "file.open", label: "file.open" }, { id: "file.copy", label: "dir.copy" }]
);
check(
	"the Chinese dictionary distinguishes file from folder",
	[seen.dicts.zh["file.copy"], seen.dicts.zh["dir.copy"]],
	["复制文件路径", "复制文件夹路径"]
);

console.log("\n[5] workspace-relative resolution");
check(
	"relative path joins the Windows workspace root, keeping the authored separators",
	detection.resolveWorkspacePath("E:\\Code\\Test", "src/index.ts"),
	"E:\\Code\\Test\\src/index.ts"
);
check(
	"absolute path passes through",
	detection.resolveWorkspacePath("E:\\Code\\Test", "E:/other/a.txt"),
	"E:/other/a.txt"
);
check(
	"unknown workspace keeps the relative path",
	detection.resolveWorkspacePath(undefined, "src/index.ts"),
	"src/index.ts"
);

console.log("");
if (failures.length > 0) {
	console.error(`${failures.length} failure(s):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("all checks passed");
