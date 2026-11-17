// Kition product naming, separate from the neutral KHP manifest contract.
export const KIT_NAMES = Object.freeze({
  note: 'Note', doc: 'Doc', slide: 'Slide', sheet: 'Sheet', table: 'Table', board: 'Board',
  photo: 'Photo', film: 'Film', pdf: 'PDF', vector: 'Vector', layout: 'Layout',
  motion: 'Motion', cad: 'CAD', html: 'HTML', design: 'Design', scene: 'Scene',
})

/** Structured syntax suffixes a Kition native format may use, one per real container (kit-matrix N7). */
export const NATIVE_SUFFIXES = Object.freeze(['zip', 'json', 'sqlite3'])

const retired = { word: 'doc', document: 'note', deck: 'slide', presentation: 'slide' }
const typeName = (name) => name[0].toUpperCase() + name.slice(1)

/** Fail only Kition identities; third-party KHP kits keep their own names. */
export function checkKitNaming(manifest, { schema, packageManifest, pin, key } = {}) {
  const failures = []
  const fail = (field, expected) => failures.push(`${field}: expected ${JSON.stringify(expected)} (Kition naming)`)
  const name = manifest.id?.startsWith('kit.') ? manifest.id.slice(4) : null
  if (retired[name]) {
    fail('id', `kit.${retired[name]}`)
    return failures
  }
  if (!Object.hasOwn(KIT_NAMES, name)) return failures
  const equal = (field, actual, expected) => { if (actual !== expected) fail(field, expected) }
  equal('name', manifest.name, KIT_NAMES[name])
  if (manifest.agent) equal('agent.prefix', manifest.agent.prefix, name)
  if (manifest.headless) equal('headless.executable', manifest.headless.executable, `kition-${name}`)
  if (manifest.objectModel) equal('objectModel.namespace', manifest.objectModel.namespace, typeName(name))
  if (manifest.engine?.runtime === 'rust-wasm') {
    equal('engine.crate', manifest.engine.crate, `kition-${name}-kit`)
    equal('engine.module', manifest.engine.module, `kition_${name}_kit`)
    equal('engine.class', manifest.engine.class, `${typeName(name)}Document`)
  }
  const defaultName = ['pdf', 'cad', 'html'].includes(name) ? KIT_NAMES[name] : name
  for (const [i, create] of (manifest.creates ?? []).entries()) {
    equal(`creates[${i}].id`, create.id, name)
    equal(`creates[${i}].baseName`, create.baseName, `Untitled ${defaultName}`)
  }
  for (const [i, format] of (manifest.formats ?? []).entries()) {
    const native = format.mime?.startsWith('application/vnd.kition.')
    if (native && !NATIVE_SUFFIXES.some((suffix) => format.mime === `application/vnd.kition.${name}+${suffix}`)) {
      fail(`formats[${i}].mime`, `application/vnd.kition.${name}+zip, +json or +sqlite3 (matching the container)`)
    }
    for (const extension of format.extensions ?? []) {
      if (native || extension.startsWith('kition') || ['kitable', 'kiboard'].includes(extension)) {
        equal(`formats[${i}].extensions`, extension, `k${name}`)
      }
    }
  }
  if (schema) {
    equal('model.schema.kit', schema.kit, manifest.id)
    equal('model.schema.schemaVersion', schema.schemaVersion, manifest.model?.schemaVersion)
    if (name === 'slide') equal('model.schema.root', schema.root, 'SlideFile')
    if (name === 'note') equal('model.schema.root', schema.root, 'Note')
  }
  if (packageManifest) {
    equal('package.kitId', packageManifest.kitId, manifest.id)
    equal('package.version', packageManifest.version, manifest.version)
  }
  if (key !== undefined) equal('registry key', key, name)
  if (pin) {
    equal('lock.repository', pin.repository, `KitionAI/kition-${name}`)
    equal('lock.version', pin.version, manifest.version)
    equal('lock.asset', pin.asset, `kition-${name}-${manifest.version}.tgz`)
    if (packageManifest) equal('lock.commit', packageManifest.commit, pin.commit)
  }
  return failures
}
