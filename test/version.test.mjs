/**
 * Offline tests for the version-line dimension (lib/semver.mjs, lib/versionline.mjs).
 *
 * No network: the packument shapes below are real records captured from
 * registry.npmjs.org on 2026-10-26 (trimmed to the fields this plugin reads).
 *
 * The interesting part of this file is the prerelease rule. The host installed
 * on the machine this was written for is `0.2.1-rc.2` — a PRERELEASE — and
 * semver excludes prereleases from every range that does not name the same
 * triplet, including `*`. So the two most permissive-looking ranges both reject
 * the installed host, and a matcher that says otherwise tells the user a plugin
 * installs when it does not.
 *
 * Run: node --test test/version.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseVersion, compareVersions, parseRange, satisfies,
  maxVersion, versionsInRange, classifyVersionLine,
} from '../lib/semver.mjs'
import {
  readLocalToolsVersion, peerLineOf, fetchPackument, versionLineFor,
  candidatePackageJsonPaths, looksLikePackageJsonPath, TOOLS_PEER, CORDIS_PEER,
} from '../lib/versionline.mjs'

// The host version this plugin was developed against, read from the real
// package.json. Pinned as a fixture so the tests state which line they assume.
const HOST = '0.2.1-rc.2'

// ─────────────────────────── real packument shapes ───────────────────────────

/** dsh-find-plugin@0.4.0, captured 2026-10-26. The task's worked example. */
const FIND_PLUGIN = {
  latest: '0.4.0',
  versions: ['0.1.0', '0.2.0', '0.3.0', '0.3.3', '0.3.4', '0.3.5', '0.3.6', '0.3.7', '0.4.0'],
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.1',
    '@deepseek-ai/dsh-tools': '^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.3-alpha.2 || ^0.1.5-alpha.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1',
  },
}

/** dsh-mcp-panel: the shape that DOES accept the installed host. */
const MCP_PANEL = {
  latest: '1.2.0',
  versions: ['1.0.0', '1.1.0', '1.2.0'],
  peerDependencies: {
    '@deepseek-ai/dsh-tools': '>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-0 <0.2.0 || >=0.1.7-0 <0.2.0 || >=0.2.0-0 <0.3.0 || >=0.2.1-0 <0.3.0',
  },
}


// ─────────────────────────────── parsing ───────────────────────────────

test('parseVersion reads numbers, prerelease and drops build metadata', () => {
  const v = parseVersion('0.2.1-rc.2+build.9')
  assert.equal(v.major, 0)
  assert.equal(v.minor, 2)
  assert.equal(v.patch, 1)
  assert.deepEqual(v.prerelease, ['rc', '2'])
  // Build metadata never affects precedence, so it is not kept.
  assert.equal(Object.hasOwn(v, 'build'), false)
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(null), null)
})

test('compareVersions follows semver precedence including prerelease ordering', () => {
  // The §11.4 example sequence, which is the canonical ordering test.
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`)
    assert.equal(compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`)
  }
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.2'), 0)
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1'), -1, 'a prerelease precedes its release')
})


// ───────────────────── the prerelease rule (the whole point) ─────────────────────

test('a prerelease host is rejected by every range that does not name its triplet', () => {
  // Verified against npm's own semver. These four are the cases a naive
  // matcher gets wrong, and getting them wrong means telling the user a
  // plugin installs when npm would refuse it.
  assert.equal(satisfies(HOST, '^0.2.1'), false, '^0.2.1 has no prerelease')
  assert.equal(satisfies(HOST, '*'), false, 'even * excludes prereleases')
  assert.equal(satisfies(HOST, '>=0.1.0'), false, 'so does an open lower bound')
  assert.equal(satisfies(HOST, '>=0.2.0 <0.3.0'), false, 'the triplet is not named')
})

test('a prerelease host IS accepted when the range names its own triplet', () => {
  assert.equal(satisfies(HOST, '^0.2.1-rc.1'), true)
  assert.equal(satisfies(HOST, '0.2.1-rc.2'), true)
  assert.equal(satisfies(HOST, '>=0.2.1-rc.1 <0.3.0-0'), true)
})

test('a prerelease from a different triplet never satisfies a prerelease range', () => {
  // ^0.1.7-alpha.1 tops out below 0.2.0, so a 0.2.x prerelease is out of range
  // regardless of the prerelease rule.
  assert.equal(satisfies(HOST, '^0.1.7-alpha.1'), false)
  assert.equal(satisfies('0.1.7-alpha.2', '^0.1.7-alpha.1'), true)
  assert.equal(satisfies('0.1.7', '^0.1.7-alpha.1'), true, 'the release of the same triplet fits')
})

test('a release version is unaffected by the prerelease rule', () => {
  assert.equal(satisfies('0.2.1', '^0.2.1'), true)
  assert.equal(satisfies('0.2.1', '*'), true)
  assert.equal(satisfies('0.2.1', '>=0.1.0'), true)
  assert.equal(satisfies('0.2.0', '^0.2.1'), false)
})


// ───────────────────────────── range parsing ─────────────────────────────

test('parseRange expands carets, tildes and partials the way npm does', () => {
  const render = (r) => parseRange(r).map(set =>
    set.map(c => c.op + (c.version
      ? `${c.version.major}.${c.version.minor}.${c.version.patch}`
        + (c.version.prerelease.length ? `-${c.version.prerelease.join('.')}` : '')
      : '')).join(' '))
  assert.deepEqual(render('^0.2.1'), ['>=0.2.1 <0.3.0-0'])
  assert.deepEqual(render('^1.2.3'), ['>=1.2.3 <2.0.0-0'])
  assert.deepEqual(render('~0.2.1'), ['>=0.2.1 <0.3.0-0'])
  assert.deepEqual(render('~1'), ['>=1.0.0 <2.0.0-0'])
  assert.deepEqual(render('^1.2'), ['>=1.2.0 <2.0.0-0'])
  assert.deepEqual(render('1.x'), ['>=1.0.0 <2.0.0-0'])
  assert.deepEqual(render('0.2.x'), ['>=0.2.0 <0.3.0-0'])
})

test('parseRange splits || alternatives', () => {
  const sets = parseRange('^0.1.0-rc.6 || ^0.1.7-alpha.1')
  assert.equal(sets.length, 2)
  assert.equal(satisfies('0.1.0-rc.7', sets), true)
  assert.equal(satisfies('0.1.7-alpha.3', sets), true)
  // Both alternatives are 0.1.x, so a plain 0.1.x release fits the first one.
  assert.equal(satisfies('0.1.4', sets), true)
  // Outside 0.1.x entirely.
  assert.equal(satisfies('0.2.0', sets), false)
})

test('parseRange refuses ranges it cannot decide instead of guessing', () => {
  // These must surface as "could not determine", never as a boolean. A guessed
  // true would be a false "installs fine".
  for (const r of ['latest', 'next', 'workspace:*', 'file:../x', 'link:../y',
    'git+https://github.com/o/r', 'https://example.com/x.tgz', 'npm:other@1.0.0']) {
    assert.equal(parseRange(r), null, `${r} must not parse`)
  }
})

test('satisfies returns null, not false, for an undecidable range', () => {
  assert.equal(satisfies(HOST, 'workspace:*'), null)
  assert.equal(satisfies(HOST, 'latest'), null)
  assert.equal(satisfies('garbage', '^1.0.0'), null)
})

test('a hyphen range is inclusive at both ends', () => {
  assert.equal(satisfies('1.2.3', '1.2.3 - 2.0.0'), true)
  assert.equal(satisfies('2.0.0', '1.2.3 - 2.0.0'), true)
  assert.equal(satisfies('2.0.1', '1.2.3 - 2.0.0'), false)
})


// ───────────────────────── versionsInRange / maxVersion ─────────────────────────

test('versionsInRange lists only matching versions, newest first', () => {
  const out = versionsInRange(FIND_PLUGIN.versions, FIND_PLUGIN.peerDependencies[TOOLS_PEER])
  // Every 0.x release of dsh-find-plugin is outside the 0.1.x line except 0.1.0
  // itself — this is the actionable answer the user needs.
  assert.deepEqual(out.matching, ['0.1.0'])
  assert.equal(out.highest, '0.1.0')
  assert.equal(out.total, 1)
})

test('versionsInRange respects limit while reporting the true total', () => {
  const many = Array.from({ length: 30 }, (_, i) => `1.${i}.0`)
  const out = versionsInRange(many, '^1.0.0', { limit: 3 })
  assert.equal(out.matching.length, 3)
  assert.equal(out.total, 30, 'a truncated list must not look like the whole set')
  assert.equal(out.highest, '1.29.0')
})

test('versionsInRange returns nothing for an undecidable range', () => {
  const out = versionsInRange(['1.0.0'], 'workspace:*')
  assert.deepEqual(out.matching, [])
  assert.equal(out.total, 0)
})

test('maxVersion ignores unparsable entries', () => {
  assert.equal(maxVersion(['1.0.0', 'nope', '2.0.0-rc.1', '1.9.0']), '2.0.0-rc.1')
  assert.equal(maxVersion([]), null)
  assert.equal(maxVersion(null), null)
})


// ─────────────────────────── classification ───────────────────────────

test('classifyVersionLine marks a range that excludes the host as blocked', () => {
  const r = classifyVersionLine({
    declaredRange: FIND_PLUGIN.peerDependencies[TOOLS_PEER],
    localVersion: HOST,
    publishedVersions: FIND_PLUGIN.versions,
  })
  assert.equal(r.status, 'blocked')
  assert.equal(r.satisfies, false)
  assert.equal(r.declaredRange, FIND_PLUGIN.peerDependencies[TOOLS_PEER])
  assert.equal(r.localVersion, HOST)
  // The actionable half is present and correct.
  assert.deepEqual(r.installable.matching, ['0.1.0'])
})

test('classifyVersionLine marks a range that accepts the host as ok', () => {
  const r = classifyVersionLine({
    declaredRange: MCP_PANEL.peerDependencies[TOOLS_PEER],
    localVersion: HOST,
    publishedVersions: MCP_PANEL.versions,
  })
  assert.equal(r.status, 'ok')
  assert.equal(r.satisfies, true)
  assert.equal(r.reason, null)
})

test('classifyVersionLine distinguishes no-constraint from unknown', () => {
  // No peerDependency at all: a fact about the plugin. Most plugins are here.
  const none = classifyVersionLine({ declaredRange: undefined, localVersion: HOST })
  assert.equal(none.status, 'no-constraint')
  assert.equal(none.satisfies, null)

  // The installed version could not be read: a failure of this run.
  const noLocal = classifyVersionLine({ declaredRange: '^0.2.1', localVersion: null })
  assert.equal(noLocal.status, 'unknown')
  assert.match(noLocal.reason, /读不到本机/)
})

test('classifyVersionLine reports undecidable for a non-version range', () => {
  const r = classifyVersionLine({ declaredRange: 'workspace:*', localVersion: HOST })
  assert.equal(r.status, 'undecidable')
  assert.equal(r.satisfies, null)
  assert.match(r.reason, /不是可判定的版本范围/)
})

test('blocked and unknown never collapse into one another', () => {
  const blocked = classifyVersionLine({ declaredRange: '^0.1.0', localVersion: HOST })
  const unknown = classifyVersionLine({ declaredRange: '^0.1.0', localVersion: null })
  assert.equal(blocked.status, 'blocked')
  assert.equal(unknown.status, 'unknown')
  assert.notEqual(blocked.status, unknown.status)
})


// ─────────────────────── local version discovery ───────────────────────

test('readLocalToolsVersion honours the DSH_TOOLS_VERSION override', () => {
  // The override exists because a packaged Electron host keeps dsh-tools inside
  // app.asar, which only the host process can read. Without a way to state the
  // version, the whole dimension would report "unknown" on that install.
  const original = process.env.DSH_TOOLS_VERSION
  try {
    process.env.DSH_TOOLS_VERSION = '0.2.1-rc.2'
    const got = readLocalToolsVersion({ candidates: [] })
    assert.equal(got.version, '0.2.1-rc.2')
    assert.equal(got.source, 'env:DSH_TOOLS_VERSION')
  } finally {
    if (original === undefined) delete process.env.DSH_TOOLS_VERSION
    else process.env.DSH_TOOLS_VERSION = original
  }
})

test('readLocalToolsVersion ignores a nonsense override', () => {
  const original = process.env.DSH_TOOLS_VERSION
  try {
    process.env.DSH_TOOLS_VERSION = 'not-a-version'
    const got = readLocalToolsVersion({ candidates: [] })
    // Falls through to the candidate list, which is empty here.
    assert.notEqual(got.version, 'not-a-version')
  } finally {
    if (original === undefined) delete process.env.DSH_TOOLS_VERSION
    else process.env.DSH_TOOLS_VERSION = original
  }
})

test('readLocalToolsVersion returns null rather than guessing a version', () => {
  const original = process.env.DSH_TOOLS_VERSION
  try {
    delete process.env.DSH_TOOLS_VERSION
    // No candidates and no resolvable package: the honest answer is null.
    // Guessing would make every plugin look "blocked" with false confidence.
    const got = readLocalToolsVersion({ candidates: ['/definitely/not/here/package.json'] })
    assert.equal(got.version, null)
    assert.equal(got.source, null)
  } finally {
    if (original !== undefined) process.env.DSH_TOOLS_VERSION = original
  }
})

test('candidate paths target the real dsh-tools package.json shapes', () => {
  const paths = candidatePackageJsonPaths()
  assert.ok(paths.length > 0)
  for (const p of paths) {
    assert.ok(looksLikePackageJsonPath(p), `not a dsh-tools package.json path: ${p}`)
  }
  // The Electron resources dir is the signal that works inside a packaged host.
  assert.ok(paths.some(p => p.includes('app.asar')))
})


// ─────────────────────────── peer line extraction ───────────────────────────

test('peerLineOf reads both peers and the optional marker', () => {
  const line = peerLineOf(FIND_PLUGIN)
  assert.equal(line.toolsDeclared, true)
  assert.equal(line.toolsRange, FIND_PLUGIN.peerDependencies[TOOLS_PEER])
  assert.equal(line.cordisRange, '^4.0.1')
  assert.equal(line.toolsOptional, false)

  const optional = peerLineOf({
    peerDependencies: { [TOOLS_PEER]: '^9.9.9' },
    peerDependenciesMeta: { [TOOLS_PEER]: { optional: true } },
  })
  assert.equal(optional.toolsOptional, true)
})

test('peerLineOf reports an undeclared peer as undeclared, not as a wildcard', () => {
  const line = peerLineOf({ peerDependencies: { [CORDIS_PEER]: '^4.0.1' } })
  assert.equal(line.toolsDeclared, false)
  assert.equal(line.toolsRange, null, 'absent must not become "*"')
  assert.equal(line.cordisRange, '^4.0.1')
})


// ─────────────────────────── packument handling ───────────────────────────

test('fetchPackument reads the peer block from the latest version', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    'dist-tags': { latest: '0.4.0' },
    versions: {
      '0.1.0': { peerDependencies: { [TOOLS_PEER]: '^0.0.1' } },
      // `FIND_PLUGIN.peerDependencies` IS the peer map, so it is the value of
      // the `peerDependencies` key, not a manifest to spread.
      '0.4.0': { peerDependencies: FIND_PLUGIN.peerDependencies },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const doc = await fetchPackument('dsh-find-plugin', [])
    assert.equal(doc.ok, true)
    assert.equal(doc.latest, '0.4.0')
    // The line is declared on the version the user would install, so an older
    // entry's peer block must not win.
    assert.equal(doc.peerDependencies[TOOLS_PEER], FIND_PLUGIN.peerDependencies[TOOLS_PEER])
    assert.deepEqual(doc.versions.sort(), ['0.1.0', '0.4.0'])
  } finally {
    globalThis.fetch = original
  }
})

test('fetchPackument falls back to the newest version when dist-tags is stale', async () => {
  // A yanked release or a mirror-trimmed packument can leave dist-tags pointing
  // at an entry the versions map does not carry. Reading no peers at all there
  // would report a constrained plugin as unconstrained.
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    'dist-tags': { latest: '9.9.9' },
    versions: {
      '0.1.0': { peerDependencies: { [TOOLS_PEER]: '^0.0.1' } },
      '0.2.0': { peerDependencies: { [TOOLS_PEER]: '^0.2.1-rc.1' } },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const doc = await fetchPackument('x', [])
    assert.equal(doc.ok, true)
    assert.equal(doc.latest, '9.9.9', 'the advertised tag is reported as-is')
    assert.equal(doc.peerDependencies[TOOLS_PEER], '^0.2.1-rc.1', 'peers come from the newest real version')
  } finally {
    globalThis.fetch = original
  }
})

test('fetchPackument reports a registry failure instead of an empty manifest', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  const failures = []
  try {
    const doc = await fetchPackument('dsh-find-plugin', failures)
    assert.equal(doc.ok, false)
    assert.equal(doc.reason, 'registry-no-answer')
    assert.ok(failures.length > 0, 'a 500 must land in requestFailures')
  } finally {
    globalThis.fetch = original
  }
})

test('fetchPackument refuses an empty package name without a request', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }) }
  try {
    const doc = await fetchPackument('', [])
    assert.equal(doc.ok, false)
    assert.equal(doc.reason, 'no-package-name')
    assert.equal(called, false, 'no request should be made for an empty name')
  } finally {
    globalThis.fetch = original
  }
})


// ───────────────────────── versionLineFor end to end ─────────────────────────

test('versionLineFor resolves the task\'s worked example exactly', async () => {
  const failures = []
  const r = await versionLineFor({
    pkgName: 'dsh-find-plugin',
    localVersion: HOST,
    failures,
    fetchPackumentImpl: async () => ({
      ok: true, reason: null, latest: FIND_PLUGIN.latest,
      versions: FIND_PLUGIN.versions, peerDependencies: FIND_PLUGIN.peerDependencies,
    }),
  })
  assert.equal(r.status, 'blocked')
  assert.equal(r.pkg, 'dsh-find-plugin')
  assert.equal(r.localVersion, HOST)
  assert.equal(r.latest, '0.4.0')
  assert.equal(r.cordisRange, '^4.0.1')
  assert.deepEqual(r.installable.matching, ['0.1.0'])
  assert.equal(failures.length, 0)
})

test('versionLineFor falls back to the registry repository pointer for a name', async () => {
  // The catalog entry names only a repository. The name must come from the
  // registry's own pointer, never from the repo's last path segment.
  const seen = []
  const r = await versionLineFor({
    pkgName: null,
    repoId: 'zhu1090093659/dsh-pet',
    localVersion: HOST,
    failures: [],
    resolve: async (repoId) => { seen.push(repoId); return { pkg: '@linxin666/dsh-pet', repo: repoId } },
    fetchPackumentImpl: async (pkg) => ({
      ok: true, reason: null, latest: '1.0.0', versions: ['1.0.0'],
      peerDependencies: { [TOOLS_PEER]: '^0.2.1-rc.1' },
    }),
  })
  assert.deepEqual(seen, ['zhu1090093659/dsh-pet'])
  assert.equal(r.pkg, '@linxin666/dsh-pet')
  assert.equal(r.pkgSource, 'registry-repository-url')
  assert.equal(r.status, 'ok')
})

test('versionLineFor says unknown when no package can be identified', async () => {
  // A miss here is a fact, not an error — but it is NOT "installs fine".
  const r = await versionLineFor({
    pkgName: null,
    repoId: 'some/repo',
    localVersion: HOST,
    failures: [],
    resolve: async () => null,
  })
  assert.equal(r.status, 'unknown')
  assert.match(r.reason, /没有指向/)
})

test('versionLineFor says unknown when the registry does not answer', async () => {
  const failures = []
  const r = await versionLineFor({
    pkgName: 'dsh-find-plugin',
    localVersion: HOST,
    failures,
    fetchPackumentImpl: async (pkg, sink) => {
      sink.push('HTTP 500 registry')
      return { ok: false, reason: 'registry-no-answer', latest: null, versions: [] }
    },
  })
  assert.equal(r.status, 'unknown')
  assert.match(r.reason, /取不到 packument/)
  assert.ok(failures.length > 0)
})

test('versionLineFor does not treat an optional peer as a hard block', async () => {
  const r = await versionLineFor({
    pkgName: 'x',
    localVersion: HOST,
    failures: [],
    fetchPackumentImpl: async () => ({
      ok: true, reason: null, latest: '1.0.0', versions: ['1.0.0'],
      peerDependencies: { [TOOLS_PEER]: '^9.9.9' },
      peerDependenciesMeta: { [TOOLS_PEER]: { optional: true } },
    }),
  })
  // The range genuinely excludes the host, so the status is blocked...
  assert.equal(r.status, 'blocked')
  // ...but npm will not refuse the install for an optional peer, so the report
  // must not present it as a hard blocker.
  assert.equal(r.blocking, false)
})
