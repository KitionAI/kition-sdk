/**
 * Two pages (two browser contexts, Alice and Bob) co-edit one note through a Kition Server: live,
 * then with Bob offline while both edit, until both hold both edits. Bob reconnects with a token
 * asked for again.
 */
import { expect, test, type Browser, type Page } from '@playwright/test'
import { NOTES, noteFixture, requireNoteKit, typeAfter, waitForNoteText } from './fixtures'
import {
  collabState,
  collabStatus,
  errors,
  fileBytes,
  join,
  kitionServerSkipReason,
  liveTo,
  openApp,
  openFile,
  replicaCounters,
  sameReplica,
  saves,
  settledVersion,
  shareLink,
  startKitionServer,
  syncNetwork,
  tokenCalls,
  upload,
  type KitionServer,
} from './helpers'

let server: KitionServer | null = null

test.beforeEach(async ({}, testInfo) => {
  requireNoteKit()
  const unavailable = kitionServerSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  testInfo.setTimeout(600_000)
  server = await startKitionServer(testInfo.title.replace(/\W+/g, '-').slice(0, 40))
})

test.afterEach(async () => {
  await server?.stop()
  server = null
})

/** Alice's and Bob's pages, Bob's sync connection one the test can cut. */
async function twoPages(browser: Browser) {
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  const pageA = await alice.newPage()
  const pageB = await bob.newPage()
  await openApp(pageA, { user: 'alice', server: server!.url })
  await openApp(pageB, { user: 'bob', server: server!.url })
  return { pageA, pageB, bobNetwork, close: async () => Promise.all([alice.close(), bob.close()]) }
}

/** Alice shares `name` (open in her page); Bob joins from the page's link. */
async function share(pageA: Page, pageB: Page, name: string, ready: (kit: import('@playwright/test').FrameLocator) => Promise<void>) {
  const a = await openFile(pageA, name)
  await ready(a.kit)
  await expect(collabStatus(a)).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
  const link = await shareLink(a)
  const b = await join(pageB, link, name)
  await ready(b.kit)
  await expect(collabStatus(b)).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
  // The people in the room as the page's directory names them (`identity.users`), with avatars.
  await expect(a.pane).toHaveAttribute('data-peers', 'Alice Adams,Bob Brown', { timeout: 15_000 })
  await expect(a.pane).toHaveAttribute('data-avatars', '2')
  await expect.poll(() => sameReplica(pageA, pageB, name), { timeout: 15_000 }).toBe('same')
  return { a, b }
}

test('two pages co-edit a note: live, and merging edits made offline', async ({ browser }, testInfo) => {
  const { pageA, pageB, bobNetwork, close } = await twoPages(browser)
  try {
    await upload(pageA, NOTES, noteFixture())
    const shared = await share(pageA, pageB, NOTES, (kit) => waitForNoteText(kit, 'Goals for the quarter.'))
    const { b } = shared

    // Alice reloads her page before editing anything: the note opens again as the same document,
    // in the same room (its replica was kept with the file when the room was made).
    const docId = (await collabState(pageA, NOTES))?.docId
    expect(docId).toBeTruthy()
    await pageA.reload()
    await pageA.waitForFunction(() => Boolean(window.__EMBED_TEST__))
    const a = await openFile(pageA, NOTES)
    await waitForNoteText(a.kit, 'Goals for the quarter.')
    await expect(collabStatus(a)).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    expect((await collabState(pageA, NOTES))?.docId).toBe(docId)
    expect((await collabState(pageA, NOTES))?.role).toBe('owner')
    await expect(a.pane).toHaveAttribute('data-peers', 'Alice Adams,Bob Brown', { timeout: 15_000 })
    await expect.poll(() => sameReplica(pageA, pageB, NOTES), { timeout: 15_000 }).toBe('same')

    // Alice types into the note: within a second Bob's replica holds it.
    const baseline = JSON.stringify(await replicaCounters(pageB, NOTES))
    await typeAfter(pageA, a.kit, 'Goals for the quarter.', ' Then grow.')
    const live = await liveTo(pageA, pageB, NOTES, baseline, Date.now())
    testInfo.annotations.push({ type: 'live text edit to the other page', description: `${live} ms` })
    // `liveTo` starts timing after the typing, so it counts the last key's way to Bob.
    expect(live).toBeLessThan(1_000)
    await waitForNoteText(b.kit, 'Goals for the quarter. Then grow.')

    // Bob goes offline; each adds to a list item of their own.
    const tokensBefore = await tokenCalls(pageB)
    await bobNetwork.setOnline(false)
    await expect(collabStatus(b)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await typeAfter(pageB, b.kit, 'Hire', ' by Bob')
    await typeAfter(pageA, a.kit, 'Ship', ' by Alice')
    await settledVersion(pageA, NOTES)
    await settledVersion(pageB, NOTES)
    expect(await sameReplica(pageA, pageB, NOTES)).not.toBe('same')

    // Back online: a fresh token, and both hold both edits.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(collabStatus(b)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplica(pageA, pageB, NOTES), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    expect(await tokenCalls(pageB)).toBeGreaterThan(tokensBefore)
    const merged = '# Notes\n\nGoals for the quarter. Then grow.\n\n- Hire by Bob\n- Ship by Alice\n'
    for (const kit of [a.kit, b.kit]) {
      await waitForNoteText(kit, 'Hire by Bob')
      await waitForNoteText(kit, 'Ship by Alice')
    }

    // Each saves to its own storage: the same note.
    await a.pane.getByTestId('pane-save').click()
    await b.pane.getByTestId('pane-save').click()
    await expect.poll(() => saves(pageA, NOTES), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect.poll(() => saves(pageB, NOTES), { timeout: 30_000 }).toBeGreaterThan(0)
    expect((await fileBytes(pageA, NOTES)).toString('utf8')).toBe(merged)
    expect((await fileBytes(pageB, NOTES)).toString('utf8')).toBe(merged)
    expect(await errors(pageA)).toEqual([])
    expect(await errors(pageB)).toEqual([])
    await pageA.screenshot({ path: testInfo.outputPath('alice-note.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob-note.png') })
  } finally {
    await close()
  }
})
