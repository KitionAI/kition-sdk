import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { watchPage } from './watchPage.mjs'

/** A fake Playwright browser, context and page: EventEmitters whose close() emits as Playwright's do. */
function fakeBrowser() {
  const browser = new EventEmitter()
  let connected = true
  const contexts = []
  browser.isConnected = () => connected
  browser.contexts = () => contexts
  browser.newPage = () => {
    const context = new EventEmitter()
    const pages = []
    context.browser = () => browser
    context.pages = () => pages
    context.close = async () => {
      for (const page of [...pages]) page.emit('close', page)
      context.emit('close', context)
    }
    const page = new EventEmitter()
    page.context = () => context
    page.url = () => 'http://127.0.0.1:5173/dev.html'
    page.close = async () => page.emit('close', page)
    pages.push(page)
    contexts.push(context)
    return page
  }
  browser.close = async () => {
    for (const context of [...contexts]) await context.close()
    connected = false
    browser.emit('disconnected', browser)
  }
  /** The browser process going away without browser.close(). */
  browser.exit = () => {
    for (const context of [...contexts]) {
      for (const page of context.pages()) page.emit('close', page)
      context.emit('close', context)
    }
    connected = false
    browser.emit('disconnected', browser)
  }
  return browser
}

function watched() {
  const browser = fakeBrowser()
  const page = browser.newPage()
  const lines = []
  let time = 1000
  const clock = { advance: (ms) => (time += ms) }
  const watch = watchPage(page, { name: 'kit.sheet', log: (line) => lines.push(line), now: () => time })
  return { browser, page, context: page.context(), lines, watch, clock }
}

describe('watchPage', () => {
  it('prints a crash with the step running then and how long it ran', () => {
    const { page, lines, watch, clock } = watched()
    watch.step('open the comments panel')
    clock.advance(2310)
    page.emit('crash', page)
    expect(lines).toEqual(['watchPage: kit.sheet: the page crashed during "open the comments panel" (2310 ms into the step; http://127.0.0.1:5173/dev.html)'])
    expect(watch.current).toBe('open the comments panel')
  })

  it('prints a crash even when the test then closes the page', async () => {
    const { page, lines, watch } = watched()
    watch.step('draw the hairline')
    page.emit('crash', page)
    await page.close()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('the page crashed during "draw the hairline"')
  })

  it('prints a page closed by something else, saying its context and browser were still open', () => {
    const { page, lines, watch, clock } = watched()
    watch.step('click Comment')
    clock.advance(5)
    page.emit('close', page)
    expect(lines).toEqual(['watchPage: kit.sheet: the page was closed, not by the test, during "click Comment" (5 ms into the step; http://127.0.0.1:5173/dev.html); its context is open, the browser is connected'])
  })

  it('prints nothing for a close the test makes through the page, its context or its browser', async () => {
    for (const close of [({ page }) => page.close(), ({ context }) => context.close(), ({ browser }) => browser.close()]) {
      const setup = watched()
      setup.watch.step('close')
      await close(setup)
      expect(setup.lines).toEqual([])
    }
  })

  it('prints nothing after closing() for a close that does not go through those objects', () => {
    const { page, lines, watch } = watched()
    watch.closing()
    page.emit('close', page)
    expect(lines).toEqual([])
  })

  it('tells the browser going away from the page alone: each of page, context and browser on its own line', () => {
    const { browser, lines, watch } = watched()
    watch.step('switch to Classic')
    browser.exit()
    expect(lines).toEqual([
      'watchPage: kit.sheet: the page was closed, not by the test, during "switch to Classic" (0 ms into the step; http://127.0.0.1:5173/dev.html); its context is open, the browser is connected',
      'watchPage: kit.sheet: the context was closed, not by the test, during "switch to Classic" (0 ms into the step; http://127.0.0.1:5173/dev.html); the browser is connected',
      'watchPage: kit.sheet: the browser disconnected, not by the test, during "switch to Classic" (0 ms into the step; http://127.0.0.1:5173/dev.html)',
    ])
  })

  it('wraps close() once, so a second watcher of the same objects still sees the test close them', async () => {
    const { browser, page, lines } = watched()
    const again = []
    watchPage(page, { log: (line) => again.push(line) })
    await browser.close()
    expect(lines).toEqual([])
    expect(again).toEqual([])
  })

  it('stop() removes its listeners', () => {
    const { page, lines, watch } = watched()
    watch.stop()
    page.emit('crash', page)
    page.emit('close', page)
    expect(lines).toEqual([])
    expect(page.listenerCount('crash')).toBe(0)
    expect(page.listenerCount('close')).toBe(0)
  })
})

describe('runModeSmoke', () => {
  it('watches its pages: a page that crashes while opening prints the step', async () => {
    const { runModeSmoke } = await import('./modeSmoke.mjs')
    const browser = fakeBrowser()
    browser.newContext = async () => {
      const page = browser.newPage()
      page.goto = async () => {
        page.emit('crash', page)
        throw new Error('page.goto: Target crashed')
      }
      const context = page.context()
      context.newPage = async () => page
      return context
    }
    const server = { listen: async () => {}, close: async () => {}, httpServer: { address: () => ({ port: 5173 }) } }
    const printed = []
    const error = console.error
    console.error = (line) => printed.push(line)
    try {
      await expect(runModeSmoke({ kit: 'kit.sheet', config: 'vite.config.ts', browser: { launch: async () => browser }, createServer: async () => server })).rejects.toThrow('Target crashed')
    } finally {
      console.error = error
    }
    // The crash is printed; the smoke's own browser.close() afterwards is not.
    expect(printed).toHaveLength(1)
    expect(printed[0]).toMatch(/^watchPage: kit\.sheet: the page crashed during "menus: open the editor" \(\d+ ms into the step; /)
  })
})
