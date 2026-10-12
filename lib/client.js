/**
 * Right-click context menu, browser half.
 *
 * Hand-authored client bundle in the module system's factory-CJS form: loading
 * this file only registers a factory, and every side effect (including the
 * document listener) runs when the Loader materializes the plugin at boot.
 *
 * Behavior
 * --------
 * The desktop shell builds its native right-click menu in the Electron main
 * process and only for an editable field or a text selection, so right-clicking
 * a file reference or a link currently produces no menu at all. This plugin
 * fills that gap in the page itself:
 *
 *   - an HTTP(S) link  -> "在外部浏览器中打开" / "Open in external browser"
 *   - a workspace file -> "在资源管理器中打开" / "Show in File Explorer"
 *   - either one also offers a "copy" row
 *
 * Opening a link reuses the product's own external-navigation carrier
 * (`window.open(url, "_blank")`, which the Electron main process turns into
 * `shell.openExternal`). Revealing a file reuses the Session Remote
 * `session.openWorkspacePath({ action: "reveal" })`, so the Host still verifies
 * the path through the composed filesystem before touching the desktop.
 *
 * The menu itself is the shared `Menu` primitive, so ordering, keyboard
 * navigation, focus return, outside-click dismissal and theme integration stay
 * the product's rather than a private copy.
 *
 * Known limitation
 * ----------------
 * A Markdown file link whose path is an image carries no `title` (its tooltip
 * is the image preview), so such a link is only detected when its label itself
 * spells the path. Every other file surface carries an explicit path attribute
 * or an absolute path in its tooltip.
 */

window.__ModuleLoader__.load({
	id: "dsh-right-click-menu",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const { Menu, Toast } = primitives;
		const {
			IconFolderOpenOutlineRegular,
			IconLinkOutlineRegular,
			IconCopyOutlineRegular
		} = primitives;

		//#region dictionaries
		/** Dictionary namespace owned by this plugin. */
		const NS = "right-click-menu";

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"file.open": "在资源管理器中打开",
			"file.copy": "复制文件路径",
			"dir.copy": "复制文件夹路径",
			"url.open": "在外部浏览器中打开",
			"url.copy": "复制链接地址",
			"reveal.error": "无法在资源管理器中打开，请重试",
			"copy.done": "已复制到剪贴板",
			"copy.error": "复制失败，请重试"
		};

		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"file.open": "Show in File Explorer",
			"file.copy": "Copy file path",
			"dir.copy": "Copy folder path",
			"url.open": "Open in external browser",
			"url.copy": "Copy link address",
			"reveal.error": "Could not open in the file manager. Try again.",
			"copy.done": "Copied to clipboard",
			"copy.error": "Could not copy. Try again."
		};
		//#endregion

		//#region path helpers
		/** Whether a path is a Windows drive path (`C:\a`, `C:/a`). */
		function isWindowsDrive(value) {
			return /^[A-Za-z]:[/\\]/.test(value);
		}

		/** Whether a path is a Windows drive or UNC path. */
		function isWindowsStylePath(value) {
			return isWindowsDrive(value) || value.startsWith("\\\\");
		}

		/** Whether a path is absolute in either spelling the Host accepts. */
		function isAbsolutePath(value) {
			return value.startsWith("/") || isWindowsStylePath(value);
		}

		/**
		 * Resolve a workspace-relative path against the Session workspace root,
		 * mirroring the product's own `resolveWorkspacePath` helper. The Session
		 * Remote resolves a relative path against the Host process directory, so
		 * only an already-absolute path may be handed over unresolved.
		 * @param cwd - Session workspace root, when known.
		 * @param path - absolute or workspace-relative path.
		 * @returns an absolute path when a workspace root is known.
		 */
		function resolveWorkspacePath(cwd, path) {
			if (isAbsolutePath(path)) return path;
			if (cwd === undefined || cwd === "") return path;
			const separator = isWindowsStylePath(cwd) && cwd.includes("\\") ? "\\" : "/";
			return `${cwd.replace(/[/\\]+$/u, "")}${separator}${path.replace(/^[/\\]+/u, "")}`;
		}

		/**
		 * Normalize a path as it appears in a tooltip or a reference label: strip
		 * the `@` reference sigil and any wrapping quotes the renderer adds.
		 * @param raw - the raw attribute or text value.
		 * @returns the candidate path.
		 */
		function normalizePathCandidate(raw) {
			let value = raw.trim();
			if (value.startsWith("@")) value = value.slice(1).trim();
			value = value.replace(/^"|"$/gu, "").replace(/^'|'$/gu, "");
			return value.replace(/#L\d+(?:-L?\d+)?$/u, "").trim();
		}

		/**
		 * Whether a candidate is plausible as a Host path rather than prose.
		 * @param value - the normalized candidate.
		 * @param requireAbsolute - only accept paths with no workspace root needed.
		 * @returns true when the value may be handed to the Session Remote.
		 */
		function isUsablePath(value, requireAbsolute) {
			if (value.length === 0 || value.length > 1024) return false;
			if (/[\r\n\t]/u.test(value)) return false;
			if (isAbsolutePath(value)) return true;
			if (requireAbsolute) return false;
			// A single token: a relative path never contains raw whitespace.
			if (/\s/u.test(value)) return false;
			if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
			return /[/\\]/u.test(value) || /^\S+\.[A-Za-z0-9]{1,12}$/u.test(value);
		}

		/**
		 * Read a path from an element's tooltip, falling back to its label.
		 * @param element - the candidate element.
		 * @param requireAbsolute - require a Host-ready absolute path.
		 * @returns the path, or null.
		 */
		function readPathAttribute(element, requireAbsolute) {
			const title = element.getAttribute("title");
			if (title !== null) {
				const candidate = normalizePathCandidate(title);
				if (isUsablePath(candidate, requireAbsolute)) return candidate;
			}
			if (requireAbsolute) return null;
			const label = normalizePathCandidate(element.textContent ?? "");
			return isUsablePath(label, false) ? label : null;
		}
		//#endregion

		//#region element classification
		/**
		 * The generated class names of a Markdown file link (`_fileLink_<hash>_<n>`)
		 * and of an openable `@` reference chip (`_fileMention_<hash>_<n>`). Matched
		 * without the hash so a restyled build keeps working.
		 */
		const FILE_LINK_CLASS = /(?:^|[^A-Za-z])file(?:Link|Mention)(?:[^A-Za-z]|$)/u;

		/**
		 * The prefix the left sidebar keys a Workspace's project row with
		 * (`workspace:<workspaceId>`); the ungrouped bucket is `workspace:`.
		 */
		const WORKSPACE_ROW_PREFIX = "workspace:";

		/** Whether this element is one the product renders as an openable file reference. */
		function isFileLinkElement(element) {
			const className = element.getAttribute("class");
			return className !== null && FILE_LINK_CLASS.test(className);
		}

		/** Whether an element is a clickable control whose tooltip may name a path. */
		function isClickable(element) {
			if (element.tagName === "BUTTON" || element.tagName === "A") return true;
			const role = element.getAttribute("role");
			return role === "button" || role === "link";
		}

		/**
		 * The HTTP(S) destination of a link element.
		 * @param element - the candidate element.
		 * @returns the authored URL, or null.
		 */
		function linkUrlOf(element) {
			if (element.tagName !== "A") return null;
			const href = element.getAttribute("href");
			if (href === null) return null;
			return /^https?:\/\//iu.test(href) ? href : null;
		}

		/**
		 * The workspace file a single element stands for, if any.
		 * @param element - the candidate element.
		 * @param ctx - the client plugin context, for the Workspace list.
		 * @returns `{ path, directory }` (the path possibly workspace-relative), or null.
		 */
		function filePathOf(element, ctx) {
			// The left sidebar's project row names one Workspace: its directory is
			// owned by the client Workspace list, keyed by workspace id. The
			// ungrouped bucket shares the same prefix with an empty id and is not a
			// directory of its own.
			const rowKey = element.getAttribute("data-row-key");
			if (rowKey !== null && rowKey.startsWith(WORKSPACE_ROW_PREFIX)) {
				return pathTarget(workspacePathOf(ctx, rowKey.slice(WORKSPACE_ROW_PREFIX.length)), true);
			}

			// The right Sidebar's file tree stamps every row with its absolute path
			// and its own kind.
			const treePath = element.getAttribute("data-files-path");
			if (treePath !== null && treePath !== "" && isUsablePath(treePath, true)) {
				return pathTarget(treePath, element.getAttribute("data-files-entry") === "directory");
			}

			// Its header row stands for the listed directory itself.
			const treeRoot = element.getAttribute("data-files-root");
			if (treeRoot !== null && isUsablePath(treeRoot, true)) return pathTarget(treeRoot, true);

			// An `@` reference chip carries `@path` (or `@"path"`) in its tooltip.
			// A chip declares its own kind, so a session, skill, or command chip is
			// never second-guessed into a file even when its label looks like one.
			const chip = element.getAttribute("data-ref-chip");
			if (chip !== null) {
				if (chip !== "file" && chip !== "folder") return null;
				return pathTarget(readPathAttribute(element, false), chip === "folder");
			}

			// A Markdown file link: the path is the tooltip, or the label itself.
			if (isFileLinkElement(element)) {
				const fromLink = readPathAttribute(element, false);
				if (fromLink !== null) return pathTarget(fromLink, false);
			}

			// Delivery cards, path labels and similar controls name an absolute path
			// in their tooltip while being ordinary buttons.
			if (isClickable(element)) {
				const absolute = readPathAttribute(element, true);
				if (absolute !== null) return pathTarget(absolute, false);
			}
			return null;
		}

		/**
		 * Resolve the element under the pointer into something the menu can act on,
		 * walking outward so a nested icon or label reaches its own control.
		 * @param start - the event target.
		 * @param ctx - the client plugin context.
		 * @returns `{ kind: 'url' | 'file', value, directory }`, or null when nothing applies.
		 */
		function resolveContextTarget(start, ctx) {
			for (let element = start; element instanceof Element; element = element.parentElement) {
				const url = linkUrlOf(element);
				if (url !== null) return { kind: "url", value: url, directory: false };
				const file = filePathOf(element, ctx);
				if (file !== null) return { kind: "file", value: file.path, directory: file.directory };
			}
			return null;
		}

		/** One resolved path, tagged with whether the Host should open the directory itself. */
		function pathTarget(path, directory) {
			return path === undefined || path === null || path === "" ? null : { path, directory: directory === true };
		}

		/**
		 * The directory of one Workspace, read from the client Workspace list — the
		 * sidebar row carries only the Workspace id.
		 * @param ctx - the client plugin context.
		 * @param workspaceId - the id the project row is keyed by.
		 * @returns the absolute directory, or undefined for the ungrouped bucket and
		 * an unknown id.
		 */
		function workspacePathOf(ctx, workspaceId) {
			if (workspaceId === "") return undefined;
			try {
				const item = ctx.workspaces.list.getSnapshot().items
					.find((candidate) => candidate.workspaceId === workspaceId);
				return isUsablePath(item?.path ?? "", true) ? item.path : undefined;
			} catch {
				return undefined;
			}
		}

		/**
		 * The workspace root of the Session the main view retains, which is the
		 * Session whose files the visible transcript addresses.
		 * @param ctx - the client plugin context.
		 * @returns the absolute workspace directory, or undefined.
		 */
		function activeWorkspaceCwd(ctx) {
			try {
				const rows = Object.values(ctx.sessions.list.getSnapshot().byId ?? {});
				const main = rows.find((row) => (row.retainedBy?.mainView ?? 0) > 0);
				return (main ?? rows[0])?.cwd;
			} catch {
				return undefined;
			}
		}
		//#endregion

		//#region menu rows
		/**
		 * The rows one resolved target offers. Pure so the wording of each row —
		 * including the file/folder split of the copy row — is testable without a
		 * renderer; the host adds icons and the disabled state.
		 * @param target - a resolved context target, or null.
		 * @param t - the bound dictionary translator.
		 * @returns rows in menu order.
		 */
		function menuRowsFor(target, t) {
			if (target === null) return [];
			if (target.kind === "url") {
				return [
					{ id: "url.open", label: t("url.open") },
					{ id: "url.copy", label: t("url.copy") }
				];
			}
			return [
				{ id: "file.open", label: t("file.open") },
				{ id: "file.copy", label: t(target.directory === true ? "dir.copy" : "file.copy") }
			];
		}
		//#endregion

		//#region menu host
		/**
		 * Open one URL in the external browser through the product's own carrier:
	 * the Electron main process intercepts a `_blank` window open and hands the
	 * URL to `shell.openExternal`, so this matches a Chat link click exactly.
		 * @param url - the authored HTTP(S) URL.
		 */
		function openExternal(url) {
			window.open(url, "_blank", "noopener,noreferrer");
		}

		/**
		 * Build the frame-wide overlay entry owning the document listener and the
		 * open menu.
		 * @param ctx - the client plugin context.
		 * @param t - the bound dictionary translator.
		 * @returns the React component registered into `shell.overlay`.
		 */
		function createMenuHost(ctx, t) {
			return function RightClickMenuHost() {
				const [target, setTarget] = React.useState(null);
				const [notice, setNotice] = React.useState(null);
				/** Whether the Host can reveal a path at all; null until answered. */
				const [desktop, setDesktop] = React.useState(null);

				React.useEffect(() => {
					let live = true;
					ctx.remote.session.canOpenWorkspacePath().then(
						(result) => {
							if (live) setDesktop(result?.ok === true && result.value === true);
						},
						() => {
							if (live) setDesktop(false);
						}
					);
					return () => {
						live = false;
					};
				}, []);

				React.useEffect(() => {
					/**
					 * Claim a right-click that lands on a link or a file reference.
					 * Anything else keeps the shell's own behavior, which is what an
					 * editable field or a text selection needs.
					 */
					const onContextMenu = (event) => {
						const start = event.target instanceof Element ? event.target : null;
						const resolved = start === null ? null : resolveContextTarget(start, ctx);
						if (resolved === null) {
							setTarget(null);
							return;
						}
						event.preventDefault();
						const value = resolved.kind === "file"
							? resolveWorkspacePath(activeWorkspaceCwd(ctx), resolved.value)
							: resolved.value;
						setTarget({
							kind: resolved.kind,
							value,
							directory: resolved.directory === true,
							point: {
								left: event.clientX,
								top: event.clientY,
								right: event.clientX,
								bottom: event.clientY,
								width: 0,
								height: 0
							}
						});
					};
					document.addEventListener("contextmenu", onContextMenu, true);
					return () => {
						document.removeEventListener("contextmenu", onContextMenu, true);
					};
				}, []);

				const point = target?.point;
				const getAnchorRect = React.useCallback(() => point ?? null, [point]);

				const copy = async (text) => {
					try {
						await navigator.clipboard.writeText(text);
						setNotice({ text: t("copy.done"), tone: "success" });
					} catch (error) {
						console.error("right-click-menu: clipboard write failed", error);
						setNotice({ text: t("copy.error"), tone: "error" });
					}
				};

				const reveal = async (path, directory) => {
					try {
						// A directory is opened in the file manager itself; a file is
						// revealed (selected) where it already lives, because "open in the
						// file manager" never means "launch this file's own application".
						const request = directory ? { path } : { path, action: "reveal" };
						const result = await ctx.remote.session.openWorkspacePath(request);
						if (result?.ok !== true) throw new Error("the host refused the path");
					} catch (error) {
						console.error("right-click-menu: reveal failed", error);
						setNotice({ text: t("reveal.error"), tone: "error" });
					}
				};

				const run = (id, active) => {
					if (active === null) return;
					switch (id) {
						case "url.open":
							openExternal(active.value);
							return;
						case "url.copy":
							void copy(active.value);
							return;
						case "file.copy":
							void copy(active.value);
							return;
						default:
							void reveal(active.value, active.directory === true);
					}
				};

				const items = menuRowsFor(target, t).map((row) => ({
					...row,
					icon: row.id === "url.open"
						? jsx(IconLinkOutlineRegular, {})
						: row.id === "file.open"
							? jsx(IconFolderOpenOutlineRegular, {})
							: jsx(IconCopyOutlineRegular, {}),
					disabled: row.id === "file.open" && desktop === false
				}));

				return jsxs(Fragment, {
					children: [
						target === null ? null : jsx(Menu, {
							open: true,
							anchor: null,
							portal: true,
							selection: "fill",
							items,
							getAnchorRect,
							onSelect: (id) => {
								const active = target;
								setTarget(null);
								run(id, active);
							},
							onClose: () => {
								setTarget(null);
							}
						}),
						notice === null ? null : jsx(Toast, {
							text: notice.text,
							tone: notice.tone,
							onDone: () => {
								setNotice(null);
							}
						})
					]
				});
			};
		}
		//#endregion

		//#region plugin
		/** Required client services: the slot registry, copy, and the Session Remote. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session",
			"sessions",
			"workspaces"
		];

		/**
		 * Client plugin body: register the dictionaries and the frame-wide overlay
		 * entry that owns the right-click listener and the menu.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "right-click-menu: dictionaries");
			const t = ctx.locale.bind(NS);
			const Host = createMenuHost(ctx, t);
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "right-click-menu",
				order: 100,
				locale: NS
			}, Host));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
