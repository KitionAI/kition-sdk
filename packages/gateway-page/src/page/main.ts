/**
 * The gateway's editor page: `page/?path=<file>` (the editor) and `page/review?path=<file>` (the
 * review of the agent's draft of the file), with `theme=light|dark` and `locale=en|zh`.
 *
 * Its credential: behind a same-origin proxy that adds the gateway's token, none. Opened directly
 * (`kition gateway --open`), its address's fragment carries `bootstrap=<signed path>`, which it
 * trades once for a page session, keeps in the tab (`sessionStorage`, never a cookie) and drops
 * from the address bar, so the address in the history opens nothing. A reload in the same tab
 * keeps its session.
 */
import './page.css'
import { EditorView } from './editor'
import { Bridge } from './bridge'
import { Gateway, gatewayRoot, read, SESSION_KEY, cleanPath } from './gateway'
import { localeFrom, setLocale, t } from './i18n'
import { listen, post } from './parent'
import { mountReview } from './review'
import { schemeFrom, setScheme } from './theme'
import { shortcutsFrom } from './kits'
import { h, panel } from './ui'

const params = new URLSearchParams(location.search)
setScheme(schemeFrom(params.get('theme')))
setLocale(localeFrom(params.get('locale') ?? navigator.language))

const view = location.pathname.endsWith('/review') ? 'review' : 'editor'
const path = cleanPath(params.get('path') ?? '')

/** The page session: traded from the address's bootstrap, or kept in the tab from before. */
async function credential(gateway: Gateway) {
  const fragment = new URLSearchParams(location.hash.slice(1))
  const bootstrap = fragment.get('bootstrap')
  if (bootstrap) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
    const response = await fetch(gateway.url(bootstrap), { cache: 'no-store', credentials: 'omit' })
    const answer = await read<{ session: string; expires: number }>(response)
    sessionStorage.setItem(SESSION_KEY, answer.session)
    return answer.session
  }
  return sessionStorage.getItem(SESSION_KEY)
}

async function start() {
  const app = document.getElementById('app')!
  const banner = h('div', { class: 'banner', role: 'status', 'aria-live': 'polite', hidden: true, 'data-testid': 'draft-banner' })
  const stage = h('main', { class: 'stage', id: 'stage' })
  app.replaceChildren(banner, stage)
  const gateway = new Gateway(gatewayRoot(location.pathname), null)
  try {
    gateway.session = await credential(gateway)
  } catch (error) {
    app.append(panel('unreachable', t('unreachableTitle'), t('unreachable'), { detail: (error as Error).message }))
    post({ type: 'ready', view, path })
    return
  }
  if (!path) {
    app.append(panel('missing', t('missingTitle', { name: params.get('path') ?? '' }), t('missing')))
    post({ type: 'ready', view, path: null })
    return
  }
  const bridge = new Bridge(gateway)
  if (view === 'review') {
    const content = h('section', { class: 'review-page', 'aria-labelledby': 'review-title' }, h('h1', { id: 'review-title' }, t('reviewTitle', { name: path.split('/').pop() ?? path })))
    const host = h('div')
    content.append(host)
    stage.replaceChildren(content)
    mountReview(gateway, path, host, { onDone: (outcome) => post({ type: 'reviewed', path, outcome }) })
    post({ type: 'ready', view, path })
    return
  }
  const editor = new EditorView(gateway, bridge, path, app, gateway.session !== null, shortcutsFrom(params.get('keys')), params.get('focus') !== 'no')
  gateway.onUnauthorized = () => undefined
  ;(window as unknown as { kitionGatewayPage: unknown }).kitionGatewayPage = {
    get state() {
      return editor.state
    },
    save: () => editor.save(),
    review: () => editor.review(),
  }
  listen((command) => {
    switch (command.type) {
      case 'theme':
        setScheme(command.theme)
        editor.setTheme()
        break
      case 'locale':
        setLocale(command.locale)
        editor.setLocale()
        break
      case 'save':
        void editor.save().then((answer) => post({ type: 'saved', path, ...answer }))
        break
      case 'focus':
        editor.focus()
        break
      case 'review':
        editor.review()
        break
    }
  })
  // Unsaved edits are not lost to a closed tab without the person being asked; a host that asks
  // itself (`closing=host`) gets no question from the page: in an Electron app nobody shows it, and
  // the window then refuses to close, silently.
  if (params.get('closing') !== 'host') window.addEventListener('beforeunload', (event) => {
    if (!editor.unsaved) return
    event.preventDefault()
    event.returnValue = ''
  })
  bridge.open()
  post({ type: 'ready', view, path })
  await editor.open()
}

void start()
