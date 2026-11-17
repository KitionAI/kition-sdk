/**
 * An engine's refusals the page tells apart from a failure.
 *
 * - An engine refuses a call's parameters for a check its schema cannot state with
 *   `Err(kition_kit::schema::refusal(&errors))`: the message is the errors' text, U+001E, and the
 *   errors as JSON (`[{ path, message, expected }]`, Kit Process Protocol `invalid_params`). The
 *   worker answers it as a `KitParamsError` whose message is the text alone, so the person and a
 *   caller never see the JSON; `ai/run` answers it with reason `invalid-params` and the errors.
 * - The worker refuses a host's change (origin `system`) on an engine that cannot run commands
 *   as an origin, since it could not keep the change out of the person's undo history
 *   (`KitEngineRefusal`, reason `unsupported`).
 */
import { INVALID_PARAMS_REASON } from '@kition/kit-ui-protocol'

/** One parameter a call got wrong: a JSON Pointer into the params, what is wrong, and what the command takes there. */
export type KitParamError = { path: string; message: string; expected?: string }

/** Separates a refusal's text from its errors (`kition_kit::schema::REFUSAL_SEPARATOR`). */
export const REFUSAL_SEPARATOR = '\u001e'

/** The reason of a host's change refused because the engine cannot keep it out of the undo history. */
export const UNSUPPORTED_REASON = 'unsupported'

/** An engine refused a call's parameters; `message` is its text, `errors` each wrong parameter. */
export class KitParamsError extends Error {
  readonly reason = INVALID_PARAMS_REASON
  constructor(
    message: string,
    readonly errors: KitParamError[],
  ) {
    super(message)
    this.name = 'KitParamsError'
  }
}

/** The worker refused a call it cannot run as asked (`reason`). */
export class KitEngineRefusal extends Error {
  constructor(
    readonly reason: typeof UNSUPPORTED_REASON,
    message: string,
  ) {
    super(message)
    this.name = 'KitEngineRefusal'
  }
}

function paramError(value: unknown): KitParamError | null {
  if (!value || typeof value !== 'object') return null
  const { path, message, expected } = value as Record<string, unknown>
  if (typeof path !== 'string' || typeof message !== 'string') return null
  return typeof expected === 'string' ? { path, message, expected } : { path, message }
}

/** An engine's error as a `KitParamsError` when it is a refusal of the parameters; `null` for any other. */
export function paramsRefusal(error: unknown): KitParamsError | null {
  if (error instanceof KitParamsError) return error
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  const at = text?.indexOf(REFUSAL_SEPARATOR) ?? -1
  if (text == null || at < 0) return null
  let errors: KitParamError[] = []
  try {
    const parsed = JSON.parse(text.slice(at + 1)) as unknown
    if (Array.isArray(parsed)) errors = parsed.map(paramError).filter((item): item is KitParamError => item !== null)
  } catch {
    // Errors that do not parse are left out; the text still reads alone.
  }
  return new KitParamsError(text.slice(0, at), errors)
}

/** Separates a command failure's text from its reason (`kition_kit::failure::FAILURE_SEPARATOR`). */
export const FAILURE_SEPARATOR = '\u001f'

/** The reasons a kit gives for a command that did not run (`kition_kit::failure::CommandFailure`). */
export const COMMAND_FAILURES = ['command_not_found', 'command_disabled', 'invalid_params'] as const
export type CommandFailureReason = (typeof COMMAND_FAILURES)[number]

/** A command did not run for the `reason` its kit gave; `message` is the text a person reads. */
export class KitCommandFailure extends Error {
  constructor(
    readonly reason: CommandFailureReason,
    message: string,
  ) {
    super(message)
    this.name = 'KitCommandFailure'
  }
}

/**
 * An engine's error as a `KitCommandFailure` when the kit gave its reason (`kition_kit::failure`:
 * its text, U+001F, the reason); `null` for any other, which is read by its wording where a code
 * is needed.
 */
export function commandFailure(error: unknown): KitCommandFailure | null {
  if (error instanceof KitCommandFailure) return error
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  const at = text?.lastIndexOf(FAILURE_SEPARATOR) ?? -1
  if (text == null || at < 0) return null
  const reason = COMMAND_FAILURES.find((known) => known === text.slice(at + 1))
  return reason ? new KitCommandFailure(reason, text.slice(0, at)) : null
}
