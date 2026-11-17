// One object-model script, run unchanged in Node (run-node.mjs), against the native headless kit
// (run-headless.mjs), and in a page through @kition/embed (the embed example app's "Run script"
// button). It takes any opened Note document (`openDocument`) and answers what it did.

/** Adds a review section with a task, puts "Q3 " before its heading, and checks the task off. */
/** The section headed `heading` at any depth, its heading loaded; sections nest under their parent's. */
async function findSection(context, heading) {
  let level = [context.root.sections.load()]
  while (level.length > 0) {
    await context.sync()
    const sections = level.flatMap((list) => Array.from({ length: list.length }, (_, index) => list.at(index).load(['heading'])))
    await context.sync()
    const found = sections.find((section) => section.heading === heading)
    if (found) return found
    level = sections.map((section) => section.sections.load())
  }
  return null
}

export async function quarterlyReview(note) {
  return note.run(async (context) => {
    // A command with domain logic: the kit appends a section at the end of the note.
    context.commands.run('block.append', { markdown: '## Quarterly review\n\n- [ ] Share the revenue numbers' })
    const root = context.root
    root.load(['body'])
    await context.sync()

    // Data through the object model: the note's text, and the sections and tasks the kit reads from it.
    const section = await findSection(context, 'Quarterly review')
    const at = root.body.toString().lastIndexOf('## Quarterly review') + '## '.length
    root.body.insert(at, 'Q3 ')
    section.tasks.load()
    await context.sync()
    const task = section.tasks.at(0)
    task.checked = true
    await context.sync()

    root.load(['body'])
    section.load(['heading', 'level'])
    task.load(['text', 'checked'])
    await context.sync()
    return { heading: section.heading, level: section.level, task: { text: task.text, checked: task.checked }, text: root.body.toString() }
  })
}
