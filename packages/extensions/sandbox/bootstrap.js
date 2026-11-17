// The extension sandbox page's only script (its CSP allows it by hash). The host posts it the
// worker runtime, the extension's allowed connect-src, and the channel's port; it adds the
// connect-src policy, starts the worker from a blob, and hands the worker the port.
;(() => {
  'use strict'
  const TAG = 'kition-ext-sandbox/1'
  const SOURCE = /^(?:'none'|(?:(?:https|wss|http|ws):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)(?: (?:https|wss|http|ws):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)*)$/
  let started = false
  addEventListener('message', (event) => {
    const data = event.data
    if (started || event.source !== parent || !data || data.tag !== TAG || data.type !== 'start') return
    const port = event.ports[0]
    if (!port || typeof data.runtime !== 'string' || typeof data.connect !== 'string' || !SOURCE.test(data.connect)) return
    started = true
    const policy = document.createElement('meta')
    policy.httpEquiv = 'Content-Security-Policy'
    policy.content = `connect-src ${data.connect}`
    document.head.appendChild(policy)
    const url = URL.createObjectURL(new Blob([data.runtime], { type: 'text/javascript' }))
    const worker = new Worker(url, { name: 'kition-extension' })
    worker.postMessage({ tag: TAG, type: 'port' }, [port])
  })
})()
