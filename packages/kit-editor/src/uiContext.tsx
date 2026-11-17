/**
 * The UI configuration where a kit's editor draws (protocol section 9). The editor provider
 * gives it (`UiProvider`); `KitElement` and Kition Tessera's components ask it whether an element
 * is hidden or disabled, Tessera's through its `ElementsProvider`, which `UiProvider` fills.
 */
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { KitUiHostButton } from '@kition/kit-ui-protocol'
import { ElementsProvider, type Elements } from '@kition/tessera-ui'
import { EMPTY_UI_CONFIG, buttonsAt, uiState } from './uiConfig'
import { createUiStore, type UiStore } from './uiStore'

export type UiContextValue = {
  store: UiStore
  locale: string
  /** A command's menu path (`menu:` configuration). */
  menuOf: (command: string) => readonly string[]
  /** The kit's declared ids (development warnings); null when it declared none. */
  declared: ReadonlySet<string> | null
  /** A host button was pressed. */
  press: (id: string) => void
  /** Offers "Hide" for an element at a screen point; null without the `customize` capability. */
  offerHide: ((id: string, x: number, y: number) => void) | null
  /** Opens the customize dialog; null without the `customize` capability. */
  openCustomize: (() => void) | null
  /** Hides an element for the person at once; null without the `customize` capability. */
  hide: ((id: string) => void) | null
  /** Draws the host's buttons at a place (the editor gives `HostButtons`; `ui.tsx` cannot import it). */
  renderButtons: (place: string, as: 'menu' | 'ribbon' | 'action') => ReactNode
  /**
   * Whether the session hides an engine command whatever the configuration says: a commenter's
   * editor hides the edits they cannot run (`hiddenForCommenter`). Absent: it hides none.
   */
  sessionHidden?: (command: string) => boolean
}

const HIDES_NONE = () => false

export const UiContext = createContext<UiContextValue | null>(null)

const NO_STORE = createUiStore(EMPTY_UI_CONFIG, null, () => undefined)

/**
 * The configuration here, and what it says about an element (nothing hidden outside an editor).
 * Depend on `config` in effects; the functions are rebuilt each render.
 */
export function useUi() {
  const context = useContext(UiContext)
  const store = context?.store ?? NO_STORE
  const config = useSyncExternalStore(store.subscribe, store.get)
  return {
    config,
    store,
    locale: context?.locale ?? 'en-US',
    declared: context?.declared ?? null,
    state: (id: string, menu?: readonly string[]) => {
      const isCommand = id.startsWith('command:')
      const state = uiState(config, id, menu ?? (isCommand ? (context?.menuOf(id.slice('command:'.length)) ?? []) : []))
      // A command the session hides (a commenter's edit) is not drawn; the configuration still decides the rest.
      return isCommand && !state.hidden && context?.sessionHidden?.(id.slice('command:'.length)) ? { ...state, hidden: true } : state
    },
    sessionHidden: context?.sessionHidden ?? HIDES_NONE,
    buttons: (place: string): KitUiHostButton[] => buttonsAt(config, place),
    press: context?.press ?? (() => undefined),
    offerHide: context?.offerHide ?? null,
    openCustomize: context?.openCustomize ?? null,
    hide: context?.hide ?? null,
    renderButtons: context?.renderButtons ?? (() => null),
  }
}

const warned = new Set<string>()

/** In development, warns once about an id drawn without being declared with `defineKitUi`. */
export function warnUndeclared(id: string, declared: ReadonlySet<string> | null) {
  if (!import.meta.env?.DEV || !declared || declared.has(id) || warned.has(id)) return
  warned.add(id)
  console.warn(`[kit-editor] ${id} is drawn but not declared with defineKitUi`)
}

/**
 * Gives a UI configuration to everything below: kit-editor's own parts (`useUi`) and Tessera's
 * components, which see it as element states and draw the host's buttons as extras.
 */
export function UiProvider({ value, children }: { value: UiContextValue | null; children: ReactNode }) {
  return (
    <UiContext.Provider value={value}>
      <TesseraElements>{children}</TesseraElements>
    </UiContext.Provider>
  )
}

function TesseraElements({ children }: { children: ReactNode }) {
  const context = useContext(UiContext)
  const ui = useUi()
  const { config } = ui
  // The same object while the configuration and the context are (`ui` is rebuilt from them every
  // render), so Tessera's components redraw only when they change.
  const elements = useMemo<Elements>(
    () => ({
      state: (id) => ui.state(id),
      renderExtras: (place, as) => ui.renderButtons(place, as),
      // Engine menu paths (`menu:`) are not declared with defineKitUi; every other id is.
      drawn: (id) => {
        if (!id.startsWith('menu:')) warnUndeclared(id, ui.declared)
      },
    }),
    [config, context],
  )
  return <ElementsProvider elements={elements}>{children}</ElementsProvider>
}

/** One of the kit's own elements: not drawn when hidden; its form controls disabled when disabled (enforcement is in the session's run). */
export function KitElement({ id, children }: { id: string; children: ReactNode }) {
  const ui = useUi()
  warnUndeclared(id, ui.declared)
  const state = ui.state(id)
  if (state.hidden) return null
  return (
    <fieldset className="kui-element" data-kit-ui-id={id} disabled={state.disabled} role="presentation">
      {children}
    </fieldset>
  )
}
