// Agent auth probe with INJECTABLE exec/exists dependencies (#554). Returns
// { ok, reason } (async). This is the seam `ralph cycle`'s preflight uses so a
// Codex-only machine is not blocked by a Claude credentials file it will never
// have, and a Claude machine keeps its exact current check.
//
//   Claude  — ok = exists(claudeCredentialsPath). Today's behavior, unchanged.
//             reason 'claude credentials missing' when absent.
//   Codex   — run `codex login status` and key on the EXIT CODE ONLY, never on
//             output text: managed-credential builds legitimately print
//             "Login is not required." and exit zero, which must count as
//             success. Non-zero (or a spawn error) => not authenticated.

import { existsSync as realExistsSync } from 'node:fs'

// Codex auth subcommand, verified against the installed CLI (`codex login`
// has a `status` subcommand). Kept here so the argv lives in one place.
const CODEX_LOGIN_STATUS_ARGV = ['login', 'status']

export async function probeAgentAuth({
  agent,
  exec,
  exists = realExistsSync,
  claudeCredentialsPath,
} = {}) {
  if (agent === 'claude') {
    return exists(claudeCredentialsPath)
      ? { ok: true, reason: null }
      : { ok: false, reason: 'claude credentials missing' }
  }

  if (agent === 'codex') {
    try {
      const r = await exec('codex', CODEX_LOGIN_STATUS_ARGV, { reject: false })
      // EXIT CODE ONLY — never parse stdout/stderr text.
      if (r && r.exitCode === 0) return { ok: true, reason: null }
    } catch {
      // fall through to the failure result below
    }
    return { ok: false, reason: 'codex not authenticated' }
  }

  throw new Error(`probeAgentAuth: unknown agent '${agent}'`)
}
