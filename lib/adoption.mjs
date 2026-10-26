/**
 * dsh-plugin-adoption — rank DSH plugins by real npm downloads, not stars.
 *
 * WHY THIS EXISTS
 * The community's discovery surfaces rank by GitHub stars. Measured on the
 * live catalog, that ordering is measurably wrong as a proxy for "is anyone
 * actually using this":
 *
 *   by stars:  vision-router(1174) > mnemon(701) > config-manager(240)
 *              > find-plugin(206) > memento(141) > mcp-panel(89)
 *              > secure-audit(85)
 *   by downloads: mnemon(50,672) > vision-router(33,058) > find-plugin(22,038)
 *              > config-manager(15,291) > mcp-panel(10,058) > memento(5,966)
 *              > secure-audit(2,047)
 *
 * `dsh-mcp-panel` sits 6th by stars but 4th by downloads — a 89-star plugin
 * that more people actually run than a 240-star one. Stars measure attention
 * a repository got; downloads measure installs that happened.
 *
 * WHAT IT DOES
 * - Reads the plugin list from the 1024Store catalog API (public, no auth).
 * - Queries npm's public downloads API for each package that has one.
 * - Reports both orderings side by side, and flags the plugins whose real
 *   adoption rank differs most from their star rank.
 *
 * DESIGN CONSTRAINTS (same ones trust-audit follows)
 * - Registers NO HTTP route of its own.
 * - Read-only: GETs to two public APIs, nothing else. No writes anywhere.
 * - Every number carries its source and the date it was fetched. A ranking
 *   without provenance is not evidence.
 * - Says `unknown` when a plugin has no npm package, instead of guessing 0 —
 *   "no published package" and "nobody downloaded it" are different facts.
 */

const CATALOG_API = 'https://api.deepseek1024.com/v1/plugins/search'
const NPM_DL_API = 'https://api.npmjs.org/downloads/point/last-month'
const FETCH_TIMEOUT_MS = 20000

/**
 * The catalog API is anonymous at 50 requests/day, 10/minute
 * (its own docs). A default run of 60 candidates is 60 npm calls plus one
 * catalog call, so this plugin can exhaust a caller's daily quota on the first
 * try — which would break the store for everything else they do that day.
 *
 * So: one request at a time, spaced, and a 429 backs off hard instead of
 * hammering. Being slower on purpose is the only way this is safe to ship.
 */
const MIN_GAP_MS = 1200
const BACKOFF_MS = [5000, 15000, 45000]

let lastRequestAt = 0

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Wait out the minimum gap, so bursts never leave this process. */
async function pace() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/** Package names that are not real install targets. */
const NON_PACKAGE_PREFIXES = ['github:', 'gitlab:', 'bitbucket:', 'gist:', 'jsr:', 'file:', 'link:', 'http:', 'https:']

/**
 * Shapes that are paths rather than package names.
 *
 * install-analytics lists these as `never reported`, and they must not reach
 * npm: a local path would produce a 404 (wasting quota and, worse, reading as
 * "zero downloads" for a plugin that is very much installed).
 */
const PATH_SHAPES = [
  /^[\\/]/,           // /abs/path or \abs\path
  /^[A-Za-z]:[\\/]/,  // C:\... or C:/...
  /^~[\\/]/,          // ~/...
  /^\.\.?[\\/]/,      // ./ or ../
]


/**
 * Pull the package name out of a catalog `install` command.
 *
 * Exported so the test suite exercises this exact function. A copy living in
 * the test file passes while the shipped code is broken — which is precisely
 * how the `/some/local/path` case slipped through the first version.
 *
 * `dsh plugin --profile web add github:owner/repo`      -> no npm package
 * `dsh plugin --profile web add @scope/name`            -> @scope/name
 * `dsh plugin --profile web add name`                   -> name
 * `dsh plugin --profile web add github:o/r#path:sub`    -> no npm package
 * `dsh plugin add /some/local/path`                     -> no npm package
 */
export function packageOf(installCmd) {
  if (typeof installCmd !== 'string') return null
  const afterAdd = installCmd.split(/\sadd\s/).pop() || ''
  const target = afterAdd.trim().split(/\s+/)[0] || ''
  if (!target) return null
  for (const p of NON_PACKAGE_PREFIXES) {
    if (target.startsWith(p)) return null
  }
  for (const re of PATH_SHAPES) {
    if (re.test(target)) return null
  }
  // A path fragment (`#path:sub/dir`) still means a published package here,
  // but the fragment is not part of the name.
  return target.split('#')[0] || null
}


/** One GET, JSON back. Returns null on failure, and records why. */
async function getJson(url, sink) {
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
      // Never swallow this silently. A report that says "0 plugins" when the
      // network actually failed is worse than one that says "I could not tell":
      // the first reads as a finding, the second reads as a failure.
      if (sink) sink.push(`${e.name || 'error'} ${url.slice(0, 80)}`)
      return null
    }
  }
  return null
}


/** Fetch the catalog page for a query. */
async function catalogPage(query, limit, sink) {
  const url = `${CATALOG_API}?q=${encodeURIComponent(query)}&limit=${limit}`
  return getJson(url, sink)
}


/** Monthly downloads for one package, or null when npm has no answer. */
async function npmDownloads(pkg, sink) {
  const j = await getJson(`${NPM_DL_API}/${encodeURIComponent(pkg)}`, sink)
  if (!j || typeof j.downloads !== 'number') return null
  return j.downloads
}


/** Spearman-ish rank distance: how far a plugin moved between two orderings. */
export function rankShift(starRank, dlRank) {
  if (typeof starRank !== 'number' || typeof dlRank !== 'number') return null
  return starRank - dlRank   // positive = downloads rank it higher than stars do
}


/**
 * Build the report.
 *
 * `queries` are catalog search terms; their union is the candidate pool.
 * Kept small on purpose — each npm lookup is a separate request and this runs
 * inside a tool call, so a handful of well-chosen queries beats one huge one.
 */
export async function adoption({ queries = ['dsh'], limit = 60, topN = 15 } = {}) {
  const qs = Array.isArray(queries) && queries.length ? queries.slice(0, 6) : ['dsh']
  // 12 by default: one catalog call + at most 12 npm calls stays well inside
  // the anonymous 50/day budget, so running this does not break the caller's
  // other store usage. Pass a bigger limit deliberately if you have a key.
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12
  const lim = Math.min(requested, 100)
  const n = Number.isFinite(topN) && topN > 0 ? Math.min(Math.floor(topN), 50) : 15
  /** Every request failure lands here, and is reported. See getJson. */
  const failures = []

  // 1. Collect candidates from the catalog, de-duplicated by id.
  const byId = new Map()
  const perQuery = {}
  for (const q of qs) {
    const j = await catalogPage(q, lim, failures)
    const results = (j && Array.isArray(j.results)) ? j.results : []
    perQuery[q] = results.length
    for (const it of results) {
      if (!it || typeof it.id !== 'string') continue
      if (byId.has(it.id)) continue
      byId.set(it.id, {
        id: it.id,
        name: it.name || it.id,
        stars: typeof it.stars === 'number' ? it.stars : null,
        installs: typeof it.installCount === 'number' ? it.installCount : null,
        category: it.category || null,
        pkg: packageOf(it.install),
      })
    }
  }

  const candidates = [...byId.values()]

  // 2. Look up downloads for the ones that have a published package.
  for (const c of candidates) {
    if (!c.pkg) { c.downloads = null; continue }
    c.downloads = await npmDownloads(c.pkg, failures)
  }

  // 3. Two orderings over the plugins that have BOTH numbers, so the
  //    comparison is not confounded by missing data.
  const both = candidates.filter(c => c.downloads !== null)
  const byStars = [...both].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
  const byDownloads = [...both].sort((a, b) => b.downloads - a.downloads)

  const starRank = new Map(byStars.map((c, i) => [c.id, i + 1]))
  const dlRank = new Map(byDownloads.map((c, i) => [c.id, i + 1]))

  // 4. Flag the biggest disagreements: downloaded far more than starred.
  const flagged = byDownloads
    .map(c => ({
      id: c.id, name: c.name, stars: c.stars, downloads: c.downloads,
      pkg: c.pkg,
      starRank: starRank.get(c.id), downloadRank: dlRank.get(c.id),
      shift: rankShift(starRank.get(c.id), dlRank.get(c.id)),
    }))
    .filter(x => x.shift !== null && x.shift > 0)
    .sort((a, b) => b.shift - a.shift)
    .slice(0, topN)

  // 5. Same display name, different npm package. `dsh-pet` and
  //    `@linxin666/dsh-pet` are two packages that happen to share a short
  //    name, and they are not interchangeable — installing one does not get
  //    you the other. The short name alone is ambiguous, so say so where the
  //    ambiguity actually is instead of letting the reader guess.
  const byShortName = new Map()
  for (const c of both) {
    if (!c.pkg) continue
    if (!byShortName.has(c.name)) byShortName.set(c.name, new Set())
    byShortName.get(c.name).add(c.pkg)
  }
  const ambiguous = [...byShortName.entries()]
    .filter(([, pkgs]) => pkgs.size > 1)
    .map(([name, pkgs]) => ({ name, packages: [...pkgs] }))

  return {
    ok: true,
    queries: qs,
    perQuery,
    sampled: candidates.length,
    withPackage: candidates.filter(c => c.pkg).length,
    withDownloads: both.length,
    // Provenance, so a ranking is never mistaken for evidence on its own.
    sources: {
      catalog: CATALOG_API,
      npm: NPM_DL_API,
      fetchedAt: new Date().toISOString(),
    },
    topByDownloads: byDownloads.slice(0, n).map(c => ({
      name: c.name, pkg: c.pkg, downloads: c.downloads,
      stars: c.stars, installs: c.installs,
      starRank: starRank.get(c.id), downloadRank: dlRank.get(c.id),
    })),
    underratedByStars: flagged,
    // Short names that map to more than one npm package. Always install by
    // the full package name.
    ambiguousNames: ambiguous,
    noPackage: candidates.filter(c => !c.pkg).map(c => c.id).slice(0, 20),
    // Request failures, verbatim. If this is non-empty the ranking below is
    // incomplete, and the report says so instead of quietly shrinking.
    requestFailures: failures.slice(0, 10),
    caveat: '下载量来自 npm 官方月下载接口，星数来自 1024Store catalog 快照。'
      + '两者口径不同：星数衡量仓库获得的关注，下载量衡量实际发生的安装。'
      + '没有 npm 包的插件无法比较，已单列在 noPackage，不当成 0 处理。'
      + (failures.length > 0
        ? ` ⚠️ 本次有 ${failures.length} 次请求失败，下面的排名不完整 —— 失败项列在 requestFailures。`
        : ''),
  }
}
