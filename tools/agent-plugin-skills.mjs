#!/usr/bin/env node
// Generates the kit skills of the kition-kits agent plugins (skills/<kit>-editing/SKILL.md) from
// each kit's own model guide, `agent/guide.md` (KHP K17), and its kit.json (`name`,
// `agent.prefix`, `agent.describe`), for two harnesses: Claude Code
// (plugins/claude-code/kition-kits) and DeepSeek Harness (plugins/deepseek-harness/kition-kits).
// The guide stays the only source: edit it in the kit's repository and run this again. Only the
// opening paragraph, which names the tools as the harness shows them, differs between targets.
//
//   node tools/agent-plugin-skills.mjs [--target <target>] [--repos <folder>]          write the skills
//   node tools/agent-plugin-skills.mjs --check [--target <target>] [--repos <folder>]  fail when a skill differs
//
// `--target` is claude-code or deepseek-harness; without it, both. `--repos` is the folder holding
// the kit repositories (kition-<kit>/), by default this repository's parent; `--skills` writes one
// target's skills to another folder. A kit whose repository isn't there is skipped with a note, and
// --check passes when none is there, so it can run where only kition-sdk is checked out.
import fs from 'node:fs'
import path from 'node:path'
import { PUBLISHED_KITS } from './published-kits.mjs'

export const KITS = PUBLISHED_KITS

/** Each harness's plugin folder, and the paragraph that names the tools as it shows them. */
export const TARGETS = Object.freeze({
  'claude-code': {
    plugin: 'plugins/claude-code/kition-kits',
    tools: (prefix) => `This plugin serves one tool set for every kit by default (its "unified" option): the
\`${prefix}_<action>\` tools this guide names are \`kit_<action>\`, routed by the file's extension
(\`${prefix}_run\` is \`kit_run\`, \`${prefix}_check\` is \`kit_check\`). With "unified" off they are named as
written. Paths are relative to the project folder.`,
  },
  'deepseek-harness': {
    plugin: 'plugins/deepseek-harness/kition-kits',
    tools: (prefix) => `This plugin serves one tool set for every kit by default (KITION_KITS_UNIFIED): the
\`${prefix}_<action>\` tools this guide names are \`mcp__kition__kit_<action>\`, routed by the file's
extension (\`${prefix}_run\` is \`mcp__kition__kit_run\`, \`${prefix}_check\` is \`mcp__kition__kit_check\`).
With KITION_KITS_UNIFIED=false they are \`mcp__kition__${prefix}_<action>\`. Paths are relative to the
workspace folder.`,
  },
})

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** The skill for one kit, from its kit.json and guide, for one harness. */
export function skill(kit, manifest, guide, target = 'claude-code') {
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

<!-- Generated from kition-${kit} agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

${TARGETS[target].tools(prefix)}

${body}
`
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const option = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const repos = path.resolve(option('--repos') ?? path.join(root, '..'))
  const target = option('--target')
  if (target !== undefined && !Object.hasOwn(TARGETS, target)) {
    console.error(`agent-plugin-skills: --target is ${Object.keys(TARGETS).join(' or ')}, not ${target}`)
    process.exit(2)
  }
  const targets = target ? [target] : Object.keys(TARGETS)
  if (option('--skills') !== undefined && targets.length !== 1) {
    console.error('agent-plugin-skills: --skills needs one --target')
    process.exit(2)
  }
  const kits = []
  for (const kit of KITS) {
    const repo = path.join(repos, `kition-${kit}`)
    const guidePath = path.join(repo, 'agent/guide.md')
    if (!fs.existsSync(guidePath)) {
      console.error(`skip ${kit}: no ${path.relative(repos, guidePath)}`)
      continue
    }
    kits.push({ kit, manifest: JSON.parse(fs.readFileSync(path.join(repo, 'kit.json'), 'utf8')), guide: fs.readFileSync(guidePath, 'utf8') })
  }
  const differ = []
  for (const name of targets) {
    const skillsDir = path.resolve(option('--skills') ?? path.join(root, TARGETS[name].plugin, 'skills'))
    for (const { kit, manifest, guide } of kits) {
      const text = skill(kit, manifest, guide, name)
      const out = path.join(skillsDir, `${kit}-editing`, 'SKILL.md')
      const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null
      if (current === text) continue
      if (check) {
        differ.push(path.relative(root, out))
      } else {
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, text)
        console.log(`wrote ${path.relative(root, out)}`)
      }
    }
    // Skills of kits no longer in the list.
    for (const entry of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
      const kit = entry.endsWith('-editing') ? entry.slice(0, -'-editing'.length) : null
      if (kit && !KITS.includes(kit)) {
        if (check) differ.push(`${path.relative(root, path.join(skillsDir, entry))} (no such kit)`)
        else fs.rmSync(path.join(skillsDir, entry), { recursive: true })
      }
    }
  }
  if (check) {
    if (kits.length === 0 && differ.length === 0) {
      console.log('agent-plugin-skills: no kit repositories next to kition-sdk; nothing to check')
      return
    }
    if (differ.length) {
      console.error(`agent-plugin-skills: ${differ.length} skill(s) differ from their kit's guide; run node tools/agent-plugin-skills.mjs`)
      for (const file of differ) console.error(`  ${file}`)
      process.exit(1)
    }
    console.log(`agent-plugin-skills: ${kits.length} kit skills match their guides for ${targets.join(' and ')}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
