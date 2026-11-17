/**
 * The documents the tests open, and how they drive the Note kit's editor. A note is its Markdown
 * text, so a saved note is read as text; the Note engine is loaded only to tell whether the kit's
 * package is there.
 */
import path from 'node:path'
import { expect, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, kitsDir } from './helpers'

/** The Note kit's engine: whether its package is built. */
export const noteEngine = kitEngine<{ NoteDocument: unknown }>('note', 'kition_note_kit')

/**
 * Fails, never skips, without the Note kit's package: the package is public, not a private tool
 * (docs/quality.md, Private tools), so a missing one is a failure that says how to get it.
 */
export function requireNoteKit() {
  expect(noteEngine.built, `no Note kit package in ${path.join(kitsDir, 'note-ui')}: run make kit-fetch in the Kition checkout beside this repository, or set KITION_KITS_DIR to a folder holding note-ui/`).toBe(true)
}

export const NOTES = 'Notes.md'

/** An existing Markdown document: a heading, a paragraph, and a list. */
export const NOTES_TEXT = '# Notes\n\nGoals for the quarter.\n\n- Hire\n- Ship\n'

/** The note's file: its text. */
export const noteFixture = () => Buffer.from(NOTES_TEXT)

/** The note an editor shows, as text (its accessible document). */
export async function noteText(kit: FrameLocator) {
  return (await kit.getByTestId('note-text').textContent({ timeout: 5_000 }).catch(() => null)) ?? ''
}

/** Waits until the editor shows `text`. */
export async function waitForNoteText(kit: FrameLocator, text: string) {
  await expect.poll(() => noteText(kit), { timeout: 60_000 }).toContain(text)
}

/** Presses `key` with the platform's command key, as the kit reads the platform. */
export async function pressCommand(page: Page, kit: FrameLocator, key: string) {
  const mac = await kit.locator('body').evaluate(() => /Mac|iPhone|iPad/i.test(navigator.platform))
  await page.keyboard.press(`${mac ? 'Meta' : 'Control'}+${key}`)
}

/**
 * Puts the caret right after `text` (its first occurrence) the way a person can on the canvas:
 * Find selects it, Escape closes the find bar, and ArrowRight collapses the selection at its end.
 * With `select`, the found text stays selected.
 */
export async function caretAfter(page: Page, kit: FrameLocator, text: string, { select = false } = {}) {
  await waitForNoteText(kit, text)
  await kit.getByTestId('note-canvas').click({ position: { x: 10, y: 10 } })
  await pressCommand(page, kit, 'f')
  const input = kit.getByTestId('note-find-input')
  await expect(input).toBeVisible()
  await input.fill(text)
  await input.press('Enter')
  await input.press('Escape')
  await expect(kit.getByTestId('note-find')).toHaveCount(0)
  // The keyboard goes back to the note a frame after Find closes; a key pressed before then is lost.
  await expect(kit.getByTestId('kit-text-sink')).toBeFocused()
  if (!select) await page.keyboard.press('ArrowRight')
}

/** Types `text` at the end of the line that holds `after`. */
export async function typeAfter(page: Page, kit: FrameLocator, after: string, text: string) {
  await caretAfter(page, kit, after)
  await page.keyboard.type(text)
}
