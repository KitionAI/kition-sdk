// Flow-test check for UI configuration (Kit UI protocol section 9), run from Node with Playwright:
// every control in a kit's chrome (top bar, command row or ribbon, drop-down panels, Focus bar,
// options bar, tool rail, panels, workspace frames) sits in an element with an id, and every id drawn is one the editor lists in
// `ui/elements`.
//
//   import { checkUiIds } from '@kition/kit-dev-host/check-ui-ids'
//   const problems = await checkUiIds(frame, await page.evaluate(() => window.devHost.connection().elements()))
//
// With `{ strict: true }`, a panel's own id does not cover the controls inside its content: a
// `WorkspaceLayout` frame (`.kui-ws-frame`) and a `panel:` `KitElement` still cover their tab
// strip, but each control in a panel's body (`.kui-ws-body`) needs an id of its own, closer than
// the panel's (`control:…`, `tool:…`). A workspace's gutters are not controls and carry no id; a
// kit maps upstream's `dock.gutter.*` to their test ids (`<testId>-gutter-<path>`). The frame's
// structural buttons are not controls either and carry no id: a scrolled row's scroll buttons and
// a Single line group's chevron (or its one button), which only open the group's popover.

/** Answers the problems found in `frame` (a Playwright Frame of the kit); empty when none. */
export async function checkUiIds(frame, elements, options = {}) {
  return frame.evaluate(
    ({ known, strict }) => {
      const scope = '.kui-frame-top, .kui-ribbon-body, .kui-line, .kui-drop-panel, .kui-focus-bar, .kui-options-bar, .kui-tool-rail, .kui-panel, .kui-workspace'
      /** An id that names the whole panel, which in strict mode does not cover its body's controls. */
      const panelWide = (element) => element.classList.contains('kui-ws-frame') || (element.classList.contains('kui-element') && element.getAttribute('data-kit-ui-id').startsWith('panel:'))
      const structural = '.kui-ribbon-scroll, .kui-line-more, .kui-line-collapsed'
      const problems = []
      for (const control of document.querySelectorAll(`:is(${scope}) :is(button, input, select, textarea, [role="menuitem"])`)) {
        if (control.matches(structural)) continue
        let owner = control.closest('[data-kit-ui-id]')
        if (strict && control.closest('.kui-ws-body')) {
          while (owner && panelWide(owner)) owner = owner.parentElement?.closest('[data-kit-ui-id]') ?? null
          // Past the panel's own ids there is nothing in the body to cover the control.
          if (owner && !owner.closest('.kui-ws-body')) owner = null
        }
        if (!owner) problems.push(`no id: ${control.outerHTML.slice(0, 120)}`)
      }
      for (const element of document.querySelectorAll('[data-kit-ui-id]')) {
        const id = element.getAttribute('data-kit-ui-id')
        if (!id.startsWith('host:') && !known.includes(id)) problems.push(`not declared: ${id}`)
      }
      return problems
    },
    { known: elements.map((element) => element.id), strict: options.strict === true },
  )
}
