import fs from 'node:fs'

// Copied kit artifacts may enter the public SDK only through this allowlist.
export const PUBLISHED_KITS = Object.freeze(JSON.parse(fs.readFileSync(new URL('../published-kits.json', import.meta.url), 'utf8')))
