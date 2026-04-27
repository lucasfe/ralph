import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { hashConfig, readState, writeState } from './state.js'

export class FinalizeStateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FinalizeStateError'
  }
}

export function finalizeState({
  projectRoot = process.cwd(),
  ralphVersion = process.env.RALPH_VERSION,
  fs: fsImpl,
} = {}) {
  const state = readState(projectRoot, fsImpl)
  if (!state) {
    throw new FinalizeStateError(
      'finalizeState: .ralph/state.json missing after validation',
    )
  }
  const required = [
    'validated_at',
    'detected_stack',
    'notes',
    'last_seen_release',
  ]
  for (const k of required) {
    if (!(k in state)) {
      throw new FinalizeStateError(
        `finalizeState: .ralph/state.json missing required field "${k}"`,
      )
    }
  }
  const configPath = join(projectRoot, 'ralph.config.sh')
  const configHash = hashConfig(configPath, fsImpl)
  const next = {
    ...state,
    config_hash: configHash,
    ralph_version: ralphVersion ?? state.ralph_version ?? 'unknown',
  }
  writeState(projectRoot, next, fsImpl)
  return next
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  try {
    const result = finalizeState()
    process.stdout.write(
      `==> state.json finalized (config_hash=${result.config_hash.slice(0, 12)}…)\n`,
    )
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    process.exit(1)
  }
}
