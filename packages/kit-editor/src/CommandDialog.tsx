import { useState } from 'react'
import { Button, Dialog } from '@kition/tessera-ui'
import type { KitCommand } from './engine/kitModule'

type Node = { type?: string; description?: string; enum?: unknown[]; default?: unknown; required?: boolean; items?: Node; oneOf?: Node[] }

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

/**
 * A command's parameters as a form, from its schema (standard A5): a menu for an enum, a number
 * field, a check box, or a text field (JSON for arrays and objects). Runs it with the values.
 */
export function CommandDialog({
  command,
  onRun,
  onClose,
  labels,
  values: given = {},
  title,
}: {
  command: KitCommand
  onRun: (params: Record<string, unknown>) => void
  onClose: () => void
  labels: { run: string; cancel: string; required: string; more?: string }
  /** Values to start with (the current page), over the schema's defaults. */
  values?: Record<string, unknown>
  /** The dialog's title, translated (the command's title by default). */
  title?: string
}) {
  const schema = (command.schema ?? {}) as Record<string, Node>
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(schema).map(([key, node]) => [key, initial(node, given[key])])))
  // A long form shows what must or was given first, and the other optional values under
  // "More options"; a short one shows everything.
  const entries = Object.entries(schema)
  const fold = entries.length > FOLD_AFTER
  const shownFirst = ([key, node]: [string, Node]) => !fold || node.required || given[key] !== undefined
  const main = entries.filter(shownFirst)
  const more = entries.filter((entry) => !shownFirst(entry))
  const field = ([key, node]: [string, Node]) => {
    const set = (value: string) => setValues((current) => ({ ...current, [key]: value }))
    const id = `param-${key}`
    return [
      <label key={`${key}-label`} htmlFor={id} title={node.description}>
        {key}
        {node.required ? <span title={labels.required}> *</span> : null}
      </label>,
      node.enum?.length ? (
        <select key={key} id={id} className="kui-field" value={values[key]} onChange={(event) => set(event.target.value)}>
          {node.required ? null : <option value="" />}
          {node.enum.map((choice) => (
            <option key={String(choice)} value={String(choice)}>
              {String(choice)}
            </option>
          ))}
        </select>
      ) : node.type === 'boolean' ? (
        <input key={key} id={id} type="checkbox" checked={values[key] === 'true'} onChange={(event) => set(String(event.target.checked))} />
      ) : (
        <input
          key={key}
          id={id}
          className="kui-field"
          type={node.type === 'number' || node.type === 'integer' ? 'number' : 'text'}
          value={values[key]}
          placeholder={node.description}
          onChange={(event) => set(event.target.value)}
        />
      ),
    ]
  }
  const missing = Object.entries(schema).some(([key, node]) => node.required && (values[key] ?? '').trim() === '')
  const submit = () => {
    const params: Record<string, unknown> = {}
    for (const [key, node] of Object.entries(schema)) {
      const value = parse(node, values[key] ?? '')
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
