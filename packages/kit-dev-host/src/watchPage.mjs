// Says which step was running when a Playwright page crashed or was closed under a test. Playwright
// reports both the same way to the call in flight ("Target page, context or browser has been
// closed"; a crash says "Target crashed"), without the step or who closed it:
//
//   import { watchPage } from '@kition/sdk/dev-host/watch-page'
//   const watch = watchPage(page, { name: 'kit.doc' })
//   watch.step('open the comments panel')
//   await frame.getByTestId('comments').click()
//   ...
//   await context.close()   // closed by the test: not printed
//   watch.stop()
//
// It prints one line (console.error, or `log`) per event:
//
//   watchPage: kit.doc: the page crashed during "open the comments panel" (2310 ms into the step; http://...)
//   watchPage: kit.doc: the page was closed, not by the test, during "open the comments panel" (2310 ms into the step; http://...); its context is open, the browser is connected
//   watchPage: kit.doc: the context was closed, not by the test, during "..." (...); the browser is connected
//   watchPage: kit.doc: the browser disconnected, not by the test, during "..." (...)
//
// A crash is always printed. A close is printed only when the test did not close it itself:
// watchPage wraps close() of the page, of its context and of its browser (once per object, kept
// for the object's life), so a close() the test or its runner calls on any of them, before or
// after watchPage, marks the page, the context or the browser (and what it holds) as closed by the
// test. Something else closing them (the page's own window.close(), the browser process exiting,
// another handle of the same browser) is printed. `closing()` marks the page as closed by the test
// for a close that does not go through these objects. The page's close line says whether its
// context and browser were still open, which tells a page closed alone from one closed with its
// context or browser (each of those is printed on its own line too).

const closedByTest = new WeakSet()
const wrapped = Symbol.for('kition.watchPage.closeWrapped')

/** Wraps `target.close` once so that calling it marks `target` (and `marks()`) closed by the test. */
function markOnClose(target, marks) {
  if (!target || typeof target.close !== 'function' || target[wrapped]) return
  const close = target.close
  target[wrapped] = true
  target.close = function (...args) {
    closedByTest.add(target)
    for (const held of marks()) closedByTest.add(held)
    return close.apply(this, args)
  }
}

/**
 * Watches `page` (a Playwright Page) for a crash and for a close the test did not make, and prints
 * which step was running then.
 *
 * @param {any} page A Playwright Page.
 * @param {{ name?: string, log?: (line: string) => void, now?: () => number }} [options]
 *   `name` starts each line (a kit id); `log` receives each line (default console.error); `now`
 *   is the clock in ms (default Date.now).
 * @returns {{ step: (label: string) => void, readonly current: string, closing: () => void, stop: () => void }}
 *   `step(label)` sets the step running now; `current` is it; `closing()` marks the page closed by
 *   the test; `stop()` removes the listeners.
 */
export function watchPage(page, { name = '', log = (line) => console.error(line), now = () => Date.now() } = {}) {
  const context = typeof page.context === 'function' ? page.context() : null
  const browser = context && typeof context.browser === 'function' ? context.browser() : null
  markOnClose(page, () => [])
  markOnClose(context, () => (typeof context.pages === 'function' ? context.pages() : []))
  markOnClose(browser, () => (typeof browser.contexts === 'function' ? browser.contexts().flatMap((held) => [held, ...(typeof held.pages === 'function' ? held.pages() : [])]) : []))

  let current = '(before the first step)'
  let started = now()
  let contextClosed = false
  let browserDisconnected = false
  const prefix = `watchPage: ${name ? `${name}: ` : ''}`
  const where = () => {
    let url = ''
    try {
      url = typeof page.url === 'function' ? page.url() : ''
    } catch {
      url = ''
    }
    return `during "${current}" (${now() - started} ms into the step${url ? `; ${url}` : ''})`
  }
  const byTest = (target) => closedByTest.has(target)

  const onCrash = () => log(`${prefix}the page crashed ${where()}`)
  const onPageClose = () => {
    if (byTest(page)) return
    const contextState = context ? (contextClosed ? 'its context is closed' : 'its context is open') : 'its context is unknown'
    const browserState = browser ? (browserDisconnected || (typeof browser.isConnected === 'function' && !browser.isConnected()) ? 'the browser is disconnected' : 'the browser is connected') : 'the browser is unknown'
    log(`${prefix}the page was closed, not by the test, ${where()}; ${contextState}, ${browserState}`)
  }
  const onContextClose = () => {
    contextClosed = true
    if (byTest(context) || byTest(page)) return
    const browserState = browser ? (browserDisconnected || (typeof browser.isConnected === 'function' && !browser.isConnected()) ? 'the browser is disconnected' : 'the browser is connected') : 'the browser is unknown'
    log(`${prefix}the context was closed, not by the test, ${where()}; ${browserState}`)
  }
  const onDisconnected = () => {
    browserDisconnected = true
    if (byTest(browser) || byTest(context) || byTest(page)) return
    log(`${prefix}the browser disconnected, not by the test, ${where()}`)
  }

  page.on('crash', onCrash)
  page.on('close', onPageClose)
  context?.on?.('close', onContextClose)
  browser?.on?.('disconnected', onDisconnected)

  return {
    step(label) {
      current = label
      started = now()
    },
    get current() {
      return current
    },
    closing() {
      closedByTest.add(page)
    },
    stop() {
      page.off('crash', onCrash)
      page.off('close', onPageClose)
      context?.off?.('close', onContextClose)
      browser?.off?.('disconnected', onDisconnected)
    },
  }
}
