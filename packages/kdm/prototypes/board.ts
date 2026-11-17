/**
 * Whiteboard on the KDM: the phase 1 prototype of the built-in board's `BoardStore` records.
 * Updates are property-level patches, element ids come from the KDM (never `Date.now()`), and z
 * order is a movable list, so concurrent edits keep each other's intent.
 */
import { parseSchema, type ObjectId, type Origin, type Replica } from '../src/index'
import schemaJson from './board-schema.json'

export const boardSchema = parseSchema(schemaJson)

export type ElementKind = 'rect' | 'ellipse' | 'text' | 'arrow'

export interface ElementProps {
  kind: ElementKind
  x: number
  y: number
  w: number
  h: number
  rotation?: number
  fill?: string
  stroke?: string
}

export type ElementPatch = Partial<Omit<ElementProps, 'kind'>>

export interface BoardElement extends ElementProps {
  id: ObjectId
  text: string
}

const PATCHABLE: ReadonlyArray<keyof ElementPatch> = ['x', 'y', 'w', 'h', 'rotation', 'fill', 'stroke']

export class BoardModel {
  private constructor(
    readonly replica: Replica,
    readonly board: ObjectId,
  ) {}

  /** A new board with one page in an empty replica. */
  static create(replica: Replica, origin: Origin, name = 'Board'): BoardModel {
    const board = replica.transact(origin, (tx) => {
      const board = tx.create('Board', { name })
      tx.listInsert(board, 'pages', 0, tx.create('Page', { name: 'Page 1' }))
      return board
    })
    return new BoardModel(replica, board)
  }

  /** The board of a replica that already has one. */
  static open(replica: Replica): BoardModel {
    const [board] = replica.objectsOfType('Board')
    if (!board) throw new Error('the replica holds no board')
    return new BoardModel(replica, board)
  }

  page(): ObjectId {
    return this.replica.list(this.board, 'pages')[0]
  }

  add(props: ElementProps, origin: Origin): ObjectId {
    return this.replica.transact(origin, (tx) => {
      const element = tx.create('Element', { ...props })
      const page = this.page()
      tx.listInsert(page, 'elements', tx.list(page, 'elements').length, element)
      return element
    })
  }

  /** Sets only the patched properties. */
  update(id: ObjectId, patch: ElementPatch, origin: Origin): void {
    this.replica.transact(origin, (tx) => {
      for (const key of PATCHABLE) if (key in patch) tx.set(id, key, patch[key] ?? null)
    })
  }

  setText(id: ObjectId, text: string, origin: Origin): void {
    this.replica.transact(origin, (tx) => {
      const length = tx.textLength(id, 'text')
      if (length) tx.textDelete(id, 'text', 0, length)
      if (text) tx.textInsert(id, 'text', 0, text)
    })
  }

  remove(id: ObjectId, origin: Origin): void {
    this.replica.transact(origin, (tx) => {
      const page = this.page()
      const index = tx.list(page, 'elements').indexOf(id)
      if (index >= 0) tx.listRemove(page, 'elements', index)
      if (tx.exists(id)) tx.delete(id)
    })
  }

  bringToFront(id: ObjectId, origin: Origin): void {
    this.replica.transact(origin, (tx) => {
      const page = this.page()
      const order = tx.list(page, 'elements')
      const index = order.indexOf(id)
      if (index >= 0 && index !== order.length - 1) tx.listMove(page, 'elements', index, order.length - 1)
    })
  }

  /** Live elements in z order, back to front; ids whose object was deleted are skipped. */
  elements(): BoardElement[] {
    const out: BoardElement[] = []
    for (const id of this.replica.list(this.page(), 'elements')) {
      if (!this.replica.exists(id)) continue
      const element: BoardElement = {
        id,
        kind: this.replica.get(id, 'kind') as ElementKind,
        x: this.replica.get(id, 'x') as number,
        y: this.replica.get(id, 'y') as number,
        w: this.replica.get(id, 'w') as number,
        h: this.replica.get(id, 'h') as number,
        text: this.replica.text(id, 'text'),
      }
      for (const key of ['rotation', 'fill', 'stroke'] as const) {
        const value = this.replica.get(id, key)
        if (value !== null) (element as unknown as Record<string, unknown>)[key] = value
      }
      out.push(element)
    }
    return out
  }
}
