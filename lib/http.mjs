/**
 * Shared HTTP transport for dsh-plugin-adoption.
 *
 * WHY THIS IS ITS OWN MODULE
 * Every request this plugin makes — catalog, npm, and the dsh-xray capability
 * file — has to leave this process at the MIN_GAP_MS pace. If each data source
 * kept its own "last request at" clock, two sources could fire together and
 * double the burst the rate limits actually see. One clock, one pace().
 *
 * The catalog API is anonymous at 50 requests/day, 10/minute (its own docs). A
 * default run of 60 candidates is 60 npm calls plus one catalog call, so this
 * plugin can exhaust a caller's daily quota on the first try — which would
 * break the store for everything else they do that day.
 *
 * So: one request at a time, spaced, and a 429 backs off hard instead of
 * hammering. Being slower on purpose is the only way this is safe to ship.
 *
 * Read-only by construction: nothing here can issue anything but a GET.
 */

export const FETCH_TIMEOUT_MS = 20000
export const MIN_GAP_MS = 1200
export const BACKOFF_MS = [5000, 15000, 45000]

let lastRequestAt = 0

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Wait out the minimum gap, so bursts never leave this process. */
export async function pace() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/**
 * One GET, JSON back. Returns null on failure, and records why.
 *
 * `sink` is the run's `requestFailures` array. A failure is never swallowed:
 * a report that says "0 results" when the network failed is worse than one that
 * says "I could not tell" — the first reads as a finding, the second as a fault.
 */
export async function getJson(url, sink) {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    await pace()
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-adoption' },
        signal: ac.signal,
      })
      clearTimeout(timer)

      // 429 is the caller's quota, not a transient fault. Back off and retry a
      // few times, then give up and report it — never spin.
      if (res.status === 429) {
        if (attempt < BACKOFF_MS.length) {
          if (sink) sink.push(`429 rate-limited, backing off ${BACKOFF_MS[attempt]}ms`)
          await sleep(BACKOFF_MS[attempt])
          continue
        }
        if (sink) sink.push(`HTTP 429 rate-limited (quota exhausted) ${url.slice(0, 80)}`)
        return null
      }
      if (!res.ok) {
        if (sink) sink.push(`HTTP ${res.status} ${url.slice(0, 80)}`)
        return null
      }
      return await res.json()
    } catch (e) {
      // A timeout while the host is throttling us is worth one more try;
      // a DNS or connection refusal is not.
      const timedOut = e && e.name === 'AbortError'
      if (timedOut && attempt < BACKOFF_MS.length) {
        if (sink) sink.push(`timeout, retrying in ${BACKOFF_MS[attempt]}ms`)
        await sleep(BACKOFF_MS[attempt])
        continue
      }
      // Never swallow this silently. See this function's doc comment.
      if (sink) sink.push(`${e.name || 'error'} ${url.slice(0, 80)}`)
      return null
    }
  }
  return null
}

/**
 * One GET that reports its HTTP status instead of folding it into null.
 *
 * Some callers must tell two outcomes apart that `getJson` merges:
 *
 *   404  — the resource does not exist. That is a *fact about the subject*
 *          ("dsh-xray never scanned this repository"), and it belongs in the
 *          report as data.
 *   5xx / timeout — we failed to find out. That is a *fault*, and it belongs in
 *          `requestFailures`.
 *
 * Reading a 404 as "unknown capability surface" is exactly the silent-empty
 * result this plugin refuses to produce.
 *
 * No retries on purpose: a 404 is not transient, and this path only runs when
 * the bulk data source is already unavailable.
 */
export async function getJsonDetailed(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  await pace()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-adoption' },
      signal: ac.signal,
    })
    if (!res.ok) return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}` }
    return { ok: true, status: res.status, data: await res.json(), error: null }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e?.name || 'error' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One GET of a potentially large text body, with a hard size ceiling.
 *
 * The dsh-xray capability file is ~14 MB. Buffering an unbounded response is
 * how a read-only audit turns into an out-of-memory crash, so this checks
 * Content-Length up front and then counts bytes as they arrive — a server that
 * lies about (or omits) Content-Length still cannot push past `maxBytes`.
 *
 * Returns `{ ok, text }` or `{ ok: false, reason }`, where reason is
 * `'too-large' | 'timeout' | 'http-<status>' | <error name>`.
 */
export async function getTextLimited(url, { sink, maxBytes, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 32 * 1024 * 1024
  await pace()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-adoption' },
      signal: ac.signal,
    })
    if (!res.ok) {
      if (sink) sink.push(`HTTP ${res.status} ${url.slice(0, 80)}`)
      return { ok: false, reason: `http-${res.status}` }
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      if (sink) sink.push(`refused ${url.slice(0, 80)}: ${declared} bytes exceeds ${cap} byte ceiling`)
      return { ok: false, reason: 'too-large' }
    }
    const dec = new TextDecoder()
    let text = ''
    let seen = 0
    for await (const chunk of res.body) {
      seen += chunk.byteLength
      if (seen > cap) {
        if (sink) sink.push(`refused ${url.slice(0, 80)}: body exceeded ${cap} byte ceiling`)
        return { ok: false, reason: 'too-large' }
      }
      text += dec.decode(chunk, { stream: true })
    }
    text += dec.decode()
    return { ok: true, text }
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'timeout' : (e?.name || 'error')
    if (sink) sink.push(`${reason} ${url.slice(0, 80)}`)
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}
