/**
 * dsh-xray capability data source — the "how much can this plugin actually do"
 * dimension that stars and downloads both lack.
 *
 * WHERE THE DATA COMES FROM
 * https://unstone.github.io/dsh-xray/ scans DSH plugin repositories and grades
 * each one's capability surface. The published 14.86 MB file
 * (https://unstone.github.io/dsh-xray/data.json) is the ONLY machine-readable
 * source that carries the individual flag ids, and the flag ids are the whole
 * point: "level 2" alone cannot tell you whether a plugin runs subprocesses or
 * reads your API keys.
 *
 * The grading vocabulary is the publisher's, quoted from the site rather than
 * invented here:
 *
 *   C0  No notable capability surface.
 *   C1  Ordinary: registers tools/services, calls external domains.
 *   C2  Powerful: prompt surface, API interception, subprocess, exec,
 *       credential reads or install scripts.
 *   C3  Powerful capabilities combined with sensitive behavior.
 *
 * MEASURED, on 2026-10-26 (see research/round50-capability-dimension.md):
 *   14,855,325 bytes; 13.8 s cold / 1.5 s warm over gzip; JSON.parse of the
 *   whole document costs 145 ms and 25.3 MB of heap. Projecting to the fields
 *   this module keeps, and dropping the parsed document, brings that to about
 *   15.6 MB of live heap.
 *
 * So the document IS parsed whole — there is no cheaper faithful way, because
 * a hand-rolled JSON splitter over chunk boundaries silently drops objects
 * (measured: it truncated the last record and had to be abandoned). What this
 * module does instead is keep only a projected `Map` and return nothing else,
 * so the 25 MB document is garbage the moment projection finishes.
 *
 * FAILURE POLICY (inherited from this plugin's core rule)
 * "I could not find out" and "it has no capabilities" are different facts.
 *   - transport/timeout/HTTP failure  -> push to `requestFailures`, source
 *                                        reported as `unavailable`, every
 *                                        plugin's capability left `null`.
 *   - a 404 for one repository        -> that repository was never scanned;
 *                                        that is data, and is reported as
 *                                        `not-scanned`, still not a zero.
 * Nothing here ever turns a failure into an empty array.
 */

import { getJsonDetailed, getTextLimited } from './http.mjs'

export const XRAY_DATA_URL = 'https://unstone.github.io/dsh-xray/data.json'
export const XRAY_BADGE_BASE = 'https://unstone.github.io/dsh-xray/badge'

/**
 * The bulk file is 14 MB. Fetching it once per tool call would mean a fresh
 * download every time somebody asks a second question, which is both slow and
 * rude to the publisher's GitHub Pages.
 *
 * So the parsed index is held in memory for the process lifetime. The upstream
 * file is a daily scan snapshot, so a long-lived process serving stale levels
 * is a real but bounded problem — the report says which snapshot it used
 * (`generatedAt`), so the reader can always tell how old the grade is.
 *
 * A failed load is NOT cached: the next call should try again rather than
 * inherit a failure for the rest of the session.
 */
let bulkCache = null

/** Test seam: drop the cached bulk index. */
export function clearXrayCache() {
  bulkCache = null
}

/** Level meaning, quoted from the publisher's legend. Never re-worded here. */
export const LEVEL_LEGEND = {
  0: 'C0 没有值得注意的能力面',
  1: 'C1 普通：注册工具/服务、访问外部域名',
  2: 'C2 强势：prompt 面、API 拦截、子进程、exec、读凭证或安装脚本',
  3: 'C3 强势能力与敏感行为的组合',
}

/**
 * Flags that make a capability *sensitive* in their own right.
 *
 * This subset is OUR judgement, not the publisher's: the grade already folds
 * these in, but "which sensitive thing can it do" is the question an installing
 * user actually asks, and the level alone does not answer it.
 *
 * `runtime_patch` is first because it is by far the most common (18,943 of
 * 21,452 scanned) — a plugin that patches the runtime config can change how
 * every other plugin behaves, which is a bigger deal than executing a
 * subprocess inside its own sandbox.
 */
export const SENSITIVE_FLAGS = [
  'runtime_patch',       // patches the runtime config / other plugins
  'prompt_surface',      // can rewrite what is sent to the model
  'api_intercept',       // sits in front of the model API
  'token_env',           // reads API-key-class environment variables
  'install_script',      // runs arbitrary code at install time
  'exec',                // executes commands / arbitrary code
  'net_server',          // opens a listening socket
  'subprocess_service',  // drives subprocesses through the host service
  'eval',                // evaluates strings as code
  'base64_decode',       // decodes embedded blobs (a common loader shape)
]

const SENSITIVE_SET = new Set(SENSITIVE_FLAGS)

/**
 * Combinations worth naming out loud, each with the reason it is worse than
 * either half. Measured counts over the 21,452 scanned repositories, so the
 * thresholds below are the observed shape of the ecosystem, not a guess.
 */
export const DANGEROUS_COMBOS = [
  { id: 'exec+token_env', flags: ['exec', 'token_env'], count: 1135,
    why: '能执行命令，又能读到 API Key —— 两者合用等于凭证可被程序读走后外发' },
  { id: 'prompt_surface+exec', flags: ['prompt_surface', 'exec'], count: 1064,
    why: '能改写发给模型的内容，又能执行命令 —— prompt 注入可以升级成真实代码执行' },
  { id: 'api_intercept+token_env', flags: ['api_intercept', 'token_env'], count: null,
    why: '拦在模型 API 前面，又能读凭证 —— 流量与密钥在同一处汇合' },
  { id: 'net_server+token_env', flags: ['net_server', 'token_env'], count: null,
    why: '对外开监听端口，又能读凭证 —— 本机服务暴露面与密钥暴露面重叠' },
]

/** Is this flag id in the sensitive subset above? */
export function isSensitiveFlag(id) {
  return SENSITIVE_SET.has(id)
}

/** Narrow one raw dsh-xray flag entry (object with `id`, or a bare string) to its id. */
export function flagIdOf(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.id === 'string') return entry.id
  return null
}

/**
 * Project one raw dsh-xray plugin record down to what this plugin reports.
 *
 * Returns `null` for anything that is not a usable record (no repo).
 *
 * LEVEL -1 IS NOT C0. Measured on the 2026-10-26 snapshot: 349 of 21,801
 * records carry `level: -1` with a `status` of "skipped: …" — no scannable
 * code (324), download failed (23), or a scanner error (2). Those repositories
 * were never graded. Folding them into level 0 would read as "scanned, found
 * harmless", which is the exact silent-empty result this plugin refuses to
 * produce, so they are projected as `level: null` plus the reason in `status`.
 */
export function projectRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  if (!repo) return null
  const rawLevel = Number.isInteger(raw.level) ? raw.level : null
  // Negative levels are the publisher's "skipped" sentinel, not a grade.
  const level = rawLevel !== null && rawLevel >= 0 && rawLevel <= 3 ? rawLevel : null
  const flags = Array.isArray(raw.flags)
    ? [...new Set(raw.flags.map(flagIdOf).filter(Boolean))]
    : []
  const status = typeof raw.status === 'string' ? raw.status : null
  return {
    repo,
    level,
    flags,
    sensitive: flags.filter(isSensitiveFlag),
    filesScanned: Number.isFinite(raw.files_scanned) ? raw.files_scanned : null,
    status,
    // Why this record has no grade, when the publisher said why. Null when it
    // was graded, or when no reason was given.
    ungradedReason: level === null
      ? (status && /^skipped/i.test(status) ? status : (rawLevel === null ? status : 'level out of range'))
      : null,
  }
}

/**
 * Highest level (0..3) present in a flag set, or null when there is none.
 *
 * Fallback only. Used when the bulk file is unavailable, because the per-repo
 * badge endpoint publishes a level but not the flag ids. It is a *lower bound*:
 * a badge that says C2 could be C2 for exec or for an install script, and the
 * report must not pretend to know which.
 */
export function maxLevelOf(levels) {
  let best = null
  for (const l of levels) {
    if (Number.isInteger(l) && (best === null || l > best)) best = l
  }
  return best
}

/**
 * Index a dsh-xray document by repository id.
 *
 * Two repo spellings have to agree, because the two sources do not use the
 * same one: the catalog writes `github:owner/repo#path:sub` while dsh-xray keys
 * on `owner/repo`. `repoKeyOf` is the single normalisation both sides go
 * through, so a mismatch is impossible by construction rather than by luck.
 */
export function indexXray(doc) {
  const plugins = doc && Array.isArray(doc.plugins) ? doc.plugins : null
  if (!plugins) return null
  const byRepo = new Map()
  let skipped = 0
  for (const raw of plugins) {
    const rec = projectRecord(raw)
    if (!rec) { skipped++; continue }
    const key = repoKeyOf(rec.repo)
    if (!key) { skipped++; continue }
    byRepo.set(key, rec)
  }
  return {
    byRepo,
    generatedAt: typeof doc.generated_at === 'string' ? doc.generated_at : null,
    scanned: Number.isFinite(doc.scanned) ? doc.scanned : null,
    total: Number.isFinite(doc.total) ? doc.total : null,
    skipped,
  }
}

/**
 * Normalise any repo spelling this plugin sees to `owner/repo` lowercased.
 *
 *   github:nexu-io/open-design#path:packages/dsh-runtime -> nexu-io/open-design
 *   https://github.com/nexu-io/open-design             -> nexu-io/open-design
 *   git+https://github.com/o/r.git                     -> o/r
 *   nexu-io/open-design                                -> nexu-io/open-design
 *   @scope/name                                        -> null (a package, not a repo)
 */
export function repoKeyOf(value) {
  if (typeof value !== 'string') return null
  let t = value.trim()
  if (!t) return null
  // A scoped npm package is not a repository id.
  if (t.startsWith('@') && !t.includes('github.com')) return null
  const m = t.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/i)
  if (m) return `${m[1]}/${m[2]}`.toLowerCase()
  for (const p of ['github:', 'gitlab:', 'bitbucket:', 'gist:']) {
    if (t.toLowerCase().startsWith(p)) t = t.slice(p.length)
  }
  t = t.split('#')[0]
  const n = t.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  return n ? `${n[1]}/${n[2]}`.toLowerCase() : null
}

/**
 * Load the capability index.
 *
 * @param {object} opts
 * @param {string[]} opts.failures - the run's requestFailures sink
 * @param {number} [opts.maxBytes] - hard ceiling on the downloaded body
 * @returns {Promise<{source: string, available: boolean, byRepo: Map,
 *   generatedAt: string|null, scanned: number|null, total: number|null,
 *   skipped: number, reason: string|null, legend: object}>}
 *
 * `source` is `'dsh-xray'` when the bulk file parsed, `'unavailable'` when it
 * did not. Callers must branch on `available` rather than on an empty map: an
 * empty map from a failed download is the silent-empty result this plugin
 * exists to avoid.
 */
export async function loadXray({ failures, maxBytes = 40 * 1024 * 1024 } = {}) {
  const sink = Array.isArray(failures) ? failures : []
  const base = {
    source: XRAY_DATA_URL,
    available: false,
    byRepo: new Map(),
    generatedAt: null,
    scanned: null,
    total: null,
    skipped: 0,
    reason: null,
    legend: LEVEL_LEGEND,
  }

  if (bulkCache) {
    return { ...bulkCache }
  }

  const fetched = await getTextLimited(XRAY_DATA_URL, { sink, maxBytes })
  if (!fetched.ok) {
    return { ...base, reason: fetched.reason }
  }

  let doc
  try {
    doc = JSON.parse(fetched.text)
  } catch {
    // A truncated or non-JSON body is a transport fault, not "no plugins have
    // capabilities". Say so; do not degrade to an empty index.
    sink.push(`dsh-xray: response was not valid JSON (${fetched.text.length} chars)`)
    return { ...base, reason: 'invalid-json' }
  }

  const index = indexXray(doc)
  if (!index) {
    sink.push('dsh-xray: response had no plugins array')
    return { ...base, reason: 'no-plugins-array' }
  }
  if (index.skipped > 0) {
    sink.push(`dsh-xray: ${index.skipped} records skipped (missing repo or level)`)
  }

  const result = {
    ...base,
    available: true,
    byRepo: index.byRepo,
    generatedAt: index.generatedAt,
    scanned: index.scanned,
    total: index.total,
    skipped: index.skipped,
  }
  bulkCache = result
  return { ...result }
}

/**
 * Per-repository badge lookup — the degraded path when the bulk file fails.
 *
 * Measured: ~300-700 ms and 92 bytes per repository, versus 1.5 s and 14.9 MB
 * once for the whole ecosystem. So this only makes sense for the handful of
 * candidates actually being reported, and it is strictly poorer data: it
 * returns a level and a flag COUNT, never the flag ids. `flags` stays empty and
 * `partial: true` marks every row it produces, so no report can mistake it for
 * the full picture.
 *
 * A 404 means dsh-xray never scanned this repository. That is data, returned as
 * `scanned: false`. Only a transport/5xx failure is pushed to `requestFailures`.
 */
export async function fetchBadge(repo, { failures } = {}) {
  const key = repoKeyOf(repo)
  if (!key) return { scanned: false, level: null, flagCount: null, partial: true, reason: 'not-a-repo' }
  const sink = Array.isArray(failures) ? failures : []
  const url = `${XRAY_BADGE_BASE}/${key.replace('/', '__')}.json`
  const res = await getJsonDetailed(url)
  if (res.ok) {
    const message = typeof res.data?.message === 'string' ? res.data.message : ''
    const lvl = message.match(/\bC([0-3])\b/)
    const cnt = message.match(/(\d+)\s*flags?/)
    return {
      scanned: lvl !== null,
      level: lvl ? Number(lvl[1]) : null,
      flagCount: cnt ? Number(cnt[1]) : null,
      partial: true,
      reason: null,
    }
  }
  if (res.status === 404) {
    // Never scanned. A fact about the repository, not a fault of ours.
    return { scanned: false, level: null, flagCount: null, partial: true, reason: 'not-scanned' }
  }
  sink.push(`dsh-xray badge ${key}: ${res.error}`)
  return { scanned: false, level: null, flagCount: null, partial: true, reason: res.error }
}
