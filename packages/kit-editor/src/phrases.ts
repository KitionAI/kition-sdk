/**
 * Translations of a kit's English interface text (command titles, menu and group names) from the
 * catalogs its upstream editor already ships, in either form:
 * - `*.tsv`: `context <TAB> English <TAB> translation` lines (`#` starts a comment; `\n`, `\t`,
 *   `\\` are escapes);
 * - `*.rs`: a Rust `match` table of `"English" => "translation",` arms.
 * A kit loads them with `import.meta.glob('…/i18n/*.tsv', { query: '?raw', import: 'default' })`.
 */
export type Phrases = (english: string) => string

const unescape = (text: string) => text.replace(/\\(.)/g, (_, next: string) => (next === 'n' ? '\n' : next === 't' ? '\t' : next))

/** One catalog's English → translation table. */
export function parsePhrases(tsv: string) {
  const table = new Map<string, string>()
  for (const line of tsv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [, source, translation] = line.split('\t')
    if (source && translation) table.set(unescape(source), unescape(translation.replace(/\r$/, '')))
  }
  return table
}

/** One Rust `match` table's English → translation arms. */
export function parseRustPhrases(source: string) {
  const table = new Map<string, string>()
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"\s*=>\s*"((?:[^"\\]|\\.)*)"/g)) table.set(unescape(match[1]), unescape(match[2]))
  return table
}

/** The catalog names a locale may be in, best first: `zh-CN` → `zh-hans`, `pt-BR` → `pt-br`. */
export function catalogNames(locale: string) {
  const tag = locale.toLowerCase()
  const [language, region] = tag.split('-')
  const names = [tag]
  if (language === 'zh') names.push(['tw', 'hk', 'mo', 'hant'].includes(region ?? '') ? 'zh-hant' : 'zh-hans')
  if (language === 'sr' && tag.includes('latn')) names.push('sr-latn')
  names.push(language)
  return names
}

/**
 * The phrases for `locale` from `loaders` (path → its text, as from `import.meta.glob`); English
 * text passes through unchanged when no catalog matches or a phrase is missing.
 */
export async function loadPhrases(loaders: Record<string, () => Promise<unknown>>, locale: string): Promise<Phrases> {
  const byName = new Map(Object.entries(loaders).map(([path, load]) => [path.split('/').pop()!.replace(/\.(tsv|rs)$/, '').toLowerCase(), { path, load }]))
  const name = catalogNames(locale).find((candidate) => byName.has(candidate))
  if (!name || locale.toLowerCase().startsWith('en')) return (english) => english
  const { path, load } = byName.get(name)!
  const text = String(await load())
  const table = path.endsWith('.rs') ? parseRustPhrases(text) : parsePhrases(text)
  return (english) => table.get(english) ?? english
}

/**
 * `upstream` with a kit's own translations of English labels checked first (`extra[locale]`,
 * with the same locale fallbacks), for labels the upstream catalog lacks.
 */
export function withPhrases(upstream: Phrases, extra: Record<string, Record<string, string>>, locale: string): Phrases {
  const tag = catalogNames(locale).concat(locale).find((name) => Object.keys(extra).some((key) => key.toLowerCase() === name))
  const table = tag ? Object.entries(extra).find(([key]) => key.toLowerCase() === tag)?.[1] : undefined
  if (!table || locale.toLowerCase().startsWith('en')) return upstream
  return (english) => table[english] ?? upstream(english)
}
