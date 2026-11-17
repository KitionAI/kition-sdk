import { parseSchema, type Schema } from '@kition/kdm'

const schema: Schema = parseSchema({
  kdm: 1,
  kit: 'kit.consumer',
  schemaVersion: 1,
  root: 'Root',
  types: {
    Root: { fields: {} },
    Line: {
      projected: true,
      fields: { text: { kind: 'string' } },
      projectedOps: { set: { command: 'line.set', params: { id: 'target' } } },
    },
  },
})

export const parameterPaths: Record<string, string> | undefined = schema.types.Line.projectedOps?.set.params
