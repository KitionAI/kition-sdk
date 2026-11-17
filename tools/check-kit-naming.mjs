#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { checkKitNaming } from './kit-naming.mjs'

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  package: { type: 'string' }, lock: { type: 'string' }, key: { type: 'string' },
} })
if (positionals.length !== 1 || (values.lock && !values.key)) {
  console.error('usage: check-kit-naming.mjs <kit.json> [--package <dir>] [--lock <file> --key <name>]')
  process.exit(2)
}
try {
  const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
  const file = resolve(positionals[0])
  const manifest = json(file)
  const schemaFile = manifest.model?.schema && resolve(dirname(file), manifest.model.schema)
  const schema = schemaFile ? json(schemaFile) : undefined
  const packageManifest = values.package ? json(join(values.package, 'kit-ui.json')) : undefined
  const lock = values.lock ? json(values.lock) : undefined
  if (lock && !lock[values.key]) throw new Error(`lock has no ${values.key} entry`)
  const failures = checkKitNaming(manifest, { schema, packageManifest, pin: lock?.[values.key], key: values.key })
  if (values.package && schema) {
    const shippedSchema = join(values.package, 'model/schema.json')
    if (!existsSync(shippedSchema) || JSON.stringify(json(shippedSchema)) !== JSON.stringify(schema)) {
      failures.push('package model/schema.json differs from the source schema')
    }
  }
  for (const failure of failures) console.error(`FAIL ${failure}`)
  if (failures.length) process.exitCode = 1
  else console.log(`PASS ${manifest.id}: product naming${values.package ? ', package' : ''}${lock ? ', lock' : ''}`)
} catch (error) {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
}
