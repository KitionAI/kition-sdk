/**
 * Which kit opens which file, and how DeepSeek Harness is told. The table of the extensions each
 * published kit edits is generated at build time (build-client.mjs) from the kits' manifests.
 *
 * DeepSeek Harness previews some of these types itself (its document previews, the same in
 * 0.2.2-rc.2 and rc.5: Markdown md, markdown; HTML html, htm; PDF pdf; Office doc, docx, ppt,
 * pptx; Excel xlsx, xls, csv, tsv; images png, jpg, jpeg, gif, webp, bmp, ico, svg; and source code
 * by extension). For those the kit is one more preview under "Open with", and DeepSeek Harness's own
 * stays the default. Every other kit extension is a right sidebar tab type of its own, so a click
 * in the file tree opens the Kition editor.
 */
import table from 'virtual:kit-extensions'

/** Each extension a published kit edits, and the kit. */
export const KIT_EXTENSIONS: Readonly<Record<string, string>> = table

/** The extensions DeepSeek Harness 0.2.2-rc.2 and rc.5 preview themselves (dsh-client-ui-sidebar-documentpreview, dsh-util-code-language). */
export const DSH_PREVIEWS: ReadonlySet<string> = new Set([
  ...['md', 'markdown', 'html', 'htm', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xlsx', 'xls', 'csv', 'tsv'],
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'],
  ...'ts tsx mts cts js jsx mjs cjs sh bash zsh fish json jsonc jsonl ndjson ipynb py pyw pyi rb rake gemspec go rs java c h cc cpp cxx hh hpp hxx cs kt kts swift php yaml yml toml ini conf cfg properties env log diff patch http mdx rst tex sty cls bib adoc xhtml css scss less sql xml xsd xsl xslt plist lua bat cmd ps1 psm1 psd1 r jl dart scala clj cljs edn erl hrl ex exs hs fs fsi fsx vb pl pm v sv svh graphql gql proto tf tfvars hcl nix vue svelte makefile mk cmake gradle groovy'.split(' '),
])

/** The extensions that open in a Kition tab when clicked: no DeepSeek Harness preview takes them. */
export const TAB_EXTENSIONS = Object.keys(KIT_EXTENSIONS).filter((extension) => !DSH_PREVIEWS.has(extension))

/** Per kit, the extensions it is offered for under "Open with" beside DeepSeek Harness's own preview. */
export const PREVIEW_EXTENSIONS: Readonly<Record<string, string[]>> = Object.entries(KIT_EXTENSIONS)
  .filter(([extension]) => DSH_PREVIEWS.has(extension))
  .reduce<Record<string, string[]>>((byKit, [extension, kit]) => {
    ;(byKit[kit] ??= []).push(extension)
    return byKit
  }, {})

/** The kit's name as people read it. */
export const kitName = (kit: string) => (kit === 'html' || kit === 'pdf' || kit === 'cad' ? kit.toUpperCase() : kit.charAt(0).toUpperCase() + kit.slice(1))
