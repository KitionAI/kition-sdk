/**
 * A kit's KDM schema, which a kit whose engine does not describe its own needs with a draft's
 * `compare` and `merge` and with object-model requests (Kit UI protocol sections 7a and 7d). The
 * page may give it (`kit.schema`); otherwise it is the one the kit package ships
 * (`model/schema.json`, the schema its engine was built with), else `@kition/script`'s generated kit,
 * loaded only for this kit and only when needed.
 */
type Descriptor = { schema: object }

const GENERATED: Record<string, () => Promise<Descriptor>> = {
  'kit.board': async () => (await import('../../script/kits/board')).boardKit,
  'kit.cad': async () => (await import('../../script/kits/cad')).cadKit,
  'kit.design': async () => (await import('../../script/kits/design')).designKit,
  'kit.doc': async () => (await import('../../script/kits/doc')).docKit,
  'kit.film': async () => (await import('../../script/kits/film')).filmKit,
  'kit.html': async () => (await import('../../script/kits/html')).htmlKit,
  'kit.layout': async () => (await import('../../script/kits/layout')).layoutKit,
  'kit.motion': async () => (await import('../../script/kits/motion')).motionKit,
  'kit.note': async () => (await import('../../script/kits/note')).noteKit,
  'kit.pdf': async () => (await import('../../script/kits/pdf')).pdfKit,
  'kit.photo': async () => (await import('../../script/kits/photo')).photoKit,
  'kit.scene': async () => (await import('../../script/kits/scene')).sceneKit,
  'kit.sheet': async () => (await import('../../script/kits/sheet')).sheetKit,
  'kit.slide': async () => (await import('../../script/kits/slide')).slideKit,
  'kit.table': async () => (await import('../../script/kits/table')).tableKit,
  'kit.vector': async () => (await import('../../script/kits/vector')).vectorKit,
}

/** The schema a kit package ships at `url`, or `undefined` when it ships none or it cannot be read. */
export async function fetchPackageSchema(url: string): Promise<object | undefined> {
  try {
    const response = await fetch(url, { credentials: 'omit' })
    if (!response.ok) return undefined
    const schema: unknown = await response.json()
    return schema && typeof schema === 'object' ? schema : undefined
  } catch {
    return undefined
  }
}

/**
 * The schema for `kitId`: the page's, else the kit package's (`fromPackage`, when it names this
 * kit), else the generated kit's, else `undefined` (the kit describes its own).
 */
export function kitSchemaLoader(kitId: string, given?: object, fromPackage?: () => Promise<object | undefined>): () => Promise<object | undefined> {
  let loading: Promise<object | undefined> | null = null
  const generatedSchema = () => {
    const generated = GENERATED[kitId]
    return generated ? generated().then((kit) => kit.schema, () => undefined) : Promise.resolve(undefined)
  }
  const packaged = async () => {
    const schema = await fromPackage?.().catch(() => undefined)
    return schema && (schema as { kit?: unknown }).kit === kitId ? schema : generatedSchema()
  }
  return () => {
    if (given) return Promise.resolve(given)
    loading ??= packaged()
    return loading
  }
}
