// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { checkUiIds } from './checkUiIds.mjs'

/** A stand-in for a Playwright Frame: runs the page function here, in jsdom. */
const frame = { evaluate: async (fn, arg) => fn(arg) }

afterEach(() => {
  document.body.innerHTML = ''
})

/** A workspace frame: a tab and ≡ in its strip, and a panel body with a bare and an id'd control. */
function workspace() {
  document.body.innerHTML = `
    <div class="kui-workspace">
      <div class="kui-ws-frame" data-kit-ui-id="panel:timeline">
        <div class="kui-ws-strip">
          <div role="tablist"><button role="tab" data-kit-ui-id="panel:timeline">Timeline</button></div>
          <button class="kui-ws-menu-button">≡</button>
        </div>
        <div class="kui-ws-body">
          <fieldset class="kui-element" data-kit-ui-id="panel:timeline">
            <button id="bare">Snap</button>
            <span data-kit-ui-id="control:track.lock"><button id="owned">Lock</button></span>
          </fieldset>
        </div>
      </div>
      <div class="kui-ws-gutter" role="separator" tabindex="0"></div>
    </div>`
}

const ELEMENTS = [{ id: 'panel:timeline' }, { id: 'control:track.lock' }]

describe('checkUiIds', () => {
  it('checks workspace frames, where a panel id covers its controls by default', async () => {
    workspace()
    expect(await checkUiIds(frame, ELEMENTS)).toEqual([])
    document.querySelector('.kui-ws-frame').removeAttribute('data-kit-ui-id')
    document.querySelector('fieldset').removeAttribute('data-kit-ui-id')
    const problems = await checkUiIds(frame, ELEMENTS)
    expect(problems.some((problem) => problem.includes('≡'))).toBe(true)
    expect(problems.some((problem) => problem.includes('id="bare"'))).toBe(true)
  })

  it('in strict mode, wants an id of its own for each control in a panel body, but not in the strip', async () => {
    workspace()
    const problems = await checkUiIds(frame, ELEMENTS, { strict: true })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('id="bare"')
  })

  it('passes the structural buttons: ribbon scrolling and Single line chevrons', async () => {
    document.body.innerHTML = `
      <div class="kui-line">
        <button class="kui-ribbon-scroll" data-side="end">></button>
        <div class="kui-line-group"><button class="kui-line-more">v</button></div>
        <div class="kui-line-group"><button class="kui-ribbon-button kui-line-collapsed">Font</button></div>
        <button id="bare">Bold</button>
      </div>`
    const problems = await checkUiIds(frame, ELEMENTS)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('id="bare"')
  })

  it('reports ids the kit did not declare', async () => {
    workspace()
    expect(await checkUiIds(frame, [{ id: 'panel:timeline' }])).toEqual(['not declared: control:track.lock'])
  })
})
