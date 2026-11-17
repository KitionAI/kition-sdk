// Opens a workspace file in its kit, runs one command, and saves it, through `kition-kits serve`.
//
//   node edit.mjs <kition-kits> <workspace> <kits-dir> <file> <command> '<params as JSON>'
//
// Node's standard library is all it needs: the service speaks JSON-RPC 2.0, one message per line,
// on the process's standard input and output (docs/sdk/hosts.md).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

class Kits {
  constructor(executable, workspace, kitsDir) {
    this.process = spawn(executable, ['serve', '--workspace', workspace, '--kits-dir', kitsDir], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.next = 1
    this.waiting = new Map()
    // Answers come as they finish; each carries its request's id.
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      const answer = JSON.parse(line)
      const waiting = this.waiting.get(answer.id)
      this.waiting.delete(answer.id)
      if (answer.error) waiting?.reject(Object.assign(new Error(answer.error.message), { code: answer.error.code, reason: answer.error.data?.reason }))
      else waiting?.resolve(answer.result)
    })
  }

  call(method, params = {}) {
    const id = this.next++
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }))
  }

  close() {
    this.process.stdin.end()
    return new Promise((resolve) => this.process.once('exit', resolve))
  }
}

const [executable, workspace, kitsDir, file, command, params] = process.argv.slice(2)
const kits = new Kits(executable, workspace, kitsDir)
try {
  await kits.call('kits.initialize', { client: { name: 'node-example', version: '1' } })
  const document = await kits.call('documents.open', { path: file })
  const target = { kit: document.kitId, documentId: document.documentId }
  await kits.call('commands.execute', { ...target, command, params: JSON.parse(params), origin: 'system' })
  const saved = await kits.call('documents.save', target)
  console.log(JSON.stringify({ path: saved.path, dirty: saved.dirty }))
} catch (error) {
  console.log(JSON.stringify({ error: error.reason ?? error.code }))
} finally {
  await kits.close()
}
