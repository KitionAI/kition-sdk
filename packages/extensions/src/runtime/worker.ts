/**
 * The sandbox worker's entry (bundled into `WORKER_RUNTIME` by scripts/build-runtime.mjs). The
 * sandbox page starts it from a blob and hands it the channel's port; it then imports the
 * extension's module from a blob URL. The page's CSP, which the worker inherits, keeps both from
 * reaching anything but the extension's declared origins.
 */
import { SANDBOX_TAG } from '../protocol'
import { startRuntime } from './runtime'

const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null }

scope.onmessage = (event: MessageEvent) => {
  const data = event.data as { tag?: unknown; type?: unknown } | null
  if (!data || data.tag !== SANDBOX_TAG || data.type !== 'port' || !event.ports[0]) return
  scope.onmessage = null
  startRuntime(event.ports[0], async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      return await import(/* @vite-ignore */ url)
    } finally {
      URL.revokeObjectURL(url)
    }
  })
}
