// The kition-kits agent plugins' generated kit skills (tools/agent-plugin-skills.mjs), for Claude
// Code and DeepSeek Harness, and the Claude Code plugin (plugins/claude-code/kition-kits): its
// draft skills and the launcher that turns the plugin's options into kition-kits-mcp arguments.
// The DeepSeek Harness plugin's own files: tools/dsh-plugin.test.mjs.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { KITS, TARGETS, skill } from './agent-plugin-skills.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const plugin = path.join(root, 'plugins/claude-code/kition-kits')
const frontmatter = (text) => Object.fromEntries([...text.matchAll(/^([a-z-]+): (.*)$/gm)].map(([, key, value]) => [key, value]))

describe('kit skills', () => {
  it('are the guide under a frontmatter that says when to use the kit', () => {
    const manifest = { name: 'Slide', agent: { prefix: 'slide', describe: { noun: 'slide file', fileTypes: '.kslide and .pptx', covers: 'slides and shapes' } } }
    const text = skill('slide', manifest, '\n# Slide\n\nInspect first.\n\n')
    const fields = frontmatter(text.split('---')[1])
    expect(fields.name).toBe('slide-editing')
    expect(JSON.parse(fields.description)).toBe(
      "Create, inspect, edit and check a slide file (.kslide and .pptx) with the Kition Slide kit's tools: slides and shapes. Use when the user asks to make, read, change, review or fix .kslide and .pptx files in this project.",
    )
    expect(text).toContain('`slide_run` is `kit_run`')
    expect(text.endsWith('# Slide\n\nInspect first.\n')).toBe(true)
  })

  it('name the tools as DeepSeek Harness shows them, for its plugin', () => {
    const manifest = { name: 'Slide', agent: { prefix: 'slide' } }
    const claude = skill('slide', manifest, '# Slide\n', 'claude-code')
    const dsh = skill('slide', manifest, '# Slide\n', 'deepseek-harness')
    expect(dsh).toContain('`slide_run` is `mcp__kition__kit_run`')
    expect(dsh).toContain('`mcp__kition__slide_<action>`')
    expect(dsh).not.toContain('`slide_run` is `kit_run`')
    // The frontmatter and the guide are the same for both harnesses.
    expect(dsh.split('---')[1]).toBe(claude.split('---')[1])
    expect(dsh.endsWith('# Slide\n')).toBe(true)
  })

  it("match their kit's guide (skipped where the kit repositories aren't checked out)", () => {
    expect(() => execFileSync(process.execPath, [path.join(root, 'tools/agent-plugin-skills.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow()
  })

  it('exist for every kit in both plugins, with a description within the skill listing limit', () => {
    for (const { plugin: folder } of Object.values(TARGETS)) {
      for (const kit of KITS) {
        const text = fs.readFileSync(path.join(root, folder, 'skills', `${kit}-editing`, 'SKILL.md'), 'utf8')
        const fields = frontmatter(text.split('---')[1])
        expect(fields.name).toBe(`${kit}-editing`)
        expect(JSON.parse(fields.description).length).toBeLessThanOrEqual(1536)
      }
    }
  })
})

describe('draft skills', () => {
  it('leave merging and discarding to the person (KHP A14)', () => {
    for (const name of ['drafts-merge', 'drafts-discard']) {
      const fields = frontmatter(fs.readFileSync(path.join(plugin, 'skills', name, 'SKILL.md'), 'utf8').split('---')[1])
      expect(fields['disable-model-invocation'], name).toBe('true')
    }
    for (const name of ['drafts-list', 'drafts-compare']) {
      const fields = frontmatter(fs.readFileSync(path.join(plugin, 'skills', name, 'SKILL.md'), 'utf8').split('---')[1])
      expect(fields['disable-model-invocation'], name).toBeUndefined()
    }
  })
})

describe('the launcher', () => {
  // Stand-ins for kition-kits-mcp and kition that print the arguments they were started with.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-kits-plugin-'))
  const fake = path.join(dir, 'kition-kits-mcp')
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const repos = path.join(dir, 'repos')
  for (const [repo, executable] of [['kition-slide', 'kition-slide'], ['kition-doc', null], ['kition-scene-curves', 'kition-scene']]) {
    fs.mkdirSync(path.join(repos, repo, 'target/debug'), { recursive: true })
    if (executable) fs.writeFileSync(path.join(repos, repo, 'target/debug', executable), '', { mode: 0o755 })
  }
  const run = (args, env) =>
    execFileSync(path.join(plugin, 'scripts/kits-mcp.sh'), args, { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' }).trim().split('\n')

  it('serves one tool set for every kit by default, with the built kit repositories', () => {
    expect(run(['--workspace', '/w'], { KITION_KITS_MCP: fake, KITION_KIT_REPOS: repos, KITION_KITS_DIR: '${user_config.kits_dir}' })).toEqual([
      '--workspace',
      '/w',
      '--kit',
      path.join(repos, 'kition-slide/target/debug/kition-slide'),
      '--unified',
    ])
  })

  it('gives each kit its own tools when unified is off, and never passes --unified to drafts', () => {
    expect(run(['--workspace', '/w'], { KITION_KITS_MCP: fake, KITION_KITS_UNIFIED: 'false', KITION_KITS_DIR: '/kits' })).toEqual(['--workspace', '/w', '--kits-dir', '/kits'])
    expect(run(['drafts', 'list', '--workspace', '/w'], { KITION_KITS_MCP: fake })).toEqual(['drafts', 'list', '--workspace', '/w'])
  })

  it('takes kition-kits-mcp from the PATH when the option is unset', () => {
    expect(run(['--workspace', '/w'], { PATH: `${dir}:/usr/bin:/bin`, KITION_KITS_MCP: '${user_config.kits_mcp}', KITION_KITS_UNIFIED: 'false' })).toEqual(['--workspace', '/w'])
  })

  it('prefers kition, from the option or the PATH, and starts it as kition mcp', () => {
    const bin = path.join(dir, 'with-kition')
    fs.mkdirSync(bin, { recursive: true })
    const kition = path.join(bin, 'kition')
    fs.writeFileSync(kition, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const both = `${bin}:${dir}:/usr/bin:/bin`
    expect(run(['--workspace', '/w'], { PATH: both, KITION_KITS_MCP: '${user_config.kits_mcp}' })).toEqual(['mcp', '--workspace', '/w', '--unified'])
    expect(run(['drafts', 'list', '--workspace', '/w'], { PATH: both, KITION_KITS_MCP: '' })).toEqual(['mcp', 'drafts', 'list', '--workspace', '/w'])
    expect(run(['--workspace', '/w'], { KITION_KITS_MCP: kition, KITION_KITS_DIR: '/kits', KITION_KITS_UNIFIED: 'false' })).toEqual(['mcp', '--workspace', '/w', '--kits-dir', '/kits'])
  })

  it('falls back to the npm launcher through npx, without the unset option in its environment', () => {
    // A stand-in npx that prints its arguments, then what KITION_KITS_MCP is.
    const bin = path.join(dir, 'npx-only')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "env=%s\\n" "${KITION_KITS_MCP-unset}"\n', { mode: 0o755 })
    const env = { PATH: `${bin}:/usr/bin:/bin`, KITION_KITS_MCP: '${user_config.kits_mcp}', KITION_KITS_DIR: '' }
    expect(run(['--workspace', '/w'], env)).toEqual(['-y', '@kition/cli', 'mcp', '--workspace', '/w', '--unified', 'env=unset'])
    expect(run(['drafts', 'list', '--workspace', '/w'], env)).toEqual(['-y', '@kition/cli', 'mcp', 'drafts', 'list', '--workspace', '/w', 'env=unset'])
  })
})
