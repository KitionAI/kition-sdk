/**
 * A kit's interface strings by locale (protocol section 4): `en-US` is required, the rest
 * optional. Lookups fall back from `zh-CN` to `zh` to `en-US`, then to the key itself.
 */
export type Catalog = Record<string, string>

export function createStrings(catalogs: Record<string, Catalog>, locale: string) {
  const chain = [locale, locale.split('-')[0], 'en-US'].map((tag) => catalogs[tag] ?? Object.entries(catalogs).find(([key]) => key.split('-')[0] === tag)?.[1]).filter((catalog): catalog is Catalog => Boolean(catalog))
  return (key: string, values?: Record<string, string | number>) => {
    const text = chain.find((catalog) => key in catalog)?.[key] ?? key
    return values ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match)) : text
  }
}
