import { describe, expect, it } from 'vitest'
import { catalogNames, loadPhrases, parsePhrases, parseRustPhrases } from './phrases'

describe('upstream phrase catalogs', () => {
  it('reads tab-separated catalogs and Rust match tables', () => {
    expect(parsePhrases('# comment\n\tPaste\t粘贴\n\tLine\\nBreak\t换行\n').get('Line\nBreak')).toBe('换行')
    const rust = parseRustPhrases('Some(match text {\n        "Paste" => "粘贴",\n        "Say \\"hi\\"" => "说“嗨”",\n        _ => return None,\n')
    expect(rust.get('Paste')).toBe('粘贴')
    expect(rust.get('Say "hi"')).toBe('说“嗨”')
  })

  it('finds a locale’s catalog by its upstream name', async () => {
    expect(catalogNames('zh-CN')).toContain('zh-hans')
    expect(catalogNames('zh-TW')).toContain('zh-hant')
    const phrase = await loadPhrases({ '../i18n/zh.rs': async () => '"Bold" => "粗体",' }, 'zh-CN')
    expect(phrase('Bold')).toBe('粗体')
    expect(phrase('Italic')).toBe('Italic')
    expect((await loadPhrases({ '../i18n/zh.rs': async () => '"Bold" => "粗体",' }, 'en-US'))('Bold')).toBe('Bold')
  })
})

describe('a kit’s own phrases', () => {
  it('come before the upstream ones', async () => {
    const upstream = await loadPhrases({ 'zh.rs': async () => '"Bold" => "粗体", "Font" => "字型",' }, 'zh-CN')
    const { withPhrases } = await import('./phrases')
    const phrase = withPhrases(upstream, { 'zh-CN': { Font: '字体', Clipboard: '剪贴板' } }, 'zh-CN')
    expect([phrase('Font'), phrase('Clipboard'), phrase('Bold'), phrase('Other')]).toEqual(['字体', '剪贴板', '粗体', 'Other'])
  })
})
