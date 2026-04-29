const DEFAULT_TIMEOUT_MS = 5000

export async function pingSuccess({
  url,
  fetch: fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!url) return { ok: false, reason: 'no-url' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' }
  return doPing(url, fetchImpl, timeoutMs)
}

export async function pingFail({
  url,
  failUrl,
  fetch: fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = failUrl || (url ? `${url}/fail` : '')
  if (!target) return { ok: false, reason: 'no-url' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' }
  return doPing(target, fetchImpl, timeoutMs)
}

async function doPing(url, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal })
    if (!res || !res.ok) {
      const status = res?.status ?? 'unknown'
      return { ok: false, reason: `http-${status}` }
    }
    return { ok: true }
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timeout' : 'network-error'
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

export { DEFAULT_TIMEOUT_MS }
