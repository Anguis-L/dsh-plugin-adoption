/**
 * Version-line matching: does this plugin's declared peer range accept the
 * dsh-tools version that is actually installed here?
 *
 * WHY THIS EXISTS
 * A real user put the ordering plainly: "I check which tools version line a
 * plugin rides before I look at downloads." The tool covered only the second
 * half of that sentence. Measured on 20 catalog plugins that have a resolvable
 * npm package, only 4 (20%) declare `peerDependencies['@deepseek-ai/dsh-tools']`
 * at all, and their ranges disagree wildly (`^0.0.1-rc.1`, `^0.1.1-rc.2`,
 * `0.1.2-rc.1`, `*`). So "which line does this need" has no single answer and
 * currently costs one failed install per plugin to find out.
 *
 * WHY A HAND-WRITTEN MATCHER (no `semver` dependency)
 * `semver` is not resolvable from this plugin and is not in the host tree, and
 * this plugin has no dependencies by design. More importantly, the ONE thing
 * that matters here is the rule every naive implementation gets wrong:
 *
 *   A prerelease version only satisfies a comparator set when that set itself
 *   mentions a prerelease on the SAME major.minor.patch.
 *
 * The installed host here is `0.2.1-rc.2`. Verified against npm's own `semver`:
 *
 *   0.2.1-rc.2 satisfies "^0.2.1"      -> false   (range has no prerelease)
 *   0.2.1-rc.2 satisfies "^0.2.1-rc.1" -> true    (same triplet, has prerelease)
 *   0.2.1-rc.2 satisfies "*"           -> false   (any-range still excludes prereleases)
 *   0.2.1-rc.2 satisfies ">=0.1.0"     -> false   (same reason)
 *   0.2.1-rc.2 satisfies "^0.1.7-alpha.1" -> false (different triplet)
 *
 * So `*` and `>=0.1.0` — the ranges that look most permissive — both REJECT the
 * installed host. A report that rendered "satisfies: true" for `*` would tell
 * the user a plugin installs when it does not. Every case above is pinned by a
 * test, and `test/version.test.mjs` cross-checks this matcher against npm's real
 * `semver` when that module happens to be present.
 */

/** A parsed version: numbers plus the prerelease identifier list. */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/**
 * Parse one version string. Returns null for anything that is not a version.
 *
 * Build metadata (`+sha`) is parsed and dropped: semver says it never affects
 * precedence, so keeping it would only invite comparisons that read it.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const m = VERSION_RE.exec(value.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw: value.trim(),
  }
}

/** Compare two prerelease identifier lists per semver §11.4. */
function comparePrerelease(a, b) {
  // An empty list (a release) outranks any prerelease of the same triplet.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i], bi = b[i]
    // A shorter list sorts first when every preceding identifier is equal.
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const an = /^\d+$/.test(ai), bn = /^\d+$/.test(bi)
    if (an && bn) {
      const d = Number(ai) - Number(bi)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    // Numeric identifiers always sort below alphanumeric ones.
    if (an) return -1
    if (bn) return 1
    if (ai !== bi) return ai < bi ? -1 : 1
  }
  return 0
}

/** Full semver precedence: -1 / 0 / 1, or null when either side is unparsable. */
export function compareVersions(a, b) {
  const pa = typeof a === 'string' ? parseVersion(a) : a
  const pb = typeof b === 'string' ? parseVersion(b) : b
  if (!pa || !pb) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

/**
 * Build the synthetic lower bound a range's upper limit uses.
 *
 * `-0` is semver's own spelling for "before any prerelease of this triplet",
 * which is what makes `^0.1.7` exclude `0.2.0-alpha.1`.
 */
function bound(major, minor, patch, prerelease) {
  return { major, minor, patch, prerelease }
}

/** `*`-style ranges: any version, but still never a prerelease. */
const ANY = [{ op: '*', version: null }]

/**
 * Parse one comparator (`^1.2.3`, `>=0.1.0`, `1.2.3`, `~1.2`) into a
 * normalized comparator list, or null when it is not a range this module
 * understands.
 *
 * Partial versions are expanded the way npm does: `^1.2` means `>=1.2.0 <2.0.0`
 * and `~1` means `>=1.0.0 <2.0.0`.
 */
function parseComparator(token) {
  if (token === '*' || token === 'x' || token === 'X' || token === '') return ANY
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  if (!m) return null
  const op = m[1] || '='
  const rest = m[2].trim()

  // Partial versions: keep how many numeric segments were actually written.
  // `x`/`X`/`*` in any position is a wildcard, which npm treats exactly like an
  // omitted segment (`1.x` === `1`, `1.2.x` === `1.2`).
  const wild = (s) => s === undefined || s === 'x' || s === 'X' || s === '*'
  const partial = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(rest)
  if (!partial) return null
  const major = wild(partial[1]) ? null : Number(partial[1])
  const minor = wild(partial[2]) ? null : Number(partial[2])
  const patch = wild(partial[3]) ? null : Number(partial[3])
  const pre = partial[4] ? partial[4].split('.') : []

  // `*`, `x`, or a range whose major is a wildcard means "any version".
  if (major === null) return ANY
  // A prerelease on a wildcarded triplet is meaningless; refuse rather than guess.
  if (pre.length > 0 && (minor === null || patch === null)) return null

  const full = (ma, mi, pa, pr = []) => bound(ma, mi, pa, pr)

  switch (op) {
    case '^': {
      // Caret: allow changes that do not modify the left-most non-zero digit.
      const lo = full(major, minor ?? 0, patch ?? 0, pre)
      let hi
      if (major !== 0) hi = full(major + 1, 0, 0, ['0'])
      else if (minor === null) hi = full(1, 0, 0, ['0'])
      else if (minor !== 0) hi = full(0, minor + 1, 0, ['0'])
      else if (patch === null) hi = full(0, 1, 0, ['0'])
      else hi = full(0, 0, patch + 1, ['0'])
      return [{ op: '>=', version: lo }, { op: '<', version: hi }]
    }
    case '~': {
      const lo = full(major, minor ?? 0, patch ?? 0, pre)
      const hi = minor === null ? full(major + 1, 0, 0, ['0']) : full(major, minor + 1, 0, ['0'])
      return [{ op: '>=', version: lo }, { op: '<', version: hi }]
    }
    case '>':
    case '>=':
    case '<':
    case '<=': {
      // A partial bound is only meaningful when fully specified; npm treats
      // `>=1.2` as `>=1.2.0`, which is what filling zeros does.
      return [{ op, version: full(major, minor ?? 0, patch ?? 0, pre) }]
    }
    case '=': {
      if (minor === null) {
        // `1` means the whole 1.x line.
        return [{ op: '>=', version: full(major, 0, 0) }, { op: '<', version: full(major + 1, 0, 0, ['0']) }]
      }
      if (patch === null) {
        // `1.2` means the whole 1.2.x line.
        return [{ op: '>=', version: full(major, minor, 0) }, { op: '<', version: full(major, minor + 1, 0, ['0']) }]
      }
      return [{ op: '=', version: full(major, minor, patch, pre) }]
    }
    default:
      return null
  }
}

/**
 * Parse a full range: `||` alternatives of whitespace-separated comparator sets.
 *
 * Returns null when the range is not something this module can decide, which is
 * the honest answer for `latest`, `workspace:*`, `file:../x`, `npm:foo@1`, or a
 * git URL. A caller must render that as "could not determine", never as "ok".
 */
export function parseRange(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  // npm aliases and protocol specifiers are not version ranges.
  if (/^(workspace|file|link|portal|git|git\+[a-z]+|https?|npm):/i.test(text)) return null
  if (/^(latest|next|beta|canary)$/i.test(text)) return null

  const sets = []
  for (const alternative of text.split('||')) {
    const part = alternative.trim()
    if (part === '') {
      sets.push(ANY)
      continue
    }
    const comparators = []
    // Hyphen range: `1.2.3 - 2.3.4`.
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(part)
    if (hyphen) {
      const lo = parseComparator(`>=${hyphen[1]}`)
      const hi = parseComparator(`<=${hyphen[2]}`)
      if (!lo || !hi) return null
      sets.push([...lo, ...hi])
      continue
    }
    for (const token of part.split(/\s+/)) {
      const parsed = parseComparator(token)
      if (!parsed) return null
      comparators.push(...parsed)
    }
    sets.push(comparators.length > 0 ? comparators : ANY)
  }
  return sets.length > 0 ? sets : null
}

/** Does one comparator hold for `version`? */
function testComparator(comparator, version) {
  if (comparator.op === '*') return true
  const c = compareVersions(version, comparator.version)
  if (c === null) return false
  switch (comparator.op) {
    case '=': return c === 0
    case '>': return c > 0
    case '>=': return c >= 0
    case '<': return c < 0
    case '<=': return c <= 0
    default: return false
  }
}

/**
 * The prerelease gate: a prerelease version is admitted by a comparator set
 * only when that set carries a prerelease comparator on the SAME triplet.
 *
 * This single rule is why `*` and `>=0.1.0` reject `0.2.1-rc.2`. Verified
 * against npm's `semver`; see the module doc comment.
 */
function admitsPrerelease(comparators, version) {
  if (version.prerelease.length === 0) return true
  return comparators.some(c =>
    c.version !== null
    && c.version.prerelease.length > 0
    && c.version.major === version.major
    && c.version.minor === version.minor
    && c.version.patch === version.patch)
}

/**
 * Does `version` satisfy `range`?
 *
 * @returns {boolean|null} null when either side cannot be decided — never a
 *   guessed true or false.
 */
export function satisfies(version, range) {
  const v = typeof version === 'string' ? parseVersion(version) : version
  if (!v) return null
  const sets = Array.isArray(range) ? range : parseRange(range)
  if (!sets) return null
  for (const comparators of sets) {
    if (!admitsPrerelease(comparators, v)) continue
    if (comparators.every(c => testComparator(c, v))) return true
  }
  return false
}

/** Highest version in a list, or null. Unparsable entries are ignored. */
export function maxVersion(versions) {
  let best = null
  for (const candidate of Array.isArray(versions) ? versions : []) {
    const parsed = parseVersion(candidate)
    if (!parsed) continue
    if (best === null || compareVersions(parsed, best) > 0) best = parsed
  }
  return best ? best.raw : null
}

/**
 * Which published versions of a package satisfy a declared range.
 *
 * This is the actionable half of the answer: when the installed host does not
 * satisfy the range, the useful next sentence is "these versions do", so the
 * user can pin one instead of reinstalling until something sticks.
 *
 * `limit` keeps the payload small — a package with 200 releases does not need
 * all 200 printed, and the caller only ever shows the newest few.
 *
 * @returns {{matching: string[], highest: string|null, total: number}}
 */
export function versionsInRange(versions, range, { limit = 10 } = {}) {
  const sets = Array.isArray(range) ? range : parseRange(range)
  const all = Array.isArray(versions) ? versions : []
  if (!sets) return { matching: [], highest: null, total: 0 }
  const matching = []
  for (const candidate of all) {
    if (satisfies(candidate, sets) === true) matching.push(candidate)
  }
  // Newest first, so `limit` keeps the most useful end of the list.
  matching.sort((a, b) => {
    const c = compareVersions(b, a)
    return c === null ? 0 : c
  })
  return {
    matching: matching.slice(0, limit),
    highest: maxVersion(matching),
    total: matching.length,
  }
}

/**
 * Classify one plugin's version line against the installed host.
 *
 * The statuses are the report's vocabulary:
 *   'ok'             the declared range accepts the installed version
 *   'blocked'        it does not — this plugin will not install as-is
 *   'no-constraint'  no peerDependency on dsh-tools was declared
 *   'undecidable'    a range was declared but is not a version range this
 *                    module can decide (`workspace:*`, a git URL, a tag)
 *   'unknown'        the package could not be identified, or the registry did
 *                    not answer — the "I could not find out" case
 *
 * `blocked` and `unknown` must never collapse into one another: the first is a
 * finding about the plugin, the second is a failure of this run.
 *
 * @param {object} input
 * @param {string|null} input.declaredRange - raw peerDependencies value
 * @param {string|null} input.localVersion - the installed dsh-tools version
 * @param {string[]} [input.publishedVersions] - versions from the packument
 */
export function classifyVersionLine({ declaredRange, localVersion, publishedVersions } = {}) {
  const local = typeof localVersion === 'string' ? parseVersion(localVersion) : null
  const base = {
    declaredRange: typeof declaredRange === 'string' ? declaredRange : null,
    localVersion: local ? local.raw : null,
    satisfies: null,
    status: 'unknown',
    installable: { matching: [], highest: null, total: 0 },
    reason: null,
  }

  if (declaredRange === undefined || declaredRange === null) {
    return { ...base, status: 'no-constraint', reason: '未声明 @deepseek-ai/dsh-tools 的 peerDependency' }
  }
  if (typeof declaredRange !== 'string') {
    return { ...base, declaredRange: null, status: 'undecidable', reason: 'peerDependency 不是字符串' }
  }
  if (!local) {
    return { ...base, status: 'unknown', reason: '读不到本机 dsh-tools 版本' }
  }
  const range = parseRange(declaredRange)
  if (!range) {
    return { ...base, status: 'undecidable', reason: `不是可判定的版本范围（${declaredRange.slice(0, 40)}）` }
  }

  const ok = satisfies(local, range)
  if (ok === null) {
    return { ...base, status: 'unknown', reason: '版本或范围无法解析' }
  }
  const installable = Array.isArray(publishedVersions)
    ? versionsInRange(publishedVersions, range)
    : { matching: [], highest: null, total: 0 }
  return {
    ...base,
    satisfies: ok,
    status: ok ? 'ok' : 'blocked',
    installable,
    reason: ok ? null : `声明的范围不接受本机 ${local.raw}`,
  }
}
