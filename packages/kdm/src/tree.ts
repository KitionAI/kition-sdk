/**
 * A tree field: its nodes are object ids, one node per object, each under a parent (`null`: a
 * root) at a place among its siblings, as the Rust store holds it.
 */
import type { ObjectId } from './ids'
import type { JsonValue } from './value'

export class Tree {
  private readonly parents = new Map<ObjectId, ObjectId | null>()
  private readonly roots: ObjectId[] = []
  private readonly kids = new Map<ObjectId, ObjectId[]>()

  isEmpty(): boolean {
    return this.parents.size === 0
  }

  get size(): number {
    return this.parents.size
  }

  contains(node: ObjectId): boolean {
    return this.parents.has(node)
  }

  /** The children of `parent` (`null`: the roots), in order. */
  children(parent: ObjectId | null): readonly ObjectId[] {
    return parent === null ? this.roots : (this.kids.get(parent) ?? [])
  }

  /** Every node. */
  nodes(): IterableIterator<ObjectId> {
    return this.parents.keys()
  }

  /** The node's parent and its index among its siblings, or `null` when the tree has no such node. */
  place(node: ObjectId): [ObjectId | null, number] | null {
    const parent = this.parents.get(node)
    if (parent === undefined) return null
    return [parent, this.children(parent).indexOf(node)]
  }

  /** Whether putting `node` under `parent` would make it its own ancestor. */
  wouldCycle(node: ObjectId, parent: ObjectId): boolean {
    let at: ObjectId | null = parent
    let steps = 0
    while (at !== null) {
      if (at === node || steps > this.parents.size) return true
      steps += 1
      at = this.parents.get(at) ?? null
    }
    return false
  }

  /** Adds `node` under `parent` at `index` (at most the number of its children). */
  insert(node: ObjectId, parent: ObjectId | null, index: number): void {
    let siblings = parent === null ? this.roots : this.kids.get(parent)
    if (!siblings) {
      siblings = []
      this.kids.set(parent as ObjectId, siblings)
    }
    siblings.splice(Math.min(index, siblings.length), 0, node)
    this.parents.set(node, parent)
  }

  /** Takes `node` out of its parent's children (its own children stay under it); answers its place. */
  detach(node: ObjectId): [ObjectId | null, number] | null {
    const place = this.place(node)
    if (!place) return null
    const [parent, index] = place
    const siblings = parent === null ? this.roots : this.kids.get(parent)
    siblings?.splice(index, 1)
    if (parent !== null && siblings?.length === 0) this.kids.delete(parent)
    this.parents.delete(node)
    return place
  }

  /** The nodes in pre-order (each parent before its children, siblings in order), each with its parent and depth. */
  preorder(): Array<{ node: ObjectId; parent: ObjectId | null; depth: number }> {
    const out: Array<{ node: ObjectId; parent: ObjectId | null; depth: number }> = []
    const stack: Array<{ node: ObjectId; parent: ObjectId | null; depth: number }> = [...this.roots].reverse().map((node) => ({ node, parent: null, depth: 0 }))
    while (stack.length) {
      const entry = stack.pop()!
      out.push(entry)
      const children = this.kids.get(entry.node) ?? []
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], parent: entry.node, depth: entry.depth + 1 })
    }
    return out
  }

  /**
   * The tree as the canonical state writes it: `[{"children":[...],"object":"<id>"}]`, siblings in
   * order; a node `keep` refuses is left out with its subtree. Built without recursion.
   */
  toJson(keep: (node: ObjectId) => boolean): JsonValue {
    const top: JsonValue[] = []
    const stack: Array<{ node: ObjectId; into: JsonValue[] }> = [...this.roots].reverse().map((node) => ({ node, into: top }))
    while (stack.length) {
      const { node, into } = stack.pop()!
      if (!keep(node)) continue
      const children: JsonValue[] = []
      into.push({ children, object: node })
      const kids = this.kids.get(node) ?? []
      for (let index = kids.length - 1; index >= 0; index -= 1) stack.push({ node: kids[index], into: children })
    }
    return top
  }
}
