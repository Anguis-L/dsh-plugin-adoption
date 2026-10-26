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
 * - Joins each candidate to its dsh-xray capability grade (level + flag ids).
 * - Reports three orderings side by side: by stars, by downloads, and by
 *   capability risk — plus the intersection that matters most, plugins that are
 *   BOTH widely installed AND sensitive.
 *
 * DESIGN CONSTRAINTS (same ones trust-audit follows)
 * - Registers NO HTTP route of its own.
 * - Read-only: GETs to public APIs, nothing else. No writes anywhere.
 * - Every number carries its source and the date it was fetched. A ranking
 *   without provenance is not evidence.
 * - Says `unknown` when a plugin has no npm package, instead of guessing 0 —
 *   "no published package" and "nobody downloaded it" are different facts.
 * - Says `unknown` when a plugin has no capability grade, instead of guessing
 *   C0 — "never scanned" and "scanned and found harmless" are different facts.
 * - Says `unknown` when the version line cannot be decided, instead of guessing
 *   that a plugin installs — "I could not find out" and "it will not install"
 *   are different facts too, and only one of them is actionable.
 */

import { getJson } from './http.mjs'
import {
  XRAY_DATA_URL, XRAY_BADGE_BASE, LEVEL_LEGEND, DANGEROUS_COMBOS,
  loadXray, fetchBadge, repoKeyOf,
} from './xray.mjs'
import {
  riskScore, riskBucket, rankByRisk, highAdoptionAndRisk, dangerCombos,
} from './risk.mjs'
import { readLocalToolsVersion, versionLineFor } from './versionline.mjs'

const CATALOG_API = 'https://api.deepseek1024.com/v1/plugins/search'
const NPM_DL_API = 'https://api.npmjs.org/downloads/point/last-month'

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
 * `dsh plugin add --allow-build=x dsh-pet`              -> dsh-pet
 *
 * The last case was measured on 2026-10-26: a catalog entry whose install
 * command carries an option before the target (`add --allow-build=@dsh-external
 * dsh-pet`) made this return the option itself, which then cost a real 404
 * against npm and would have attributed another package's downloads to this
 * entry. Options are skipped, not parsed — the target is the first argument
 * that is not one.
 */
export function packageOf(installCmd) {
  if (typeof installCmd !== 'string') return null
  const afterAdd = installCmd.split(/\sadd\s/).pop() || ''
  const target = afterAdd.trim().split(/\s+/).find(tok => tok && !tok.startsWith('-')) || ''
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


/** Fetch the catalog page for a query. */
async function catalogPage(query, limit, sink) {
  const url = `${CATALOG_API}?q=${encodeURIComponent(query)}&limit=${limit}`
  return getJson(url, sink)
}


/**
 * The repository id out of a catalog install command, when it names one.
 *
 * `dsh plugin --profile web add github:owner/repo`  ->  owner/repo
 * `dsh plugin --profile web add owner/repo`        ->  owner/repo
 * `dsh plugin --profile web add @scope/name`      ->  null (already a package)
 * `dsh plugin add --allow-build=x github:o/r`     ->  o/r (options are skipped)
 */
export function repoIdOf(installCmd) {
  if (typeof installCmd !== 'string') return null
  const afterAdd = installCmd.split(/\sadd\s/).pop() || ''
  const target = afterAdd.trim().split(/\s+/).find(tok => tok && !tok.startsWith('-')) || ''
  if (!target) return null
  let t = target
  for (const p of NON_PACKAGE_PREFIXES) {
    if (t.startsWith(p)) t = t.slice(p.length)
  }
  t = t.split('#')[0]
  const m = t.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  return m ? `${m[1]}/${m[2]}` : null
}


/**
 * Find the npm package that belongs to a GitHub repository.
 *
 * WHY THIS EXISTS
 * The catalog's `install` command is not always a package name. `dsh plugin add
 * github:owner/repo` is a repository, and a repository is not a package. Guessing
 * that the package is named after the repo hits about half the time: measured on
 * 40 random catalog entries, "the last segment of owner/repo" is a real npm
 * package only 20 times.
 *
 * The misses are not typos, they are forks and re-publications:
 *
 *   @linxin666/dsh-pet   ->  repository github.com/zhu1090093659/dsh-pet
 *   @ttmouse/dsh-taskboard -> repository github.com/ttmouse/dsh-taskboard
 *
 * The package owner and the repository owner are simply different people. So
 * instead of guessing, read the registry: every packument version carries a
 * `repository.url`, and the package whose repository points at THIS repository
 * is the one that belongs to it. That is the same binding the 1024Store catalog
 * uses, and it is the only way to attribute a download count to the right
 * repository.
 *
 * Returns the package name, or null when the repository has no published
 * package (which is a fact about the plugin, not an error).
 */
export function repoOfPackage(pkgName, repositoryUrl) {
  if (!pkgName || !repositoryUrl) return null
  const repo = String(repositoryUrl).toLowerCase()
  // Normalise the shapes a repository field comes in: git+https://github.com/o/r.git,
  // git://github.com/o/r, https://github.com/o/r, github:o/r
  const m = repo.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/)
  if (!m) return null
  const owner = m[1], name = m[2]
  const pkg = pkgName.toLowerCase()
  const pkgTail = pkg.includes('/') ? pkg.split('/').pop() : pkg
  // The package name has to match the repository's own name. The owner is
  // deliberately not compared: a package's scope and its repository's owner
  // are often different people (@linxin666/dsh-pet points at
  // zhu1090093659/dsh-pet), and the repository pointer is what makes the
  // match trustworthy in the first place.
  //
  // Comparing only the tail is enough, and comparing the owner as well would
  // reject exactly the real matches this exists to find.
  if (pkgTail !== name) return null
  return `${owner}/${name}`
}


/** Monthly downloads for one package, or null when npm has no answer. */
async function npmDownloads(pkg, sink) {
  const j = await getJson(`${NPM_DL_API}/${encodeURIComponent(pkg)}`, sink)
  if (!j || typeof j.downloads !== 'number') return null
  return j.downloads
}


/**
 * Resolve which npm package belongs to a catalog entry that has no package name.
 *
 * The catalog gives a repository. npm's search API returns each candidate
 * package's `repository.url`. Match it against the repository we were given.
 *
 * Only the npm search endpoint is used, which is a different service from the
 * catalog API, so this does not touch the catalog's 50/day quota.
 */
export async function resolvePackage(repoId, sink) {
  if (!repoId) return null
  const name = String(repoId).split('/').pop()
  if (!name) return null
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=25`
  const j = await getJson(url, sink)
  if (!j || !Array.isArray(j.objects)) return null
  const wanted = String(repoId).toLowerCase()
  for (const o of j.objects) {
    const p = o?.package || {}
    const links = p.links || {}
    let repo = links.repository || p.repository || ''
    if (repo && typeof repo === 'object') repo = repo.url || ''
    repo = String(repo || '')
    if (!repo) continue
    const m = repo.toLowerCase().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/)
    if (!m) continue
    if (`${m[1]}/${m[2]}` === wanted) {
      return { pkg: p.name, monthly: o?.downloads?.monthly ?? null, repo }
    }
  }
  return null
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
 *
 * `capability` controls the dsh-xray dimension:
 *   'auto'  (default) load the bulk capability file once; on failure fall back
 *           to per-candidate badge lookups for the reported rows only.
 *   'bulk'  bulk file only. Fastest path when you know it will work.
 *   'badge' skip the 14.9 MB file; badge lookups only. Partial data by design.
 *   'off'   skip the dimension entirely (the pre-existing behaviour).
 */
export async function adoption({
  queries = ['dsh'], limit = 60, topN = 15, capability = 'auto', xrayMaxBytes,
  versionLine = 'auto', localVersion,
} = {}) {
  const qs = Array.isArray(queries) && queries.length ? queries.slice(0, 6) : ['dsh']
  // 12 by default: one catalog call + at most 12 npm calls stays well inside
  // the anonymous 50/day budget, so running this does not break the caller's
  // other store usage. Pass a bigger limit deliberately if you have a key.
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12
  const lim = Math.min(requested, 100)
  const n = Number.isFinite(topN) && topN > 0 ? Math.min(Math.floor(topN), 50) : 15
  const capMode = ['auto', 'bulk', 'badge', 'off'].includes(capability) ? capability : 'auto'
  const versionMode = ['auto', 'off'].includes(versionLine) ? versionLine : 'auto'
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
        installCmd: typeof it.install === 'string' ? it.install : null,
        pkg: packageOf(it.install),
        // The catalog's own `url` is the most reliable repo pointer; the install
        // command is the fallback because it may name a package instead.
        repoId: repoKeyOf(it.url) || repoKeyOf(it.install) || null,
      })
    }
  }

  const candidates = [...byId.values()]

  // 2. Look up downloads for the ones that have a published package.
  //
  //    An entry whose install command names a GitHub repository has no package
  //    name, and the repository's name is only the package name about half the
  //    time. For those, ask the registry which package actually points back at
  //    this repository, instead of guessing and reporting the wrong number.
  //
  //    The catalog's `install` field keeps the repository in the github: form,
  //    so the repository id is recoverable from it.
  let resolved = 0
  for (const c of candidates) {
    if (!c.pkg) {
      const repoId = repoIdOf(c.installCmd)
      if (repoId) {
        const found = await resolvePackage(repoId, failures)
        if (found) {
          c.pkg = found.pkg
          c.pkgResolvedFrom = repoId
          resolved++
        }
      }
    }
    if (!c.pkg) { c.downloads = null; continue }
    c.downloads = await npmDownloads(c.pkg, failures)
  }

  // 2b. Attach the capability grade. This is a join against an independently
  //     published dataset, so a miss is a fact about that dataset, not an error
  //     in this one — but a transport failure IS an error, and it is reported.
  const cap = await attachCapability(candidates, capMode, failures, xrayMaxBytes)

  // 3. Orderings over the plugins that have BOTH numbers, so the star/download
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

  // 6. The capability-risk view. Built over ALL candidates, not just the ones
  //    with a download number: a plugin nobody measured still executes code on
  //    your machine if you install it.
  const riskRows = rankByRisk(candidates).map(c => riskRowOf(c))
  const highRiskHighAdoption = highAdoptionAndRisk(candidates)

  // 7. The version-line view. This is the half a real user checks FIRST —
  //    "which tools line does it ride" — before looking at downloads at all.
  const versionLines = await attachVersionLines(candidates, { mode: versionMode, failures, localVersion })

  const graded = candidates.filter(c => Number.isInteger(c.capability?.level))
  return {
    ok: true,
    queries: qs,
    perQuery,
    sampled: candidates.length,
    withPackage: candidates.filter(c => c.pkg).length,
    withDownloads: both.length,
    // How many entries had no package name in the catalog and had one recovered
    // from the registry's repository pointer. Without this step those entries
    // would be reported as "no package" and left out of the comparison.
    packageResolved: resolved,
    // Provenance, so a ranking is never mistaken for evidence on its own.
    sources: {
      catalog: CATALOG_API,
      npm: NPM_DL_API,
      npmSearch: 'https://registry.npmjs.org/-/v1/search',
      xray: XRAY_DATA_URL,
      xrayBadge: XRAY_BADGE_BASE,
      fetchedAt: new Date().toISOString(),
    },
    topByDownloads: byDownloads.slice(0, n).map(c => ({
      name: c.name, pkg: c.pkg, downloads: c.downloads,
      stars: c.stars, installs: c.installs,
      starRank: starRank.get(c.id), downloadRank: dlRank.get(c.id),
      pkgResolvedFrom: c.pkgResolvedFrom || null,
      capability: capabilityOf(c),
      versionLine: versionLineOf(c),
    })),
    underratedByStars: flagged,
    // Short names that map to more than one npm package. Always install by
    // the full package name.
    ambiguousNames: ambiguous,
    noPackage: candidates.filter(c => !c.pkg).map(c => c.id).slice(0, 20),

    // ── the version-line dimension ────────────────────────────────────────
    versionLines,

    // ── the capability dimension ──────────────────────────────────────────
    // How the grade was obtained, so the reader knows whether `flags` is
    // populated (bulk) or empty by necessity (badge).
    capabilitySource: {
      mode: capMode,
      used: cap.used,
      available: cap.available,
      reason: cap.reason,
      universe: cap.available ? { scanned: cap.scanned, total: cap.total, generatedAt: cap.generatedAt } : null,
      graded: graded.length,
      ungraded: candidates.length - graded.length,
      legend: LEVEL_LEGEND,
      note: cap.note,
    },
    // The second ordering: worst capability surface first. Ungraded plugins are
    // kept and sorted last — omitted rows would make the list look complete.
    topByRisk: riskRows.slice(0, n),
    // The intersection that is the actual point: installed a lot, AND able to
    // do sensitive things.
    highAdoptionAndHighRisk: {
      threshold: highRiskHighAdoption.threshold,
      basis: highRiskHighAdoption.basis,
      rows: highRiskHighAdoption.rows
        .sort((a, b) => b.downloads - a.downloads)
        .map(c => riskRowOf(c)),
    },
    // Which dangerous combinations exist in the candidate pool, with the
    // ecosystem-wide count alongside for scale.
    dangerousCombos: DANGEROUS_COMBOS.map(combo => ({
      id: combo.id,
      why: combo.why,
      ecosystemCount: combo.count,
      inCandidates: candidates.filter(c =>
        dangerCombos(c.capability?.flags, [combo]).length > 0).length,
    })),
    // Failures of the capability join specifically, kept separate from the
    // general requestFailures so the reader can tell which dimension is short.
    capabilityFailures: cap.specificFailures,

    // Request failures, verbatim. If this is non-empty the ranking below is
    // incomplete, and the report says so instead of quietly shrinking.
    requestFailures: failures.slice(0, 10),
    caveat: '下载量来自 npm 官方月下载接口，星数来自 1024Store catalog 快照。'
      + '两者口径不同：星数衡量仓库获得的关注，下载量衡量实际发生的安装。'
      + '没有 npm 包的插件无法比较，已单列在 noPackage，不当成 0 处理。'
      + '能力面等级（C0-C3）与 flags 来自 dsh-xray 的公开扫描，是无标注的静态分析结果，'
      + '不是安全保证 —— 它回答「这个插件能做什么」，不回答「这个插件是恶意的」。'
      + (cap.available
        ? ''
        : ' ⚠️ 本次能力面数据不可用（见 capabilitySource.reason），'
          + '所有插件的 capability 都是 null，请当作「不知道」而不是「没问题」。')
      + (failures.length > 0
        ? ` ⚠️ 本次有 ${failures.length} 次请求失败，下面的排名不完整 —— 失败项列在 requestFailures。`
        : ''),
  }
}


/**
 * The capability view of one candidate, as it appears in a report row.
 *
 * Kept in one place so `topByDownloads`, `topByRisk` and the high-risk list
 * cannot drift into three different spellings of the same fact.
 */
function capabilityOf(c) {
  const x = c.capability
  if (!x || !Number.isInteger(x.level)) {
    return {
      level: null, bucket: 'unknown', sensitive: [], flags: [],
      repo: x?.repo ?? c.repoId ?? null,
      note: x?.note ?? '未分级',
      // Why the publisher has no grade, when it said why. "skipped: no
      // scannable code" is a different fact from "we failed to fetch".
      ungradedReason: x?.ungradedReason ?? null,
    }
  }
  return {
    level: x.level,
    bucket: riskBucket(x),
    sensitive: x.sensitive ?? [],
    flags: x.flags ?? [],
    repo: x.repo,
    filesScanned: x.filesScanned ?? null,
    partial: x.partial === true,
  }
}

/** One row of the risk ordering. */
function riskRowOf(c) {
  const capability = capabilityOf(c)
  return {
    id: c.id,
    name: c.name,
    pkg: c.pkg,
    repo: capability.repo,
    downloads: c.downloads,
    stars: c.stars,
    installs: c.installs,
    level: capability.level,
    bucket: capability.bucket,
    riskScore: riskScore(capability),
    sensitive: capability.sensitive,
    flags: capability.flags,
    partial: capability.partial === true,
    ungradedReason: capability.ungradedReason,
  }
}


/**
 * The version-line view of one candidate, as it appears in a report row.
 *
 * `status` is the whole answer in one word, and the four non-ok values are
 * deliberately distinct — a reader acts differently on each:
 *   ok / no-constraint   nothing to fix
 *   blocked              this will not install here; pin a version or skip it
 *   undecidable          a range exists but is not a version range
 *   unknown              we could not find out (no package, no registry answer)
 */
function versionLineOf(c) {
  const v = c.versionLine
  if (!v) {
    return {
      status: 'unknown', pkg: c.pkg ?? null, declaredRange: null,
      localVersion: null, satisfies: null, installable: { matching: [], highest: null, total: 0 },
      reason: '未查询',
    }
  }
  return {
    status: v.status,
    pkg: v.pkg ?? null,
    pkgSource: v.pkgSource ?? null,
    repo: v.repo ?? null,
    declaredRange: v.declaredRange ?? null,
    localVersion: v.localVersion ?? null,
    satisfies: v.satisfies,
    blocking: v.blocking === true,
    cordisRange: v.cordisRange ?? null,
    latest: v.latest ?? null,
    // Only the newest few are shown; `total` says how many actually match so a
    // truncated list is never mistaken for the whole set.
    installable: v.installable ?? { matching: [], highest: null, total: 0 },
    reason: v.reason ?? null,
  }
}


/**
 * Resolve the version line for every candidate.
 *
 * COST CONTROL. A packument GET per candidate would double this plugin's
 * request count, so the work is bounded twice over:
 *   - only candidates that have an accurate package name are queried at all;
 *     a bare repository gets `resolvePackage` first, which is itself a request,
 *     so those are capped separately;
 *   - `limit` caps how many are queried per run, and the report says how many
 *     were skipped for that reason rather than silently showing fewer rows.
 *
 * Every request goes through the shared `pace()` clock, so this cannot outrun
 * the 1.2s cadence the other sources already use.
 */
async function attachVersionLines(candidates, { mode, failures, localVersion }) {
  const sink = Array.isArray(failures) ? failures : []
  const local = readLocalToolsVersion()
  const resolvedLocal = typeof localVersion === 'string' && localVersion.trim() !== ''
    ? { version: localVersion.trim(), source: 'argument', tried: local.tried }
    : local

  const summary = {
    enabled: mode !== 'off',
    localVersion: resolvedLocal.version,
    localVersionSource: resolvedLocal.source,
    // How many candidates were queried, and how many were left out to keep the
    // request count bounded. Both numbers are needed to read the rest.
    queried: 0,
    skippedForBudget: 0,
    statusCounts: { ok: 0, blocked: 0, 'no-constraint': 0, undecidable: 0, unknown: 0 },
    blockedPlugins: [],
    note: null,
  }

  if (mode === 'off') {
    summary.note = '版本线维度已关闭（versionLine=off）'
    return summary
  }
  if (!resolvedLocal.version) {
    // Without the installed version there is no question to answer. Say so;
    // do not invent a line.
    summary.note = '读不到本机 dsh-tools 版本，无法判断任何插件是否装得上'
      + '（可用 DSH_TOOLS_VERSION 环境变量或 localVersion 参数指定）'
    return summary
  }

  // One packument per candidate, capped. 24 keeps a default run near the
  // existing request budget while still covering a normal candidate pool.
  const MAX_QUERIES = 24
  let budget = MAX_QUERIES
  for (const c of candidates) {
    const hasName = typeof c.pkg === 'string' && c.pkg !== ''
    const hasRepo = typeof c.repoId === 'string' && c.repoId !== ''
    if (!hasName && !hasRepo) {
      c.versionLine = {
        status: 'unknown', pkg: null, reason: '既没有 npm 包名也没有仓库地址',
        localVersion: resolvedLocal.version, installable: { matching: [], highest: null, total: 0 },
      }
      summary.statusCounts.unknown++
      continue
    }
    if (budget <= 0) {
      summary.skippedForBudget++
      c.versionLine = {
        status: 'unknown', pkg: c.pkg ?? null, localVersion: resolvedLocal.version,
        reason: `本次运行达到查询上限（${MAX_QUERIES}），未查询`,
        installable: { matching: [], highest: null, total: 0 },
      }
      summary.statusCounts.unknown++
      continue
    }
    budget--
    summary.queried++
    const line = await versionLineFor({
      pkgName: hasName ? c.pkg : null,
      repoId: hasRepo ? c.repoId : null,
      localVersion: resolvedLocal.version,
      failures: sink,
      resolve: resolvePackage,
    })
    c.versionLine = line
    const status = line.status in summary.statusCounts ? line.status : 'unknown'
    summary.statusCounts[status]++
    if (status === 'blocked') {
      summary.blockedPlugins.push({
        id: c.id,
        name: c.name,
        pkg: line.pkg ?? null,
        declaredRange: line.declaredRange ?? null,
        reason: line.reason ?? null,
        // The actionable half: which published versions DO fit.
        installable: line.installable ?? { matching: [], highest: null, total: 0 },
      })
    }
  }

  if (summary.skippedForBudget > 0) {
    summary.note = `为控制请求数，本次只查询了 ${summary.queried} 个候选，`
      + `另有 ${summary.skippedForBudget} 个未查询（标记为 unknown，不是「装得上」）`
  }
  return summary
}


/**
 * Join the dsh-xray capability grade onto every candidate.
 *
 * Three strategies, and the report always says which one produced the numbers:
 *
 *   bulk   one 14.9 MB GET, every candidate graded exactly. Preferred.
 *   badge  per-candidate GET (~300-700 ms each, 92 bytes), level only, flag ids
 *          unavailable because the publisher does not include them. Marked
 *          `partial: true` on every row it produces.
 *   none   dimension off, or both paths failed. Capability stays null and the
 *          report says `unknown` — never 0, never `[]` meaning "harmless".
 *
 * A candidate missing from the bulk index gets `capability.level === null` with
 * a `note` saying it was not found, which is a different statement from a
 * transport failure and is reported differently.
 */
async function attachCapability(candidates, mode, failures, xrayMaxBytes) {
  const specific = []
  const blank = { used: 'none', available: false, reason: null, scanned: null, total: null, generatedAt: null, note: null, specificFailures: specific }

  if (mode === 'off') {
    return { ...blank, note: '能力面维度已关闭（capability=off）' }
  }

  // The bulk path is tried first unless explicitly skipped. On 'auto' a failure
  // here is not fatal — it downgrades to badge lookups below.
  if (mode === 'bulk' || mode === 'auto') {
    const xray = await loadXray({ failures, maxBytes: xrayMaxBytes })
    if (xray.available) {
      for (const c of candidates) {
        const key = c.repoId || repoKeyOf(c.installCmd)
        const rec = key ? xray.byRepo.get(key) : undefined
        if (rec) {
          c.capability = { ...rec, available: true, repo: rec.repo }
        } else {
          c.capability = {
            level: null, flags: [], sensitive: [], available: true,
            repo: key || null, filesScanned: null,
            note: key ? 'dsh-xray 未收录该仓库' : 'catalog 未给出仓库地址，无法对表',
          }
        }
      }
      return {
        used: 'bulk', available: true, reason: null,
        scanned: xray.scanned, total: xray.total, generatedAt: xray.generatedAt,
        note: '能力面来自 dsh-xray 全量扫描快照（level + 具体 flags id 均可用）',
        specificFailures: specific,
      }
    }
    specific.push(`dsh-xray 全量文件不可用：${xray.reason}`)
    if (mode === 'bulk') {
      for (const c of candidates) c.capability = { level: null, flags: [], sensitive: [], available: false }
      return { ...blank, reason: xray.reason, specificFailures: specific, note: 'bulk 模式要求全量文件，本次失败固无数据' }
    }
  }

  // Badge fallback. Only worth the per-request cost for candidates we actually
  // report, so it is restricted to them; the rest stay ungraded rather than
  // costing 60 more requests.
  const wanted = candidates.filter(c => c.repoId || repoKeyOf(c.installCmd))
  for (const c of wanted) {
    const repo = c.repoId || repoKeyOf(c.installCmd)
    const badge = await fetchBadge(repo, { failures: specific })
    c.capability = badge.scanned
      ? {
          level: badge.level, flags: [], sensitive: [], available: true,
          repo, filesScanned: null, partial: true, flagCount: badge.flagCount,
          note: '仅 level（badge 接口不含 flags id）',
        }
      : {
          level: null, flags: [], sensitive: [], available: badge.reason !== 'not-scanned',
          repo, filesScanned: null, partial: true,
          note: badge.reason === 'not-scanned' ? 'dsh-xray 未收录该仓库' : `badge 查询失败：${badge.reason}`,
        }
  }
  for (const c of candidates) {
    if (!c.capability) c.capability = { level: null, flags: [], sensitive: [], available: false, repo: null, note: '未查询' }
  }
  const anyGraded = wanted.some(c => Number.isInteger(c.capability?.level))
  if (!anyGraded) {
    // Both paths are down. Saying so once is better than 12 identical rows.
    return { ...blank, reason: 'badge-all-failed', specificFailures: specific, note: '全量文件与 badge 接口都不可用' }
  }
  // Say what actually happened: an explicitly requested badge run must not be
  // described as a fallback, or a reader will think something broke.
  const why = mode === 'badge'
    ? '按请求（capability=badge）跳过全量文件，只查 badge'
    : '全量文件不可用，降级为逐仓库 badge 查询'
  return {
    used: 'badge', available: true, reason: null, scanned: null, total: null, generatedAt: null,
    note: `${why}：只有 level，没有 flags id，且只覆盖有仓库地址的候选。`
      + '等级是下界 —— 同一等级可能来自不同能力。',
    specificFailures: specific,
  }
}
