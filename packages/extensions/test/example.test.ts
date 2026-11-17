/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portFromEngine } from '@kition/script'
import { openKitPackage } from '@kition/script/node'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionHost, RpcPeer, type SandboxFactory } from '../src/index'
import { startRuntime } from '../src/runtime/index'

const example = (name: string) => readFileSync(fileURLToPath(new URL(`../../../examples/extensions/title-case/${name}`, import.meta.url)), 'utf8')
const kits = resolve(process.env.KITION_KITS_DIR ?? fileURLToPath(new URL('../../../../kition/public/kits', import.meta.url)))
const notePackage = join(kits, 'note-ui')

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const sandbox: SandboxFactory = async () => {
  const channel = new MessageChannel()
  const peer = startRuntime(channel.port2, async (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))
  const dispose = () => {
    peer.close()
    channel.port1.close()
  }
  cleanups.push(dispose)
  return { port: channel.port1, dispose }
}

describe('the title-case example extension', () => {
  it('title-cases a word with its marks intact', async () => {
    const { titleCase } = (await import(`data:text/javascript;base64,${Buffer.from(example('extension.mjs')).toString('base64')}`)) as { titleCase: (text: string) => string }
    expect(titleCase('the state of the union')).toBe('The State of the Union')
    expect(titleCase('what we built in Q3 for iPhone users')).toBe('What We Built in Q3 for iPhone Users')
    expect(titleCase('a tale of two cities')).toBe('A Tale of Two Cities')
  })

  it.skipIf(!existsSync(join(notePackage, 'kit-ui.json')))('title-cases every heading of a real note, from its command and its panel (kit package from KITION_KITS_DIR)', async () => {
    const notes = await openKitPackage(notePackage)
    const file = notes.create('Review.md')
    cleanups.push(() => file.close())
    file.engine.execute('note.write', JSON.stringify({ markdown: '# quarterly business review\n\nrevenue grew in the north\n\n```\n# a comment in code\n```\n\n## next steps for the team\n' }))
    const host = new ExtensionHost({ sandbox })
    cleanups.push(() => host.dispose())
    host.load({ manifest: example('extension.json'), source: example('extension.mjs'), files: { 'panel.html': example('panel.html') } })
    host.openDocument({ id: 'Review.md', kitId: 'kit.note', path: 'Review.md', port: portFromEngine(file.engine, 'kit.note'), schema: notes.schema! })

    // Its panel lists the headings as they are.
    expect(host.panelsFor('Review.md')).toEqual([expect.objectContaining({ id: 'titleCase.titles', title: 'Headings', extension: 'com.kition.examples.title-case' })])
    const channel = new MessageChannel()
    const panel = new RpcPeer(channel.port1)
    cleanups.push(() => panel.close())
    const session = await host.openPanel('Review.md', 'com.kition.examples.title-case', 'titleCase.titles', channel.port2)
    cleanups.push(() => session.close())
    await expect(panel.request('panel/request', { type: 'titles' })).resolves.toEqual({
      titles: [
        { level: 1, text: 'quarterly business review' },
        { level: 2, text: 'next steps for the team' },
      ],
    })

    await expect(host.runCommand('Review.md', 'com.kition.examples.title-case', 'titleCase.apply')).resolves.toEqual({ changed: 2 })
    await expect(panel.request('panel/request', { type: 'titles' })).resolves.toEqual({
      titles: [
        { level: 1, text: 'Quarterly Business Review' },
        { level: 2, text: 'Next Steps for the Team' },
      ],
    })
    await expect(panel.request('panel/request', { type: 'apply' })).resolves.toMatchObject({ changed: 0, summary: 'Every heading is already in title case' })

    // The saved note has the new headings; the body and the code block are untouched.
    expect(new TextDecoder().decode(file.save())).toBe('# Quarterly Business Review\n\nrevenue grew in the north\n\n```\n# a comment in code\n```\n\n## Next Steps for the Team\n')
  })
})
