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
		//#region src/client/task-store.ts
		/**
		* Task Panel Client Store（自包含：不依赖宿主 store 包）
		* Reactive store for task list, bound task, UI state.
		* 数据由 /tasks、/task 命令执行结果（JSON 载荷）写入，localStorage 持久化 UI 状态。
		*/
		/** 从命令输出文本中解析任务快照 JSON（支持 fenced ```json 块或尾部对象）。 */
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
		const STORAGE_KEY = "dsh-pm-task-panel-state";
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
		function getDefaultState() {
			if (typeof window !== "undefined") try {
				const saved = localStorage.getItem(STORAGE_KEY);
				if (saved) {
					const parsed = JSON.parse(saved);
					return {
						tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
						boundTaskId: parsed.boundTaskId ?? null,
						archivedCount: parsed.archivedCount ?? 0,
						expandedTaskIds: Array.isArray(parsed.expandedTaskIds) ? parsed.expandedTaskIds : [],
						panelPosition: parsed.panelPosition ?? defaultPosition(),
						minimized: parsed.minimized !== false,
						theme: typeof parsed.theme === "string" ? parsed.theme : "native",
						closed: !!parsed.closed,
						lastUpdate: parsed.lastUpdate ?? 0
					};
				}
			} catch {}
			return {
				tasks: [],
				boundTaskId: null,
				archivedCount: 0,
				expandedTaskIds: [],
				panelPosition: defaultPosition(),
				minimized: true,
				closed: false,
				theme: "native",
				lastUpdate: 0
			};
		}
		function persist(state) {
			if (typeof window === "undefined") return;
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			} catch {}
		}
		let state = getDefaultState();
		const listeners = /* @__PURE__ */ new Set();
		function setState(next) {
			state = next;
			persist(next);
			for (const listener of listeners) listener();
		}
		const taskStore = {
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			getSnapshot() {
				return state;
			},
			actions: {
				setTasks(payload) {
					setState({
						...state,
						tasks: payload.tasks || [],
						boundTaskId: payload.boundTaskId ?? null,
						archivedCount: payload.archivedCount ?? 0,
						lastUpdate: Date.now()
					});
				},
				toggleTaskExpanded(taskId) {
					const prev = state;
					const ids = prev.expandedTaskIds.includes(taskId) ? prev.expandedTaskIds.filter((id) => id !== taskId) : [...prev.expandedTaskIds, taskId];
					setState({
						...prev,
						expandedTaskIds: ids
					});
				},
				expandAll() {
					const prev = state;
					setState({
						...prev,
						expandedTaskIds: prev.tasks.map((t) => t.id)
					});
				},
				setPanelPosition(pos) {
					setState({
						...state,
						panelPosition: pos
					});
				},
				/** 展开面板（同时解除隐藏/折叠）。 */
				open() {
					setState({
						...state,
						minimized: false,
						closed: false
					});
				},
				/** 折叠成顶部迷你条（仍可见）。 */
				minimize() {
					setState({
						...state,
						minimized: true,
						closed: false
					});
				},
				/** 彻底隐藏（无迷你条）；仅能通过 /task、/tasks 或重新加载唤起。 */
				close() {
					setState({
						...state,
						minimized: true,
						closed: true
					});
				},
				setTheme(theme) {
					setState({
						...state,
						theme
					});
				},
				setMinimized(minimized) {
					setState({
						...state,
						minimized,
						closed: minimized ? state.closed : false
					});
				},
				reset() {
					setState(getDefaultState());
				}
			}
		};
		function useTaskStore() {
			return (0, react.useSyncExternalStore)(taskStore.subscribe, taskStore.getSnapshot, taskStore.getSnapshot);
		}
		//#endregion
		//#region \0dsh-css:/home/sxt/project/dsh-project-memory/src/client/TaskPanel.module.css.mjs
		const css$1 = ".vZSZnG_panel,.vZSZnG_pill{pointer-events:auto;font-family:inherit}.vZSZnG_panel{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));border:1px solid var(--dsw-alias-border-l2,#7f7f7f4d);border-radius:14px;flex-direction:column;width:380px;max-width:calc(100vw - 24px);max-height:min(70vh,640px);animation:.18s ease-out vZSZnG_panelIn;display:flex;position:fixed;overflow:hidden;box-shadow:0 12px 32px #00000029,0 2px 8px #00000014}@keyframes vZSZnG_panelIn{0%{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}.vZSZnG_dragHandle{cursor:grab;z-index:1;justify-content:center;align-items:center;height:12px;display:flex;position:absolute;top:0;left:0;right:0}.vZSZnG_dragHandle:active{cursor:grabbing}.vZSZnG_handleGrip{background:var(--dsw-alias-separator-primary,#7f7f7f59);opacity:.8;border-radius:2px;width:32px;height:3px}.vZSZnG_header{border-bottom:1px solid var(--dsw-alias-border-l1,#7f7f7f2e);-webkit-user-select:none;user-select:none;justify-content:space-between;align-items:center;gap:8px;padding:10px 10px 8px 14px;display:flex}.vZSZnG_headerLeft{align-items:center;gap:6px;min-width:0;display:flex}.vZSZnG_headerIcon{color:var(--dsw-alias-label-secondary);flex:none}.vZSZnG_headerTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;margin:0;font-size:13px;font-weight:600;line-height:20px}.vZSZnG_headerRight{align-items:center;gap:2px;margin-left:auto;display:flex}.vZSZnG_counts{color:var(--dsw-alias-label-tertiary);white-space:nowrap;margin-right:4px;font-size:11px;line-height:16px}.vZSZnG_boundBadge{color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#3a6ef5);white-space:nowrap;border-radius:7px;flex:none;padding:0 6px;font-size:10px;line-height:14px}.vZSZnG_softBadge{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1f);white-space:nowrap;border-radius:7px;flex:none;padding:0 6px;font-size:10px;line-height:14px}.vZSZnG_notice{color:var(--dsw-alias-state-warn-label,#b7791f);background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1a);word-break:break-all;border-radius:8px;margin:8px 12px 0;padding:6px 10px;font-size:12px;line-height:18px}.vZSZnG_taskList{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,transparent) transparent;flex-direction:column;gap:6px;padding:8px;display:flex;overflow-y:auto}.vZSZnG_emptyState{text-align:center;color:var(--dsw-alias-label-secondary);padding:36px 24px 30px}.vZSZnG_emptyTitle{color:var(--dsw-alias-label-primary);margin:0 0 6px;font-size:13px;font-weight:600}.vZSZnG_emptyDesc{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:20px}.vZSZnG_syncHint{color:var(--dsw-alias-label-dimmed);justify-content:center;align-items:center;gap:6px;margin:10px 0 0;font-size:11px;display:flex}.vZSZnG_card{border:1px solid var(--dsw-alias-border-l1,#7f7f7f29);background:var(--dsw-alias-bg-base,transparent);border-radius:10px;transition:border-color .15s;overflow:hidden}.vZSZnG_cardBound{border-color:var(--dsw-alias-border-l3,#7f7f7f59);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,transparent)}.vZSZnG_cardHead{cursor:pointer;text-align:left;background:0 0;border:none;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:8px 10px 7px;display:flex}.vZSZnG_cardHead:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.vZSZnG_cardTitleRow{align-items:center;gap:6px;min-width:0;display:flex}.vZSZnG_cardTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.vZSZnG_cardMeta{color:var(--dsw-alias-label-tertiary);flex:none;align-items:center;gap:8px;display:flex}.vZSZnG_progressText{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}.vZSZnG_updated{color:var(--dsw-alias-label-dimmed);font-size:10px;line-height:14px}.vZSZnG_chevron{color:var(--dsw-alias-label-tertiary);display:inline-flex}.vZSZnG_track{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1f);border-radius:1px;height:2px;margin:0 10px 6px;overflow:hidden}.vZSZnG_trackFill{background:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-button-primary-fill,#3a6ef5));border-radius:1px;height:100%;transition:width .2s}.vZSZnG_cardBody{border-top:1px solid var(--dsw-alias-border-l1,#7f7f7f24);padding:8px 10px 10px}.vZSZnG_section{margin-bottom:8px}.vZSZnG_section:last-child{margin-bottom:0}.vZSZnG_sectionLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;margin-bottom:4px;font-size:11px;line-height:16px;display:flex}.vZSZnG_sectionCount{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1a);color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:0 5px;font-size:10px;line-height:14px}.vZSZnG_stepsList{flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;display:flex}.vZSZnG_stepRow{align-items:flex-start;gap:7px;padding:3px 2px;display:flex}.vZSZnG_stepRow>svg{flex:none;margin-top:2px}.vZSZnG_stepDone{color:var(--dsw-alias-label-dimmed)}.vZSZnG_stepRun{color:var(--dsw-alias-label-primary-bluish,#3a6ef5)}.vZSZnG_stepPending{background:var(--dsw-alias-border-l3,#7f7f7f80);border-radius:50%;flex:none;width:8px;height:8px;margin:5px 3px}.vZSZnG_stepContent{color:var(--dsw-alias-label-secondary);word-break:break-word;font-size:12px;line-height:20px}.vZSZnG_stepContentDone{color:var(--dsw-alias-label-dimmed);text-decoration:line-through}.vZSZnG_stepContentRun{color:var(--dsw-alias-label-primary)}.vZSZnG_muted{color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:18px}.vZSZnG_filesList{flex-direction:column;margin:0;padding:0;list-style:none;display:flex}.vZSZnG_fileRow{cursor:pointer;text-align:left;background:0 0;border:none;border-radius:6px;align-items:center;gap:6px;width:100%;padding:3px 4px;display:flex}.vZSZnG_fileRow:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.vZSZnG_fileDot{background:var(--dsw-alias-border-l3,#7f7f7f80);border-radius:50%;flex:none;width:5px;height:5px}.vZSZnG_filePath{color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;text-align:left;direction:rtl;font-family:ui-monospace,SF Mono,Menlo,Consolas,monospace;font-size:11px;line-height:18px;overflow:hidden}.vZSZnG_fileLine{color:var(--dsw-alias-label-dimmed);flex:none;font-size:10px;line-height:18px}.vZSZnG_cardFooter{gap:6px;margin-top:8px;display:flex}.vZSZnG_spinning svg{animation:.9s linear infinite vZSZnG_spin}@keyframes vZSZnG_spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.vZSZnG_panel{animation:none}.vZSZnG_trackFill,.vZSZnG_card,.vZSZnG_pill{transition:none}.vZSZnG_spinning svg{animation-duration:2.4s}}.vZSZnG_miniBar{border:1px solid var(--dsw-alias-border-l3,#7f7f7f4d);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));max-width:min(46vw,340px);height:34px;color:var(--dsw-alias-label-primary);cursor:grab;-webkit-user-select:none;user-select:none;pointer-events:auto;border-radius:999px;align-items:center;gap:7px;padding:0 12px;font-size:12px;line-height:18px;transition:background .15s,border-color .15s;display:inline-flex;position:fixed;box-shadow:0 6px 20px #00000024,0 1px 4px #00000014}.vZSZnG_miniBar:active{cursor:grabbing}.vZSZnG_miniBar:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.vZSZnG_miniIcon{color:var(--dsw-alias-label-secondary);flex:none}.vZSZnG_miniText{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.vZSZnG_miniChevron{color:var(--dsw-alias-label-tertiary);flex:none}.vZSZnG_taskList{flex:auto;min-height:0}.vZSZnG_cardBody{overscroll-behavior:contain;max-height:300px;overflow-y:auto}.vZSZnG_card{flex-direction:column;display:flex}.vZSZnG_boundaryFallback{border:1px solid var(--dsw-alias-border-l3,#7f7f7f4d);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary);cursor:pointer;pointer-events:auto;border-radius:999px;padding:4px 10px;font-size:12px;line-height:18px;position:fixed;top:64px;right:16px}.vZSZnG_stepToggle{cursor:pointer;background:0 0;border:none;border-radius:4px;flex:none;align-items:center;margin-top:2px;padding:0;display:inline-flex}.vZSZnG_stepToggle:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f1f)}.vZSZnG_stepToggle:disabled{cursor:default;opacity:.5}.vZSZnG_stepEditable{cursor:text;border-radius:3px}.vZSZnG_stepEditable:hover{outline:1px dashed var(--dsw-alias-border-l3,#7f7f7f66);outline-offset:1px}.vZSZnG_stepInput{min-width:0;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l3,#7f7f7f73);resize:none;box-sizing:border-box;white-space:pre-wrap;word-break:break-word;border-radius:5px;flex:auto;width:auto;min-width:0;padding:0 5px;font-size:12px;line-height:20px;display:block;overflow:hidden}.vZSZnG_cardTitleEditable{cursor:text;border-radius:3px}.vZSZnG_cardTitleEditable:hover{outline:1px dashed var(--dsw-alias-border-l3,#7f7f7f66);outline-offset:1px}.vZSZnG_panel[data-theme=glass],.vZSZnG_miniBar[data-theme=glass]{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#fff) 90%, transparent);-webkit-backdrop-filter:blur(18px)saturate(1.2);border:1px solid color-mix(in srgb, var(--dsw-alias-border-l2,#7f7f7f4d) 80%, transparent)}.vZSZnG_panel[data-theme=glass] .vZSZnG_card{background:color-mix(in srgb, var(--dsw-alias-bg-base,transparent) 84%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-border-l1,#7f7f7f29) 60%, transparent)}.vZSZnG_panel[data-theme=glass] .vZSZnG_cardBody{border-top-color:color-mix(in srgb, var(--dsw-alias-border-l1,#7f7f7f24) 60%, transparent)}@media (prefers-reduced-transparency:reduce){.vZSZnG_panel[data-theme=glass],.vZSZnG_miniBar[data-theme=glass]{background:var(--dsw-alias-bg-layer-2,#fff);-webkit-backdrop-filter:none;backdrop-filter:none}.vZSZnG_panel[data-theme=glass] .vZSZnG_card{background:var(--dsw-alias-bg-base,transparent)}}@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.vZSZnG_panel[data-theme=glass],.vZSZnG_miniBar[data-theme=glass]{background:var(--dsw-alias-bg-layer-2,#fff)}}.vZSZnG_panel[data-theme=brutal]{box-shadow:none;border-width:1px;border-radius:6px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_card{border:1px solid var(--dsw-alias-border-l3,#7f7f7f6b);background:var(--dsw-alias-bg-base,transparent);box-shadow:none;border-radius:3px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_cardHead{padding:7px 10px 6px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_cardTitle{letter-spacing:.01em;font-weight:650}.vZSZnG_panel[data-theme=brutal] .vZSZnG_headerTitle{letter-spacing:.03em}.vZSZnG_panel[data-theme=brutal] .vZSZnG_boundBadge{border-radius:2px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_track{border-radius:0;height:3px}.vZSZnG_panel[data-theme=brutal] .vZSZnG_trackFill{border-radius:0}.vZSZnG_panel[data-theme=brutal] .vZSZnG_cardBody{border-top:1px solid var(--dsw-alias-border-l2,#7f7f7f3d)}.vZSZnG_panel[data-theme=mono] .vZSZnG_headerTitle,.vZSZnG_panel[data-theme=mono] .vZSZnG_counts,.vZSZnG_panel[data-theme=mono] .vZSZnG_cardTitle,.vZSZnG_panel[data-theme=mono] .vZSZnG_progressText,.vZSZnG_panel[data-theme=mono] .vZSZnG_stepContent,.vZSZnG_panel[data-theme=mono] .vZSZnG_filePath{font-family:ui-monospace,SF Mono,Menlo,Consolas,Liberation Mono,monospace}.vZSZnG_panel[data-theme=mono] .vZSZnG_cardTitle{font-size:12px}.vZSZnG_panel[data-theme=mono] .vZSZnG_stepContent{font-size:11.5px}.vZSZnG_panel[data-theme=mono] .vZSZnG_card{border-radius:5px}.vZSZnG_panel[data-theme=mono] .vZSZnG_trackFill{border-radius:0}.vZSZnG_panel[data-theme=mono] .vZSZnG_stepPending{border-radius:1px}.vZSZnG_panel[data-theme=mono] .vZSZnG_updated{letter-spacing:.02em}.vZSZnG_headerIconBtn{color:inherit;cursor:pointer;background:0 0;border:none;border-radius:0;flex:none;justify-content:center;align-items:center;margin:0;padding:0;display:inline-flex}.vZSZnG_headerIcon{color:var(--dsw-alias-label-secondary);flex:none;display:block}.vZSZnG_headerLeft{min-width:0}.vZSZnG_headerTitle{text-overflow:ellipsis;flex:0 auto;min-width:0;overflow:hidden}.vZSZnG_headerRight{min-width:0}.vZSZnG_counts{text-overflow:ellipsis;flex:none;max-width:45%;margin-left:auto;overflow:hidden}";
		const tagId$1 = "@yolk_vat-y/dsh-project-memory/TaskPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@yolk_vat-y/dsh-project-memory";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var TaskPanel_module_css_default = {
			"stepEditable": "vZSZnG_stepEditable",
			"stepContent": "vZSZnG_stepContent",
			"cardBound": "vZSZnG_cardBound",
			"updated": "vZSZnG_updated",
			"headerRight": "vZSZnG_headerRight",
			"muted": "vZSZnG_muted",
			"fileLine": "vZSZnG_fileLine",
			"spinning": "vZSZnG_spinning",
			"headerTitle": "vZSZnG_headerTitle",
			"miniText": "vZSZnG_miniText",
			"boundBadge": "vZSZnG_boundBadge",
			"card": "vZSZnG_card",
			"spin": "vZSZnG_spin",
			"syncHint": "vZSZnG_syncHint",
			"emptyDesc": "vZSZnG_emptyDesc",
			"stepsList": "vZSZnG_stepsList",
			"stepRow": "vZSZnG_stepRow",
			"trackFill": "vZSZnG_trackFill",
			"stepContentDone": "vZSZnG_stepContentDone",
			"filesList": "vZSZnG_filesList",
			"miniBar": "vZSZnG_miniBar",
			"boundaryFallback": "vZSZnG_boundaryFallback",
			"handleGrip": "vZSZnG_handleGrip",
			"sectionCount": "vZSZnG_sectionCount",
			"miniIcon": "vZSZnG_miniIcon",
			"panelIn": "vZSZnG_panelIn",
			"stepInput": "vZSZnG_stepInput",
			"cardTitleRow": "vZSZnG_cardTitleRow",
			"filePath": "vZSZnG_filePath",
			"panel": "vZSZnG_panel",
			"dragHandle": "vZSZnG_dragHandle",
			"cardHead": "vZSZnG_cardHead",
			"pill": "vZSZnG_pill",
			"chevron": "vZSZnG_chevron",
			"header": "vZSZnG_header",
			"fileRow": "vZSZnG_fileRow",
			"emptyState": "vZSZnG_emptyState",
			"headerIconBtn": "vZSZnG_headerIconBtn",
			"headerIcon": "vZSZnG_headerIcon",
			"stepToggle": "vZSZnG_stepToggle",
			"taskList": "vZSZnG_taskList",
			"cardTitleEditable": "vZSZnG_cardTitleEditable",
			"notice": "vZSZnG_notice",
			"softBadge": "vZSZnG_softBadge",
			"stepDone": "vZSZnG_stepDone",
			"stepPending": "vZSZnG_stepPending",
			"track": "vZSZnG_track",
			"cardTitle": "vZSZnG_cardTitle",
			"cardMeta": "vZSZnG_cardMeta",
			"fileDot": "vZSZnG_fileDot",
			"counts": "vZSZnG_counts",
			"stepContentRun": "vZSZnG_stepContentRun",
			"emptyTitle": "vZSZnG_emptyTitle",
			"progressText": "vZSZnG_progressText",
			"cardBody": "vZSZnG_cardBody",
			"stepRun": "vZSZnG_stepRun",
			"cardFooter": "vZSZnG_cardFooter",
			"sectionLabel": "vZSZnG_sectionLabel",
			"miniChevron": "vZSZnG_miniChevron",
			"headerLeft": "vZSZnG_headerLeft",
			"section": "vZSZnG_section"
		};
		//#endregion
		//#region src/client/TaskPanel.tsx
		/**
		* Task Panel — dsh web `shell.overlay` 浮动任务面板。
		*
		* 升级原 `/tasks` 文本输出为可交互卡片：
		*  - 默认收成右侧浮标（不影响用户操作/不挡对话）；
		*  - 展开时通过宿主 `remote.commands.execute(sessionId, '/tasks')` 拉取最新快照
		*    （命令只读，走 /tasks 同一数据源 = tasks.json，因此与模型维护的 todo 双向一致）；
		*  - 卡片内「切换 / 归档」执行 `/task switch|archive <id>`，服务端返回新快照 JSON，
		*    面板即时刷新，无需再跑一次 /tasks；
		*  - 可拖拽（仅头部把手），位置持久化 localStorage。
		*
		* 依赖仅 react + @deepseek-ai/dsh-client-ui-primitives（宿主 seed 模块）。
		*/
		function getT() {
			return createTranslate(typeof navigator !== "undefined" && navigator.language.startsWith("zh") ? zh : en);
		}
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
		/** 行内编辑框：自动按内容增高（最多 160px），Enter 提交、Shift+Enter 换行、Esc 取消、失焦提交。 */
		function AutoEdit({ value, onCommit, onCancel, singleLine }) {
			const [text, setText] = (0, react.useState)(value);
			const ref = (0, react.useRef)(null);
			const settled = (0, react.useRef)(false);
			const once = (fn) => {
				if (settled.current) return;
				settled.current = true;
				fn();
			};
			const adjust = () => {
				const el = ref.current;
				if (!el) return;
				el.style.height = "auto";
				el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
			};
			(0, react.useEffect)(() => {
				adjust();
				const el = ref.current;
				el?.focus();
				el?.select();
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				ref,
				className: TaskPanel_module_css_default.stepInput,
				rows: 1,
				value: text,
				onChange: (e) => {
					setText(e.target.value);
					adjust();
				},
				onBlur: () => once(() => onCommit(text)),
				onKeyDown: (e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						once(() => onCancel());
					} else if (e.key === "Enter" && (singleLine || !e.shiftKey)) {
						e.preventDefault();
						once(() => onCommit(text));
					}
				}
			});
		}
		/** 折叠迷你条：可拖拽（按住拖动，轻点展开）。 */
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
		/**
		* 错误边界：任务面板渲染一旦抛错，不再让 shell.overlay 把整条条目退休
		* （宿主对崩溃条目会永久移除直到重载页面）。捕获后显示一个纯文本兜底，
		* 点击重新渲染。
		*/
		var PanelErrorBoundary = class extends react.Component {
			state = { failed: false };
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.warn("[dsh-project-memory] task panel render crashed (contained by boundary):", error);
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
			const state = useTaskStore();
			const sessionId = useSessionId(ctx);
			const [syncing, setSyncing] = (0, react.useState)(false);
			const [syncedAt, setSyncedAt] = (0, react.useState)(0);
			const [copiedPath, setCopiedPath] = (0, react.useState)(null);
			const [syncError, setSyncError] = (0, react.useState)(null);
			const panelRef = (0, react.useRef)(null);
			const drag = (0, react.useRef)(null);
			const copyTimer = (0, react.useRef)(void 0);
			const actions = taskStore.actions;
			const activeTasks = state.tasks.filter((task) => !task.archived);
			const boundTask = state.boundTaskId ? state.tasks.find((task) => task.id === state.boundTaskId) ?? null : null;
			const applyPayload = (text) => {
				const parsed = parseTaskPayloadText(text);
				if (!parsed) return false;
				actions.setTasks({
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
					await runLine("/tasks");
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
			const [editing, setEditing] = (0, react.useState)(null);
			const STATUS_CYCLE = [
				"pending",
				"in_progress",
				"completed"
			];
			const pushSteps = (taskId, steps) => {
				runLine(`/task todos ${JSON.stringify(steps.map((s) => ({
					content: s.content,
					status: s.status
				})))}`);
			};
			const cycleStatus = (taskId, index) => {
				const task = state.tasks.find((tt) => tt.id === taskId);
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
				const task = state.tasks.find((tt) => tt.id === taskId);
				const trimmed = value.trim();
				if (!task) {
					setEditing(null);
					return;
				}
				const same = (task.steps || [])[index]?.content === trimmed;
				setEditing(null);
				if (same || !trimmed) return;
				const next = (task.steps || []).map((s, i) => i === index ? {
					...s,
					content: trimmed
				} : s);
				pushSteps(taskId, next);
			};
			const [editingTitle, setEditingTitle] = (0, react.useState)(null);
			const commitTitle = (taskId, value) => {
				const task = state.tasks.find((tt) => tt.id === taskId);
				const trimmed = value.trim();
				if (!task) {
					setEditingTitle(null);
					return;
				}
				const same = task.title === trimmed;
				setEditingTitle(null);
				if (same || !trimmed) return;
				runLine(`/task rename ${taskId} ${JSON.stringify(trimmed)}`);
			};
			const expand = () => {
				actions.open();
				if (Date.now() - Math.max(state.lastUpdate, syncedAt) > 3e4) refresh();
			};
			const THEMES = [
				"native",
				"glass",
				"brutal",
				"mono"
			];
			const style = THEMES.includes(state.theme) ? state.theme : "native";
			const styleLabel = t(`style.${style}`);
			const cycleTheme = () => {
				const i = THEMES.indexOf(style);
				actions.setTheme(THEMES[(i + 1) % THEMES.length]);
			};
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
					actions.setPanelPosition({
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
			const copyPath = (path) => {
				if (copiedPath === path) return;
				navigator.clipboard?.writeText(path).catch(() => void 0);
				setCopiedPath(path);
				window.clearTimeout(copyTimer.current);
				copyTimer.current = window.setTimeout(() => setCopiedPath(null), 1200);
			};
			(0, react.useEffect)(() => () => window.clearTimeout(copyTimer.current), []);
			(0, react.useEffect)(() => {
				if (!sessionId) return;
				const snap = taskStore.getSnapshot();
				if (snap.lastUpdate === 0 && !snap.closed) {
					const timer = window.setTimeout(() => void refresh(), 300);
					return () => window.clearTimeout(timer);
				}
			}, [sessionId]);
			if (state.closed) return null;
			if (state.minimized) {
				const label = boundTask ? `${t("minibar.current")}: ${boundTask.title}` : activeTasks.length > 0 ? `${t("minibar.current")}: ${activeTasks.length} ${t("minibar.tasks")}` : t("minibar.no-task");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniBar, {
					label,
					hint: t("minibar.click-expand"),
					position: state.panelPosition,
					theme: style,
					onMove: (pos) => actions.setPanelPosition(pos),
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
					left: state.panelPosition.x,
					top: state.panelPosition.y
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
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
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
									className: syncing ? TaskPanel_module_css_default.spinning : void 0,
									onClick: () => void refresh(),
									disabled: syncing,
									"aria-label": t("panel.refresh"),
									title: t("panel.refresh"),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: () => actions.minimize(),
									"aria-label": t("panel.minimize"),
									title: t("panel.minimize"),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: () => actions.close(),
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
							const steps = task.steps || [];
							const done = steps.filter((s) => s.status === "completed").length;
							const expanded = state.expandedTaskIds.includes(task.id);
							const isBound = state.boundTaskId === task.id;
							const pct = steps.length > 0 ? Math.round(done / steps.length * 100) : 0;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: `${TaskPanel_module_css_default.card}${isBound ? ` ${TaskPanel_module_css_default.cardBound}` : ""}`,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										className: TaskPanel_module_css_default.cardHead,
										onClick: () => {
											if (editingTitle?.taskId === task.id) return;
											actions.toggleTaskExpanded(task.id);
										},
										"aria-expanded": expanded,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: TaskPanel_module_css_default.cardTitleRow,
											children: [isBound && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: TaskPanel_module_css_default.boundBadge,
												children: t("task.current")
											}), isBound && editingTitle?.taskId === task.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AutoEdit, {
												value: editingTitle.value,
												singleLine: true,
												onCommit: (v) => commitTitle(task.id, v),
												onCancel: () => setEditingTitle(null)
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `${TaskPanel_module_css_default.cardTitle}${isBound ? ` ${TaskPanel_module_css_default.cardTitleEditable}` : ""}`,
												title: isBound ? t("task.title-edit") : void 0,
												onDoubleClick: (e) => {
													e.preventDefault();
													e.stopPropagation();
													if (isBound) setEditingTitle({
														taskId: task.id,
														value: task.title
													});
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
												}), steps.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
													className: TaskPanel_module_css_default.stepsList,
													children: steps.map((step, i) => {
														const isEditing = isBound && editing?.taskId === task.id && editing.index === i;
														return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
															className: TaskPanel_module_css_default.stepRow,
															children: [isBound ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: TaskPanel_module_css_default.stepToggle,
																disabled: syncing,
																onClick: () => cycleStatus(task.id, i),
																title: `${t("step.completed")}/${t("step.in-progress")}/${t("step.pending")}（点击切换）`,
																children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepIcon, { status: step.status })
															}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepIcon, { status: step.status }), isEditing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AutoEdit, {
																value: editing.value,
																onCommit: (v) => commitStepText(task.id, i, v),
																onCancel: () => setEditing(null)
															}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: `${TaskPanel_module_css_default.stepContent}${step.status === "completed" ? ` ${TaskPanel_module_css_default.stepContentDone}` : ""}${step.status === "in_progress" ? ` ${TaskPanel_module_css_default.stepContentRun}` : ""}${isBound ? ` ${TaskPanel_module_css_default.stepEditable}` : ""}`,
																title: isBound ? t("step.edit-hint") : void 0,
																onDoubleClick: () => {
																	if (isBound) setEditing({
																		taskId: task.id,
																		index: i,
																		value: String(step.content ?? "")
																	});
																},
																children: step.content
															})]
														}, i);
													})
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
														onClick: () => copyPath(file.path),
														title: `${t(copiedPath === file.path ? "file.copied" : "file.copy")}: ${file.path}${file.line ? `:${file.line}` : ""}`,
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
														onClick: () => void handleAction("switch", task.id),
														children: t("task.switch")
													}),
													isBound && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
														variant: "outline",
														size: "sm",
														disabled: syncing,
														onClick: () => void runLine("/task unbind"),
														title: t("task.unbind"),
														children: t("task.unbind")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
														variant: "outline",
														size: "sm",
														disabled: syncing,
														onClick: () => void handleAction("archive", task.id),
														children: t("task.archive")
													})
												]
											})
										]
									})
								]
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
		*
		* 目标：不再让大段文本+JSON 出现在会话里——
		*  - 列表型（/tasks、无动词的 /task）：只渲染一行极简“已同步 N 套”状态；
		*    同时把节点文本里的 JSON 载荷解析进浮动面板（侧边卡片由它驱动），
		*    面板若被收起则自动展开（等价“输入 /task 就看到卡片”）。
		*  - 动作型（/task switch|archive）：渲染一行操作结果（切换/归档反馈）。
		*  - 错误/执行中：一行极简状态，不倾倒原文。
		*/
		/** node = CommandRowOwnerProps.node（CommandNode: name / args / outcome{kind,text}） */
		function TaskCommandNode({ node }) {
			const name = node?.name ?? "task";
			const outcome = node?.outcome ?? null;
			const verb = (typeof node?.args === "string" ? node.args : "").trim().split(/\s+/)[0] ?? "";
			const isList = name === "tasks" || !verb;
			const text = outcome?.text ?? "";
			const parsed = parseTaskPayloadText(text);
			(0, react.useEffect)(() => {
				if (!parsed) return;
				taskStore.actions.setTasks({
					tasks: parsed.tasks,
					boundTaskId: parsed.boundId,
					archivedCount: parsed.archived
				});
				if (isList) taskStore.actions.open();
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