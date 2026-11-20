/**
 * The document in a kit's `ai/inspect` answer as an agent reads it: without the editor state the
 * kit declares in its manifest (`kit.json` `engine.editorState`, platform rule K23) and without the
 * editing session's bookkeeping at the top, as the headless path answers it (Kition's
 * `editorState.ts`).
 */

const SESSION_KEYS: readonly string[] = ['canUndo', 'canRedo', 'dirty', 'revision', 'history', 'redo', 'undo', 'path', 'title']

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function withoutNames(value: unknown, names: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutNames(item, names))
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !names.has(key)).map(([key, item]) => [key, withoutNames(item, names)]))
}

function at(root: unknown, tokens: string[]): unknown {
  let value = root
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined
      value = value[Number(token)]
    } else if (isObject(value) && Object.hasOwn(value, token)) value = value[token]
    else return undefined
  }
  return value
}

/** `inspected` without the session's bookkeeping and the declared editor state (names anywhere, JSON Pointers at their place). */
export function documentContent(inspected: unknown, editorState: readonly string[]): unknown {
  const pointers = editorState.filter((key) => key.startsWith('/'))
  const value = withoutNames(inspected, new Set(editorState.filter((key) => !key.startsWith('/'))))
  if (!isObject(value)) return value
  for (const key of SESSION_KEYS) delete value[key]
  for (const pointer of pointers) {
    const tokens = pointer
      .slice(1)
      .split('/')
      .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    const key = tokens.pop()!
    const parent = at(value, tokens)
    if (isObject(parent)) delete parent[key]
  }
  return value
}

/** The editor state a kit's manifest declares, or `null` when it declares none (its `inspect()` is then read whole). */
export function declaredEditorState(manifest: unknown): string[] | null {
  const declared = isObject(manifest) && isObject(manifest.engine) ? manifest.engine.editorState : undefined
  return Array.isArray(declared) && declared.every((key) => typeof key === 'string') ? (declared as string[]) : null
}

/** What an agent reads of an `ai/inspect` answer: its `details` as the document, when the kit declares its editor state. */
export function agentInspect<T extends Record<string, unknown>>(answer: T, editorState: readonly string[] | null): T {
  if (!editorState || !('details' in answer)) return answer
  return { ...answer, details: documentContent(answer.details, editorState) }
}
