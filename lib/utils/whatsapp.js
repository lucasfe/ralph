const ENDPOINT = 'https://api.callmebot.com/whatsapp.php'
const DEFAULT_TIMEOUT_MS = 5000

export async function sendWhatsappMessage({
  phone,
  apiKey,
  message,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!phone || !apiKey) return { ok: false, reason: 'missing_credentials' }
  if (!message) return { ok: false, reason: 'missing_message' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'missing_fetch' }

  const url =
    `${ENDPOINT}?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(message)}` +
    `&apikey=${encodeURIComponent(apiKey)}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res || !res.ok) {
      const status = res?.status ?? 'unknown'
      return { ok: false, reason: `http_${status}` }
    }
    return { ok: true }
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : 'network_error'
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

export { ENDPOINT as CALLMEBOT_ENDPOINT, DEFAULT_TIMEOUT_MS }
