/** The extensions each published kit opens, and whether it only views them; made by build-client.mjs. */
declare module 'virtual:kit-extensions' {
  const table: Record<string, { kit: string; view: boolean }>
  export default table
}
