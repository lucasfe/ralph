import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { globalConfigPath } from './global-config.js'

// #5: surgically upsert KEY=value pairs into raw dotenv text. Matching keys are
// updated in place (their original position is kept); missing keys are appended;
// comments, blank lines, and unrelated vars are preserved untouched. The `export
// ` prefix is honored when matching but normalized away on the rewritten line
// (mirroring parseEnvFile's key handling).
export function upsertEnvContent(content, updates) {
  const pending = { ...updates }
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = content.length ? body.split('\n') : []
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=')
      if (eq !== -1) {
        const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '')
        if (Object.prototype.hasOwnProperty.call(pending, key)) {
          out.push(`${key}=${pending[key]}`)
          delete pending[key]
          continue
        }
      }
    }
    out.push(line)
  }
  for (const [key, value] of Object.entries(pending)) {
    out.push(`${key}=${value}`)
  }
  let text = out.join('\n')
  if (text.length && !text.endsWith('\n')) text += '\n'
  return text
}

// #5: write the given credential values into the global Ralph dotenv file via a
// surgical upsert. Enforces 0700 on the parent dir and 0600 on the file. The fs
// impl and path/home/processEnv are injectable so memfs tests never touch the
// real home dir. Reuses globalConfigPath so there is one source of truth.
export function writeGlobalCreds({
  values,
  fs,
  processEnv = process.env,
  home = homedir(),
  path = globalConfigPath({ processEnv, home }),
}) {
  let existing = ''
  try {
    existing = fs.readFileSync(path, 'utf8').toString()
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const next = upsertEnvContent(existing, values)
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, next, { mode: 0o600 })
  // #5: writeFileSync's `mode` is honored only on CREATE — on overwrite of a
  // pre-existing (possibly world-readable) file it is ignored, leaving a
  // credentials file with loose perms. chmod unconditionally to re-tighten to
  // 0600 on both create and update. Guarded so an injected fs stub without a
  // chmodSync still works (real fs and memfs both provide it).
  if (typeof fs.chmodSync === 'function') fs.chmodSync(path, 0o600)
  return path
}
