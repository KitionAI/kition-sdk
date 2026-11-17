#!/usr/bin/env node
// Generates the kition-kits Claude Code plugin's kit skills (plugins/claude-code/kition-kits/
// skills/<kit>-editing/SKILL.md) from each kit's own model guide, `agent/guide.md` (KHP K17), and
// its kit.json (`name`, `agent.prefix`, `agent.describe`). The guide stays the only source: edit it
// in the kit's repository and run this again.
//
//   node tools/claude-plugin-skills.mjs [--repos <folder>]          write the skills
//   node tools/claude-plugin-skills.mjs --check [--repos <folder>]  fail when a skill differs
//
// `--repos` is the folder holding the kit repositories (kition-<kit>/), by default this
// repository's parent. A kit whose repository isn't there is skipped with a note, and --check
// passes when none is there, so it can run where only kition-sdk is checked out.
import fs from 'node:fs'
import path from 'node:path'
import { PUBLISHED_KITS } from './published-kits.mjs'

export const KITS = PUBLISHED_KITS

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** The skill for one kit, from its kit.json and guide. */
export function skill(kit, manifest, guide) {
  const prefix = manifest.agent?.prefix ?? kit
  const describe = manifest.agent?.describe ?? {}
  const noun = describe.noun ?? `${manifest.name ?? kit} file`
  const types = describe.fileTypes ?? (manifest.formats ?? []).flatMap((format) => format.extensions ?? []).map((extension) => `.${extension}`).join(', ')
  const covers = describe.covers ? `: ${describe.covers}` : ''
  const description =
    `Create, inspect, edit and check a ${noun} (${types}) with the Kition ${manifest.name ?? kit} kit's tools${covers}. ` +
    `Use when the user asks to make, read, change, review or fix ${types} files in this project.`
  const body = guide.replace(/^\s+/, '').replace(/\s+$/, '')
  return `---
name: ${kit}-editing
description: ${JSON.stringify(description)}
---

<!-- Generated from kition-${kit} agent/guide.md by kition-sdk tools/claude-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (its "unified" option): the
\`${prefix}_<action>\` tools this guide names are \`kit_<action>\`, routed by the file's extension
(\`${prefix}_run\` is \`kit_run\`, \`${prefix}_check\` is \`kit_check\`). With "unified" off they are named as
written. Paths are relative to the project folder.

${body}
`
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const reposAt = args.indexOf('--repos')
  const repos = path.resolve(reposAt >= 0 ? args[reposAt + 1] : path.join(root, '..'))
  const skillsAt = args.indexOf('--skills')
  const skillsDir = path.resolve(skillsAt >= 0 ? args[skillsAt + 1] : path.join(root, 'plugins/claude-code/kition-kits/skills'))
  let found = 0
  const differ = []
  for (const kit of KITS) {
    const repo = path.join(repos, `kition-${kit}`)
    const guidePath = path.join(repo, 'agent/guide.md')
    if (!fs.existsSync(guidePath)) {
      console.error(`skip ${kit}: no ${path.relative(repos, guidePath)}`)
      continue
    }
    found++
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'kit.json'), 'utf8'))
    const text = skill(kit, manifest, fs.readFileSync(guidePath, 'utf8'))
    const out = path.join(skillsDir, `${kit}-editing`, 'SKILL.md')
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null
    if (check) {
      if (current !== text) differ.push(path.relative(root, out))
    } else if (current !== text) {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, text)
      console.log(`wrote ${path.relative(root, out)}`)
    }
  }
  // Skills of kits no longer in the list.
  for (const entry of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
    const kit = entry.endsWith('-editing') ? entry.slice(0, -'-editing'.length) : null
    if (kit && !KITS.includes(kit)) {
      if (check) differ.push(`plugins/claude-code/kition-kits/skills/${entry} (no such kit)`)
      else fs.rmSync(path.join(skillsDir, entry), { recursive: true })
    }
  }
  if (check) {
    if (found === 0 && differ.length === 0) {
      console.log('claude-plugin-skills: no kit repositories next to kition-sdk; nothing to check')
      return
    }
    if (differ.length) {
      console.error(`claude-plugin-skills: ${differ.length} skill(s) differ from their kit's guide; run node tools/claude-plugin-skills.mjs`)
      for (const file of differ) console.error(`  ${file}`)
      process.exit(1)
    }
    console.log(`claude-plugin-skills: ${found} kit skills match their guides`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
