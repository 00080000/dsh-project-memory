/**
 * Locale dictionaries for Task Panel
 */
export const zh = {
  'panel.title': '工作流任务',
  'panel.active': '进行中',
  'panel.total': '总计',
  'panel.minimize': '收起为顶部迷你条',
  'panel.close': '关闭面板（隐藏，/task 可唤起）',
    'panel.refresh': '同步最新任务',
  'panel.style': '切换面板风格',
  'style.native': '原生',
  'style.glass': '玻璃',
  'style.brutal': '粗野',
  'style.mono': '终端',
  'panel.syncing': '同步中…',
  'panel.sync-failed': '同步失败',
  'panel.empty': '暂无任务',
  'panel.empty-desc': '让模型开始工作并维护 todo 清单后会自动建档',
    'panel.no-session': '还没有会话',
  'task.progress': '进度',
  'task.steps': '步骤',
  'task.files': '文件',
    'task.current': '当前',
  'task.title-edit': '双击修改标题',
  'task.switch': '切换到此任务',
  'task.unbind': '取消当前任务',
  'task.archive': '归档',
    'task.drag': '拖拽移动',
  'step.completed': '已完成',
  'step.in-progress': '进行中',
  'step.pending': '待办',
  'step.edit-hint': '双击编辑步骤文案；点击图标循环 待办/进行中/已完成',
    'file.copy': '复制路径',
  'file.copied': '已复制路径',
  'minibar.current': '当前任务',
  'minibar.click-expand': '点击展开并同步',
  'minibar.tasks': '个任务',
  'minibar.no-task': '暂无任务 · 点击查看',
}

export const en = {
  'panel.title': 'Task Flow',
  'panel.active': 'Active',
  'panel.total': 'Total',
  'panel.minimize': 'Collapse to mini bar',
  'panel.close': 'Close panel (hidden; /task reopens)',
    'panel.refresh': 'Sync latest tasks',
  'panel.style': 'Panel style',
  'style.native': 'Native',
  'style.glass': 'Glass',
  'style.brutal': 'Brutal',
  'style.mono': 'Mono',
  'panel.syncing': 'Syncing…',
  'panel.sync-failed': 'Sync failed',
  'panel.empty': 'No Tasks',
  'panel.empty-desc': 'Tasks are created automatically when the model maintains a todo list',
    'panel.no-session': 'No session yet',
  'task.progress': 'Progress',
  'task.steps': 'Steps',
  'task.files': 'Files',
    'task.current': 'Current',
  'task.title-edit': 'Double-click to rename',
  'task.switch': 'Switch to this task',
  'task.unbind': 'Unbind current task',
  'task.archive': 'Archive',
    'task.drag': 'Drag to move',
  'step.completed': 'Completed',
  'step.in-progress': 'In Progress',
  'step.pending': 'Pending',
  'step.edit-hint': 'Double-click to edit; click the icon to cycle status',
    'file.copy': 'Copy path',
  'file.copied': 'Path copied',
  'minibar.current': 'Current task',
  'minibar.click-expand': 'Click to expand & sync',
  'minibar.tasks': 'tasks',
  'minibar.no-task': 'No tasks · click to view',
}

export type LocaleDict = typeof zh

export function createTranslate(dict: LocaleDict) {
  return (key: keyof LocaleDict, params?: Record<string, string | number>) => {
    let text = dict[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
    }
    return text
  }
}
