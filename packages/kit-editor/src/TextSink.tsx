import { useEffect, useRef, type CompositionEvent, type KeyboardEvent } from 'react'
import { composingKey } from './host'

/**
 * Where typed text goes while an engine tool takes text (UI-K6): a hidden, focused text field.
 * Input methods (Chinese, Japanese, Korean) compose in it as in any field; finished text goes to
 * `onText`, and editing keys (Enter, Backspace, arrows, Escape, shortcuts) to `onKey`, which
 * answers whether it took the key. Raw key events alone cannot carry composed text. What is being
 * composed goes to `onCompose` as it changes, with the input method's cursor in it (characters),
 * so the tool can show it at its caret; the empty text ends it, before the finished text reaches
 * `onText`. The canvas puts the field on the tool's caret (`KitCanvas`' `caret`), so the input
 * method's candidate window opens beside it.
 */
/** A field the person is typing in themselves (the find bar, a font size): the sink leaves it be. */
function editingElsewhere(sink: HTMLTextAreaElement | null) {
  const focused = document.activeElement
  if (!focused || focused === sink) return false
  return focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement || (focused instanceof HTMLElement && focused.isContentEditable)
}

/** The input method's cursor in the composition `text`, in characters: where `field` has it, else at the end. */
function cursorIn(field: HTMLTextAreaElement, text: string) {
  const length = Array.from(text).length
  // A composition event can come before the field shows what it composes.
  if (field.value !== text) return length
  const end = Math.min(field.selectionEnd ?? text.length, text.length)
  return Math.min(Array.from(text.slice(0, end)).length, length)
}

export function TextSink({ active, onText, onKey, onCompose }: { active: boolean; onText: (text: string) => void; onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean; onCompose?: (text: string, cursor: number) => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)

  useEffect(() => {
    if (!active) return
    let pending: number | undefined
    const focus = () => {
      pending = undefined
      // An embedded editor must not steal keyboard focus from its host or another
      // iframe when activation or a deferred pointer callback finishes loading.
      if (document.hasFocus() && !editingElsewhere(field.current)) field.current?.focus({ preventScroll: true })
    }
    focus()
    // A click on the canvas moves focus away; the next frame brings it back while typing, unless
    // the click put the caret in another field.
    const onPointerUp = () => {
      if (pending !== undefined) cancelAnimationFrame(pending)
      pending = requestAnimationFrame(focus)
    }
    // A pressed button would take focus until that frame, and a Space or Enter typed in between
    // would press it again (a second Undo) instead of reaching the document: while the person
    // types here, a press on a button leaves focus where it is. Its click still runs, and Tab
    // still focuses buttons for the keyboard.
    const onMouseDown = (event: MouseEvent) => {
      if (document.activeElement !== field.current) return
      const button = event.target instanceof Element ? event.target.closest('button') : null
      if (button && !button.disabled) event.preventDefault()
    }
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('mousedown', onMouseDown, true)
      if (pending !== undefined) cancelAnimationFrame(pending)
    }
  }, [active])

  const flush = () => {
    const text = field.current?.value ?? ''
    if (field.current) field.current.value = ''
    if (text) onText(text)
  }

  return (
    <textarea
      ref={field}
      className="kui-text-sink"
      aria-hidden="true"
      tabIndex={-1}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      onCompositionStart={(event: CompositionEvent<HTMLTextAreaElement>) => {
        composing.current = true
        // A composition starts empty: nothing to show yet.
        if (event.data) onCompose?.(event.data, cursorIn(event.currentTarget, event.data))
      }}
      onCompositionUpdate={(event: CompositionEvent<HTMLTextAreaElement>) => {
        onCompose?.(event.data ?? '', cursorIn(event.currentTarget, event.data ?? ''))
      }}
      onCompositionEnd={() => {
        composing.current = false
        // The composition goes before its finished text comes (or, cancelled, none does).
        onCompose?.('', 0)
        flush()
      }}
      onInput={() => {
        if (!composing.current) flush()
      }}
      onKeyDown={(event) => {
        // While composing, the input method owns every key (Enter commits the composition).
        if (composing.current || composingKey(event.nativeEvent)) return
        const command = event.metaKey || event.ctrlKey
        // Printable keys become input events (and so compose); the rest are the tool's.
        if (event.key.length === 1 && !command) return
        if (onKey(event)) event.preventDefault()
      }}
      data-testid="kit-text-sink"
    />
  )
}
