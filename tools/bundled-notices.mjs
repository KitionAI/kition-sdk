// The notices of the npm packages a public package's bundles contain (tools/build-package.mjs
// writes them to dist/THIRD_PARTY_NOTICES): every licence and notice file each package ships,
// LICENSE*, LICENCE*, COPYING*, NOTICE* and THIRD_PARTY_NOTICES*, from its root and its dist/.
import fs from 'node:fs'
import path from 'node:path'

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice|third[-_]party[-_]notices)(?:[._-].*)?$/i
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[._-].*)?$/i

/** The licence and notice files a package ships; throws when it ships no licence file. */
export function packageNoticeFiles(dir) {
  const files = []
  for (const folder of [dir, path.join(dir, 'dist')]) {
    if (!fs.existsSync(folder)) continue
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && NOTICE_FILE.test(entry.name)) files.push(path.join(folder, entry.name))
    }
  }
  if (!files.some((file) => LICENSE_FILE.test(path.basename(file)))) {
    const { name } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    throw new Error(`${name} ships no license file`)
  }
  return files.sort()
}

/** One section of THIRD_PARTY_NOTICES: the package, its licence, its repository and its files' texts. */
export function packageNoticeSection(dir) {
  const dependency = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const repository = (typeof dependency.repository === 'string' ? dependency.repository : dependency.repository?.url)?.replace(/^git\+/, '').replace(/\.git$/, '') ?? dependency.homepage
  const texts = []
  for (const file of packageNoticeFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (text && !texts.includes(text)) texts.push(text)
  }
  return {
    key: `${dependency.name}@${dependency.version}`,
    text: [`${dependency.name} ${dependency.version} (${dependency.license})`, ...(repository ? [repository] : []), '', texts.join('\n\n')].join('\n'),
  }
}
