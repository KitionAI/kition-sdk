/**
 * One person: the page's own storage behind the embedded Note editor, served from
 * another origin. Open, edit, save, reopen; a script through the object model; and view mode
 * refuses edits.
 */
import { expect, test } from '@playwright/test'
import { NOTES, NOTES_TEXT, noteEngine, noteFixture, noteText, typeAfter, waitForNoteText } from './fixtures'
import { closeFile, errors, fileBytes, openApp, openFile, saves, upload, type Hook } from './helpers'

test.beforeEach(() => {
  test.skip(!noteEngine.built, 'no Note kit package: set KITION_KITS_DIR to a folder holding note-ui/')
})

test('the kit editor comes from another origin than the page, under both origins’ policies', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
  })
  await openApp(page)
  await upload(page, NOTES, noteFixture())
  const { pane, kit } = await openFile(page, NOTES)
  await waitForNoteText(kit, 'Goals for the quarter.')
  const src = await pane.locator('iframe').getAttribute('src')
  expect(new URL(src!).origin).not.toBe(new URL(page.url()).origin)
  expect(await pane.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-downloads allow-popups')
  const kitPage = await page.request.get(src!)
  expect(kitPage.headers()['content-security-policy']).toContain("'wasm-unsafe-eval'")
  expect(violations).toEqual([])
  expect(await errors(page)).toEqual([])
})

test('Note: opens a Markdown file, edits it, and saves it through the page’s storage, and reopens with the edit', async ({ page }) => {
  await openApp(page)
  await upload(page, NOTES, noteFixture())
  const { pane, kit } = await openFile(page, NOTES)
  // The Note kit's own editor, over its engine in a worker.
  await expect(kit.getByTestId('note-editor')).toBeVisible({ timeout: 60_000 })
  await waitForNoteText(kit, 'Goals for the quarter.')

  // The kit's own Save writes through the provider.
  await typeAfter(page, kit, 'Goals for the quarter.', ' Then grow.')
  await expect(kit.getByTestId('note-unsaved')).toBeVisible()
  await kit.getByTestId('note-save').click()
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0, { timeout: 30_000 })
  expect(await saves(page, NOTES)).toBe(1)
  expect((await fileBytes(page, NOTES)).toString('utf8')).toBe('# Notes\n\nGoals for the quarter. Then grow.\n\n- Hire\n- Ship\n')

  // The page's Save (`editor.save()`) does too.
  await typeAfter(page, kit, 'Ship', ' it')
  await expect(kit.getByTestId('note-unsaved')).toBeVisible()
  await pane.getByTestId('pane-save').click()
  await expect.poll(() => saves(page, NOTES), { timeout: 30_000 }).toBe(2)
  const saved = '# Notes\n\nGoals for the quarter. Then grow.\n\n- Hire\n- Ship it\n'
  expect((await fileBytes(page, NOTES)).toString('utf8')).toBe(saved)

  // Closed and opened again (and after a reload, from IndexedDB): the saved note.
  await closeFile(page, NOTES)
  const again = await openFile(page, NOTES)
  await waitForNoteText(again.kit, 'Ship it')
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__EMBED_TEST__))
  const reloaded = await openFile(page, NOTES)
  await waitForNoteText(reloaded.kit, 'Ship it')
  expect(await errors(page)).toEqual([])
})

test('Note: a script edits the note through the object model (@kition/script), the editor undoes it, and the edit saves', async ({ page }) => {
  await openApp(page)
  await upload(page, NOTES, noteFixture())
  const { pane, kit } = await openFile(page, NOTES)
  await waitForNoteText(kit, 'Goals for the quarter.')

  // The same script examples/sdk-scripts/run-node.mjs runs headless.
  const result = await page.evaluate((name) => (window.__EMBED_TEST__ as Hook).runReview(name), NOTES)
  const reviewed = `${NOTES_TEXT}\n## Q3 Quarterly review\n\n- [x] Share the revenue numbers\n`
  expect(result).toEqual({ heading: 'Q3 Quarterly review', level: 2, task: { text: 'Share the revenue numbers', checked: true }, text: reviewed })
  // The editor shows the script's section.
  await waitForNoteText(kit, 'Q3 Quarterly review')
  const read = () => page.evaluate((name) => (window.__EMBED_TEST__ as Hook).readNote(name), NOTES)
  expect(await read()).toBe(reviewed)
  // The kit answers the object model itself, so the script's edits are steps of the person's own
  // history: Undo takes back the checked task, then the heading's "Q3 ", then the section the
  // script's command added; Redo brings them back in order.
  const undo = kit.getByTestId('note-undo')
  const redo = kit.getByTestId('note-redo')
  const unchecked = reviewed.replace('- [x]', '- [ ]')
  const added = unchecked.replace('Q3 Quarterly review', 'Quarterly review')
  await undo.click()
  await expect.poll(read, { timeout: 30_000 }).toBe(unchecked)
  await undo.click()
  await expect.poll(read, { timeout: 30_000 }).toBe(added)
  await undo.click()
  await expect.poll(read, { timeout: 30_000 }).toBe(NOTES_TEXT)
  await redo.click()
  await expect.poll(read, { timeout: 30_000 }).toBe(added)
  await redo.click()
  await expect.poll(read, { timeout: 30_000 }).toBe(unchecked)
  await redo.click()
  await expect.poll(read, { timeout: 30_000 }).toBe(reviewed)
  await expect(redo).toBeDisabled()
  // Its Save writes the script's edits.
  await pane.getByTestId('pane-save').click()
  await expect.poll(() => saves(page, NOTES), { timeout: 30_000 }).toBe(1)
  expect((await fileBytes(page, NOTES)).toString('utf8')).toBe(reviewed)
  expect(await errors(page)).toEqual([])
})

test('view mode writes nothing to the page’s storage: the kit offers no Save, and the page’s is refused', async ({ page }) => {
  await openApp(page, { mode: 'view' })
  const bytes = noteFixture()
  await upload(page, NOTES, bytes)

  const { pane, kit } = await openFile(page, NOTES)
  await waitForNoteText(kit, 'Goals for the quarter.')
  // The kit offers no Save, and the page's Save is refused: nothing reaches the file.
  await expect(kit.getByTestId('note-view-only')).toBeVisible()
  await expect(kit.getByTestId('note-save')).toHaveCount(0)
  await pane.getByTestId('pane-save').click()

  await expect.poll(async () => (await errors(page)).length, { timeout: 15_000 }).toBeGreaterThan(0)
  expect(await saves(page, NOTES)).toBe(0)
  expect((await fileBytes(page, NOTES)).equals(bytes)).toBe(true)
  for (const error of await errors(page)) expect(error).toMatch(/read-only/)
})

test('view mode: the Note editor refuses edits on screen', async ({ page }) => {
  await openApp(page, { mode: 'view' })
  await upload(page, NOTES, noteFixture())
  const { kit } = await openFile(page, NOTES)
  await waitForNoteText(kit, 'Goals for the quarter.')
  // Moving around still works; typing changes nothing.
  await typeAfter(page, kit, 'Goals for the quarter.', ' Then grow.')
  await page.waitForTimeout(500)
  expect(await noteText(kit)).not.toContain('Then grow.')
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0)
})
