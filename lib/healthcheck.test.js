import { describe, it, expect } from 'vitest'
import { pingSuccess, pingFail } from './healthcheck.js'

function makeFetch(handler) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts)
  }
  fn.calls = calls
  return fn
}

const URL = 'https://hc-ping.com/abc123'

describe('pingSuccess', () => {
  it('returns { ok: false, reason: "no-url" } when url is missing and does not call fetch', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    expect(await pingSuccess({ url: '', fetch: fetchImpl })).toEqual({
      ok: false,
      reason: 'no-url',
    })
    expect(await pingSuccess({ fetch: fetchImpl })).toEqual({
      ok: false,
      reason: 'no-url',
    })
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('returns { ok: false, reason: "no-fetch" } when no fetch implementation is available', async () => {
    expect(await pingSuccess({ url: URL, fetch: null })).toEqual({
      ok: false,
      reason: 'no-fetch',
    })
  })

  it('issues a GET to the url and returns { ok: true } on 2xx', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    const res = await pingSuccess({ url: URL, fetch: fetchImpl })
    expect(res).toEqual({ ok: true })
    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0].url).toBe(URL)
    expect(fetchImpl.calls[0].opts.method).toBe('GET')
  })

  it('returns { ok: false, reason: "http-<status>" } when the upstream responds non-ok', async () => {
    const fetchImpl = makeFetch(() => ({ ok: false, status: 500 }))
    const res = await pingSuccess({ url: URL, fetch: fetchImpl })
    expect(res).toEqual({ ok: false, reason: 'http-500' })
  })

  it('returns { ok: false, reason: "network-error" } when fetch rejects', async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error('boom')
    })
    const res = await pingSuccess({ url: URL, fetch: fetchImpl })
    expect(res).toEqual({ ok: false, reason: 'network-error' })
  })

  it('returns { ok: false, reason: "timeout" } when the fetch is aborted by the timeout signal', async () => {
    const fetchImpl = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    const res = await pingSuccess({ url: URL, fetch: fetchImpl, timeoutMs: 5 })
    expect(res).toEqual({ ok: false, reason: 'timeout' })
  })

  it('never throws even when fetch synchronously throws a non-Error value', async () => {
    const fetchImpl = () => {
      throw 'string-error'
    }
    const res = await pingSuccess({ url: URL, fetch: fetchImpl })
    expect(res.ok).toBe(false)
  })
})

describe('pingFail', () => {
  it('returns { ok: false, reason: "no-url" } when url and failUrl are both missing', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    expect(await pingFail({ url: '', fetch: fetchImpl })).toEqual({
      ok: false,
      reason: 'no-url',
    })
    expect(await pingFail({ fetch: fetchImpl })).toEqual({
      ok: false,
      reason: 'no-url',
    })
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('derives the failure URL by appending /fail to the base url by default', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    const res = await pingFail({ url: URL, fetch: fetchImpl })
    expect(res).toEqual({ ok: true })
    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0].url).toBe(`${URL}/fail`)
    expect(fetchImpl.calls[0].opts.method).toBe('GET')
  })

  it('uses a custom failUrl when provided, ignoring the base url', async () => {
    const customFailUrl = 'https://hc-ping.com/custom-fail-uuid'
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    const res = await pingFail({ url: URL, failUrl: customFailUrl, fetch: fetchImpl })
    expect(res).toEqual({ ok: true })
    expect(fetchImpl.calls[0].url).toBe(customFailUrl)
  })

  it('uses failUrl even when base url is empty', async () => {
    const customFailUrl = 'https://hc-ping.com/custom-fail-uuid'
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    const res = await pingFail({ failUrl: customFailUrl, fetch: fetchImpl })
    expect(res).toEqual({ ok: true })
    expect(fetchImpl.calls[0].url).toBe(customFailUrl)
  })

  it('accepts a message argument without throwing (message handling is best-effort)', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true, status: 200 }))
    const res = await pingFail({ url: URL, message: 'something failed', fetch: fetchImpl })
    expect(res).toEqual({ ok: true })
    expect(fetchImpl.calls).toHaveLength(1)
  })

  it('returns { ok: false, reason: "network-error" } when fetch rejects', async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error('boom')
    })
    const res = await pingFail({ url: URL, fetch: fetchImpl })
    expect(res).toEqual({ ok: false, reason: 'network-error' })
  })

  it('returns { ok: false, reason: "timeout" } when aborted by the timeout signal', async () => {
    const fetchImpl = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    const res = await pingFail({ url: URL, fetch: fetchImpl, timeoutMs: 5 })
    expect(res).toEqual({ ok: false, reason: 'timeout' })
  })

  it('returns { ok: false, reason: "http-<status>" } when the upstream responds non-ok', async () => {
    const fetchImpl = makeFetch(() => ({ ok: false, status: 502 }))
    const res = await pingFail({ url: URL, fetch: fetchImpl })
    expect(res).toEqual({ ok: false, reason: 'http-502' })
  })
})
