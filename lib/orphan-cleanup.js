// #139: the label an orphan is orphaned BY, taken from lib/labels.js rather than spelled
// here. The sweep and the query that excludes the label are one mechanism seen from two ends —
// this module hunts exactly the issues that query hides — so the two cannot be allowed to
// drift into a sweep that clears one word and a queue that skips another.
import { IN_PROGRESS_LABEL } from './labels.js'

const ORPHAN_LABEL = IN_PROGRESS_LABEL

// `--state all`, not `--state open` (#40): an issue closed by a merged PR keeps
// `claude-working` (neither of the agent's removal paths runs on that route), and
// a sweep scoped to open issues can never see it — which is why that backlog had
// to be cleared by hand. Listing every state repairs the existing backlog while
// leaving the open-orphan behavior identical.
//
// `--limit 100` raises the page from gh's default 30 but is NOT a guarantee: with
// no `--search`, gh orders CREATED_AT DESC, so the page fills from the newest
// orphan backwards and the OLDEST fall off — and since the loop picks work with
// `sort:created-asc`, a long-lived OPEN orphan is the item most likely to be
// truncated once >100 orphans exist. There is one page and no state-aware second
// pass; the backlog self-drains over a few cycles, which is what makes the bound
// acceptable rather than safe.
const LIST_ARGS = [
  'issue',
  'list',
  '--state',
  'all',
  '--label',
  ORPHAN_LABEL,
  '--limit',
  '100',
  '--json',
  'number,title,updatedAt',
]

export async function findOrphans({ exec, repoPath, log = console.error } = {}) {
  if (typeof exec !== 'function') return []
  let result
  try {
    result = await exec('gh', LIST_ARGS, { cwd: repoPath, reject: false })
  } catch (err) {
    log(`orphan-cleanup: failed to list orphans: ${err?.message ?? err}`)
    return []
  }
  if (!result || result.exitCode !== 0) {
    const stderr = (result?.stderr ?? '').trim()
    log(`orphan-cleanup: gh list exited ${result?.exitCode}: ${stderr}`)
    return []
  }
  const stdout = (result.stdout ?? '').trim() || '[]'
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    log(`orphan-cleanup: invalid JSON from gh: ${err?.message ?? err}`)
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((item) => item && typeof item.number === 'number')
    .map((item) => ({
      number: item.number,
      title: item.title,
      updatedAt: item.updatedAt,
    }))
}

export async function cleanupOrphans({ exec, orphans, log = console.error } = {}) {
  if (typeof exec !== 'function') return []
  if (!Array.isArray(orphans) || orphans.length === 0) return []
  const cleared = []
  for (const orphan of orphans) {
    if (!orphan || typeof orphan.number !== 'number') continue
    const args = ['issue', 'edit', String(orphan.number), '--remove-label', ORPHAN_LABEL]
    let result
    try {
      result = await exec('gh', args, { reject: false })
    } catch (err) {
      log(`orphan-cleanup: failed to clear #${orphan.number}: ${err?.message ?? err}`)
      continue
    }
    if (!result || result.exitCode !== 0) {
      const stderr = (result?.stderr ?? '').trim()
      log(`orphan-cleanup: gh edit #${orphan.number} exited ${result?.exitCode}: ${stderr}`)
      continue
    }
    cleared.push(orphan.number)
  }
  return cleared
}
