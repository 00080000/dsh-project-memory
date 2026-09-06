window.__ModuleLoader__.load({
	id: "@yolk_vat-y/dsh-project-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		/**
		* Locale dictionaries for Task Panel
		*/
		const zh = {
			"panel.title": "工作流任务",
			"panel.active": "进行中",
			"panel.total": "总计",
			"panel.minimize": "收起为顶部迷你条",
			"panel.close": "关闭面板（隐藏，/task 可唤起）",
			"panel.refresh": "同步最新任务",
			"panel.style": "切换面板风格",
			"style.native": "原生",
			"style.glass": "玻璃",
			"style.brutal": "粗野",
			"style.mono": "终端",
			"panel.syncing": "同步中…",
			"panel.sync-failed": "同步失败",
			"panel.hints-on": "显示提示信息",
			"panel.hints-off": "隐藏提示信息",
			"drag.cancel": "取消拖拽",
			"panel.empty": "暂无任务",
			"panel.empty-desc": "让模型开始工作并维护 todo 清单后会自动建档",
			"panel.no-session": "还没有会话",
			"task.progress": "进度",
			"task.steps": "步骤",
			"task.files": "文件",
			"task.current": "当前",
			"task.title-edit": "双击修改标题",
			"task.switch": "切换到此任务",
			"task.unbind": "取消当前任务",
			"task.archive": "归档",
			"task.drag": "拖拽移动",
			"step.completed": "已完成",
			"step.in-progress": "进行中",
			"step.pending": "待办",
			"step.edit-hint": "双击编辑步骤文案；点击图标循环 待办/进行中/已完成",
			"file.copy": "复制路径",
			"file.copied": "已复制路径",
			"minibar.current": "当前任务",
			"minibar.click-expand": "点击展开并同步",
			"minibar.tasks": "个任务",
			"minibar.no-task": "暂无任务 · 点击查看"
		};
		const en = {
			"panel.title": "Task Flow",
			"panel.active": "Active",
			"panel.total": "Total",
			"panel.minimize": "Collapse to mini bar",
			"panel.close": "Close panel (hidden; /task reopens)",
			"panel.refresh": "Sync latest tasks",
			"panel.style": "Panel style",
			"style.native": "Native",
			"style.glass": "Glass",
			"style.brutal": "Brutal",
			"style.mono": "Mono",
			"panel.syncing": "Syncing…",
			"panel.sync-failed": "Sync failed",
			"panel.hints-on": "Show hints",
			"panel.hints-off": "Hide hints",
			"drag.cancel": "Cancel drag",
			"panel.empty": "No Tasks",
			"panel.empty-desc": "Tasks are created automatically when the model maintains a todo list",
			"panel.no-session": "No session yet",
			"task.progress": "Progress",
			"task.steps": "Steps",
			"task.files": "Files",
			"task.current": "Current",
			"task.title-edit": "Double-click to rename",
			"task.switch": "Switch to this task",
			"task.unbind": "Unbind current task",
			"task.archive": "Archive",
			"task.drag": "Drag to move",
			"step.completed": "Completed",
			"step.in-progress": "In Progress",
			"step.pending": "Pending",
			"step.edit-hint": "Double-click to edit; click the icon to cycle status",
			"file.copy": "Copy path",
			"file.copied": "Path copied",
			"minibar.current": "Current task",
			"minibar.click-expand": "Click to expand & sync",
			"minibar.tasks": "tasks",
			"minibar.no-task": "No tasks · click to view"
		};
		function createTranslate(dict) {
			return (key, params) => {
				let text = dict[key] ?? key;
				if (params) for (const [k, v] of Object.entries(params)) text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
				return text;
			};
		}
		//#endregion
		//#region src/client/task-data-store.ts
		/**
		* Task Data Store — 仅管服务端同步的数据（tasks、boundTaskId、archivedCount）
		* - 单向数据流：命令执行结果 → setTasks → 广播给其他标签页
		* - 无 UI 状态，无 localStorage，纯内存 + BroadcastChannel 同步
		*/
		function parseTaskPayloadText(text) {
			if (!text) return null;
			let jsonBlock = null;
			const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
			if (fenced) jsonBlock = fenced[1];
			else {
				const lastBrace = text.lastIndexOf("{");
				if (lastBrace !== -1) jsonBlock = text.slice(lastBrace);
			}
			if (!jsonBlock) return null;
			try {
				const data = JSON.parse(jsonBlock);
				if (!Array.isArray(data.tasks)) return null;
				return {
					tasks: data.tasks,
					boundId: data.boundId ?? null,
					archived: data.archived ?? 0
				};
			} catch {
				return null;
			}
		}
		const SYNC_CHANNEL = typeof window !== "undefined" ? new BroadcastChannel("dsh-pm-tasks-data") : null;
		let dataState = {
			tasks: [],
			boundTaskId: null,
			archivedCount: 0,
			lastUpdate: 0
		};
		const dataListeners = /* @__PURE__ */ new Set();
		function setDataState(next) {
			dataState = next;
			for (const listener of dataListeners) listener();
		}
		function broadcastDataUpdate(tasks, archivedCount) {
			if (!SYNC_CHANNEL) return;
			SYNC_CHANNEL.postMessage({
				type: "PROJECT_TASKS_UPDATED",
				payload: {
					tasks,
					archivedCount
				}
			});
		}
		if (SYNC_CHANNEL) SYNC_CHANNEL.onmessage = (event) => {
			const msg = event.data;
			if (msg?.type === "PROJECT_TASKS_UPDATED" && msg.payload) {
				const { tasks, archivedCount } = msg.payload;
				setDataState((prev) => ({
					...prev,
					tasks: tasks || [],
					archivedCount: archivedCount ?? 0,
					lastUpdate: Date.now()
				}));
			}
		};
		const taskDataStore = {
			subscribe(listener) {
				dataListeners.add(listener);
				return () => {
					dataListeners.delete(listener);
				};
			},
			getSnapshot() {
				return dataState;
			},
			actions: {
				setTasks(payload) {
					const nextTasks = payload.tasks || [];
					const nextArchived = payload.archivedCount ?? 0;
					setDataState({
						tasks: nextTasks,
						boundTaskId: payload.boundTaskId ?? null,
						archivedCount: nextArchived,
						lastUpdate: Date.now()
					});
					broadcastDataUpdate(nextTasks, nextArchived);
				},
				reset() {
					setDataState({
						tasks: [],
						boundTaskId: null,
						archivedCount: 0,
						lastUpdate: 0
					});
				}
			}
		};
		function useTaskData() {
			return (0, react.useSyncExternalStore)(taskDataStore.subscribe, taskDataStore.getSnapshot, taskDataStore.getSnapshot);
		}
		function useTaskDataActions() {
			return taskDataStore.actions;
		}
		//#endregion
		//#region src/client/task-ui-store.ts
		/**
		* Task UI Store — 仅管本地 UI 状态（closed、minimized、position、expandedIds、theme）
		* - 持久化到 localStorage（key: dsh-pm-task-panel-ui）
		* - 不跨标签页同步（每个标签页独立）
		* - 启动/刷新强制 closed: true，面板默认不显示
		*/
		const STORAGE_KEY = "dsh-pm-task-panel-ui";
		function defaultPosition() {
			if (typeof window !== "undefined") return {
				x: Math.max(16, window.innerWidth - 408),
				y: 72
			};
			return {
				x: 0,
				y: 0
			};
		}
		/**
		* 启动时的初始状态：
		* - closed 恒为 true（不读取 localStorage 的 closed），刷新后面板隐藏；
		* - 其余（展开项/位置/主题）可恢复上次会话偏好，minimized 默认折叠成迷你条。
		*/
		function getDefaultUIState() {
			if (typeof window !== "undefined") try {
				const saved = localStorage.getItem(STORAGE_KEY);
				if (saved) {
					const parsed = JSON.parse(saved);
					return {
						expandedTaskIds: Array.isArray(parsed.expandedTaskIds) ? parsed.expandedTaskIds : [],
						panelPosition: parsed.panelPosition ?? defaultPosition(),
						minimized: parsed.minimized !== false,
						closed: true,
						theme: typeof parsed.theme === "string" ? parsed.theme : "native"
					};
				}
			} catch {}
			return {
				expandedTaskIds: [],
				panelPosition: defaultPosition(),
				minimized: true,
				closed: true,
				theme: "native"
			};
		}
		function persistUI(state) {
			if (typeof window === "undefined") return;
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			} catch {}
		}
		let uiState = getDefaultUIState();
		const uiListeners = /* @__PURE__ */ new Set();
		function setUIState(next) {
			uiState = next;
			persistUI(next);
			for (const listener of uiListeners) listener();
		}
		const taskUIStore = {
			subscribe(listener) {
				uiListeners.add(listener);
				return () => {
					uiListeners.delete(listener);
				};
			},
			getSnapshot() {
				return uiState;
			},
			actions: {
				toggleTaskExpanded(taskId) {
					const prev = uiState;
					const ids = prev.expandedTaskIds.includes(taskId) ? prev.expandedTaskIds.filter((id) => id !== taskId) : [...prev.expandedTaskIds, taskId];
					setUIState({
						...prev,
						expandedTaskIds: ids
					});
				},
				expandAll(taskIds) {
					setUIState({
						...uiState,
						expandedTaskIds: taskIds
					});
				},
				setPanelPosition(pos) {
					setUIState({
						...uiState,
						panelPosition: pos
					});
				},
				open() {
					setUIState({
						...uiState,
						minimized: false,
						closed: false
					});
				},
				minimize() {
					setUIState({
						...uiState,
						minimized: true,
						closed: false
					});
				},
				close() {
					setUIState({
						...uiState,
						minimized: true,
						closed: true
					});
				},
				setTheme(theme) {
					setUIState({
						...uiState,
						theme
					});
				},
				reset() {
					setUIState(getDefaultUIState());
				}
			}
		};
		function useTaskUI() {
			return (0, react.useSyncExternalStore)(taskUIStore.subscribe, taskUIStore.getSnapshot, taskUIStore.getSnapshot);
		}
		function useTaskUIActions() {
			return taskUIStore.actions;
		}
		//#endregion
		//#region src/client/task-hooks.ts
		/**
		* Task Panel Hooks — 步骤拖拽交互逻辑（useTaskDrag）。
		* 只依赖 react + task-data-store 类型，不碰数据/UI store。
		*/
		/**
		* useTaskDrag — 步骤拖拽重排（绑定任务内，同一任务卡的步骤行间移动）。
		*
		* 交互模型（拖动全程按住鼠标）：
		*  - 步骤行上按下（左键、非按钮/输入区域）→ 进入预览；
		*  - 按住 350ms 不松，或按住后移动超过 6px → 唤起跟随鼠标的浮动幽灵卡片；
		*  - 幽灵悬停到本任务卡内的步骤行时显示蓝色插入线（上半=插到该行前，下半=插到该行后）；
		*  - 松手（mouseup）：落在有效位置 → onReorder 落子；落在卡外/别的任务卡/原行
		*    （插入自身前后）/按钮输入等控件上 → 取消；
		*  - 350ms 内原地松手 = 普通点击，不产生幽灵；Esc → 取消。
		*/
		function useTaskDrag(taskId, steps, isBound, onReorder) {
			const [dragState, setDragState] = (0, react.useState)(null);
			const [dropTargetIndex, setDropTargetIndex] = (0, react.useState)(null);
			const dragRef = (0, react.useRef)(dragState);
			dragRef.current = dragState;
			const longPressTimer = (0, react.useRef)(void 0);
			const dragOrigin = (0, react.useRef)(null);
			const clearTimer = (0, react.useCallback)(() => {
				if (longPressTimer.current !== void 0) {
					window.clearTimeout(longPressTimer.current);
					longPressTimer.current = void 0;
				}
			}, []);
			const cancelDrag = (0, react.useCallback)(() => {
				clearTimer();
				dragOrigin.current = null;
				document.body.style.userSelect = "";
				setDropTargetIndex(null);
				setDragState(null);
			}, [clearTimer]);
			const startDrag = (0, react.useCallback)((fromIndex, stepContent, e) => {
				if (!isBound || e.button !== 0) return;
				if (dragRef.current) return;
				e.preventDefault();
				e.stopPropagation();
				document.body.style.userSelect = "none";
				dragOrigin.current = {
					x: e.clientX,
					y: e.clientY
				};
				setDropTargetIndex(null);
				setDragState({
					fromIndex,
					stepContent,
					clientX: e.clientX,
					clientY: e.clientY,
					dragging: false
				});
				clearTimer();
				longPressTimer.current = window.setTimeout(() => {
					longPressTimer.current = void 0;
					setDragState((prev) => prev ? {
						...prev,
						dragging: true
					} : null);
				}, 350);
			}, [isBound, clearTimer]);
			/** 计算某行上 y 坐标对应的插入位（行数下标：上半=该行前，下半=该行后）；非本任务卡返回 null */
			const dropIndexAt = (0, react.useCallback)((row, clientY) => {
				const parentOl = row.closest("ol");
				if (!parentOl || !parentOl.closest(`article[data-task-id="${taskId}"]`)) return null;
				const index = Array.from(parentOl.children).indexOf(row);
				const rect = row.getBoundingClientRect();
				return clientY < rect.top + rect.height / 2 ? index : index + 1;
			}, [taskId]);
			/** 在 (x,y) 处结算：命中有效落点则重排，否则取消；并结束本次拖拽 */
			const commitDrop = (0, react.useCallback)((x, y) => {
				const cur = dragRef.current;
				if (!cur || !cur.dragging) return;
				const el = document.elementFromPoint(x, y);
				if (el && !el.closest("button, input, textarea, a")) {
					const row = el.closest("[data-step-row]");
					if (row) {
						const drop = dropIndexAt(row, y);
						if (drop !== null) {
							if ((drop > cur.fromIndex ? drop - 1 : drop) !== cur.fromIndex) onReorder(cur.fromIndex, drop);
						}
					}
				}
				cancelDrag();
			}, [
				dropIndexAt,
				onReorder,
				cancelDrag
			]);
			const active = dragState !== null;
			(0, react.useEffect)(() => {
				if (!active) return;
				const onMouseMove = (e) => {
					const cur = dragRef.current;
					if (!cur) return;
					if (!cur.dragging) {
						const origin = dragOrigin.current;
						if (!origin) return;
						if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 6) return;
						clearTimer();
						setDragState((prev) => prev ? {
							...prev,
							dragging: true,
							clientX: e.clientX,
							clientY: e.clientY
						} : null);
					} else setDragState((prev) => prev ? {
						...prev,
						clientX: e.clientX,
						clientY: e.clientY
					} : null);
					const row = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-step-row]");
					setDropTargetIndex(row ? dropIndexAt(row, e.clientY) : null);
				};
				const onMouseUp = (e) => {
					const cur = dragRef.current;
					if (!cur) return;
					if (cur.dragging) commitDrop(e.clientX, e.clientY);
					else cancelDrag();
				};
				const onClick = (e) => {
					const cur = dragRef.current;
					if (!cur || !cur.dragging) return;
					commitDrop(e.clientX, e.clientY);
				};
				const onKeyDown = (e) => {
					if (e.key === "Escape") cancelDrag();
				};
				window.addEventListener("mousemove", onMouseMove);
				window.addEventListener("mouseup", onMouseUp);
				window.addEventListener("click", onClick, true);
				window.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("mousemove", onMouseMove);
					window.removeEventListener("mouseup", onMouseUp);
					window.removeEventListener("click", onClick, true);
					window.removeEventListener("keydown", onKeyDown);
					document.body.style.userSelect = "";
				};
			}, [
				active,
				taskId,
				dropIndexAt,
				onReorder,
				cancelDrag,
				commitDrop
			]);
			(0, react.useEffect)(() => () => clearTimer(), [clearTimer]);
			return {
				dragState,
				dropTargetIndex,
				startDrag,
				cancelDrag
			};
		}
		//#endregion
		//#region \0dsh-css:/home/sxt/project/dsh-project-memory/src/client/TaskPanel.module.css.mjs
		const css$1 = ".vZSZnG_panel{pointer-events:auto;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));border:1px solid var(--dsw-alias-border-l2,#7f7f7f4d);border-radius:14px;flex-direction:column;width:380px;max-width:calc(100vw - 24px);max-height:min(70vh,640px);font-family:inherit;animation:.18s ease-out vZSZnG_panelIn;display:flex;position:fixed;overflow:hidden;box-shadow:0 12px 32px #00000029,0 2px 8px #00000014}@keyframes vZSZnG_panelIn{0%{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}.vZSZnG_dragHandle{cursor:grab;z-index:1;justify-content:center;align-items:center;height:12px;display:flex;position:absolute;top:0;left:0;right:0}.vZSZnG_dragHandle:active{cursor:grabbing}.vZSZnG_handleGrip{background:var(--dsw-alias-separator-primary,#7f7f7f59);opacity:.8;border-radius:2px;width:32px;height:3px}.vZSZnG_header{border-bottom:1px solid var(--dsw-alias-border-l1,#7f7f7f2e);-webkit-user-select:none;user-select:none;justify-content:space-between;align-items:center;gap:8px;padding:10px 10px 8px 14px;display:flex}.vZSZnG_headerLeft{align-items:center;gap:6px;min-width:0;display:flex}.vZSZnG_headerIcon{color:var(--dsw-alias-label-secondary);flex:none}.vZSZnG_headerTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;margin:0;font-size:13px;font-weight:600;line-height:20px}.vZSZnG_headerRight{align-items:center;gap:2px;margin-left:auto;display:flex}.vZSZnG_counts{color:var(--dsw-alias-label-tertiary);white-space:nowrap;margin-right:4px;font-size:11px;line-height:16px}.vZSZnG_boundBadge{color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#3a6ef5);white-space:nowrap;border-radius:7px;flex:none;padding:0 6px;font-size:10px;line-height:14px}.vZSZnG_notice{color:var(--dsw-alias-state-warn-label,#b7791f);background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1a);word-break:break-all;border-radius:8px;margin:8px 12px 0;padding:6px 10px;font-size:12px;line-height:18px}.vZSZnG_taskList{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,transparent) transparent;flex-direction:column;gap:6px;padding:8px;display:flex;overflow-y:auto}.vZSZnG_emptyState{text-align:center;color:var(--dsw-alias-label-secondary);padding:36px 24px 30px}.vZSZnG_emptyTitle{color:var(--dsw-alias-label-primary);margin:0 0 6px;font-size:13px;font-weight:600}.vZSZnG_emptyDesc{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:20px}.vZSZnG_syncHint{color:var(--dsw-alias-label-dimmed);justify-content:center;align-items:center;gap:6px;margin:10px 0 0;font-size:11px;display:flex}.vZSZnG_card{border:1px solid var(--dsw-alias-border-l1,#7f7f7f29);background:var(--dsw-alias-bg-base,transparent);border-radius:10px;transition:border-color .15s;overflow:hidden}.vZSZnG_cardBound{border-color:var(--dsw-alias-border-l3,#7f7f7f59);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,transparent)}.vZSZnG_cardHead{cursor:pointer;text-align:left;background:0 0;border:none;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:8px 10px 7px;display:flex}.vZSZnG_cardHead:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.vZSZnG_cardTitleRow{align-items:center;gap:6px;min-width:0;display:flex}.vZSZnG_cardTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.vZSZnG_cardMeta{color:var(--dsw-alias-label-tertiary);flex:none;align-items:center;gap:8px;display:flex}.vZSZnG_progressText{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}.vZSZnG_updated{color:var(--dsw-alias-label-dimmed);font-size:10px;line-height:14px}.vZSZnG_chevron{color:var(--dsw-alias-label-tertiary);display:inline-flex}.vZSZnG_track{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1f);border-radius:1px;height:2px;margin:0 10px 6px;overflow:hidden}.vZSZnG_trackFill{background:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-button-primary-fill,#3a6ef5));border-radius:1px;height:100%;transition:width .2s}.vZSZnG_cardBody{border-top:1px solid var(--dsw-alias-border-l1,#7f7f7f24);overscroll-behavior:contain;max-height:300px;padding:8px 10px 10px;overflow-y:auto}.vZSZnG_section{margin-bottom:8px}.vZSZnG_section:last-child{margin-bottom:0}.vZSZnG_sectionLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;margin-bottom:4px;font-size:11px;line-height:16px;display:flex}.vZSZnG_sectionCount{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1a);color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:0 5px;font-size:10px;line-height:14px}.vZSZnG_stepsList{flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;display:flex}.vZSZnG_stepRow{align-items:flex-start;gap:7px;padding:3px 2px;display:flex}.vZSZnG_stepRow>svg{flex:none;margin-top:2px}.vZSZnG_stepDone{color:var(--dsw-alias-label-dimmed)}.vZSZnG_stepRun{color:var(--dsw-alias-label-primary-bluish,#3a6ef5)}.vZSZnG_stepPending{background:var(--dsw-alias-border-l3,#7f7f7f80);border-radius:50%;flex:none;width:8px;height:8px;margin:5px 3px}.vZSZnG_stepContent{color:var(--dsw-alias-label-secondary);word-break:break-word;font-size:12px;line-height:20px}.vZSZnG_stepContentDone{color:var(--dsw-alias-label-dimmed);text-decoration:line-through}.vZSZnG_stepContentRun{color:var(--dsw-alias-label-primary)}.vZSZnG_muted{color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:18px}.vZSZnG_filesList{flex-direction:column;margin:0;padding:0;list-style:none;display:flex}.vZSZnG_fileRow{cursor:pointer;text-align:left;background:0 0;border:none;border-radius:6px;align-items:center;gap:6px;width:100%;padding:3px 4px;display:flex}.vZSZnG_fileRow:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.vZSZnG_fileDot{background:var(--dsw-alias-border-l3,#7f7f7f80);border-radius:50%;flex:none;width:5px;height:5px}.vZSZnG_filePath{color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;text-align:left;direction:rtl;font-family:ui-monospace,SF Mono,Menlo,Consolas,monospace;font-size:11px;line-height:18px;overflow:hidden}.vZSZnG_fileLine{color:var(--dsw-alias-label-dimmed);flex:none;font-size:10px;line-height:18px}.vZSZnG_cardFooter{gap:6px;margin-top:8px;display:flex}@media (prefers-reduced-motion:reduce){.vZSZnG_panel{animation:none}.vZSZnG_trackFill,.vZSZnG_card{transition:none}}.vZSZnG_miniBar{border:1px solid var(--dsw-alias-border-l3,#7f7f7f4d);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));max-width:min(46vw,340px);height:34px;color:var(--dsw-alias-label-primary);cursor:grab;-webkit-user-select:none;user-select:none;pointer-events:auto;border-radius:999px;align-items:center;gap:7px;padding:0 12px;font-size:12px;line-height:18px;transition:background .15s,border-color .15s;display:inline-flex;position:fixed;box-shadow:0 6px 20px #00000024,0 1px 4px #00000014}.vZSZnG_miniBar:active{cursor:grabbing}.vZSZnG_miniBar:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.vZSZnG_miniIcon{color:var(--dsw-alias-label-secondary);flex:none}.vZSZnG_miniText{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.vZSZnG_miniChevron{color:var(--dsw-alias-label-tertiary);flex:none}.vZSZnG_taskList{flex:auto;min-height:0}.vZSZnG_card{flex-direction:column;display:flex}.vZSZnG_boundaryFallback{border:1px solid var(--dsw-alias-border-l3,#7f7f7f4d);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary);cursor:pointer;pointer-events:auto;border-radius:999px;padding:4px 10px;font-size:12px;line-height:18px;position:fixed;top:64px;right:16px}.vZSZnG_stepToggle{cursor:pointer;background:0 0;border:none;border-radius:4px;flex:none;align-items:center;margin-top:2px;padding:0;display:inline-flex}.vZSZnG_stepToggle:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1f)}.vZSZnG_stepToggle:disabled{cursor:default;opacity:.5}.vZSZnG_stepEditable{cursor:text;border-radius:3px}.vZSZnG_stepEditable:hover{outline:1px dashed var(--dsw-alias-border-l3,#7f7f7f66);outline-offset:1px}.vZSZnG_stepInput{box-sizing:border-box;width:auto;min-width:0;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l3,#7f7f7f73);border-radius:5px;flex:auto;padding:0 5px;font-size:12px;line-height:20px}.vZSZnG_stepDragging{opacity:.3;background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.vZSZnG_cardTitleEditable{cursor:text;border-radius:3px}.vZSZnG_cardTitleEditable:hover{outline:1px dashed var(--dsw-alias-border-l3,#7f7f7f66);outline-offset:1px}.vZSZnG_panel[data-theme=glass],.vZSZnG_miniBar[data-theme=glass]{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#fff) 90%, transparent);-webkit-backdrop-filter:blur(18px)saturate(1.2);border:1px solid color-mix(in srgb, var(--dsw-alias-border-l2,#7f7f7f4d) 80%, transparent)}.vZSZnG_panel[data-theme=glass] .vZSZnG_card{background:color-mix(in srgb, var(--dsw-alias-bg-base,transparent) 84%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-border-l1,#7f7f7f29) 60%, transparent)}.vZSZnG_panel[data-theme=glass] .vZSZnG_cardBody{border-top-color:color-mix(in srgb, var(--dsw-alias-border-l1,#7f7f7f24) 60%, transparent)}@media (prefers-reduced-transparency:reduce){.vZSZnG_panel[data-theme=glass],.vZSZnG_miniBar[data-theme=glass]{background:var(--dsw-alias-bg-layer-2,#fff);-webkit-backdrop-filter:none;backdrop-filter:none}.vZSZnG_panel[data-theme=glass] .vZSZnG_card{background:var(--dsw-alias-bg-base,transparent)}}@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.vZSZnG_panel[data-theme=glass],.vZSZnG_miniBar[data-theme=glass]{background:var(--dsw-alias-bg-layer-2,#fff)}}.vZSZnG_panel[data-theme=brutal]{box-shadow:none;border-width:1px;border-radius:6px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_card{border:1px solid var(--dsw-alias-border-l3,#7f7f7f6b);background:var(--dsw-alias-bg-base,transparent);box-shadow:none;border-radius:3px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_cardHead{padding:7px 10px 6px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_cardTitle{letter-spacing:.01em;font-weight:650}.vZSZnG_panel[data-theme=brutal] .vZSZnG_headerTitle{letter-spacing:.03em}.vZSZnG_panel[data-theme=brutal] .vZSZnG_boundBadge{border-radius:2px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_track{border-radius:0;height:3px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_trackFill{border-radius:0}.vZSZnG_panel[data-theme=brutal] .vZSZnG_cardBody{border-top:1px solid var(--dsw-alias-border-l2,#7f7f7f3d)}.vZSZnG_panel[data-theme=mono] .vZSZnG_headerTitle,.vZSZnG_panel[data-theme=mono] .vZSZnG_counts,.vZSZnG_panel[data-theme=mono] .vZSZnG_cardTitle,.vZSZnG_panel[data-theme=mono] .vZSZnG_progressText,.vZSZnG_panel[data-theme=mono] .vZSZnG_stepContent,.vZSZnG_panel[data-theme=mono] .vZSZnG_filePath{font-family:ui-monospace,SF Mono,Menlo,Consolas,Liberation Mono,monospace}.vZSZnG_panel[data-theme=mono] .vZSZnG_cardTitle{font-size:12px}.vZSZnG_panel[data-theme=mono] .vZSZnG_stepContent{font-size:11.5px}.vZSZnG_panel[data-theme=mono] .vZSZnG_card{border-radius:5px}.vZSZnG_panel[data-theme=mono] .vZSZnG_trackFill{border-radius:0}.vZSZnG_panel[data-theme=mono] .vZSZnG_stepPending{border-radius:1px}.vZSZnG_panel[data-theme=mono] .vZSZnG_updated{letter-spacing:.02em}.vZSZnG_headerIconBtn{color:inherit;cursor:pointer;background:0 0;border:none;border-radius:0;flex:none;justify-content:center;align-items:center;margin:0;padding:0;display:inline-flex}.vZSZnG_headerIcon{color:var(--dsw-alias-label-secondary);flex:none;display:block}.vZSZnG_headerLeft{min-width:0}.vZSZnG_headerTitle{text-overflow:ellipsis;flex:0 auto;min-width:0;overflow:hidden}.vZSZnG_headerRight{min-width:0}.vZSZnG_counts{text-overflow:ellipsis;flex:none;max-width:45%;margin-left:auto;overflow:hidden}.vZSZnG_dragGhost{pointer-events:none;z-index:9999;transition:left 50ms,top 50ms;position:fixed;transform:translate(-50%,-50%)}.vZSZnG_dragGhostCard{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));border:1px solid var(--dsw-alias-border-l3,#7f7f7f59);color:var(--dsw-alias-label-primary);white-space:nowrap;border-radius:8px;align-items:center;gap:8px;max-width:280px;padding:8px 12px;font-size:12px;line-height:20px;display:inline-flex;transform:scale(.9);box-shadow:0 8px 24px #0000002e,0 2px 8px #0000001a}.vZSZnG_dragGhostContent{text-overflow:ellipsis;word-break:break-word;flex:1;min-width:0;overflow:hidden}.vZSZnG_dragGhostClose{width:20px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:.6;background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;margin-left:8px;font-size:16px;line-height:1;transition:opacity .15s,background .15s,color .15s;display:inline-flex}.vZSZnG_dragGhostClose:hover{opacity:1;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1f)}.vZSZnG_dropTargetBefore{position:relative}.vZSZnG_dropTargetBefore:before{content:\"\";background:var(--dsw-alias-button-primary-fill,#3a6ef5);height:2px;box-shadow:0 0 4px var(--dsw-alias-button-primary-fill,#3a6ef5);border-radius:1px;animation:.8s ease-in-out infinite vZSZnG_dropPulse;position:absolute;top:-1px;left:0;right:0}.vZSZnG_dropTargetAfter{position:relative}.vZSZnG_dropTargetAfter:after{content:\"\";background:var(--dsw-alias-button-primary-fill,#3a6ef5);height:2px;box-shadow:0 0 4px var(--dsw-alias-button-primary-fill,#3a6ef5);border-radius:1px;animation:.8s ease-in-out infinite vZSZnG_dropPulse;position:absolute;bottom:-1px;left:0;right:0}@keyframes vZSZnG_dropPulse{0%,to{opacity:.6}50%{opacity:1}}";
		const tagId$1 = "@yolk_vat-y/dsh-project-memory/TaskPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@yolk_vat-y/dsh-project-memory";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var TaskPanel_module_css_default = {
			"headerLeft": "vZSZnG_headerLeft",
			"counts": "vZSZnG_counts",
			"card": "vZSZnG_card",
			"filePath": "vZSZnG_filePath",
			"headerIcon": "vZSZnG_headerIcon",
			"fileDot": "vZSZnG_fileDot",
			"dropPulse": "vZSZnG_dropPulse",
			"stepContent": "vZSZnG_stepContent",
			"stepInput": "vZSZnG_stepInput",
			"track": "vZSZnG_track",
			"muted": "vZSZnG_muted",
			"cardMeta": "vZSZnG_cardMeta",
			"miniChevron": "vZSZnG_miniChevron",
			"stepRun": "vZSZnG_stepRun",
			"stepEditable": "vZSZnG_stepEditable",
			"dragGhostContent": "vZSZnG_dragGhostContent",
			"chevron": "vZSZnG_chevron",
			"dragGhostCard": "vZSZnG_dragGhostCard",
			"cardBound": "vZSZnG_cardBound",
			"boundaryFallback": "vZSZnG_boundaryFallback",
			"headerTitle": "vZSZnG_headerTitle",
			"stepContentDone": "vZSZnG_stepContentDone",
			"fileLine": "vZSZnG_fileLine",
			"sectionLabel": "vZSZnG_sectionLabel",
			"emptyTitle": "vZSZnG_emptyTitle",
			"stepDragging": "vZSZnG_stepDragging",
			"trackFill": "vZSZnG_trackFill",
			"miniIcon": "vZSZnG_miniIcon",
			"progressText": "vZSZnG_progressText",
			"cardTitle": "vZSZnG_cardTitle",
			"cardFooter": "vZSZnG_cardFooter",
			"headerIconBtn": "vZSZnG_headerIconBtn",
			"header": "vZSZnG_header",
			"miniBar": "vZSZnG_miniBar",
			"dropTargetAfter": "vZSZnG_dropTargetAfter",
			"filesList": "vZSZnG_filesList",
			"boundBadge": "vZSZnG_boundBadge",
			"cardTitleEditable": "vZSZnG_cardTitleEditable",
			"fileRow": "vZSZnG_fileRow",
			"dragGhost": "vZSZnG_dragGhost",
			"cardTitleRow": "vZSZnG_cardTitleRow",
			"cardHead": "vZSZnG_cardHead",
			"panel": "vZSZnG_panel",
			"stepRow": "vZSZnG_stepRow",
			"headerRight": "vZSZnG_headerRight",
			"handleGrip": "vZSZnG_handleGrip",
			"panelIn": "vZSZnG_panelIn",
			"stepToggle": "vZSZnG_stepToggle",
			"notice": "vZSZnG_notice",
			"emptyState": "vZSZnG_emptyState",
			"miniText": "vZSZnG_miniText",
			"updated": "vZSZnG_updated",
			"stepsList": "vZSZnG_stepsList",
			"dragHandle": "vZSZnG_dragHandle",
			"taskList": "vZSZnG_taskList",
			"sectionCount": "vZSZnG_sectionCount",
			"stepDone": "vZSZnG_stepDone",
			"syncHint": "vZSZnG_syncHint",
			"section": "vZSZnG_section",
			"stepContentRun": "vZSZnG_stepContentRun",
			"dragGhostClose": "vZSZnG_dragGhostClose",
			"emptyDesc": "vZSZnG_emptyDesc",
			"dropTargetBefore": "vZSZnG_dropTargetBefore",
			"stepPending": "vZSZnG_stepPending",
			"cardBody": "vZSZnG_cardBody"
		};
		//#endregion
		//#region src/client/TaskComponents.tsx
		/**
		* Task Panel Presentational 组件 — MiniBar（折叠迷你条）与 TaskCard（任务卡）。
		* 纯渲染 + 卡片局部行内编辑/拖拽状态，动作经 props 回调交给容器（TaskPanel.tsx）。
		*/
		function timeAgo(iso) {
			if (!iso) return "";
			const diff = Date.now() - new Date(iso).getTime();
			const m = Math.floor(diff / 6e4);
			if (m < 1) return "刚刚";
			if (m < 60) return `${m}分钟前`;
			const h = Math.floor(m / 60);
			if (h < 24) return `${h}小时前`;
			return `${Math.floor(h / 24)}天前`;
		}
		function StepIcon({ status }) {
			if (status === "completed") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { className: TaskPanel_module_css_default.stepDone });
			if (status === "in_progress") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlayOutline16, { className: TaskPanel_module_css_default.stepRun });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: TaskPanel_module_css_default.stepPending });
		}
		function MiniBar({ label, hint, position, theme, onMove, open }) {
			const barRef = (0, react.useRef)(null);
			const down = (0, react.useRef)(null);
			const onMouseDown = (e) => {
				if (e.button !== 0) return;
				const rect = barRef.current?.getBoundingClientRect();
				if (!rect) return;
				down.current = {
					dx: e.clientX - rect.left,
					dy: e.clientY - rect.top,
					sx: e.clientX,
					sy: e.clientY,
					moved: false
				};
				const onMoveEv = (ev) => {
					const d = down.current;
					if (!d) return;
					if (!d.moved && Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) > 4) d.moved = true;
					if (d.moved) {
						const w = barRef.current?.offsetWidth ?? 260;
						const h = barRef.current?.offsetHeight ?? 34;
						onMove({
							x: Math.max(8, Math.min(window.innerWidth - w - 8, ev.clientX - d.dx)),
							y: Math.max(8, Math.min(window.innerHeight - h - 8, ev.clientY - d.dy))
						});
					}
				};
				const onUpEv = () => {
					const d = down.current;
					down.current = null;
					window.removeEventListener("mousemove", onMoveEv);
					window.removeEventListener("mouseup", onUpEv);
					if (d && !d.moved) open();
				};
				window.addEventListener("mousemove", onMoveEv);
				window.addEventListener("mouseup", onUpEv);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: barRef,
				className: TaskPanel_module_css_default.miniBar,
				style: {
					left: position.x,
					top: position.y
				},
				"data-theme": theme === "native" ? void 0 : theme,
				onMouseDown,
				role: "button",
				title: hint,
				"aria-label": hint,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, { className: TaskPanel_module_css_default.miniIcon }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: TaskPanel_module_css_default.miniText,
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, { className: TaskPanel_module_css_default.miniChevron })
				]
			});
		}
		function TaskCard({ task, isBound, expanded, onToggleExpand, onSwitch, onUnbind, onArchive, onRename, onEditStep, onCycleStatus, onReorderSteps, showHints, syncing, t }) {
			const steps = task.steps || [];
			const { dragState, dropTargetIndex, startDrag, cancelDrag } = useTaskDrag(task.id, steps, isBound, onReorderSteps);
			const [stepEdit, setStepEdit] = (0, react.useState)(null);
			const [titleEdit, setTitleEdit] = (0, react.useState)(null);
			const done = steps.filter((s) => s.status === "completed").length;
			const pct = steps.length > 0 ? Math.round(done / steps.length * 100) : 0;
			const commitStepEdit = (index) => {
				if (!stepEdit || stepEdit.index !== index) return;
				const value = stepEdit.value;
				setStepEdit(null);
				onEditStep(index, value);
			};
			const commitTitleEdit = () => {
				if (titleEdit === null) return;
				const value = titleEdit.value;
				setTitleEdit(null);
				onRename(value);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				"data-task-id": task.id,
				className: `${TaskPanel_module_css_default.card}${isBound ? ` ${TaskPanel_module_css_default.cardBound}` : ""}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						className: TaskPanel_module_css_default.cardHead,
						onClick: () => {
							if (titleEdit !== null) return;
							onToggleExpand();
						},
						"aria-expanded": expanded,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TaskPanel_module_css_default.cardTitleRow,
							children: [isBound && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TaskPanel_module_css_default.boundBadge,
								children: t("task.current")
							}), isBound && titleEdit !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: TaskPanel_module_css_default.stepInput,
								value: titleEdit.value,
								autoFocus: true,
								onChange: (e) => setTitleEdit({ value: e.target.value }),
								onBlur: commitTitleEdit,
								onKeyDown: (e) => {
									if (e.key === "Enter") commitTitleEdit();
									else if (e.key === "Escape") setTitleEdit(null);
								}
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `${TaskPanel_module_css_default.cardTitle}${isBound ? ` ${TaskPanel_module_css_default.cardTitleEditable}` : ""}`,
								title: isBound ? t("task.title-edit") : void 0,
								onDoubleClick: (e) => {
									e.preventDefault();
									e.stopPropagation();
									if (isBound) setTitleEdit({ value: String(task.title ?? "") });
								},
								children: task.title
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TaskPanel_module_css_default.cardMeta,
							children: [
								steps.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: TaskPanel_module_css_default.progressText,
									children: [
										done,
										"/",
										steps.length
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TaskPanel_module_css_default.updated,
									children: timeAgo(task.updatedAt || task.lastActiveAt)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TaskPanel_module_css_default.chevron,
									children: expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
								})
							]
						})]
					}),
					steps.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TaskPanel_module_css_default.track,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: TaskPanel_module_css_default.trackFill,
							style: { width: `${pct}%` }
						})
					}),
					expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TaskPanel_module_css_default.cardBody,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: TaskPanel_module_css_default.section,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TaskPanel_module_css_default.sectionLabel,
									children: [t("task.steps"), steps.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TaskPanel_module_css_default.sectionCount,
										children: steps.length
									})]
								}), steps.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
									className: TaskPanel_module_css_default.stepsList,
									children: steps.map((step, i) => {
										const stepIsEditing = stepEdit !== null && stepEdit.index === i;
										const stepIsDragging = dragState?.dragging && dragState.fromIndex === i;
										const isDropTarget = dropTargetIndex === i;
										const isDropTargetAfter = dropTargetIndex === i + 1;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
											"data-step-row": true,
											className: `${TaskPanel_module_css_default.stepRow}${stepIsDragging ? ` ${TaskPanel_module_css_default.stepDragging}` : ""}${isDropTarget ? ` ${TaskPanel_module_css_default.dropTargetBefore}` : ""}${isDropTargetAfter ? ` ${TaskPanel_module_css_default.dropTargetAfter}` : ""}`,
											onMouseDown: (e) => {
												if (e.button !== 0) return;
												if (!isBound || syncing) return;
												if (e.target.closest("button, input, textarea, a")) return;
												startDrag(i, step.content, e);
											},
											children: [isBound ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: TaskPanel_module_css_default.stepToggle,
												disabled: syncing,
												onClick: (e) => {
													e.stopPropagation();
													onCycleStatus(i);
												},
												title: `${t("step.completed")}/${t("step.in-progress")}/${t("step.pending")}`,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepIcon, { status: step.status })
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepIcon, { status: step.status }), stepIsEditing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: TaskPanel_module_css_default.stepInput,
												value: stepEdit.value,
												autoFocus: true,
												onChange: (e) => setStepEdit({
													index: i,
													value: e.target.value
												}),
												onBlur: () => commitStepEdit(i),
												onKeyDown: (e) => {
													if (e.key === "Enter") commitStepEdit(i);
													else if (e.key === "Escape") setStepEdit(null);
												}
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `${TaskPanel_module_css_default.stepContent}${step.status === "completed" ? ` ${TaskPanel_module_css_default.stepContentDone}` : ""}${step.status === "in_progress" ? ` ${TaskPanel_module_css_default.stepContentRun}` : ""}${isBound ? ` ${TaskPanel_module_css_default.stepEditable}` : ""}`,
												title: isBound && showHints ? t("step.edit-hint") : void 0,
												onDoubleClick: (e) => {
													e.stopPropagation();
													if (isBound) setStepEdit({
														index: i,
														value: String(step.content ?? "")
													});
												},
												children: step.content
											})]
										}, i);
									})
								}), dragState && dragState.dragging && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: TaskPanel_module_css_default.dragGhost,
									style: {
										left: dragState.clientX + 12,
										top: dragState.clientY - 20
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: TaskPanel_module_css_default.dragGhostCard,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TaskPanel_module_css_default.dragGhostContent,
											children: dragState.stepContent
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: TaskPanel_module_css_default.dragGhostClose,
											style: { pointerEvents: "auto" },
											onClick: (e) => {
												e.stopPropagation();
												cancelDrag();
											},
											title: showHints ? t("drag.cancel") : void 0,
											"aria-label": t("drag.cancel"),
											children: "×"
										})]
									})
								})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: TaskPanel_module_css_default.muted,
									children: t("panel.empty-desc")
								})]
							}),
							(task.files?.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: TaskPanel_module_css_default.section,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TaskPanel_module_css_default.sectionLabel,
									children: [t("task.files"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TaskPanel_module_css_default.sectionCount,
										children: task.files.length
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
									className: TaskPanel_module_css_default.filesList,
									children: [task.files.slice(0, 12).map((file, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										className: TaskPanel_module_css_default.fileRow,
										onClick: () => navigator.clipboard?.writeText(file.path),
										title: `${t("file.copy")}: ${file.path}${file.line ? `:${file.line}` : ""}`,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: TaskPanel_module_css_default.fileDot }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: TaskPanel_module_css_default.filePath,
												children: file.path
											}),
											file.line && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: TaskPanel_module_css_default.fileLine,
												children: [":", file.line]
											})
										]
									}) }, i)), (task.files?.length ?? 0) > 12 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
										className: TaskPanel_module_css_default.muted,
										children: [
											"… 共 ",
											task.files.length,
											" 个"
										]
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: TaskPanel_module_css_default.cardFooter,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: isBound || syncing,
										onClick: onSwitch,
										children: t("task.switch")
									}),
									isBound && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: syncing,
										onClick: onUnbind,
										title: t("task.unbind"),
										children: t("task.unbind")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: syncing,
										onClick: onArchive,
										children: t("task.archive")
									})
								]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/TaskPanel.tsx
		/**
		* Task Panel — dsh web `shell.overlay` 浮动任务面板。
		* Container 组件：负责数据获取、命令桥接、状态协调
		* Presentational 组件在 TaskComponents.tsx
		*/
		const STATUS_CYCLE = [
			"pending",
			"in_progress",
			"completed"
		];
		function getT() {
			return createTranslate(typeof navigator !== "undefined" && navigator.language.startsWith("zh") ? zh : en);
		}
		function useSessionId(ctx) {
			const [, force] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				const list = ctx?.sessions?.list;
				if (!list || typeof list.subscribe !== "function") return;
				return list.subscribe(() => force((n) => n + 1));
			}, [ctx]);
			const snap = ctx?.sessions?.list?.getSnapshot?.();
			if (!snap) return null;
			if (snap.current) return snap.current;
			return (Array.isArray(snap.items) ? snap.items.find((s) => !s.blank) ?? snap.items[0] : void 0)?.sessionId ?? null;
		}
		var PanelErrorBoundary = class extends react.Component {
			state = { failed: false };
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.warn("[dsh-project-memory] task panel render crashed:", error);
			}
			render() {
				if (!this.state.failed) return this.props.children;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					className: TaskPanel_module_css_default.boundaryFallback,
					onClick: () => this.setState({ failed: false }),
					title: "重新渲染任务面板",
					children: "任务面板（点击重试）"
				});
			}
		};
		function TaskPanelEntry({ ctx }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelErrorBoundary, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskPanelView, { ctx }) });
		}
		function TaskPanelView({ ctx }) {
			const t = getT();
			const data = useTaskData();
			const ui = useTaskUI();
			const sessionId = useSessionId(ctx);
			const [syncing, setSyncing] = (0, react.useState)(false);
			const [syncedAt, setSyncedAt] = (0, react.useState)(0);
			const [syncError, setSyncError] = (0, react.useState)(null);
			const [showHints, setShowHints] = (0, react.useState)(true);
			const dataActions = useTaskDataActions();
			const uiActions = useTaskUIActions();
			const activeTasks = data.tasks.filter((task) => !task.archived);
			const boundTask = data.boundTaskId ? data.tasks.find((task) => task.id === data.boundTaskId) ?? null : null;
			const applyPayload = (text) => {
				const parsed = parseTaskPayloadText(text);
				if (!parsed) return false;
				dataActions.setTasks({
					tasks: parsed.tasks,
					boundTaskId: parsed.boundId,
					archivedCount: parsed.archived
				});
				setSyncedAt(Date.now());
				setSyncError(null);
				return true;
			};
			const runLine = async (line) => {
				const commands = ctx?.remote?.commands;
				if (!sessionId || !commands || typeof commands.execute !== "function") {
					setSyncError("no session / commands service");
					return false;
				}
				let response;
				try {
					response = await commands.execute(sessionId, line, []);
				} catch (err) {
					setSyncError(String(err?.message ?? err));
					return false;
				}
				const envelope = response;
				const execution = envelope && typeof envelope === "object" && "value" in envelope ? envelope.value : envelope;
				const result = execution?.result ?? execution;
				if (result?.kind === "error") {
					setSyncError(result.text ?? "command error");
					return false;
				}
				return applyPayload(result?.text);
			};
			const refresh = async () => {
				if (syncing) return;
				setSyncing(true);
				try {
					const prevBoundId = data.boundTaskId;
					await runLine("/tasks");
					const newBoundId = useTaskData.getSnapshot().boundTaskId;
					if (newBoundId && newBoundId !== prevBoundId) await runLine(`/task switch ${newBoundId}`);
				} finally {
					setSyncing(false);
				}
			};
			const handleAction = async (verb, taskId) => {
				if (syncing) return;
				setSyncing(true);
				try {
					await runLine(`/task ${verb} ${taskId}`);
				} finally {
					setSyncing(false);
				}
			};
			const pushSteps = (taskId, steps) => {
				runLine(`/task todos ${JSON.stringify(steps.map((s) => ({
					content: s.content,
					status: s.status
				})))}`);
			};
			const cycleStatus = (taskId, index) => {
				const task = data.tasks.find((tt) => tt.id === taskId);
				if (!task) return;
				const next = (task.steps || []).map((s, i) => {
					if (i !== index) return s;
					const cur = STATUS_CYCLE.indexOf(s.status);
					return {
						...s,
						status: STATUS_CYCLE[(cur + 1) % STATUS_CYCLE.length]
					};
				});
				pushSteps(taskId, next);
			};
			const commitStepText = (taskId, index, value) => {
				const task = data.tasks.find((tt) => tt.id === taskId);
				const trimmed = value.trim();
				if (!task) return;
				if ((task.steps || [])[index]?.content === trimmed || !trimmed) return;
				const next = (task.steps || []).map((s, i) => i === index ? {
					...s,
					content: trimmed
				} : s);
				pushSteps(taskId, next);
			};
			const reorderSteps = (taskId, fromIndex, toIndex) => {
				if (fromIndex === toIndex) return;
				const task = data.tasks.find((tt) => tt.id === taskId);
				if (!task) return;
				const steps = [...task.steps || []];
				const [moved] = steps.splice(fromIndex, 1);
				const targetIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
				steps.splice(targetIndex, 0, moved);
				pushSteps(taskId, steps);
			};
			const commitTitle = (taskId, value) => {
				const task = data.tasks.find((tt) => tt.id === taskId);
				const trimmed = value.trim();
				if (!task) return;
				if (task.title === trimmed || !trimmed) return;
				runLine(`/task rename ${taskId} ${JSON.stringify(trimmed)}`);
			};
			const expand = () => {
				uiActions.open();
				if (Date.now() - Math.max(data.lastUpdate, syncedAt) > 3e4) refresh();
			};
			const THEMES = [
				"native",
				"glass",
				"brutal",
				"mono"
			];
			const style = THEMES.includes(ui.theme) ? ui.theme : "native";
			const styleLabel = t(`style.${style}`);
			const cycleTheme = () => {
				const i = THEMES.indexOf(style);
				uiActions.setTheme(THEMES[(i + 1) % THEMES.length]);
			};
			const panelRef = (0, react.useRef)(null);
			const drag = (0, react.useRef)(null);
			const handleDragStart = (e) => {
				if (e.target !== e.currentTarget) return;
				const rect = panelRef.current?.getBoundingClientRect();
				if (!rect) return;
				drag.current = {
					dx: e.clientX - rect.left,
					dy: e.clientY - rect.top
				};
				const onMove = (ev) => {
					if (!drag.current) return;
					const width = panelRef.current?.offsetWidth ?? 380;
					panelRef.current?.offsetHeight;
					const x = Math.max(8, Math.min(window.innerWidth - width - 8, ev.clientX - drag.current.dx));
					const y = Math.max(8, Math.min(window.innerHeight - 64, ev.clientY - drag.current.dy));
					uiActions.setPanelPosition({
						x,
						y
					});
				};
				const onUp = () => {
					drag.current = null;
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
			};
			(0, react.useEffect)(() => {
				if (!sessionId) return;
				if (!ui.closed) refresh();
			}, [sessionId]);
			(0, react.useEffect)(() => {
				const ctxWithEvents = ctx;
				const handler = () => {
					uiActions.open();
					if (Date.now() - Math.max(data.lastUpdate, syncedAt) > 3e4) refresh();
				};
				ctxWithEvents?.events?.on?.("dsh:task-panel:show", handler);
				return () => {
					ctxWithEvents?.events?.off?.("dsh:task-panel:show", handler);
				};
			}, [
				ctx,
				uiActions,
				data.lastUpdate,
				syncedAt,
				refresh
			]);
			if (ui.closed) return null;
			if (ui.minimized) {
				const label = boundTask ? `${t("minibar.current")}: ${boundTask.title}` : activeTasks.length > 0 ? `${t("minibar.current")}: ${activeTasks.length} ${t("minibar.tasks")}` : t("minibar.no-task");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniBar, {
					label,
					hint: t("minibar.click-expand"),
					position: ui.panelPosition,
					theme: style,
					onMove: uiActions.setPanelPosition,
					open: expand
				});
			}
			const doneCount = activeTasks.filter((task) => {
				const steps = task.steps || [];
				return steps.length > 0 && steps.every((s) => s.status === "completed");
			}).length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TaskPanel_module_css_default.panel,
				ref: panelRef,
				style: {
					left: ui.panelPosition.x,
					top: ui.panelPosition.y
				},
				"data-theme": style === "native" ? void 0 : style,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TaskPanel_module_css_default.dragHandle,
						onMouseDown: handleDragStart,
						title: t("task.drag"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: TaskPanel_module_css_default.handleGrip })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: TaskPanel_module_css_default.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TaskPanel_module_css_default.headerLeft,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								type: "button",
								className: TaskPanel_module_css_default.headerIconBtn,
								onClick: cycleTheme,
								title: styleLabel,
								"aria-label": styleLabel,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, { className: TaskPanel_module_css_default.headerIcon })
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: TaskPanel_module_css_default.headerTitle,
								children: t("panel.title")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TaskPanel_module_css_default.headerRight,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TaskPanel_module_css_default.counts,
									children: activeTasks.length > 0 ? `${t("panel.active")} ${activeTasks.length} · ${doneCount}/${activeTasks.length}` : ""
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: () => setShowHints(!showHints),
									"aria-label": showHints ? t("panel.hints-off") : t("panel.hints-on"),
									title: showHints ? t("panel.hints-off") : t("panel.hints-on"),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQuestionOutline14, { size: 16 })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: () => uiActions.minimize(),
									"aria-label": t("panel.minimize"),
									title: t("panel.minimize"),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: () => uiActions.close(),
									"aria-label": t("panel.close"),
									title: t("panel.close"),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {})
								})
							]
						})]
					}),
					!sessionId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: TaskPanel_module_css_default.notice,
						children: t("panel.no-session")
					}),
					syncError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TaskPanel_module_css_default.notice,
						children: [
							t("panel.sync-failed"),
							": ",
							syncError
						]
					}),
					activeTasks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TaskPanel_module_css_default.emptyState,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: TaskPanel_module_css_default.emptyTitle,
								children: t("panel.empty")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: TaskPanel_module_css_default.emptyDesc,
								children: t("panel.empty-desc")
							}),
							syncing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: TaskPanel_module_css_default.syncHint,
								children: t("panel.syncing")
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TaskPanel_module_css_default.taskList,
						children: [activeTasks.map((task) => {
							task.steps;
							const expanded = ui.expandedTaskIds.includes(task.id);
							const isBound = data.boundTaskId === task.id;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
								task,
								isBound,
								expanded,
								onToggleExpand: () => uiActions.toggleTaskExpanded(task.id),
								onSwitch: () => handleAction("switch", task.id),
								onUnbind: () => runLine("/task unbind"),
								onArchive: () => handleAction("archive", task.id),
								onRename: (value) => commitTitle(task.id, value),
								onEditStep: (index, value) => commitStepText(task.id, index, value),
								onCycleStatus: (index) => cycleStatus(task.id, index),
								onReorderSteps: (from, to) => reorderSteps(task.id, from, to),
								showHints,
								syncing,
								t
							}, task.id);
						}), syncing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: TaskPanel_module_css_default.syncHint,
							children: t("panel.syncing")
						})]
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/home/sxt/project/dsh-project-memory/src/client/TaskCommandNode.module.css.mjs
		const css = ".TPe-xa_row{max-width:100%;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;align-items:center;gap:6px;padding:2px 0;font-size:12px;line-height:20px;display:inline-flex;overflow:hidden}.TPe-xa_row[data-variant=ok]{color:var(--dsw-alias-label-secondary)}.TPe-xa_row[data-variant=error]{color:var(--dsw-alias-state-warn-label,#b7791f)}.TPe-xa_row[data-variant=running]{color:var(--dsw-alias-label-dimmed)}.TPe-xa_icon{color:var(--dsw-alias-label-tertiary);flex:none}";
		const tagId = "@yolk_vat-y/dsh-project-memory/TaskCommandNode.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@yolk_vat-y/dsh-project-memory";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var TaskCommandNode_module_css_default = {
			"row": "TPe-xa_row",
			"icon": "TPe-xa_icon"
		};
		//#endregion
		//#region src/client/TaskCommandNode.tsx
		/**
		* /tasks、/task 命令在会话中的节点渲染器（conversation.chat.commandview，按命令名 key）。
		* 列表型命令（/tasks、无动词 /task）同步数据并打开面板。
		*/
		function TaskCommandNode({ node }) {
			const name = node?.name ?? "task";
			const outcome = node?.outcome ?? null;
			const verb = (typeof node?.args === "string" ? node.args : "").trim().split(/\s+/)[0] ?? "";
			const isList = name === "tasks" || !verb;
			const text = outcome?.text ?? "";
			const parsed = parseTaskPayloadText(text);
			const live = (0, react.useRef)(outcome === null);
			(0, react.useEffect)(() => {
				if (!parsed || !live.current) return;
				taskDataStore.actions.setTasks({
					tasks: parsed.tasks,
					boundTaskId: parsed.boundId,
					archivedCount: parsed.archived
				});
				if (isList) taskUIStore.actions.open();
			}, [text]);
			if (outcome === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TaskCommandNode_module_css_default.row,
				"data-variant": "running",
				children: [
					"/",
					name,
					" 执行中…"
				]
			});
			if (outcome.kind === "error") {
				const brief = String(text ?? "").split("\n")[0].slice(0, 120);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TaskCommandNode_module_css_default.row,
					"data-variant": "error",
					children: [
						"/",
						name,
						" 失败",
						brief ? `：${brief}` : ""
					]
				});
			}
			if (!isList) {
				const note = String(text ?? "").split(/\n{2,}/)[0].replace(/```.*$/s, "").trim().slice(0, 200);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TaskCommandNode_module_css_default.row,
					"data-variant": "ok",
					children: [
						"/",
						name,
						" ",
						note || "已完成"
					]
				});
			}
			const count = parsed ? parsed.tasks.length : 0;
			const archived = parsed ? parsed.archived : 0;
			const label = parsed ? `任务 ${count} 套${archived ? `（归档 ${archived}）` : ""} · 已同步到任务面板` : `/${name} 已执行`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TaskCommandNode_module_css_default.row,
				"data-variant": "ok",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutline16, { className: TaskCommandNode_module_css_default.icon }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
			});
		}
		//#endregion
		//#region src/client/client.ts
		/**
		* dsh-project-memory Client Entry
		*
		* dsh web (rc.1) 的 client 插件契约为 cordis client plugin：
		*   export const inject = [<client 服务名>...]
		*   export function apply(ctx) { ... }
		* 面板注册进 `shell.overlay`（Frame 级浮动层，additive 列表槽）：
		* 该槽由 ui-layout 的 AppFrame 声明渲染（scope root，独立于滚动容器），
		* 默认 click-through，条目自身需开启 pointer-events。
		*
		* 只依赖宿主 seed 提供的模块（react / dsh-client-ui-primitives），
		* 数据经 remote.commands.execute 执行 /tasks 命令获取 JSON 快照。
		*/
		const NS = "dsh-project-memory";
		const name = NS;
		/** Required client services: slots registry, session scopes, commands remote (data 通道). */
		const inject = [
			"slots",
			"sessions",
			"remote",
			"remote.commands"
		];
		function apply(ctx) {
			const slots = ctx?.slots;
			if (!slots || typeof slots.inject !== "function") {
				console.warn(`[${NS}] host has no slots service — task panel disabled`);
				return;
			}
			try {
				slots.inject("shell.overlay", () => slots.register({
					name: "shell.overlay",
					id: "dsh-project-memory-task-panel",
					order: 100
				}, () => (0, react.createElement)(TaskPanelEntry, { ctx })));
				for (const key of ["tasks", "task"]) slots.inject("conversation.chat.commandview", () => slots.register({
					name: "conversation.chat.commandview",
					key
				}, TaskCommandNode));
			} catch (err) {
				console.warn(`[${NS}] task panel registration failed:`, err);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map