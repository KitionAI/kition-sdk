// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { focusBarReport, lineRowReport } from './lineRow.mjs'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('lineRowReport', () => {
  it("counts the row's enabled inline buttons and its fields, and finds the primary items", () => {
    document.body.innerHTML = `
      <div class="kui-line">
        <div class="kui-line-group">
          <div class="kui-line-inline">
            <fieldset class="kui-element">
              <button data-testid="k-bold">B</button>
              <button data-testid="k-italic" disabled>I</button>
              <select data-testid="k-font"></select>
            </fieldset>
          </div>
          <button class="kui-line-more" data-testid="kui-line-more-Font">v</button>
        </div>
        <div class="kui-line-group">
          <div class="kui-line-inline">
            <fieldset class="kui-element" disabled><button data-testid="k-paste">P</button></fieldset>
          </div>
        </div>
        <div class="kui-line-group">
          <div class="kui-line-inline" hidden><button data-testid="k-hidden">H</button></div>
          <button class="kui-line-collapsed" data-testid="kui-line-group-Styles">Styles</button>
        </div>
      </div>`
    expect(lineRowReport(['k-bold', 'k-font', 'k-paste', 'k-hidden', 'k-styles'])).toEqual({ buttons: 1, clipped: [], fields: 1, found: ['k-bold', 'k-font', 'k-paste'], missing: ['k-hidden', 'k-styles'] })
  })

  it('reports an empty row when the frame shows none', () => {
    expect(lineRowReport(['k-bold'])).toEqual({ buttons: 0, clipped: [], fields: 0, found: [], missing: ['k-bold'] })
  })
})

describe('lineRowReport clipping', () => {
  it("names buttons drawn outside the row's box (a three-row grid's other rows) and does not count them", () => {
    document.body.innerHTML = `
      <div class="kui-line"><div class="kui-line-group"><div class="kui-line-inline">
        <button data-testid="k-bold">B</button><button data-testid="k-italic">I</button><button data-testid="k-code">C</button>
      </div></div></div>`
    const at = (top, height) => () => ({ top, bottom: top + height, left: 0, right: 30, width: 30, height, x: 0, y: top })
    document.querySelector('.kui-line').getBoundingClientRect = at(40, 36)
    document.querySelector('[data-testid="k-bold"]').getBoundingClientRect = at(17, 24)
    document.querySelector('[data-testid="k-italic"]').getBoundingClientRect = at(46, 24)
    document.querySelector('[data-testid="k-code"]').getBoundingClientRect = at(67, 24)
    expect(lineRowReport([])).toMatchObject({ buttons: 1, clipped: ['k-bold', 'k-code'] })
  })
})

describe('focusBarReport', () => {
  const box = (left, top, width, height) => () => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top })
  it("names the kit's controls under the Focus bar, and none of the bar's own", () => {
    document.body.innerHTML = `
      <div class="kui-focus-bar"><button data-testid="k-focus-exit">Exit</button></div>
      <button data-testid="k-timeline-play">Play</button>
      <button aria-label="Zoom">Z</button>
      <input data-testid="k-far" />`
    document.querySelector('.kui-focus-bar').getBoundingClientRect = box(400, 800, 300, 40)
    document.querySelector('[data-testid="k-focus-exit"]').getBoundingClientRect = box(404, 804, 90, 32)
    document.querySelector('[data-testid="k-timeline-play"]').getBoundingClientRect = box(500, 810, 24, 24)
    document.querySelector('[aria-label="Zoom"]').getBoundingClientRect = box(690, 790, 24, 24)
    document.querySelector('[data-testid="k-far"]').getBoundingClientRect = box(10, 10, 100, 24)
    expect(focusBarReport()).toEqual(['k-timeline-play', 'Zoom'])
  })

  it('says when there is no Focus bar', () => {
    expect(focusBarReport()).toEqual(['no Focus bar'])
  })
})
