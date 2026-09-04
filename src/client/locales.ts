/**
 * Locale dictionaries for Task Panel
 */
export const zh = {
  'panel.title': '工作流任务',
  'panel.active': '进行中',
  'panel.total': '总计',
  'panel.minimize': '最小化',
  'panel.close': '关闭',
  'panel.empty': '暂无任务',
  'panel.empty-desc': '让模型开始工作并维护 todo 清单后会自动建档',
  'task.progress': '进度',
  'task.steps': '步骤',
  'task.files': '文件',
  'task.current': '当前',
  'task.switch': '切换到此任务',
  'task.archive': '归档',
  'task.rename': '重命名',
  'step.completed': '已完成',
  'step.in-progress': '进行中',
  'step.pending': '待办',
  'file.open': '在编辑器打开',
  'minibar.current': '当前任务',
  'minibar.click-expand': '点击展开',
}

export const en = {
  'panel.title': 'Task Flow',
  'panel.active': 'Active',
  'panel.total': 'Total',
  'panel.minimize': 'Minimize',
  'panel.close': 'Close',
  'panel.empty': 'No Tasks',
  'panel.empty-desc': 'Tasks are created automatically when the model maintains a todo list',
  'task.progress': 'Progress',
  'task.steps': 'Steps',
  'task.files': 'Files',
  'task.current': 'Current',
  'task.switch': 'Switch to this task',
  'task.archive': 'Archive',
  'task.rename': 'Rename',
  'step.completed': 'Completed',
  'step.in-progress': 'In Progress',
  'step.pending': 'Pending',
  'file.open': 'Open in Editor',
  'minibar.current': 'Current Task',
  'minibar.click-expand': 'Click to expand',
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