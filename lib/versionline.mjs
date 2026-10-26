/**
 * The version-line data source: which dsh-tools line does a plugin ride, and
 * does the one installed here satisfy it?
 *
 * THE USER'S ORDERING
 * "I check which tools version line a plugin rides before I look at downloads."
 * This module supplies the first half; `lib/adoption.mjs` already covered the
 * second.
 *
 * TWO HARD PARTS, BOTH MEASURED
 *
 * 1. The package name is not the repository name. Measured: guessing the
 *    package from the repo's last path segment hits about 50% of the time, and
 *    the misses are forks and re-publications rather than typos. A wrong name
 *    would read another package's peerDependencies as if they were this
 *    plugin's — worse than saying nothing. So a name is only accepted when it
 *    comes from the registry's own repository pointer (`resolvePackage`).
 *
 * 2. The installed version must be read, not assumed. `0.2.1-rc.2` is a
 *    PRERELEASE, and semver excludes prereleases from every range that does not
 *    name the same triplet — including `*`. Hard-coding it would also break on
 *    the next machine. See `lib/semver.mjs` for the rule and the verification.
 *
 * READ-ONLY: two GETs per candidate at most (a packument, plus the search call
 * `resolvePackage` already needs), all paced through the shared 1.2s clock.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { getJson } from './http.mjs'
import { classifyVersionLine, compareVersions } from './semver.mjs'

/** The peer dependency that decides the version line. */
export const TOOLS_PEER = '@deepseek-ai/dsh-tools'
/** The other peer the task calls out; reported alongside, never required. */
export const CORDIS_PEER = '@deepseek-ai/cordis'

export const REGISTRY_URL = 'https://registry.npmjs.org'

/** Candidate locations for the host's own `dsh-tools` package.json. */
export function candidatePackageJsonPaths() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }

  // 1. Anything the environment points at explicitly. DSH_HOST_MODULES is the
  //    convention this plugin's sibling already uses.
  push(process.env.DSH_HOST_MODULES)

  // 2. The running process's own module tree. When the plugin is loaded by the
  //    host, its import.meta.url sits inside the host install, so walking up
  //    from here finds the very package.json the host loaded.
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      push(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* not importable in some contexts; the other candidates still apply */ }

  // 3. Electron: `process.resourcesPath` is the `resources` dir of the running
  //    app, so the host tree is derivable without guessing an install location.
  //    This is the most reliable signal available in the real host process —
  //    and note that `app.asar` is a FILE that only the Electron process can
  //    read through its patched `fs`; a plain shell cannot, which is why this
  //    is one candidate among several rather than the only path.
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources) {
    for (const variant of ['app.asar', 'app.asar.unpacked']) {
      push(join(resources, variant, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
    }
  }

  // 4. The Desktop app's packaged tree, found from the install layout rather
  //    than from Electron globals (covers a host booted without a profile).
  for (const base of [
    process.env.DSH_APP_ROOT,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources'),
  ]) {
    if (!base) continue
    for (const variant of ['app.asar', 'app.asar.unpacked']) {
      push(join(base, variant, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
    }
  }

  // 5. Walking up from the executable, for an install that is not the default.
  try {
    let dir = dirname(process.execPath)
    for (let i = 0; i < 4; i++) {
      push(join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* execPath is always set, but be defensive */ }

  // 6. A profile install: the profile's node_modules can hoist it.
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) {
    push(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
  }

  // 7. Every profile under DSH_HOME, as a last local resort.
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))
    }
  } catch { /* no profiles dir; fine */ }

  return out
}

/**
 * Read the installed dsh-tools version.
 *
 * Tried in order, each cheap and side-effect free:
 *   1. `DSH_TOOLS_VERSION` — an explicit override, for a host whose tree the
 *      plugin cannot reach (e.g. a packaged asar read only by Electron).
 *   2. Node's own resolver, which is the authoritative answer when the host
 *      loaded this plugin from a tree where `@deepseek-ai/dsh-tools` resolves.
 *   3. The candidate file list.
 *
 * @returns {{version: string|null, source: string|null, tried: number}}
 *   `version` is null when nothing readable was found, which callers must
 *   report as unknown rather than defaulting to any particular line. Guessing
 *   a line would produce a confident "blocked" for every plugin, which is
 *   exactly the failure mode this whole dimension exists to avoid.
 */
export function readLocalToolsVersion({ candidates } = {}) {
  // 1. Explicit override.
  const override = process.env.DSH_TOOLS_VERSION
  if (typeof override === 'string' && /^\d+\.\d+\.\d+/.test(override.trim())) {
    return { version: override.trim(), source: 'env:DSH_TOOLS_VERSION', tried: 0 }
  }

  // 2. Node's resolver. `require.resolve` needs a base file; the plugin's own
  //    index.js is the right one, because that is the module the host loaded.
  try {
    const req = createRequire(import.meta.url)
    const found = req.resolve(`${TOOLS_PEER}/package.json`)
    const pkg = JSON.parse(readFileSync(found, 'utf8'))
    if (pkg && typeof pkg.version === 'string') {
      return { version: pkg.version, source: found, tried: 0 }
    }
  } catch { /* not resolvable from here; fall through to the path list */ }

  // 3. The candidate file list.
  const paths = Array.isArray(candidates) ? candidates : candidatePackageJsonPaths()
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      // Accept on version alone: a nested copy can be renamed by a bundler, and
      // rejecting it over a name mismatch would lose the only readable answer.
      if (pkg && typeof pkg.version === 'string') {
        return { version: pkg.version, source: p, tried: paths.length }
      }
    } catch { /* unreadable candidate; keep looking */ }
  }
  return { version: null, source: null, tried: paths.length }
}

/**
 * Normalise a peerDependencies map to the two fields this report cares about.
 *
 * `peerDependenciesMeta.optional` is preserved: an optional peer that the host
 * does not satisfy is a warning, not a blocker, and conflating the two would
 * overstate the problem.
 */
export function peerLineOf(manifest) {
  const peers = manifest && typeof manifest.peerDependencies === 'object' && manifest.peerDependencies !== null
    ? manifest.peerDependencies
    : {}
  const meta = manifest && typeof manifest.peerDependenciesMeta === 'object' && manifest.peerDependenciesMeta !== null
    ? manifest.peerDependenciesMeta
    : {}
  const tools = Object.hasOwn(peers, TOOLS_PEER) ? peers[TOOLS_PEER] : null
  const cordis = Object.hasOwn(peers, CORDIS_PEER) ? peers[CORDIS_PEER] : null
  return {
    toolsRange: typeof tools === 'string' ? tools : null,
    toolsDeclared: tools !== null,
    toolsOptional: meta?.[TOOLS_PEER]?.optional === true,
    cordisRange: typeof cordis === 'string' ? cordis : null,
    cordisDeclared: cordis !== null,
  }
}

/**
 * Fetch one package's packument and pull out what the version line needs.
 *
 * A packument for a large package is a few hundred KB; the full JSON is fetched
 * because there is no field-selecting endpoint, but only `dist-tags`,
 * `versions[*].peerDependencies` and the version keys are kept — the rest is
 * garbage as soon as this returns.
 *
 * @returns {{ok: boolean, reason: string|null, latest: string|null,
 *   versions: string[], peerDependencies: object|null,
 *   peerDependenciesMeta: object|null}}
 */
export async function fetchPackument(pkg, sink) {
  const empty = {
    ok: false, reason: null, latest: null, versions: [],
    peerDependencies: null, peerDependenciesMeta: null,
  }
  if (typeof pkg !== 'string' || pkg.trim() === '') return { ...empty, reason: 'no-package-name' }
  const j = await getJson(`${REGISTRY_URL}/${encodeURIComponent(pkg.trim())}`, sink)
  if (!j || typeof j !== 'object') return { ...empty, reason: 'registry-no-answer' }
  const versionsObj = j.versions && typeof j.versions === 'object' ? j.versions : {}
  const versions = Object.keys(versionsObj)
  const latest = j['dist-tags']?.latest ?? null
  // The line is declared on the published version the user would install, so
  // read the peer block from `latest`. Fall back to the newest version present
  // when dist-tags points at an entry the versions map does not carry (a
  // yanked release, or a packument trimmed by a mirror) — otherwise a perfectly
  // good package would read as having no peers at all.
  const newest = versions.length > 0
    ? versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), versions[0])
    : null
  const targetKey = latest && versionsObj[latest] ? latest : newest
  const target = targetKey ? versionsObj[targetKey] : undefined
  return {
    ok: true,
    reason: null,
    latest,
    versions,
    peerDependencies: target?.peerDependencies ?? null,
    peerDependenciesMeta: target?.peerDependenciesMeta ?? null,
  }
}

/**
 * Resolve one candidate's version line.
 *
 * `pkgName` must be an ACCURATE name. Callers pass the name they already
 * resolved through the registry's repository pointer; when they only have a
 * guess, `resolvePackage` runs first and a miss stays a miss.
 *
 * @returns {Promise<object>} a `classifyVersionLine` result plus provenance:
 *   `pkg`, `pkgSource`, `latest`, and `status` one of ok/blocked/no-constraint/
 *   undecidable/unknown.
 */
export async function versionLineFor({
  pkgName, repoId, localVersion, failures, resolve, fetchPackumentImpl,
} = {}) {
  const sink = Array.isArray(failures) ? failures : []
  const base = {
    pkg: pkgName ?? null,
    pkgSource: pkgName ? 'catalog' : null,
    repo: repoId ?? null,
    latest: null,
    cordisRange: null,
    toolsOptional: false,
    ...classifyVersionLine({ declaredRange: null, localVersion }),
  }

  let pkg = typeof pkgName === 'string' && pkgName.trim() !== '' ? pkgName.trim() : null
  if (!pkg) {
    // No package name in the catalog entry. Ask the registry which package
    // actually points at this repository; a miss is a fact, not an error.
    if (!repoId || typeof resolve !== 'function') {
      return { ...base, status: 'unknown', reason: '没有 npm 包名，且没有仓库地址可反查' }
    }
    const found = await resolve(repoId, sink)
    if (!found || !found.pkg) {
      return { ...base, status: 'unknown', reason: `registry 里没有指向 ${repoId} 的包` }
    }
    pkg = found.pkg
    base.pkg = pkg
    base.pkgSource = 'registry-repository-url'
  }

  const fetchFn = typeof fetchPackumentImpl === 'function' ? fetchPackumentImpl : fetchPackument
  const doc = await fetchFn(pkg, sink)
  if (!doc.ok) {
    return { ...base, status: 'unknown', reason: `取不到 packument（${doc.reason}）` }
  }
  const line = peerLineOf({
    peerDependencies: doc.peerDependencies,
    peerDependenciesMeta: doc.peerDependenciesMeta,
  })
  const verdict = classifyVersionLine({
    declaredRange: line.toolsDeclared ? line.toolsRange : undefined,
    localVersion,
    publishedVersions: doc.versions,
  })
  return {
    ...base,
    ...verdict,
    latest: doc.latest,
    cordisRange: line.cordisRange,
    toolsOptional: line.toolsOptional,
    // An optional peer that the host does not satisfy is a warning, not a hard
    // block: npm will not refuse the install.
    blocking: verdict.status === 'blocked' && !line.toolsOptional,
  }
}

/**
 * Is this path inside a package tree (as opposed to a stray file)?
 *
 * Only used by the tests to keep the candidate list honest; exported so they can
 * assert on it without reaching into internals.
 */
export function looksLikePackageJsonPath(p) {
  return typeof p === 'string' && resolve(p).endsWith(join('dsh-tools', 'package.json'))
}
