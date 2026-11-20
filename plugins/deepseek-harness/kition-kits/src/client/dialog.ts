/**
 * A question to the person in DeepSeek Harness's own page: a small modal with a few choices.
 * The browser's `confirm` would do, but it stops the page until answered, and in DeepSeek Harness
 * Desktop it is a native window that nothing on the page can reach.
 */
export type Choice = { id: string; label: string; primary?: boolean; danger?: boolean }

const STYLE_ID = 'kition-kits-dialog-style'
const STYLE = `
.kition-dialog-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgb(0 0 0 / 0.35); }
.kition-dialog { max-width: min(440px, 100%); padding: 18px 20px; border-radius: 12px; background: Canvas; color: CanvasText; box-shadow: 0 10px 40px rgb(0 0 0 / 0.25); font: 14px/1.5 system-ui, sans-serif; }
.kition-dialog p { margin: 0 0 16px; }
.kition-dialog__actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.kition-dialog button { padding: 6px 14px; border-radius: 8px; border: 1px solid rgb(127 127 127 / 0.4); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.kition-dialog button[data-primary] { background: #5645d4; border-color: #5645d4; color: #fff; }
.kition-dialog button[data-danger] { color: #c0392b; border-color: rgb(192 57 43 / 0.5); }
`

/** Asks `message`; answers the chosen choice's id, or the last one's (the safe one) on Escape. */
export function ask(message: string, choices: Choice[]): Promise<string> {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE
    document.head.append(style)
  }
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null
    const backdrop = document.createElement('div')
    backdrop.className = 'kition-dialog-backdrop'
    const box = document.createElement('div')
    box.className = 'kition-dialog'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('data-kition-dialog', '')
    const text = document.createElement('p')
    text.textContent = message
    const actions = document.createElement('div')
    actions.className = 'kition-dialog__actions'
    const fallback = choices[choices.length - 1]?.id ?? ''
    const finish = (id: string) => {
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      previous?.focus?.({ preventScroll: true })
      resolve(id)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(fallback)
    }
    for (const choice of choices) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = choice.label
      button.dataset.kitionDialogChoice = choice.id
      if (choice.primary) button.dataset.primary = ''
      if (choice.danger) button.dataset.danger = ''
      button.addEventListener('click', () => finish(choice.id))
      actions.append(button)
    }
    box.append(text, actions)
    backdrop.append(box)
    document.body.append(backdrop)
    document.addEventListener('keydown', onKey, true)
    actions.querySelector<HTMLButtonElement>('button[data-primary]')?.focus() ?? actions.querySelector<HTMLButtonElement>('button')?.focus()
  })
}
