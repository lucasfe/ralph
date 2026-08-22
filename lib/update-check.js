const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const PACKAGE_NAME = '@lucasfe/ralph'

export function isValidSemver(s) {
  return typeof s === 'string' && SEMVER_RE.test(s.trim())
}

export function compareSemver(a, b) {
  const parse = (v) => {
    const noBuild = v.split('+')[0]
    const dashIdx = noBuild.indexOf('-')
    const main = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx)
    const pre = dashIdx === -1 ? '' : noBuild.slice(dashIdx + 1)
    return { parts: main.split('.').map((n) => Number(n)), pre }
  }
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = A.parts[i] ?? 0
    const y = B.parts[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  if (A.pre === B.pre) return 0
  if (A.pre === '') return 1
  if (B.pre === '') return -1
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0
}

// #21: the registry query on its own — "what is the latest published version?"
// with no state, no dedupe, no comparison. Any failure (non-zero exit, timeout,
// missing npm, non-semver output) resolves to null, never throws.
export async function fetchLatestVersion(exec, timeoutMs = 5000) {
  if (typeof exec !== 'function') return null
  let result
  try {
    result = await exec('npm', ['view', PACKAGE_NAME, 'version'], {
      timeout: timeoutMs,
      reject: false,
    })
  } catch {
    return null
  }
  if (!result || result.exitCode !== 0 || result.timedOut) return null
  const fetched = (result.stdout || '').trim()
  return isValidSemver(fetched) ? fetched : null
}

export async function checkForUpdate(
  currentVersion,
  state,
  { exec, timeoutMs = 5000 } = {},
) {
  const safeState = state ?? {}
  const fetched = await fetchLatestVersion(exec, timeoutMs)
  if (!fetched || !isValidSemver(currentVersion)) {
    return { newVersion: null, updatedState: safeState }
  }
  if (compareSemver(fetched, currentVersion) <= 0) {
    return { newVersion: null, updatedState: safeState }
  }
  if (safeState.last_seen_release === fetched) {
    return { newVersion: null, updatedState: safeState }
  }
  return {
    newVersion: fetched,
    updatedState: { ...safeState, last_seen_release: fetched },
  }
}
