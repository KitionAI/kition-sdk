/** The page's words, in English and Chinese; `{name}` is filled in. */
const EN = {
  opening: 'Opening {name}…',
  loadingEditor: 'Loading the {kit} editor…',
  downloadingTitle: 'Installing the {kit} editor',
  downloading: 'Downloading the editor package: {done} of {total}.',
  downloadingStarted: 'Starting the download…',
  missingTitle: '{name} is not in the workspace',
  missing: 'The file was moved, renamed or deleted. Nothing was changed.',
  noKitTitle: 'No kit opens {name}',
  noKit: 'Kition has no kit that edits .{extension} files.',
  notInstalledTitle: 'The {kit} editor is not installed',
  notInstalled: 'The kit index offers no editor package for this kit version. Install the kit with `kition kit install {short}`, or upgrade it.',
  downloadFailedTitle: 'The {kit} editor could not be installed',
  unreachableTitle: 'The gateway does not answer',
  unreachable: 'kition gateway stopped, or this page’s session ended. Start the gateway again and reopen the page.',
  failedTitle: '{name} could not be opened',
  failed: 'The editor could not open the file. It was not changed.',
  retry: 'Try again',
  details: 'Details',
  draftBanner: 'An agent drafted changes to this file.',
  draftBannerReady: 'An agent drafted changes to this file and asks for your review.',
  review: 'Review',
  reviewTitle: 'The agent’s draft of {name}',
  reviewHint: 'The file is unchanged until you merge the draft. Only you can merge or discard it.',
  noDraft: 'There is no draft of {name}.',
  comparing: 'Comparing the draft with the file…',
  compareFailed: 'The draft could not be compared',
  before: 'The file now',
  after: 'With the draft',
  noPreview: 'No preview',
  created: '{count} created',
  changed: '{count} changed',
  moved: '{count} moved',
  deleted: '{count} deleted',
  changeCreated: 'Created',
  changeChanged: 'Changed',
  changeMoved: 'Moved',
  changeDeleted: 'Deleted',
  texts: 'Text',
  truncated: 'The draft changes more than the review lists: {what}.',
  noChanges: 'The draft changes no objects.',
  noModel: 'This kit has no object model to compare: compare the pictures. ({reason})',
  stale: 'The file changed since the agent drafted. Merging replaces those changes with the draft.',
  merge: 'Merge',
  overwrite: 'Merge and overwrite',
  discard: 'Discard',
  close: 'Close',
  merged: 'The draft was merged into the file.',
  discarded: 'The draft was discarded.',
  mergeFailed: 'The draft could not be merged',
  discardFailed: 'The draft could not be discarded',
  saveFailed: 'The file could not be saved',
  reconnecting: 'Reconnecting to the gateway…',
  unsaved: 'unsaved',
  reviewSaveFirst: 'Save your edits first: merging replaces the file.',
} as const

export type Words = Record<keyof typeof EN, string>

const ZH: Words = {
  opening: '正在打开 {name}…',
  loadingEditor: '正在加载 {kit} 编辑器…',
  downloadingTitle: '正在安装 {kit} 编辑器',
  downloading: '正在下载编辑器包：{done} / {total}。',
  downloadingStarted: '正在开始下载…',
  missingTitle: '工作区里没有 {name}',
  missing: '文件已被移动、改名或删除。没有任何改动。',
  noKitTitle: '没有能打开 {name} 的 kit',
  noKit: 'Kition 没有编辑 .{extension} 文件的 kit。',
  notInstalledTitle: '{kit} 编辑器未安装',
  notInstalled: 'kit 索引里没有这个 kit 版本的编辑器包。用 `kition kit install {short}` 安装 kit，或升级它。',
  downloadFailedTitle: '{kit} 编辑器安装失败',
  unreachableTitle: '网关没有响应',
  unreachable: 'kition gateway 已停止，或本页的会话已结束。请重新启动网关并重新打开本页。',
  failedTitle: '无法打开 {name}',
  failed: '编辑器无法打开这个文件。文件没有改动。',
  retry: '重试',
  details: '详情',
  draftBanner: 'agent 为这个文件起草了修改。',
  draftBannerReady: 'agent 为这个文件起草了修改，请你审阅。',
  review: '审阅',
  reviewTitle: 'agent 对 {name} 的草稿',
  reviewHint: '合入之前文件不会改变。只有你能合入或丢弃草稿。',
  noDraft: '{name} 没有草稿。',
  comparing: '正在比较草稿和文件…',
  compareFailed: '无法比较草稿',
  before: '现在的文件',
  after: '合入草稿后',
  noPreview: '没有预览',
  created: '新建 {count} 个',
  changed: '修改 {count} 个',
  moved: '移动 {count} 个',
  deleted: '删除 {count} 个',
  changeCreated: '新建',
  changeChanged: '修改',
  changeMoved: '移动',
  changeDeleted: '删除',
  texts: '文字',
  truncated: '草稿的改动比这里列出的多：{what}。',
  noChanges: '草稿没有改动任何对象。',
  noModel: '这个 kit 没有可比较的对象模型：请比较两张图。（{reason}）',
  stale: '草稿起草之后文件又被改过。合入会用草稿替换那些改动。',
  merge: '合入',
  overwrite: '合入并覆盖',
  discard: '丢弃',
  close: '关闭',
  merged: '草稿已合入文件。',
  discarded: '草稿已丢弃。',
  mergeFailed: '无法合入草稿',
  discardFailed: '无法丢弃草稿',
  saveFailed: '无法保存文件',
  reconnecting: '正在重新连接网关…',
  unsaved: '未保存',
  reviewSaveFirst: '请先保存你的修改：合入会替换文件。',
}

export type Locale = 'en' | 'zh'

let current: Locale = 'en'

export function setLocale(locale: Locale) {
  current = locale
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
}

export const locale = () => current

/** The locale a kit is told (`ui/initialize` `locale`). */
export const kitLocale = () => (current === 'zh' ? 'zh-CN' : 'en')

/** `en` or `zh` from a `locale` parameter or the browser's language. */
export function localeFrom(value: string | null | undefined): Locale {
  return (value ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function t(key: keyof Words, values: Record<string, string | number> = {}) {
  const text: string = (current === 'zh' ? ZH : EN)[key]
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
}

/** Bytes as people read them: `8.6 MB`. */
export function bytes(count: number) {
  if (count < 1024) return `${count} B`
  const units = ['KB', 'MB', 'GB']
  let value = count / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
