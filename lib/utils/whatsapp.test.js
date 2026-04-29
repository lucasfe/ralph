import { describe, it, expect } from 'vitest'
import { sendWhatsappMessage, CALLMEBOT_ENDPOINT } from './whatsapp.js'

function makeFetch(handler) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts)
  }
  fn.calls = calls
  return fn
}

describe('sendWhatsappMessage', () => {
  it('returns missing_credentials when phone or apiKey is empty', async () => {
    const noop = makeFetch(() => ({ ok: true, status: 200 }))
    expect(await sendWhatsappMessage({ phone: '', apiKey: 'k', message: 'm', fetchImpl: noop }))
      .toEqual({ ok: false, reason: 'missing_credentials' })
    expect(await sendWhatsappMessage({ phone: '+1', apiKey: '', message: 'm', fetchImpl: noop }))
      .toEqual({ ok: false, reason: 'missing_credentials' })
    expect(noop.calls).toHaveLength(0)
  })

  it('returns missing_message when message is empty', async () => {
    const noop = makeFetch(() => ({ ok: true, status: 200 }))
    const res = await sendWhatsappMessage({
      phone: '+1',
      apiKey: 'k',
      message: '',
      fetchImpl: noop,
    })
    expect(res).toEqual({ ok: false, reason: 'missing_message' })
    expect(noop.calls).toHaveLength(0)
  })

  it('returns missing_fetch when no fetch implementation is available', async () => {
    const res = await sendWhatsappMessage({
      phone: '+1',
      apiKey: 'k',
      message: 'hi',
      fetchImpl: null,
    })
    expect(res).toEqual({ ok: false, reason: 'missing_fetch' })
  })

  it('builds the CallMeBot URL with url-encoded params and reports ok on 2xx', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    const res = await sendWhatsappMessage({
      phone: '+5511999999999',
      apiKey: 'secret-key',
      message: 'Ralph started & is active',
      fetchImpl,
    })
    expect(res).toEqual({ ok: true })
    expect(fetchImpl.calls).toHaveLength(1)
    const url = fetchImpl.calls[0].url
    expect(url.startsWith(CALLMEBOT_ENDPOINT + '?')).toBe(true)
    expect(url).toContain('phone=%2B5511999999999')
    expect(url).toContain('text=Ralph%20started%20%26%20is%20active')
    expect(url).toContain('apikey=secret-key')
  })

  it('returns http_<status> when CallMeBot responds with a non-ok status', async () => {
    const fetchImpl = makeFetch(() => ({ ok: false, status: 500 }))
    const res = await sendWhatsappMessage({
      phone: '+1',
      apiKey: 'k',
      message: 'hi',
      fetchImpl,
    })
    expect(res).toEqual({ ok: false, reason: 'http_500' })
  })

  it('returns network_error when fetch rejects', async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error('boom')
    })
    const res = await sendWhatsappMessage({
      phone: '+1',
      apiKey: 'k',
      message: 'hi',
      fetchImpl,
    })
    expect(res).toEqual({ ok: false, reason: 'network_error' })
  })

  it('returns timeout when fetch is aborted by the timeout signal', async () => {
    const fetchImpl = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    const res = await sendWhatsappMessage({
      phone: '+1',
      apiKey: 'k',
      message: 'hi',
      fetchImpl,
      timeoutMs: 5,
    })
    expect(res).toEqual({ ok: false, reason: 'timeout' })
  })
})
