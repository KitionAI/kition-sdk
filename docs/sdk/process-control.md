# Kit process controls

`kition mcp`, `kition gateway` and `kition serve` accept these options beside `--sandbox`:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--call-timeout-secs <n>` | 120 | Maximum time for one request to a kit, including writing to its socket. Shorter protocol deadlines still apply (initialize: 10 seconds; ordinary control requests: 30 seconds). Progress does not extend it |
| `--idle-timeout-secs <n>` | 600 | Reclaim a worker after this long without a call, once no document operation is active |
| `--memory-limit-mib <n>` | unset | Per-process ceiling, in MiB (1,048,576 bytes). Linux uses an address-space resource limit and resident monitoring; macOS uses resident monitoring. Other platforms refuse the option |

Values must be positive integers; overflow is refused. Discovery probes receive the same
launch and memory policy. Rust hosts set `control::Limits` with `KitManager::with_limits`
before serving calls. The Kit Process Protocol's section 11 remains the wire-level default;
the host's configured deadline bounds document operations as an operator policy.

```sh
kition mcp --workspace <folder> --sandbox \
  --call-timeout-secs 120 --idle-timeout-secs 600 --memory-limit-mib 2048

kition serve --workspace <folder> --sandbox \
  --call-timeout-secs 120 --idle-timeout-secs 600 --memory-limit-mib 2048
```

## Document workers and recovery

The host admits complete operations in arrival order per canonical workspace document. The
gate covers opening, checking the revision guard, executing steps, saving, and updating the
journal. A cancelled waiter cannot let later calls overtake the active call. Stdio reserves
admission before spawning work. Different documents, including documents of one kit, use
independent processes: the kit server's existing connection workers and backend mutex cannot
make one slow document block another. There is one host admission gate for a whole operation;
the kit's existing worker continues to dispatch its wire messages.

Each document worker retains its host and agent connections and private grant session.
Manager document ids are opaque and routed to process-local ids, so identical ids assigned by
different processes do not collide. File-backed ids survive reclaim/restart. Opening a replica
draft again uses its existing persisted snapshot. Save As retires the source worker after
saving its state and routes the document's next use to the destination.

A request deadline returns `KitError::Timeout`, tool code `timeout`, or service error
`-32051` / `data.reason: call_timeout`. The host cancels the request, kills and reaps the
worker, and starts a fresh one on its next use. A timed-out operation is never left running in
the background. Recovery reads the last saved file; uncommitted edits in a killed worker are
lost. A timeout can happen after a file commit, so callers should inspect before repeating a
mutation. Existing tool rollback remains best effort.

Idle reclaim uses the same save routine as orderly manager shutdown. It persists replica
drafts without changing their review state, saves dirty file-backed documents through the
existing handle/atomic-commit path, and then sends `kit.shutdown`. A failed save (including a
file conflict) keeps an idle worker alive and retries after another idle interval. An unknown
dirty document with no persisted backing also prevents reclaim. The host never reclaims an
active call. Process exit after shutdown is bounded by five seconds, then it is killed.

One worker per document trades a higher process count for isolation. There is currently no
global process-count or aggregate-memory budget; limits apply to each worker individually.

## Memory enforcement

Linux sets `ulimit -v` before exec through the existing safe launch wrapper, inside the same
launch confinement as the sandbox. Failure to install the limit exits the wrapper; it cannot
silently run without the limit. The limit covers virtual address space, so it can refuse a
large reservation even when resident use is small. It applies only to the child, without
unsafe code or changing the host's resource limits.

Linux samples `/proc/<pid>/status`; macOS samples `/bin/ps -o rss= -p <pid>` from the host,
outside the sandbox. Sampling is every 250 ms, with up to one second for the macOS probe.
Resident limits are periodic and allow temporary overshoot. The child is checked and killed
through its owned process handle, avoiding signalling a reused PID. Failure to sample a live
process stops it with a clear monitoring error. Windows and other platforms have no safe
resident reader implemented here and refuse the option at configuration/launch time.

A worker stopped by the resident monitor returns `KitError::MemoryLimit`, tool code
`memory-limit`, or service error `-32052` / `data.reason: memory_limit`. The next call also
reports an otherwise unobserved idle memory stop once before restarting. An allocation refused
by Linux's address-space limit may instead make the engine return an ordinary kit error or
abort. The kernel does not identify an address-space allocation refusal in the child's exit
status, so an abort that the resident monitor did not cause is still `kit_unavailable`; it
cannot safely be distinguished from another engine crash. That classification remains a gap.

## MCP progress and cancellation

The host uses the protocol's existing `kit.progress`, `$/cancelRequest`, and
`-32800 request_cancelled`; it adds no kit wire messages. Each process's two connections share
a request-id sequence so broadcast progress cannot be confused with an unrelated request on
the other connection. Progress is matched to a live pending request and then to the outer MCP
call. A call supplies `params._meta.progressToken`; notifications use that exact token.
MCP `progress` is an increasing event count, since a tool can make several kit requests whose
fractions restart. The message contains the kit's title and percentage when supplied.
Notification buffers are bounded; a slow reader can lose intermediate progress.

MCP stdio continues reading while calls run. `notifications/cancelled` names `requestId` in
the same session. A queued cancellation removes that call without disturbing the active
document operation. An active cancellation sends the existing kit cancellation notification,
clears the pending request, and stops workers used by the cancelled call; the outer request
returns `-32800`. A blocked socket writer cannot hold up cancellation indefinitely.

The remaining control gaps are explicit:

- `kition-kit-server` checks cancellation before starting queued work. `KitBackend` has no
  cooperative interruption/checkpoint API for a synchronous call already executing. The host
  therefore terminates its worker, and cannot guarantee rollback of a completed file commit.
- Kit progress exists only when the kit emits it. The protocol has no composite tool-step
  progress or cancellation/rollback receipt. The host reports only notifications it receives.
- The live editor bridge has no equivalent progress or cancellation hook. Cancelling its MCP
  wrapper does not interrupt an editor mutation already executing.
- An HTTP/SSE adapter must keep one `mcp::Session` per client, construct it with
  `Session::with_notifications`, forward those notifications over SSE, and deliver cancellation
  through `handle_in` on that same session. The external desktop HTTP adapter has not been
  changed here; `handle`/`handle_with` alone provide no outgoing notification stream.
