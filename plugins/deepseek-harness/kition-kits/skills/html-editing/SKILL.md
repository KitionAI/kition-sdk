---
name: html-editing
description: "Create, inspect, edit and check a HTML document (HTML (.html or .htm)) with the Kition HTML kit's tools: HTML source replacement and undo/redo; HTML/CSS rendering and bounded JavaScript with supplied resources. Use when the user asks to make, read, change, review or fix HTML (.html or .htm) files in this project."
---

<!-- Generated from kition-html agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (KITION_KITS_UNIFIED): the
`html_<action>` tools this guide names are `mcp__kition__kit_<action>`, routed by the file's
extension (`html_run` is `mcp__kition__kit_run`, `html_check` is `mcp__kition__kit_check`).
With KITION_KITS_UNIFIED=false they are `mcp__kition__html_<action>`. Paths are relative to the
workspace folder.

# HTML kit

The HTML kit opens, edits, renders and checks single HTML pages (`.html`, `.htm`) with their CSS and
a bounded JavaScript runtime. An agent can read a page's source, replace it, click the rendered page
and move its clock forward to see how its scripts react, and check the page for resources the kit
cannot load, script errors and CSS filters the renderer does not draw.

## Tools

The kit's prefix is `html`. Its tools are:

| Tool | Does |
|---|---|
| `html_inspect` | The page as JSON (its whole source, the engine, and whether scripts run), with a preview on request |
| `html_commands` | Finds commands by keywords, each with its parameter schema |
| `html_run` | Runs a list of command steps |
| `html_check` | What is wrong with the page, as diagnostics |
| `html_create` | Makes a new `.html` page |

Every tool takes `path`, the page's path in the workspace. The kit has no object model, so it has no
`html_query` or `html_batch`. It has no `html_export` tool, and it keeps no drafts, so it has no
draft tools.

## Addressing and coordinates

- A document is one page's **HTML source**. `html_inspect` answers the whole source
  (`details.source`); `preview: true` adds the rendered page (640 × 480 for a new page).
- There are no per-element commands and no element ids: you edit the page by writing its whole
  source.
- [`html.click`](/kits/html/commands/html.click/) `{x, y}` takes **CSS pixels** on the rendered
  page, from its top-left corner `(0, 0)`, with `x` growing right and `y` growing down.
- [`html.advance`](/kits/html/commands/html.advance/) `{millis}` takes a whole number of
  **milliseconds**.

## Workflow

1. `html_inspect {path}`: read the current source.
2. `html_commands` when you need a command other than the ones below. Use the exact id it returns
   and follow its parameter schema; never guess a command id.
3. Change the source in your own text: keep everything you were not asked to change, byte for
   byte. Then `html_run {path, steps: [{command: "html.setSource", params: {source}}]}`. A call that
   succeeds saves the page (`save` defaults to `true`).
4. `html_check {path}`, then fix what it reports.
5. `html_inspect {path, preview: true}` to look at the result.

## Common tasks

| Command | Params | What it does |
|---|---|---|
| [`html.setSource`](/kits/html/commands/html.setSource/) | `{source}` | Replaces the whole page with `source` (one undo step) |
| [`html.click`](/kits/html/commands/html.click/) | `{x, y}` | Clicks the preview at those pixels (runs the page's handlers; the source is unchanged) |
| [`html.advance`](/kits/html/commands/html.advance/) | `{millis}` | Moves the preview's clock (timers, animations; the source is unchanged) |
| [`edit.undo`](/kits/html/commands/edit.undo/), [`edit.redo`](/kits/html/commands/edit.redo/) | `{}` | Takes back or redoes your last source change |

## Example 1: add a link under the date

```json
html_inspect {"path": "index.html"}
→ details.source: "<!doctype html>…<div class=\"card\"><p>Saturday 8 pm, Town Hall</p></div></body></html>\n"
html_run {"path": "index.html", "steps": [{"command": "html.setSource", "params": {"source":
  "<!doctype html>…<div class=\"card\"><p>Saturday 8 pm, Town Hall</p><p><a href=\"tickets.html\">Tickets</a></p></div></body></html>\n"}}]}
html_check {"path": "index.html"}
→ {"diagnostics": []}
```

(`…` stands for the unchanged rest of the source, which you send in full.)

## Example 2: fix what the check finds

```json
html_check {"path": "poster.html"}
→ {"diagnostics": [{"code": "html.resource-unavailable", "severity": "error",
    "message": "The page asks for `images/poster.png`, which the kit cannot load, so it is missing."}]}
```

The kit does not load linked files, even ones in the workspace, so replace the image with a drawn
placeholder (or the picture as a `data:` URL):

```json
html_run {"path": "poster.html", "steps": [{"command": "html.setSource", "params": {"source":
  "…<div style=\"width:120px;height:80px;background:#5645d4\" role=\"img\" aria-label=\"Poster\"></div></body></html>\n"}}]}
html_check {"path": "poster.html"}
→ {"diagnostics": []}
```

A script error names the line:

```json
html_check {"path": "title.html"}
→ {"diagnostics": [{"code": "html.javascript-error", "severity": "error",
    "message": "Uncaught JS error in <inline script>: ReferenceError: missingTitle is not defined (unknown at :1:23)."}]}
```

Define the value or replace `missingTitle` with the text (`"Spring concert 2026"`) in the script,
send the whole source with [`html.setSource`](/kits/html/commands/html.setSource/), and check again:
`{"diagnostics": []}`.

## Pitfalls

- **The whole page:** [`html.setSource`](/kits/html/commands/html.setSource/) replaces the whole
  page, so always start from the source `html_inspect` gave you.
- **Preview only:** [`html.click`](/kits/html/commands/html.click/) and
  [`html.advance`](/kits/html/commands/html.advance/) change only the preview, never the saved file.
- **Linked files:** the preview loads no file but the page: not images, stylesheets or scripts it
  links from the workspace (`images/logo.png`, `style.css`, `app.js`), and nothing from the network.
  Each one is reported as `html.resource-unavailable`. Write CSS and scripts in the page, and
  pictures as `data:` URLs or inline SVG.
- **Long sources** are fine; send the source as one string (escape quotes and newlines as JSON
  requires).
- **Undo:** your [`edit.undo`](/kits/html/commands/edit.undo/) takes back your own steps only; the
  person's edits stay.
- **A page that cannot be drawn** is not a diagnostic: `html_inspect` with a preview fails with the
  engine's message, and `html_check` reports nothing. Undo or simplify what you last added.

## Checks

`html_check` lists what is wrong with the page. Each diagnostic has a stable `code`, a
`severity` (`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a
command step to run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it
only when it is what the person asked for. Every code the kit reports is on the
[checks page](/kits/html/checks/).

| Code | Severity | What to do |
|---|---|---|
| `html.resource-unavailable` | error | The page asks for a file the kit cannot load (`images/poster.png`): put it in the page (a `data:` URL, a `<style>` or `<script>` element, inline SVG) or drop the reference |
| `html.javascript-error` | error | Fix the script the message names (it gives the error and the line) |
| `html.unsupported-filter` | warning | The renderer does not draw that CSS `filter` chain; use a simpler filter (`blur`, a single colour filter) or none |
| `html.unsupported-backdrop-filter` | warning | `backdrop-filter` is not drawn; use a translucent background instead |
