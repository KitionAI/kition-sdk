/** Where the live window goes. */

/** The smallest floating window the editor works in beside the conversation, CSS pixels. */
const FLOAT_MIN = { width: 420, height: 360 }

/**
 * Where a live window fits: beside the conversation (right of its column, the composer marking it),
 * as wide and tall as there is room for; null when there is too little room, and the file goes in
 * the right sidebar instead, which moves the conversation over rather than covering it.
 */
export function liveWindowRect(viewport: { width: number; height: number }, conversation: { right: number } | null) {
  const left = Math.round((conversation?.right ?? viewport.width) + 16)
  const width = Math.min(640, viewport.width - left - 16)
  const height = Math.min(760, viewport.height - 96 - 16)
  if (width < FLOAT_MIN.width || height < FLOAT_MIN.height) return null
  return { x: left, y: 96, width, height }
}
