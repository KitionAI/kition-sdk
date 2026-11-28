import { useState, type ReactNode } from 'react'
import { Button, Dialog } from '@kition/tessera-ui'
import type { KitCommand } from './engine/kitModule'

type Node = { type?: string; title?: string; description?: string; enum?: unknown[]; default?: unknown; required?: boolean; items?: Node; oneOf?: Node[]; properties?: Record<string, Node> }

/**
 * How the parameters dialog shows a command's fields (`ShellProps.commandDialog`). Without it the
 * dialog shows the schema's parameter names and one JSON text box for a list or an object.
 */
export type CommandDialogOptions = {
  /**
   * A parameter's name as the dialog shows it, translated (`cols` as "Columns"); `param` is the
   * parameter's name, or its path in an object (`range.start`), and `schema` its schema. Null or
   * undefined keeps the name.
   */
  label?: (param: string, command: KitCommand, schema: Record<string, unknown>) => string | null | undefined
  /** A choice of an enum as the dialog shows it, translated; null or undefined keeps the value. */
  choice?: (param: string, value: unknown, command: KitCommand) => string | null | undefined
  /**
   * Lists and objects in fields of their own instead of one JSON text box: a list of numbers, words
   * or booleans one item a row, with Add and Remove (a list of named numbers, `[x, y]`, one field
   * each); a list of choices a check box each; an object with `properties` a field each. A list of
   * objects, or a value of several types, stays a JSON text box.
   */
  structured?: boolean
}

/** Whether running `command` needs values a person has to give (a required parameter). */
export function needsParams(command: KitCommand) {
  return Object.values((command.schema ?? {}) as Record<string, Node>).some((node) => node.required)
}

/** Parameters a form shows in full before it folds the optional ones away. */
const FOLD_AFTER = 6

const shown = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

function initial(node: Node, given: unknown): string {
  if (given !== undefined) return shown(given)
  if (node.default !== undefined) return shown(node.default)
  // An optional choice starts empty, so the engine's own default applies.
  if (node.enum?.length) return node.required ? String(node.enum[0]) : ''
  return node.type === 'boolean' ? 'false' : ''
}

function parse(node: Node, text: string): unknown {
  switch (node.type) {
    case 'number':
    case 'integer':
      return text.trim() === '' ? undefined : Number(text)
    case 'boolean':
      return text === 'true'
    case 'string':
      return text === '' ? undefined : text
    default:
      if (text.trim() === '') return undefined
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
  }
}

/** A field's value while it is edited: a text, the items of a list, the properties of an object. */
type Draft = string | Draft[] | { [key: string]: Draft }

/** The kinds of field a structured dialog gives a value. */
type Shape = 'scalar' | 'list' | 'tuple' | 'choices' | 'object' | 'json'

const SCALARS = new Set(['string', 'number', 'integer', 'boolean'])

/** The names of a list of named numbers (`[x, y, w, h]`, the kit command syntax's description). */
function tupleNames(node: Node) {
  const match = /^\[([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)+)\]$/.exec(node.description ?? '')
  return match ? match[1].split(',').map((name) => name.trim()) : null
}

function shapeOf(node: Node): Shape {
  if (node.enum?.length || SCALARS.has(node.type ?? '')) return 'scalar'
  if (node.type === 'array') {
    const items = node.items
    if (items?.enum?.length) return 'choices'
    if (items && SCALARS.has(items.type ?? '')) return tupleNames(node) ? 'tuple' : 'list'
    return 'json'
  }
  if (node.type === 'object' && node.properties && Object.keys(node.properties).length) return 'object'
  return 'json'
}

function draftOf(node: Node, given: unknown): Draft {
  const value = given !== undefined ? given : node.default
  switch (shapeOf(node)) {
    case 'list':
      return Array.isArray(value) ? value.map((item) => draftOf(node.items!, item)) : []
    case 'tuple': {
      const names = tupleNames(node)!
      return names.map((_, index) => draftOf(node.items!, Array.isArray(value) ? value[index] : undefined))
    }
    case 'choices':
      return Array.isArray(value) ? value.map(String) : []
    case 'object': {
      const object = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
      return Object.fromEntries(Object.entries(node.properties!).map(([key, inner]) => [key, draftOf(inner, object[key])]))
    }
    default:
      return initial(node, given)
  }
}

function parseDraft(node: Node, draft: Draft): unknown {
  const shape = shapeOf(node)
  if (shape === 'list' || shape === 'tuple') {
    const items = (draft as Draft[]).map((item) => parseDraft(node.items!, item))
    if (shape === 'tuple') return items.every((item) => item === undefined) ? undefined : items.map((item) => item ?? 0)
    const kept = items.filter((item) => item !== undefined)
    return kept.length ? kept : undefined
  }
  if (shape === 'choices') {
    const picked = node.items!.enum!.filter((choice) => (draft as string[]).includes(String(choice)))
    return picked.length ? picked : undefined
  }
  if (shape === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(node.properties!)) {
      const value = parseDraft(inner, (draft as Record<string, Draft>)[key] ?? '')
      if (value !== undefined) out[key] = value
    }
    // An object nobody filled in (its check boxes all off) is not sent.
    return Object.values(out).some((value) => value !== false) ? out : undefined
  }
  return parse(node, typeof draft === 'string' ? draft : '')
}

/**
 * A command's parameters as a form, from its schema (standard A5): a menu for an enum, a number
 * field, a check box, or a text field (JSON for arrays and objects, unless `structured`). Runs it
 * with the values.
 */
export function CommandDialog({
  command,
  onRun,
  onClose,
  labels,
  values: given = {},
  title,
  label: nameOf,
  choice: choiceOf,
  structured = false,
}: {
  command: KitCommand
  onRun: (params: Record<string, unknown>) => void
  onClose: () => void
  labels: { run: string; cancel: string; required: string; more?: string; add?: string; remove?: string }
  /** Values to start with (the current page), over the schema's defaults. */
  values?: Record<string, unknown>
  /** The dialog's title, translated (the command's title by default). */
  title?: string
} & CommandDialogOptions) {
  const schema = (command.schema ?? {}) as Record<string, Node>
  const [values, setValues] = useState<Record<string, Draft>>(() => Object.fromEntries(Object.entries(schema).map(([key, node]) => [key, structured ? draftOf(node, given[key]) : initial(node, given[key])])))
  // A long form shows what must or was given first, and the other optional values under
  // "More options"; a short one shows everything.
  const entries = Object.entries(schema)
  const fold = entries.length > FOLD_AFTER
  const shownFirst = ([key, node]: [string, Node]) => !fold || node.required || given[key] !== undefined
  const main = entries.filter(shownFirst)
  const more = entries.filter((entry) => !shownFirst(entry))
  const nameFor = (path: string, node: Node) => nameOf?.(path, command, node as Record<string, unknown>) ?? path.slice(path.lastIndexOf('.') + 1)
  const choiceFor = (path: string, value: unknown) => choiceOf?.(path, value, command) ?? String(value)

  /** The control of a value that is one text (a menu, a check box, a number or text field). */
  const scalar = (path: string, id: string, node: Node, value: string, set: (value: string) => void, name?: string) =>
    node.enum?.length ? (
      <select key={id} id={id} className="kui-field" value={value} aria-label={name} onChange={(event) => set(event.target.value)}>
        {node.required ? null : <option value="" />}
        {node.enum.map((choice) => (
          <option key={String(choice)} value={String(choice)}>
            {choiceFor(path, choice)}
          </option>
        ))}
      </select>
    ) : node.type === 'boolean' ? (
      <input key={id} id={id} type="checkbox" checked={value === 'true'} aria-label={name} onChange={(event) => set(String(event.target.checked))} />
    ) : (
      <input
        key={id}
        id={id}
        className="kui-field"
        type={node.type === 'number' || node.type === 'integer' ? 'number' : 'text'}
        value={value}
        placeholder={node.description}
        aria-label={name}
        onChange={(event) => set(event.target.value)}
      />
    )

  /** The control of a value in a structured dialog: its fields, by the value's shape. */
  const control = (path: string, id: string, node: Node, draft: Draft, set: (draft: Draft) => void): ReactNode => {
    switch (shapeOf(node)) {
      case 'list': {
        const items = draft as Draft[]
        const item = node.items!
        return (
          <div key={id} id={id} className="kui-param-list" role="group" aria-label={nameFor(path, node)}>
            {items.map((value, index) => (
              <div key={index} className="kui-param-item">
                {scalar(path, `${id}-${index}`, item, value as string, (next) => set(items.map((old, at) => (at === index ? next : old))), `${nameFor(path, node)} ${index + 1}`)}
                <Button size="sm" variant="ghost" onClick={() => set(items.filter((_, at) => at !== index))} data-testid={`${id}-remove-${index}`}>
                  {labels.remove ?? 'Remove'}
                </Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => set([...items, draftOf(item, undefined)])} data-testid={`${id}-add`}>
              {labels.add ?? 'Add'}
            </Button>
          </div>
        )
      }
      case 'tuple': {
        const items = draft as Draft[]
        const names = tupleNames(node)!
        return (
          <div key={id} id={id} className="kui-param-tuple" role="group" aria-label={nameFor(path, node)}>
            {names.map((name, index) => (
              <label key={name} className="kui-param-part">
                <span>{nameFor(`${path}.${name}`, node.items!)}</span>
                {scalar(path, `${id}-${name}`, node.items!, items[index] as string, (next) => set(items.map((old, at) => (at === index ? next : old))))}
              </label>
            ))}
          </div>
        )
      }
      case 'choices': {
        const picked = draft as string[]
        return (
          <div key={id} id={id} className="kui-param-choices" role="group" aria-label={nameFor(path, node)}>
            {node.items!.enum!.map((choice) => {
              const value = String(choice)
              return (
                <label key={value} className="kui-param-part">
                  <input type="checkbox" id={`${id}-${value}`} checked={picked.includes(value)} onChange={(event) => set(event.target.checked ? [...picked, value] : picked.filter((old) => old !== value))} />
                  <span>{choiceFor(path, choice)}</span>
                </label>
              )
            })}
          </div>
        )
      }
      case 'object': {
        const object = draft as Record<string, Draft>
        return (
          <div key={id} id={id} className="kui-param-grid kui-param-object" role="group" aria-label={nameFor(path, node)}>
            {Object.entries(node.properties!).flatMap(([key, inner]) => [
              <label key={`${key}-label`} htmlFor={`${id}-${key}`} title={inner.description}>
                {nameFor(`${path}.${key}`, inner)}
              </label>,
              control(`${path}.${key}`, `${id}-${key}`, inner, object[key] ?? '', (next) => set({ ...object, [key]: next })),
            ])}
          </div>
        )
      }
      default:
        return scalar(path, id, node, typeof draft === 'string' ? draft : '', set)
    }
  }

  const field = ([key, node]: [string, Node]) => {
    const set = (value: Draft) => setValues((current) => ({ ...current, [key]: value }))
    const id = `param-${key}`
    return [
      <label key={`${key}-label`} htmlFor={id} title={node.description}>
        {nameFor(key, node)}
        {node.required ? <span title={labels.required}> *</span> : null}
      </label>,
      structured ? control(key, id, node, values[key] ?? '', set) : scalar(key, id, node, values[key] as string, set),
    ]
  }
  const missing = Object.entries(schema).some(([key, node]) => node.required && (structured ? parseDraft(node, values[key] ?? '') === undefined : ((values[key] as string) ?? '').trim() === ''))
  const submit = () => {
    const params: Record<string, unknown> = {}
    for (const [key, node] of Object.entries(schema)) {
      const value = structured ? parseDraft(node, values[key] ?? '') : parse(node, (values[key] as string) ?? '')
      if (value !== undefined) params[key] = value
    }
    onRun(params)
  }
  return (
    <Dialog
      title={title ?? command.title}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{labels.cancel}</Button>
          <Button variant="primary" disabled={missing} onClick={submit} data-testid="command-dialog-run">
            {labels.run}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!missing) submit()
        }}
      >
        <div className="kui-param-grid">{main.map(field)}</div>
        {more.length ? (
          <details>
            <summary>{labels.more ?? 'More options'}</summary>
            <div className="kui-param-grid">{more.map(field)}</div>
          </details>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
