// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { iframeSandbox, openPanelFrame, PANEL_TAG, SANDBOX_TAG } from '../src/index'
import { WORKER_RUNTIME } from '../src/runtime/index'

describe('iframeSandbox', () => {
  it('loads the sandbox page in a hidden scripts-only frame and hands it the runtime, the connect-src, and a port', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const posted: Array<{ data: unknown; origin: string; transfer: unknown[] }> = []
    const append = container.appendChild.bind(container)
    vi.spyOn(container, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      const appended = append(node)
      const frame = node as unknown as HTMLIFrameElement
      vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((data: unknown, origin: string, transfer: unknown[]) => {
        posted.push({ data, origin, transfer })
      }) as never)
      setTimeout(() => frame.dispatchEvent(new Event('load')))
      return appended
    })

    const connection = await iframeSandbox({ url: '/extensions/sandbox.html', container })({ id: 'com.example.titles', connect: "'none'" })
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe('/extensions/sandbox.html')
    expect(frame.style.display).toBe('none')
    expect(frame.dataset.kitionExtension).toBe('com.example.titles')
    expect(posted).toHaveLength(1)
    expect(posted[0].data).toEqual({ tag: SANDBOX_TAG, type: 'start', runtime: WORKER_RUNTIME, connect: "'none'" })
    expect(posted[0].origin).toBe('*')
    expect(posted[0].transfer).toHaveLength(1)
    expect(connection.port).toBeDefined()

    connection.dispose()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('fails when the page does not load', async () => {
    const container = document.createElement('div')
    vi.spyOn(container, 'appendChild').mockImplementation(<T extends Node>(node: T): T => node)
    await expect(iframeSandbox({ url: '/missing.html', container, loadTimeoutMs: 10 })({ id: 'com.example.titles', connect: "'none'" })).rejects.toThrow(/did not load/)
  })
})

describe('openPanelFrame', () => {
  /** A container whose frames "load" and record what is posted to them. */
  function frames() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const posted: Array<{ data: unknown; origin: string; transfer: unknown[] }> = []
    const append = container.appendChild.bind(container)
    vi.spyOn(container, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      const appended = append(node)
      const frame = node as unknown as HTMLIFrameElement
      vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((data: unknown, origin: string, transfer: unknown[]) => {
        posted.push({ data, origin, transfer })
      }) as never)
      setTimeout(() => frame.dispatchEvent(new Event('load')))
      return appended
    })
    return { container, posted }
  }

  it('shows the panel in a scripts-only frame and hands it its HTML, connect-src, theme, and the other end of the worker channel', async () => {
    const { container, posted } = frames()
    const closed: string[] = []
    const opened: Array<{ documentId: string; extension: string; panel: string; port: MessagePort }> = []
    const host = {
      panelContent: () => ({ html: '<p>Titles</p>', connect: 'https://api.example.com', title: 'Slide titles' }),
      openPanel: async (documentId: string, extension: string, panel: string, port: MessagePort) => {
        opened.push({ documentId, extension, panel, port })
        return { session: 'panel-1', close: () => closed.push('panel-1') }
      },
    }
    let navigated = 0
    const target = { documentId: 'Slide.pptx', extension: 'com.example.titles', panel: 'titles.panel' }
    const shown = await openPanelFrame(host, target, { url: '/extensions/panel.html', container, theme: { '--kit-primary': '#5645d4' }, locale: 'en-US', onNavigated: () => (navigated += 1) })
    const frame = container.querySelector('iframe')!
    expect(shown.frame).toBe(frame)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe('/extensions/panel.html')
    expect(frame.title).toBe('Slide titles')
    expect(frame.dataset.kitionPanel).toBe('com.example.titles:titles.panel')
    expect(opened).toEqual([{ ...target, port: expect.anything() }])
    expect(posted).toHaveLength(1)
    expect(posted[0].data).toEqual({
      tag: PANEL_TAG,
      type: 'start',
      html: '<p>Titles</p>',
      connect: 'https://api.example.com',
      theme: { '--kit-primary': '#5645d4' },
      info: { extension: 'com.example.titles', panel: 'titles.panel', documentId: 'Slide.pptx', title: 'Slide titles', locale: 'en-US' },
    })
    expect(posted[0].origin).toBe('*')
    expect(posted[0].transfer).toHaveLength(1)
    expect(posted[0].transfer[0]).not.toBe(opened[0].port)

    // A frame that loads another page is closed.
    frame.dispatchEvent(new Event('load'))
    expect(navigated).toBe(1)
    expect(closed).toEqual(['panel-1'])
    expect(container.querySelector('iframe')).toBeNull()
    shown.dispose()
    expect(closed).toEqual(['panel-1'])
  })

  it('removes the frame when the extension cannot open the panel', async () => {
    const { container, posted } = frames()
    const host = {
      panelContent: () => ({ html: '<p/>', connect: "'none'", title: 'Titles' }),
      openPanel: async () => {
        throw new Error('the extension failed to activate')
      },
    }
    await expect(openPanelFrame(host, { documentId: 'Slide.pptx', extension: 'com.example.titles', panel: 'titles.panel' }, { url: '/extensions/panel.html', container })).rejects.toThrow(/failed to activate/)
    expect(container.querySelector('iframe')).toBeNull()
    expect(posted).toHaveLength(0)
  })
})
