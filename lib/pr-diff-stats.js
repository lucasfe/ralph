// Best-effort fetcher for real PR diff stats. The issue branch `issue-<n>` is
// auto-merged and DELETED before the iteration returns, so a local `git diff`
// reports zeros on exactly the successful issues. The PR retains its stats after
// merge+delete and is addressable by the deterministic `issue-<n>` head ref, so
// we query gh instead:
//   gh pr list --head issue-<n> --state all --json additions,deletions,changedFiles
//
// This is TELEMETRY: any failure (exec throws / non-zero gh exit / unparseable
// JSON / null issueNumber / no PR) degrades to zeros and NEVER throws.
//
// Follows the injectable-dependency pattern used across this package: callers
// may pass an `exec(args) => stdoutString` impl; we fall back to a real
// execFileSync against the `gh` binary when none is given.

import { execFileSync } from 'node:child_process'

const ZERO = { additions: 0, deletions: 0, changedFiles: 0 }

// Real exec: runs `gh <args>` (argv array, NOT a shell string) and returns
// stdout as a utf8 string.
function realExec(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

export function fetchPrDiffStats(issueNumber, { exec = realExec } = {}) {
  if (issueNumber == null) return { ...ZERO }
  try {
    const stdout = exec([
      'pr',
      'list',
      '--head',
      `issue-${issueNumber}`,
      '--state',
      'all',
      '--json',
      'additions,deletions,changedFiles',
    ])
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed) || parsed.length === 0) return { ...ZERO }
    const pr = parsed[0] || {}
    return {
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changedFiles ?? 0,
    }
  } catch {
    return { ...ZERO }
  }
}
