import { h, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import { Button, IconCheckCircleOutline14, IconChevronDownOutline14, IconChevronUpOutline14, IconCircleOutline14, IconCloseOutline16, IconFileOutline14, IconFolderOutline14, IconMinimizeOutline14, IconPlayCircleOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import { createStore, useStore } from "@deepseek-ai/dsh-client-store";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/client/locales.ts
/**
* Locale dictionaries for Task Panel
*/
const zh = {
	"panel.title": "工作流任务",
	"panel.active": "进行中",
	"panel.total": "总计",
	"panel.minimize": "最小化",
	"panel.close": "关闭",
	"panel.empty": "暂无任务",
	"panel.empty-desc": "让模型开始工作并维护 todo 清单后会自动建档",
	"task.progress": "进度",
	"task.steps": "步骤",
	"task.files": "文件",
	"task.current": "当前",
	"task.switch": "切换到此任务",
	"task.archive": "归档",
	"task.rename": "重命名",
	"step.completed": "已完成",
	"step.in-progress": "进行中",
	"step.pending": "待办",
	"file.open": "在编辑器打开",
	"minibar.current": "当前任务",
	"minibar.click-expand": "点击展开"
};
const en = {
	"panel.title": "Task Flow",
	"panel.active": "Active",
	"panel.total": "Total",
	"panel.minimize": "Minimize",
	"panel.close": "Close",
	"panel.empty": "No Tasks",
	"panel.empty-desc": "Tasks are created automatically when the model maintains a todo list",
	"task.progress": "Progress",
	"task.steps": "Steps",
	"task.files": "Files",
	"task.current": "Current",
	"task.switch": "Switch to this task",
	"task.archive": "Archive",
	"task.rename": "Rename",
	"step.completed": "Completed",
	"step.in-progress": "In Progress",
	"step.pending": "Pending",
	"file.open": "Open in Editor",
	"minibar.current": "Current Task",
	"minibar.click-expand": "Click to expand"
};
function createTranslate(dict) {
	return (key, params) => {
		let text = dict[key] ?? key;
		if (params) for (const [k, v] of Object.entries(params)) text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
		return text;
	};
}
//#endregion
//#region src/client/task-store.ts
/**
* Task Panel Client Store
* Reactive store for task list, bound task, UI state
*/
const STORAGE_KEY = "dsh-pm-task-panel-state";
function getDefaultState() {
	if (typeof window !== "undefined") try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const parsed = JSON.parse(saved);
			return {
				tasks: [],
				boundTaskId: null,
				archivedCount: 0,
				expandedTaskIds: new Set(parsed.expandedTaskIds || []),
				panelPosition: parsed.panelPosition || {
					x: window.innerWidth - 440,
					y: 80
				},
				minimized: parsed.minimized || false,
				lastUpdate: 0
			};
		}
	} catch {}
	return {
		tasks: [],
		boundTaskId: null,
		archivedCount: 0,
		expandedTaskIds: /* @__PURE__ */ new Set(),
		panelPosition: {
			x: 0,
			y: 0
		},
		minimized: false,
		lastUpdate: 0
	};
}
function persist(state) {
	if (typeof window !== "undefined") try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({
			expandedTaskIds: Array.from(state.expandedTaskIds),
			panelPosition: state.panelPosition,
			minimized: state.minimized
		}));
	} catch {}
}
const taskStore = createStore({
	name: "dsh-project-memory-task-panel",
	initialState: getDefaultState(),
	reducers: {
		setTasks(state, payload) {
			state.tasks = payload.tasks;
			state.boundTaskId = payload.boundTaskId;
			state.archivedCount = payload.archivedCount;
			state.lastUpdate = Date.now();
		},
		toggleTaskExpanded(state, taskId) {
			const next = new Set(state.expandedTaskIds);
			if (next.has(taskId)) next.delete(taskId);
			else next.add(taskId);
			state.expandedTaskIds = next;
			persist(state);
		},
		setPanelPosition(state, pos) {
			state.panelPosition = pos;
			persist(state);
		},
		setMinimized(state, minimized) {
			state.minimized = minimized;
			persist(state);
		},
		reset() {
			return getDefaultState();
		}
	}
});
function useTaskStore() {
	return useSyncExternalStore(taskStore.subscribe, taskStore.getSnapshot, taskStore.getSnapshot);
}
function useTaskActions() {
	return useStore(taskStore).actions;
}
//#endregion
//#region src/client/TaskPanel.module.css
var TaskPanel_module_default = {
	"badge": "vZSZnG_badge",
	"boundBadge": "vZSZnG_boundBadge",
	"chevron": "vZSZnG_chevron",
	"dragHandle": "vZSZnG_dragHandle",
	"emptyDesc": "vZSZnG_emptyDesc",
	"emptyIcon": "vZSZnG_emptyIcon",
	"emptyState": "vZSZnG_emptyState",
	"expandIn": "vZSZnG_expandIn",
	"fileIcon": "vZSZnG_fileIcon",
	"fileLine": "vZSZnG_fileLine",
	"filePath": "vZSZnG_filePath",
	"fileRow": "vZSZnG_fileRow",
	"filesList": "vZSZnG_filesList",
	"header": "vZSZnG_header",
	"headerIcon": "vZSZnG_headerIcon",
	"headerLeft": "vZSZnG_headerLeft",
	"headerRight": "vZSZnG_headerRight",
	"headerTitle": "vZSZnG_headerTitle",
	"miniBar": "vZSZnG_miniBar",
	"miniChevron": "vZSZnG_miniChevron",
	"miniIcon": "vZSZnG_miniIcon",
	"miniTitle": "vZSZnG_miniTitle",
	"moreFiles": "vZSZnG_moreFiles",
	"panel": "vZSZnG_panel",
	"progressBg": "vZSZnG_progressBg",
	"progressFg": "vZSZnG_progressFg",
	"progressRing": "vZSZnG_progressRing",
	"pulse": "vZSZnG_pulse",
	"section": "vZSZnG_section",
	"sectionLabel": "vZSZnG_sectionLabel",
	"stepCompleted": "vZSZnG_stepCompleted",
	"stepContent": "vZSZnG_stepContent",
	"stepIconCompleted": "vZSZnG_stepIconCompleted",
	"stepIconPending": "vZSZnG_stepIconPending",
	"stepIconProgress": "vZSZnG_stepIconProgress",
	"stepRow": "vZSZnG_stepRow",
	"stepsList": "vZSZnG_stepsList",
	"taskActions": "vZSZnG_taskActions",
	"taskExpanded": "vZSZnG_taskExpanded",
	"taskFooter": "vZSZnG_taskFooter",
	"taskHeader": "vZSZnG_taskHeader",
	"taskItem": "vZSZnG_taskItem",
	"taskList": "vZSZnG_taskList",
	"taskMain": "vZSZnG_taskMain",
	"taskProgress": "vZSZnG_taskProgress",
	"taskTitle": "vZSZnG_taskTitle"
};
//#endregion
//#region src/client/TaskPanel.tsx
/**
* Task Panel - Floating interactive task management panel
*/
function getT() {
	return createTranslate(navigator.language.startsWith("zh") ? zh : en);
}
function StepIcon({ status }) {
	switch (status) {
		case "completed": return /* @__PURE__ */ jsx(IconCheckCircleOutline14, { className: TaskPanel_module_default.stepIconCompleted });
		case "in_progress": return /* @__PURE__ */ jsx(IconPlayCircleOutline14, { className: TaskPanel_module_default.stepIconProgress });
		default: return /* @__PURE__ */ jsx(IconCircleOutline14, { className: TaskPanel_module_default.stepIconPending });
	}
}
function FileRow({ file, onClick }) {
	return /* @__PURE__ */ jsxs("button", {
		className: TaskPanel_module_default.fileRow,
		onClick,
		title: `${file.path}${file.line ? `:${file.line}` : ""}`,
		children: [
			/* @__PURE__ */ jsx(IconFileOutline14, { className: TaskPanel_module_default.fileIcon }),
			/* @__PURE__ */ jsx("span", {
				className: TaskPanel_module_default.filePath,
				children: file.path
			}),
			file.line && /* @__PURE__ */ jsxs("span", {
				className: TaskPanel_module_default.fileLine,
				children: [":", file.line]
			})
		]
	});
}
function StepRow({ step, index }) {
	return /* @__PURE__ */ jsxs("div", {
		className: TaskPanel_module_default.stepRow,
		children: [/* @__PURE__ */ jsx(StepIcon, { status: step.status }), /* @__PURE__ */ jsx("span", {
			className: `${TaskPanel_module_default.stepContent} ${step.status === "completed" ? TaskPanel_module_default.stepCompleted : ""}`,
			children: step.content
		})]
	});
}
function TaskItem({ task, boundTaskId, onToggle, onSwitch, onArchive, expanded, t }) {
	const isBound = boundTaskId === task.id;
	const doneSteps = task.steps.filter((s) => s.status === "completed").length;
	const totalSteps = task.steps.length;
	const progress = totalSteps > 0 ? Math.round(doneSteps / totalSteps * 100) : 0;
	return /* @__PURE__ */ jsxs("div", {
		className: TaskPanel_module_default.taskItem,
		children: [/* @__PURE__ */ jsxs("button", {
			className: TaskPanel_module_default.taskHeader,
			onClick: () => onToggle(task.id),
			"aria-expanded": expanded,
			children: [/* @__PURE__ */ jsxs("div", {
				className: TaskPanel_module_default.taskMain,
				children: [
					isBound && /* @__PURE__ */ jsx("span", {
						className: TaskPanel_module_default.boundBadge,
						children: t("task.current")
					}),
					/* @__PURE__ */ jsx("span", {
						className: TaskPanel_module_default.taskTitle,
						children: task.title
					}),
					/* @__PURE__ */ jsxs("span", {
						className: TaskPanel_module_default.taskProgress,
						children: [totalSteps > 0 ? `${doneSteps}/${totalSteps}` : t("task.progress"), ": 0"]
					})
				]
			}), /* @__PURE__ */ jsxs("div", {
				className: TaskPanel_module_default.taskActions,
				children: [totalSteps > 0 && /* @__PURE__ */ jsxs("svg", {
					className: TaskPanel_module_default.progressRing,
					viewBox: "0 0 32 32",
					children: [/* @__PURE__ */ jsx("circle", {
						className: TaskPanel_module_default.progressBg,
						cx: "16",
						cy: "16",
						r: "14",
						fill: "none",
						strokeWidth: "3"
					}), /* @__PURE__ */ jsx("circle", {
						className: TaskPanel_module_default.progressFg,
						cx: "16",
						cy: "16",
						r: "14",
						fill: "none",
						strokeWidth: "3",
						strokeDasharray: `${progress * .88} ${88 - progress * .88}`,
						strokeDashoffset: "22",
						style: { strokeDasharray: `${progress * .88} ${88 - progress * .88}` }
					})]
				}), /* @__PURE__ */ jsx("span", {
					className: TaskPanel_module_default.chevron,
					children: expanded ? /* @__PURE__ */ jsx(IconChevronUpOutline14, {}) : /* @__PURE__ */ jsx(IconChevronDownOutline14, {})
				})]
			})]
		}), expanded && /* @__PURE__ */ jsxs("div", {
			className: TaskPanel_module_default.taskExpanded,
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: TaskPanel_module_default.section,
					children: [/* @__PURE__ */ jsx("div", {
						className: TaskPanel_module_default.sectionLabel,
						children: t("task.steps")
					}), /* @__PURE__ */ jsxs("div", {
						className: TaskPanel_module_default.stepsList,
						children: [task.steps.map((step, i) => /* @__PURE__ */ jsx(StepRow, {
							step,
							index: i
						}, i)), task.steps.length === 0 && /* @__PURE__ */ jsx("div", {
							className: TaskPanel_module_default.empty,
							children: t("panel.empty-desc")
						})]
					})]
				}),
				task.files.length > 0 && /* @__PURE__ */ jsxs("div", {
					className: TaskPanel_module_default.section,
					children: [/* @__PURE__ */ jsx("div", {
						className: TaskPanel_module_default.sectionLabel,
						children: t("task.files")
					}), /* @__PURE__ */ jsxs("div", {
						className: TaskPanel_module_default.filesList,
						children: [task.files.slice(0, 10).map((file, i) => /* @__PURE__ */ jsx(FileRow, {
							file,
							onClick: () => {
								navigator.clipboard.writeText(file.path);
							}
						}, i)), task.files.length > 10 && /* @__PURE__ */ jsxs("div", {
							className: TaskPanel_module_default.moreFiles,
							children: [
								"… 共 ",
								task.files.length,
								" 个文件"
							]
						})]
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: TaskPanel_module_default.taskFooter,
					children: [/* @__PURE__ */ jsx(Button, {
						variant: "outline",
						size: "sm",
						onClick: () => onSwitch(task.id),
						children: t("task.switch")
					}), /* @__PURE__ */ jsx(Button, {
						variant: "outline",
						size: "sm",
						onClick: () => onArchive(task.id),
						children: t("task.archive")
					})]
				})
			]
		})]
	});
}
function MiniBar({ task, t, onExpand }) {
	return /* @__PURE__ */ jsxs("div", {
		className: TaskPanel_module_default.miniBar,
		onClick: onExpand,
		title: t("minibar.click-expand"),
		children: [
			/* @__PURE__ */ jsx(IconFolderOutline14, { className: TaskPanel_module_default.miniIcon }),
			/* @__PURE__ */ jsxs("span", {
				className: TaskPanel_module_default.miniTitle,
				children: [
					t("minibar.current"),
					": ",
					task.title
				]
			}),
			/* @__PURE__ */ jsx(IconChevronUpOutline14, { className: TaskPanel_module_default.miniChevron })
		]
	});
}
function TaskPanel({ ctx }) {
	const t = getT();
	const state = useTaskStore();
	const actions = useTaskActions();
	const [dragOffset, setDragOffset] = useState({
		x: 0,
		y: 0
	});
	const panelRef = useRef(null);
	useEffect(() => {
		const saved = state.panelPosition;
		if (saved.x === 0 && saved.y === 0) actions.setPanelPosition({
			x: window.innerWidth - 440,
			y: 80
		});
	}, []);
	const handleDragStart = (e) => {
		if (e.target !== e.currentTarget) return;
		const rect = panelRef.current?.getBoundingClientRect();
		if (!rect) return;
		setDragOffset({
			x: e.clientX - rect.left,
			y: e.clientY - rect.top
		});
		document.addEventListener("mousemove", handleDrag);
		document.addEventListener("mouseup", handleDragEnd);
	};
	const handleDrag = (e) => {
		const x = Math.max(16, Math.min(window.innerWidth - 376, e.clientX - dragOffset.x));
		const y = Math.max(16, Math.min(window.innerHeight - 576, e.clientY - dragOffset.y));
		actions.setPanelPosition({
			x,
			y
		});
	};
	const handleDragEnd = () => {
		document.removeEventListener("mousemove", handleDrag);
		document.removeEventListener("mouseup", handleDragEnd);
	};
	const handleToggle = (id) => actions.toggleTaskExpanded(id);
	const handleSwitch = (id) => ctx.commands?.execute("select_task", { taskId: id });
	const handleArchive = (id) => ctx.commands?.execute("archive_task", { taskId: id });
	const activeTasks = state.tasks.filter((t) => !t.archived);
	const boundTask = state.boundTaskId ? state.tasks.find((t) => t.id === state.boundTaskId) : null;
	if (state.minimized) return boundTask ? /* @__PURE__ */ jsx(MiniBar, {
		task: boundTask,
		t,
		onExpand: () => actions.setMinimized(false)
	}) : null;
	if (!activeTasks.length) return /* @__PURE__ */ jsxs("div", {
		className: TaskPanel_module_default.panel,
		ref: panelRef,
		style: {
			left: state.panelPosition.x,
			top: state.panelPosition.y
		},
		children: [
			/* @__PURE__ */ jsx("div", {
				className: TaskPanel_module_default.dragHandle,
				onMouseDown: handleDragStart
			}),
			/* @__PURE__ */ jsxs("header", {
				className: TaskPanel_module_default.header,
				children: [/* @__PURE__ */ jsxs("div", {
					className: TaskPanel_module_default.headerLeft,
					children: [
						/* @__PURE__ */ jsx(IconFolderOutline14, { className: TaskPanel_module_default.headerIcon }),
						/* @__PURE__ */ jsx("h2", {
							className: TaskPanel_module_default.headerTitle,
							children: t("panel.title")
						}),
						/* @__PURE__ */ jsxs("span", {
							className: TaskPanel_module_default.badge,
							children: [
								t("panel.active"),
								": ",
								activeTasks.length,
								" ",
								t("panel.total"),
								": ",
								state.tasks.length - state.archivedCount
							]
						})
					]
				}), /* @__PURE__ */ jsxs("div", {
					className: TaskPanel_module_default.headerRight,
					children: [/* @__PURE__ */ jsx(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => actions.setMinimized(true),
						"aria-label": t("panel.minimize"),
						children: /* @__PURE__ */ jsx(IconMinimizeOutline14, {})
					}), /* @__PURE__ */ jsx(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => {},
						"aria-label": t("panel.close"),
						children: /* @__PURE__ */ jsx(IconCloseOutline16, {})
					})]
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: TaskPanel_module_default.emptyState,
				children: [
					/* @__PURE__ */ jsx(IconFolderOutline14, { className: TaskPanel_module_default.emptyIcon }),
					/* @__PURE__ */ jsx("p", { children: t("panel.empty") }),
					/* @__PURE__ */ jsx("p", {
						className: TaskPanel_module_default.emptyDesc,
						children: t("panel.empty-desc")
					})
				]
			})
		]
	});
	return /* @__PURE__ */ jsxs("div", {
		className: TaskPanel_module_default.panel,
		ref: panelRef,
		style: {
			left: state.panelPosition.x,
			top: state.panelPosition.y
		},
		children: [
			/* @__PURE__ */ jsx("div", {
				className: TaskPanel_module_default.dragHandle,
				onMouseDown: handleDragStart
			}),
			/* @__PURE__ */ jsxs("header", {
				className: TaskPanel_module_default.header,
				children: [/* @__PURE__ */ jsxs("div", {
					className: TaskPanel_module_default.headerLeft,
					children: [
						/* @__PURE__ */ jsx(IconFolderOutline14, { className: TaskPanel_module_default.headerIcon }),
						/* @__PURE__ */ jsx("h2", {
							className: TaskPanel_module_default.headerTitle,
							children: t("panel.title")
						}),
						/* @__PURE__ */ jsxs("span", {
							className: TaskPanel_module_default.badge,
							children: [
								t("panel.active"),
								": ",
								activeTasks.length,
								" ",
								t("panel.total"),
								": ",
								state.tasks.length - state.archivedCount
							]
						})
					]
				}), /* @__PURE__ */ jsxs("div", {
					className: TaskPanel_module_default.headerRight,
					children: [/* @__PURE__ */ jsx(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => actions.setMinimized(true),
						"aria-label": t("panel.minimize"),
						children: /* @__PURE__ */ jsx(IconMinimizeOutline14, {})
					}), /* @__PURE__ */ jsx(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => {},
						"aria-label": t("panel.close"),
						children: /* @__PURE__ */ jsx(IconCloseOutline16, {})
					})]
				})]
			}),
			/* @__PURE__ */ jsx("div", {
				className: TaskPanel_module_default.taskList,
				children: activeTasks.map((task) => /* @__PURE__ */ jsx(TaskItem, {
					task,
					boundTaskId: state.boundTaskId,
					onToggle: handleToggle,
					onSwitch: handleSwitch,
					onArchive: handleArchive,
					expanded: state.expandedTaskIds.has(task.id),
					t
				}, task.id))
			})
		]
	});
}
function TaskPanelEntry({ ctx }) {
	useEffect(() => {
		const handleCommandDone = (event) => {
			if (event.name === "tasks" && event.result?.kind === "success") {
				const match = (event.result.text || "").match(/```json\n([\s\S]*?)\n```/);
				if (match) try {
					const data = JSON.parse(match[1]);
					taskStore.actions.setTasks({
						tasks: data.tasks || [],
						boundTaskId: data.boundId || null,
						archivedCount: data.archived || 0
					});
				} catch (e) {
					console.warn("[dsh-project-memory] Failed to parse tasks JSON:", e);
				}
			}
		};
		ctx.on("command/done", handleCommandDone);
		return () => ctx.off("command/done", handleCommandDone);
	}, [ctx]);
	return /* @__PURE__ */ jsx(TaskPanel, { ctx });
}
//#endregion
//#region src/client/index.ts
/**
* dsh-project-memory Client Entry
* Registers Task Panel in conversation.overlay slot for floating panel
*/
const NS = "dsh-project-memory";
/**
* Required primitives that may not exist on older hosts.
* If missing, we skip registration gracefully.
*/
const REQUIRED_PRIMITIVES = [
	"Button",
	"IconChevronDownOutline14",
	"IconChevronUpOutline14",
	"IconCloseOutline16",
	"IconMinimizeOutline14",
	"IconCheckCircleOutline14",
	"IconCircleOutline14",
	"IconPlayCircleOutline14",
	"IconFolderOutline14",
	"IconFileOutline14"
];
function missingPrimitives(mod, required = REQUIRED_PRIMITIVES) {
	return required.filter((name) => mod[name] === void 0);
}
const name = NS;
function apply(ctx) {
	const gaps = missingPrimitives(primitives);
	if (gaps.length > 0) {
		console.warn(`[${NS}] host ui-primitives missing ${gaps.join(", ")} — task panel disabled`);
		return;
	}
	ctx.slots.inject("conversation.overlay", () => {
		return ctx.slots.register({
			name: "conversation.overlay",
			id: "dsh-project-memory-task-panel",
			order: 50,
			locale: NS
		}, () => h(TaskPanelEntry, { ctx }));
	});
}
//#endregion
export { REQUIRED_PRIMITIVES, apply, missingPrimitives, name };

//# sourceMappingURL=index.js.map