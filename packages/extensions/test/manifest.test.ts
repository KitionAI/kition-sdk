/// <reference types="node" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { appliesTo, connectSources, ManifestError, networkSources, panelAppliesTo, parseManifest } from '../src/index'
import { PANEL_HTML, RUNTIME_INPUTS_SHA256, SANDBOX_HTML, WORKER_RUNTIME } from '../src/runtime/index'
// @ts-expect-error a plain ES module without types
import { inputsHash } from '../scripts/runtime-inputs.mjs'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const example = JSON.parse(read('../../../examples/extensions/title-case/extension.json'))

const problems = (value: unknown) => {
  try {
    parseManifest(value)
    return []
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestError)
    return (error as ManifestError).problems
  }
}

describe('extension.json', () => {
  it('reads the example extension', () => {
    const manifest = parseManifest(JSON.stringify(example))
    expect(manifest.id).toBe('com.kition.examples.title-case')
    expect(manifest.contributes.commands.map((command) => command.id)).toEqual(['titleCase.apply'])
    expect(manifest.permissions).toEqual(['model.read', 'model.write'])
    expect(manifest.contributes.panels).toEqual([{ id: 'titleCase.titles', title: 'Headings', entry: 'panel.html' }])
  })

  it('checks contributed panels', () => {
    const base = { ...example, activation: { kits: ['kit.slide', 'kit.doc'] } }
    const withPanels = (panels: unknown) => ({ ...base, contributes: { commands: [], panels } })
    expect(problems(withPanels([{ id: 'one.panel', title: 'One', entry: 'panels/one.html', kits: ['kit.doc'] }]))).toEqual([])
    expect(problems(withPanels({}))).toEqual(['contributes.panels must be a list'])
    expect(
      problems(
        withPanels([
          { id: 'one.panel', title: 'One', entry: 'one.html' },
          { id: 'one.panel', title: 'Again', entry: 'again.html' },
          { id: 'flat', title: 'Flat', entry: 'flat.html' },
          { id: 'two.panel', title: 'Two', entry: '../two.html' },
          { id: 'three.panel', title: 'Three', entry: 'three.js' },
          { id: 'four.panel', title: 'Four', entry: 'four.html', kits: ['kit.sheet'] },
          { id: 'five.panel', title: 'Five', entry: 'five.html', kits: [] },
        ]),
      ),
    ).toEqual([
      'panel one.panel is contributed twice',
      expect.stringMatching(/namespaced id/),
      expect.stringMatching(/namespaced id/),
      expect.stringMatching(/namespaced id/),
      'panel four.panel: kits must list some of activation.kits',
      'panel five.panel: kits must list some of activation.kits',
    ])
    const manifest = parseManifest(withPanels([{ id: 'one.panel', title: 'One', entry: 'one.html', kits: ['kit.doc'] }, { id: 'two.panel', title: 'Two', entry: 'two.html' }]))
    const [word, any] = manifest.contributes.panels!
    expect(panelAppliesTo(manifest, word, { kitId: 'kit.doc' })).toBe(true)
    expect(panelAppliesTo(manifest, word, { kitId: 'kit.slide' })).toBe(false)
    expect(panelAppliesTo(manifest, any, { kitId: 'kit.slide' })).toBe(true)
    expect(panelAppliesTo(manifest, any, { kitId: 'kit.sheet' })).toBe(false)
  })

  it('lists every problem it finds', () => {
    expect(problems('{')).toEqual([expect.stringMatching(/^not JSON/)])
    expect(
      problems({
        kitExtensions: '2.0',
        id: 'Not An Id',
        name: '',
        version: '1',
        entry: '../escape.mjs',
        activation: { kits: ['slide'], on: 'always' },
        contributes: { commands: [{ id: 'one.two', title: 'One' }, { id: 'one.two', title: 'Again' }, { id: 'flat' }] },
        permissions: ['model.write', 'files.read', 'network:http://example.com', 'network:exa mple.com'],
      }),
    ).toEqual([
      'kitExtensions must be "1.0"',
      expect.stringMatching(/^id must be/),
      expect.stringMatching(/^name is required/),
      expect.stringMatching(/^version must be/),
      expect.stringMatching(/^entry must be/),
      expect.stringMatching(/^activation\.kits/),
      expect.stringMatching(/^activation\.on/),
      'command one.two is contributed twice',
      expect.stringMatching(/namespaced id/),
      'unknown permission files.read',
      expect.stringMatching(/^network:http:\/\/example\.com is not an origin/),
      expect.stringMatching(/^network:exa mple\.com is not an origin/),
      'model.write needs model.read',
    ])
  })

  it('turns network permissions into CSP sources, and nothing else', () => {
    expect(networkSources('network:api.example.com')).toEqual(['https://api.example.com', 'wss://api.example.com'])
    expect(networkSources('network:https://api.example.com:8443')).toEqual(['https://api.example.com:8443'])
    expect(networkSources('network:*.example.com')).toEqual(['https://*.example.com', 'wss://*.example.com'])
    expect(networkSources('network:http://127.0.0.1:3000')).toEqual(['http://127.0.0.1:3000'])
    for (const bad of ['network:http://example.com', "network:example.com; script-src *", 'network:*', 'network:example.com/path', 'network:', 'model.read']) {
      expect(networkSources(bad), bad).toBeNull()
    }
    expect(connectSources(['model.read'])).toBe("'none'")
    expect(connectSources(['network:a.example.com', 'network:https://a.example.com'])).toBe('https://a.example.com wss://a.example.com')
  })

  it('applies to its kits, narrowed by its formats', () => {
    const manifest = parseManifest({ ...example, activation: { kits: ['kit.slide'], formats: ['pptx'] } })
    expect(appliesTo(manifest, { kitId: 'kit.slide', path: 'slides/Plan.PPTX' })).toBe(true)
    expect(appliesTo(manifest, { kitId: 'kit.slide', path: 'Plan.kslide' })).toBe(false)
    expect(appliesTo(manifest, { kitId: 'kit.doc', path: 'Plan.pptx' })).toBe(false)
    expect(appliesTo(parseManifest(example), { kitId: 'kit.note', path: 'Plan.md' })).toBe(true)
  })
})

describe('the built sandbox', () => {
  it('is current with its sources (node packages/extensions/scripts/build-runtime.mjs)', () => {
    expect(RUNTIME_INPUTS_SHA256).toBe(inputsHash())
    expect(WORKER_RUNTIME).toContain('kition-ext-sandbox/1')
    expect(read('../sandbox/sandbox.html')).toBe(SANDBOX_HTML)
    expect(read('../sandbox/panel.html')).toBe(PANEL_HTML)
  })

  it('gives the panel page its own script, by hash, blob scripts, and inline styles, and nothing from the network', () => {
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(PANEL_HTML)?.[1] ?? ''
    const script = /<script>([\s\S]*)<\/script>/.exec(PANEL_HTML)?.[1] ?? ''
    expect(script).toContain('kition-ext-panel/1')
    const hash = createHash('sha256').update(script).digest('base64')
    expect(policy).toContain(`script-src 'sha256-${hash}' blob:`)
    expect(policy).toContain("style-src 'unsafe-inline'")
    expect(policy).toContain('img-src data: blob:')
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).not.toMatch(/default-src|connect-src|https?:|unsafe-eval|script-src[^;]*unsafe-inline/)
  })

  it('allows only its bootstrap script, by hash, and blob workers; connect-src is left to the bootstrap', () => {
    const bootstrap = read('../sandbox/bootstrap.js')
    const hash = createHash('sha256').update(bootstrap).digest('base64')
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(SANDBOX_HTML)?.[1] ?? ''
    expect(policy).toContain(`script-src 'sha256-${hash}' blob:`)
    expect(policy).toContain('worker-src blob:')
    expect(policy).not.toMatch(/default-src|connect-src|unsafe/)
    expect(SANDBOX_HTML).toContain(`<script>${bootstrap}</script>`)
  })
})
