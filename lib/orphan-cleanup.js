const ORPHAN_LABEL = 'claude-working'

const LIST_ARGS = [
  'issue',
  'list',
  '--state',
  'open',
  '--label',
  ORPHAN_LABEL,
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
