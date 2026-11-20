/** The page's few pieces of interface, framework-free: a state panel, a banner, toasts, a dialog. */

/** An element `tag` with `attributes` (`class`, `data-*`, `aria-*`, ...) and `children`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | boolean | undefined> = {}, ...children: Array<Node | string | null | undefined | false>) {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue
    element.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children) if (child) element.append(child)
  return element
}

export type PanelAction = { label: string; run: () => void; primary?: boolean; testId?: string }

/**
 * A centred panel over the stage: a state the page is in (opening, downloading, missing, ...), its
 * title, words, an optional progress bar and actions, and the technical details folded away.
 */
export function panel(state: string, title: string, message: string, options: { progress?: number | null; actions?: PanelAction[]; detail?: string; busy?: boolean } = {}) {
  const body = h('div', { class: 'panel', role: options.busy ? 'status' : 'alert', 'data-state': state, 'data-testid': `state-${state}` })
  if (options.busy) body.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }))
  body.append(h('h1', { class: 'panel__title' }, title), h('p', { class: 'panel__message' }, message))
  if (options.progress !== undefined) {
    const value = options.progress === null ? undefined : String(Math.round(options.progress * 100))
    const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': value, 'aria-label': title, 'data-testid': 'download-progress' })
    bar.append(h('span', { class: 'progress__bar', style: `width: ${value ?? 0}%` }))
    if (value === undefined) bar.classList.add('progress--unknown')
    body.append(bar)
  }
  if (options.actions?.length) {
    const actions = h('div', { class: 'panel__actions' })
    for (const action of options.actions) {
      const button = h('button', { type: 'button', class: action.primary ? 'button button--primary' : 'button', 'data-testid': action.testId }, action.label)
      button.addEventListener('click', action.run)
      actions.append(button)
    }
    body.append(actions)
  }
  if (options.detail) {
    const details = h('details', { class: 'panel__details' }, h('summary', {}, 'Details'), h('pre', {}, options.detail))
    body.append(details)
  }
  return h('div', { class: 'overlay' }, body)
}

let toasts: HTMLElement | null = null

/** A short notice in the corner; errors stay until dismissed by time, a little longer. */
export function toast(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info', description?: string) {
  if (!toasts) {
    toasts = h('div', { class: 'toasts', 'aria-live': 'polite', role: 'status' })
    document.body.append(toasts)
  }
  const item = h('div', { class: `toast toast--${level}`, 'data-testid': `toast-${level}` }, h('strong', {}, message), description ? h('span', {}, description) : null)
  toasts.append(item)
  setTimeout(() => item.remove(), level === 'error' ? 9000 : 4500)
}

/**
 * A modal dialog with `content`, labelled by `title`: Escape and the close button close it; the
 * keyboard stays inside it; the focus returns where it was. Answers the dialog and its close.
 */
export function dialog(title: string, content: HTMLElement, onClose: () => void, closeLabel: string) {
  const previous = document.activeElement as HTMLElement | null
  const heading = h('h2', { class: 'dialog__title', id: 'dialog-title' }, title)
  const close = h('button', { type: 'button', class: 'button button--quiet dialog__close', 'aria-label': closeLabel, 'data-testid': 'dialog-close' }, '×')
  const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title', tabindex: '-1' }, h('div', { class: 'dialog__head' }, heading, close), content)
  const backdrop = h('div', { class: 'backdrop' }, box)
  const finish = () => {
    backdrop.remove()
    document.removeEventListener('keydown', onKey, true)
    previous?.focus?.()
    onClose()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      finish()
    } else if (event.key === 'Tab') {
      const focusable = [...box.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }
  close.addEventListener('click', finish)
  document.addEventListener('keydown', onKey, true)
  document.body.append(backdrop)
  box.focus()
  return { element: box, close: finish }
}
