/**
 * `KitEmbed 1.1` in the example page, single-user: what the person may do comes from the page's
 * identity (`permissions`), the people are named by its directory (`users`), the page hears the
 * document's comment threads (`comments`), and its own button in the editor (`ui`) reports
 * presses (`action`).
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { NOTES, NOTES_TEXT, caretAfter, noteEngine, noteFixture, noteText, typeAfter, waitForNoteText } from './fixtures'
import { errors, fileBytes, openApp, openFile, saves, upload, type Hook } from './helpers'

test.beforeEach(() => {
  test.skip(!noteEngine.built, 'no Note kit package: set KITION_KITS_DIR to a folder holding note-ui/')
})

const mode = (page: Page, name: string) => page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).mode(wanted), name)
const comments = (page: Page, name: string) => page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).comments(wanted), name)
// The page writes as itself, so it names the person the comment is from: the Note kit refuses anyone else.
const comment = (page: Page, name: string, text: string) => page.evaluate(([wanted, body]) => (window.__EMBED_TEST__ as Hook).run(wanted, 'comment.add', { body, quote: 'Hire', author: 'dev:alice' }), [name, text] as const)

/** Selects `quote` and types a comment on it into the kit's comments pane. */
async function typeComment(page: Page, kit: FrameLocator, quote: string, text: string) {
  await caretAfter(page, kit, quote, { select: true })
  if ((await kit.getByTestId('note-comments-new').count()) === 0) await kit.getByTestId('note-comments-toggle').click()
  await kit.getByTestId('note-comments-new').click()
  await kit.getByTestId('note-comment-panel-new-input').fill(text)
  await kit.getByTestId('note-comment-panel-new-send').click()
}

test('a commenter (identity.permissions) comments on a note but changes nothing else, and the page hears the comments under its directory’s names', async ({ page }) => {
  await openApp(page, { mode: 'comment' })
  const bytes = noteFixture()
  await upload(page, NOTES, bytes)
  const { pane, kit } = await openFile(page, NOTES)
  await waitForNoteText(kit, 'Goals for the quarter.')
  expect(await mode(page, NOTES)).toBe('comment')

  // The content is read-only: no Save, and typing changes nothing.
  await expect(kit.getByTestId('note-view-only')).toBeVisible()
  await expect(kit.getByTestId('note-save')).toHaveCount(0)
  await typeAfter(page, kit, 'Goals for the quarter.', ' Then grow.')
  await page.waitForTimeout(500)
  expect(await noteText(kit)).not.toContain('Then grow.')

  // A comment through the kit's command, then one typed into its comments pane.
  await comment(page, NOTES, 'Looks good')
  await expect(pane).toHaveAttribute('data-comments', '1', { timeout: 15_000 })
  await typeComment(page, kit, 'Ship', 'Typed by a commenter')
  await expect(pane).toHaveAttribute('data-comments', '2', { timeout: 15_000 })
  await expect(kit.getByTestId('note-comment-panel-comment')).toHaveCount(2)
  expect((await comments(page, NOTES)).sort()).toEqual(['Alice Adams: Looks good', 'Alice Adams: Typed by a commenter'])
  expect(await page.evaluate(() => (window.__EMBED_TEST__ as Hook).usersAsked())).toContain('dev:alice')

  // Nothing reached the file.
  expect(await noteText(kit)).toContain(NOTES_TEXT.trim().split('\n').at(-1)!)
  expect(await saves(page, NOTES)).toBe(0)
  expect((await fileBytes(page, NOTES)).equals(bytes)).toBe(true)
  expect(await errors(page)).toEqual([])
})

test('the page’s own button in the editor (ui option) reports its presses, and an editor hears comments too', async ({ page }) => {
  await openApp(page)
  await upload(page, NOTES, noteFixture())
  const { pane, kit } = await openFile(page, NOTES)
  await waitForNoteText(kit, 'Goals for the quarter.')
  expect(await mode(page, NOTES)).toBe('edit')

  const submit = kit.locator('[data-kit-ui-id="host:example.submit"]')
  await expect(submit).toBeVisible()
  await expect(submit).toHaveText('Submit for review')
  await submit.click()
  await expect(page.getByTestId('notice')).toHaveText(`action: example.submit on ${NOTES}`)

  // The editor still edits, and the comments typed into its pane (as the person the page names) reach the page as well.
  await typeAfter(page, kit, 'Goals for the quarter.', ' Then grow.')
  await waitForNoteText(kit, 'Goals for the quarter. Then grow.')
  await typeComment(page, kit, 'Ship', 'Ship it')
  await expect(pane).toHaveAttribute('data-comments', '1', { timeout: 15_000 })
  expect(await comments(page, NOTES)).toEqual(['Alice Adams: Ship it'])
  expect(await errors(page)).toEqual([])
})
