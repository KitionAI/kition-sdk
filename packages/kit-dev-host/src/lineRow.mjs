// What Single line's row (kit-editor's EditorFrame in `line` mode) shows, read in the kit's page:
// the enabled buttons drawn inline (not a group's chevron, a collapsed group's one button, or a
// popover) and inside the row's box, the buttons cut off outside it, the inline fields, and which of `primary` (test ids) are drawn inline. It must stay
// self-contained: Playwright copies its source into the page (`frame.evaluate(lineRowReport, ids)`).

/** Answers `{ buttons, clipped, fields, found, missing }` for the row in this document: `clipped` names buttons drawn outside the row's box, which `buttons` does not count. */
export function lineRowReport(primary) {
  const visible = (element) => (typeof element.checkVisibility === 'function' ? element.checkVisibility() : true)
  const disabled = (button) => button.disabled || button.closest('fieldset[disabled]') != null
  const row = document.querySelector('.kui-line')
  const inline = row ? [...row.querySelectorAll('.kui-line-inline')].filter((part) => !part.hidden) : []
  const within = (selector) => inline.flatMap((part) => [...part.querySelectorAll(selector)]).filter(visible)
  const ids = new Set(within('[data-testid]').map((element) => element.getAttribute('data-testid')))
  // A button drawn outside the row's box (a grid's other rows) is cut off, whatever it reports.
  const box = row?.getBoundingClientRect()
  const outside = (element) => {
    const at = element.getBoundingClientRect()
    return box != null && box.height > 0 && at.height > 0 && (at.top < box.top - 1 || at.bottom > box.bottom + 1)
  }
  return {
    buttons: within('button').filter((button) => !disabled(button) && !outside(button)).length,
    clipped: within('button').filter(outside).map((button) => button.getAttribute('data-testid') ?? button.getAttribute('aria-label') ?? 'button'),
    fields: within('select, input').length,
    found: primary.filter((id) => ids.has(id)),
    missing: primary.filter((id) => !ids.has(id)),
  }
}

/**
 * The kit's controls the Focus bar (kit-editor's EditorFrame in `focus` mode) covers in this
 * document: visible buttons, fields, tabs, and sliders outside the bar whose box meets the bar's,
 * by test id, else name, else tag. Answers `['no Focus bar']` when the bar is missing.
 */
export function focusBarReport() {
  const bar = document.querySelector('.kui-focus-bar')
  if (!bar) return ['no Focus bar']
  const visible = (element) => (typeof element.checkVisibility === 'function' ? element.checkVisibility() : true)
  const area = bar.getBoundingClientRect()
  const covered = []
  for (const element of document.querySelectorAll('button, input, select, textarea, [role="tab"], [role="slider"], [role="button"]')) {
    if (bar.contains(element) || !visible(element)) continue
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    if (box.right > area.left && box.left < area.right && box.bottom > area.top && box.top < area.bottom) covered.push(element.getAttribute('data-testid') ?? element.getAttribute('aria-label') ?? element.tagName.toLowerCase())
  }
  return covered
}
