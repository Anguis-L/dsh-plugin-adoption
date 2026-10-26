/**
 * The capability-risk dimension: turning a dsh-xray grade into an ordering.
 *
 * WHY A SEPARATE MODULE OF PURE FUNCTIONS
 * Everything here is offline and side-effect free, so the test suite can pin the
 * judgement without touching the network. That matters more than usual: this is
 * a *judgement*, not a measurement, and the difference between "the data says
 * C2" and "we rank C2 worse than C1" has to stay visible in code.
 *
 * WHAT IS MEASURED AND WHAT IS OUR OPINION
 *   measured (from dsh-xray):   level 0..3, the flag ids present, files_scanned
 *   our opinion:                the sensitive-flag subset, the weighting below,
 *                               and which combinations count as dangerous
 *
 * The publisher's legend is quoted, never re-worded. The weights are invented
 * here and are deliberately simple and monotonic, so a reader can disagree with
 * a number and still read the ordering.
 */

import { SENSITIVE_FLAGS } from './xray.mjs'

/**
 * Risk rank for one plugin, 0..N, higher = more capability to hurt you.
 *
 * The ordering is level-first on purpose: dsh-xray already combined the signals
 * into the grade (its C3 is literally "powerful capabilities combined with
 * sensitive behavior"), so second-guessing the level with a weighted sum of
 * flags would produce an ordering that disagrees with the published grade for
 * no measurable reason. The sensitive-flag count only breaks ties *within* a
 * level, which is where the grade genuinely says nothing more.
 *
 * `null` level means "not graded" and returns null rather than 0 — an ungraded
 * plugin is not a safe plugin, and ranking it as C0 would be the exact
 * silent-empty mistake this plugin refuses to make.
 *
 * @param {{level: number|null, sensitive: string[]}} capability
 * @returns {number|null}
 */
export function riskScore(capability) {
  const level = capability?.level
  if (!Number.isInteger(level) || level < 0) return null
  const sensitive = Array.isArray(capability?.sensitive) ? capability.sensitive.length : 0
  return level * 100 + Math.min(sensitive, 99)
}

/**
 * Classify one candidate's risk for reporting.
 *
 * The buckets are the report's vocabulary, so they are named here and not in the
 * formatter:
 *   'high'      level 3 — publisher: powerful capabilities + sensitive behavior
 *   'elevated'  level 2 — powerful: exec / credentials / install scripts
 *   'low'       level 0..1 — nothing notable, or ordinary
 *   'unknown'   no grade available. NOT 'low'.
 *
 * A capability object whose `available` is false is 'unknown' regardless of
 * level, so a partially-failed run cannot launder ungraded plugins into 'low'.
 */
export function riskBucket(capability) {
  if (!capability || capability.available === false) return 'unknown'
  const level = capability.level
  if (!Number.isInteger(level)) return 'unknown'
  if (level >= 3) return 'high'
  if (level === 2) return 'elevated'
  return 'low'
}

/**
 * Combinations present in one plugin's flag set.
 *
 * Returns the matched combo descriptors, so the report can say *why* a
 * combination is bad instead of only that it exists.
 */
export function dangerCombos(flags, combos) {
  const set = new Set(Array.isArray(flags) ? flags : [])
  const source = Array.isArray(combos) ? combos : []
  return source.filter(c => c.flags.every(f => set.has(f)))
}

/**
 * Order candidates by capability risk, worst first.
 *
 * Ties break on downloads (the more installations, the more people affected),
 * then on stars, then on id so the output is stable across runs — an unstable
 * ordering would make two reports impossible to diff.
 *
 * Ungraded candidates sort last and are kept, not dropped: a reader has to see
 * that they exist. Dropping them would make the list look complete when it is
 * not.
 */
export function rankByRisk(candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  return [...list].sort((a, b) => {
    const sa = riskScore(a.capability)
    const sb = riskScore(b.capability)
    if (sa === null && sb !== null) return 1
    if (sa !== null && sb === null) return -1
    if (sa !== sb) return sb - sa
    const da = typeof a.downloads === 'number' ? a.downloads : -1
    const db = typeof b.downloads === 'number' ? b.downloads : -1
    if (da !== db) return db - da
    const ta = typeof a.stars === 'number' ? a.stars : -1
    const tb = typeof b.stars === 'number' ? b.stars : -1
    if (ta !== tb) return tb - ta
    return String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })
}

/**
 * Candidates that are BOTH widely installed AND sensitive — the point of this
 * whole dimension.
 *
 * "Widely installed" is measured, not assumed: half the median monthly download
 * of the candidate pool that actually has a download number. A fixed absolute
 * threshold would be wrong as soon as this runs against a larger catalog, so the
 * bar comes from the data in front of it. When no candidate has a download
 * number there is no measured bar, and the function says so instead of
 * inventing one.
 *
 * "Sensitive" means level >= 2 (the publisher's own "powerful" line) — not our
 * flag subset, so the filter cannot be accused of being tuned.
 *
 * @returns {{threshold: number|null, basis: string, rows: object[]}}
 */
export function highAdoptionAndRisk(candidates, { minLevel = 2 } = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const withDl = list.filter(c => typeof c.downloads === 'number' && c.downloads >= 0)
  if (withDl.length === 0) {
    return { threshold: null, basis: 'no-download-data', rows: [] }
  }
  const sorted = [...withDl].sort((a, b) => a.downloads - b.downloads)
  const mid = Math.floor(sorted.length / 2)
  // True median: for an even-length pool that is the mean of the two middle
  // values, not whichever one happens to sit at index n/2.
  const median = sorted.length % 2 === 1
    ? sorted[mid].downloads
    : (sorted[mid - 1].downloads + sorted[mid].downloads) / 2
  // Half the median: high enough to exclude one-off installs, low enough that a
  // small pool still produces a useful list. Reported with the number so the
  // reader can re-judge the bar rather than trust it.
  const threshold = Math.max(1, Math.floor(median / 2))
  const rows = list.filter(c => {
    if (typeof c.downloads !== 'number' || c.downloads < threshold) return false
    const level = c.capability?.level
    return Number.isInteger(level) && level >= minLevel
  })
  return { threshold, basis: `候选池有下载量的 ${withDl.length} 条，中位数 ${median}，取一半`, rows }
}

/** The sensitive flag ids present on one candidate, in SENSITIVE_FLAGS order. */
export function sensitiveOf(flags) {
  const set = new Set(Array.isArray(flags) ? flags : [])
  return SENSITIVE_FLAGS.filter(f => set.has(f))
}
