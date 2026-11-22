import { mergeDamage, type RasterRect } from './rasterViewport'

/** The empty area: the state was refreshed, the pixels are known to be unchanged. */
export const NOTHING: RasterRect = { x0: 0, y0: 0, x1: 0, y1: 0 }

/**
 * At most this many areas are kept apart. One added beyond it merges the two oldest into one,
 * numbered as the later of them: it stays owed at least as long, so the canvas may repaint more
 * than it must, never less. A store whose repaints nobody commits (a kit that only listens) keeps
 * no more than this.
 */
const KEPT = 32

/**
 * The repaints the canvas owes, until a repaint that holds them is committed. `add` numbers each
 * area asked for; `total` is what every area still owed asks for together (`mergeDamage`: the
 * whole canvas, null, wins over anything; the empty area adds nothing; two areas give the
 * rectangle covering both); `last` is the number of the last area added, which `total` holds;
 * `paid(n)` drops the areas numbered up to `n`, which a committed repaint held. React may take
 * several repaints in one render: taken this way, the canvas repaints what all of them owe, not
 * only the last one's area, and an area it already repainted is not owed again.
 */
export type OwedDamage = {
  add(damage: RasterRect | null): number
  total(): RasterRect | null
  last(): number
  paid(upTo: number): void
}

export function owedDamage(): OwedDamage {
  let owed: Array<{ seq: number; damage: RasterRect | null }> = []
  let seq = 0
  return {
    add(damage) {
      seq += 1
      owed.push({ seq, damage })
      if (owed.length > KEPT) {
        const [first, second, ...rest] = owed
        owed = [{ seq: second.seq, damage: mergeDamage(first.damage, second.damage) }, ...rest]
      }
      return seq
    },
    total: () => owed.reduce<RasterRect | null>((sum, entry) => mergeDamage(sum, entry.damage), NOTHING),
    last: () => seq,
    paid(upTo) {
      owed = owed.filter((entry) => entry.seq > upTo)
    },
  }
}
