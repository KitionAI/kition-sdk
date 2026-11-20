/** The browser module's words, in English and Chinese, as DeepSeek Harness's locale service takes them. */
export const NAMESPACE = 'kitionKits'

export const en = {
  openWith: 'Kition {kit}',
  starting: 'Starting Kition…',
  startingDetail: 'Kition is starting for this folder.',
  missingTitle: 'Kition is not installed',
  missingDetail: 'Install Kition, then restart DeepSeek Harness:',
  missingOr: 'or',
  unreachableTitle: 'Kition does not answer',
  unreachableDetail: 'Kition could not open this file.',
  retry: 'Try again',
  outsideTitle: 'This file is outside the session’s folder',
  outsideDetail: 'Kition opens files inside the folder this session works in.',
  noSession: 'Open a session to edit this file with Kition.',
  closeDirty: '{name} has unsaved changes in Kition. Close it and lose them?',
  draft: 'Draft',
  draftTitle: 'An agent drafted changes to this file',
}

export const zh: typeof en = {
  openWith: 'Kition {kit}',
  starting: '正在启动 Kition…',
  startingDetail: 'Kition 正在为这个文件夹启动。',
  missingTitle: '没有安装 Kition',
  missingDetail: '安装 Kition，然后重启 DeepSeek Harness：',
  missingOr: '或',
  unreachableTitle: 'Kition 没有响应',
  unreachableDetail: 'Kition 无法打开这个文件。',
  retry: '重试',
  outsideTitle: '这个文件不在会话的文件夹里',
  outsideDetail: 'Kition 只打开这个会话所在文件夹里的文件。',
  noSession: '打开一个会话，才能用 Kition 编辑这个文件。',
  closeDirty: '{name} 在 Kition 里有未保存的修改。关闭并丢弃这些修改吗？',
  draft: '草稿',
  draftTitle: 'Agent 起草了对这个文件的修改',
}

export type Key = keyof typeof en

/** `text` with `{name}` placeholders filled from `params`. */
export const fill = (text: string, params: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
