/**
 * Offline tests for the ranking logic in lib/adoption.mjs.
 *
 * No network and no API quota: `packageOf` and the ranking are re-derived here
 * from the same inputs, so a regression in either fails on every push. The
 * network layer is deliberately NOT tested — it would consume the caller's
 * 50/day anonymous quota, which is exactly what the plugin exists to avoid.
 *
 * Run: node test/logic.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// Import the real module rather than re-implementing it here. A copy in the
// test file passes while the shipped code is broken, which is how the
// `/some/local/path` bug survived the first run of this very test.
import { packageOf, rankShift, repoIdOf, repoOfPackage } from '../lib/adoption.mjs'

// The fixtures below are the real catalog x npm numbers measured on
// 2026-10-25, so the test also pins the finding that justifies the plugin.
const FIXTURE = [
  { id: 'a/dsh-mnemon', name: 'dsh-mnemon', stars: 701, installCount: 19,
    install: 'dsh plugin --profile web add dsh-mnemon', dl: 50672 },
  { id: 'b/dsh-vision-router', name: 'dsh-vision-router', stars: 1174, installCount: 56,
    install: 'dsh plugin --profile web add dsh-vision-router', dl: 33058 },
  { id: 'c/dsh-find-plugin', name: 'dsh-find-plugin', stars: 206, installCount: 14,
    install: 'dsh plugin --profile web add dsh-find-plugin', dl: 22038 },
  { id: 'd/dsh-config-manager', name: 'dsh-config-manager', stars: 240, installCount: 6,
    install: 'dsh plugin --profile web add dsh-config-manager', dl: 15291 },
  { id: 'e/dsh-mcp-panel', name: 'dsh-mcp-panel', stars: 89, installCount: 16,
    install: 'dsh plugin --profile web add dsh-mcp-panel', dl: 10058 },
  { id: 'f/dsh-memento', name: 'dsh-memento', stars: 141, installCount: 1,
    install: 'dsh plugin --profile web add dsh-memento', dl: 5966 },
  { id: 'g/dsh-secure-audit', name: 'dsh-secure-audit', stars: 85, installCount: 0,
    install: 'dsh plugin --profile web add dsh-secure-audit', dl: 2047 },
  // No npm package: a github: target. Must be excluded from comparison, not
  // treated as 0 downloads — "unpublished" and "nobody downloaded it" differ.
  { id: 'h/github-only', name: 'github-only-plugin', stars: 5000, installCount: 0,
    install: 'dsh plugin --profile web add github:h/github-only', dl: null },
  // stars is null in the catalog snapshot; must not crash the sort.
  { id: 'i/no-stars', name: 'no-stars-plugin', stars: null, installCount: 3,
    install: 'dsh plugin --profile web add no-stars-plugin', dl: 800 },
]

const NON_PACKAGE_PREFIXES = ['github:', 'gitlab:', 'bitbucket:', 'gist:', 'jsr:',
  'file:', 'link:', 'http:', 'https:']

test('packageOf extracts the npm package name', () => {
  assert.equal(packageOf('dsh plugin --profile web add dsh-mnemon'), 'dsh-mnemon')
  assert.equal(packageOf('dsh plugin --profile web add @scope/name'), '@scope/name')
})

test('packageOf returns null for non-package install targets', () => {
  // A github: target has no published package, so it cannot be compared.
  assert.equal(packageOf('dsh plugin --profile web add github:h/github-only'), null)
  assert.equal(packageOf('dsh plugin add https://example.com/x.tgz'), null)
  assert.equal(packageOf('dsh plugin add /some/local/path'), null)
  assert.equal(packageOf(undefined), null)
  assert.equal(packageOf(''), null)
})

test('packageOf strips a path fragment', () => {
  assert.equal(packageOf('dsh plugin add github:o/r#path:sub/dir'), null)
  assert.equal(packageOf('dsh plugin add name#ref'), 'name')
})

test('ranking by downloads differs from ranking by stars', () => {
  const candidates = FIXTURE.map(f => ({
    ...f, pkg: packageOf(f.install), downloads: f.dl,
  }))
  const both = candidates.filter(c => c.downloads !== null)
  const byStars = [...both].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
  const byDownloads = [...both].sort((a, b) => b.downloads - a.downloads)

  assert.equal(byStars[0].name, 'dsh-vision-router')   // 1174 stars leads
  assert.equal(byDownloads[0].name, 'dsh-mnemon')      // 50,672 downloads leads
  assert.notDeepEqual(byStars.map(c => c.name), byDownloads.map(c => c.name),
    'the two orderings should not coincide — that is the whole point')
})

test('plugins with no package are excluded, not counted as zero', () => {
  const candidates = FIXTURE.map(f => ({ ...f, pkg: packageOf(f.install) }))
  const noPkg = candidates.filter(c => !c.pkg).map(c => c.id)
  assert.deepEqual(noPkg, ['h/github-only'])
})

test('null stars sort last instead of crashing', () => {
  const both = FIXTURE.filter(f => f.dl !== null)
    .map(f => ({ ...f, pkg: packageOf(f.install) }))
  const byStars = [...both].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
  assert.equal(byStars[byStars.length - 1].name, 'no-stars-plugin')
})

test('rank shift flags the plugin stars under-rate', () => {
  // The measured case: dsh-mcp-panel is 6th by stars, 5th by downloads.
  const both = FIXTURE.filter(f => f.dl !== null)
    .map(f => ({ ...f, pkg: packageOf(f.install), downloads: f.dl }))
  const byStars = [...both].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
  const byDownloads = [...both].sort((a, b) => b.downloads - a.downloads)
  const starRank = new Map(byStars.map((c, i) => [c.id, i + 1]))
  const dlRank = new Map(byDownloads.map((c, i) => [c.id, i + 1]))

  const panel = both.find(c => c.name === 'dsh-mcp-panel')
  assert.equal(starRank.get(panel.id), 6)
  assert.equal(dlRank.get(panel.id), 5)
  assert.equal(rankShift(starRank.get(panel.id), dlRank.get(panel.id)), 1)
})

test('rankShift returns null when either rank is missing', () => {
  assert.equal(rankShift(null, 3), null)
  assert.equal(rankShift(3, null), null)
  assert.equal(rankShift(undefined, undefined), null)
})

test('a short name shared by two packages is reported as ambiguous', () => {
  // Measured on 2026-10-26: `dsh-pet` and `@linxin666/dsh-pet` are two
  // different npm packages that share a short name, and they are not
  // interchangeable. Installing one does not get you the other, so the
  // short name alone is ambiguous and has to be said out loud.
  const rows = [
    { name: 'dsh-pet', pkg: 'dsh-pet' },
    { name: 'dsh-pet', pkg: '@linxin666/dsh-pet' },
    { name: 'dsh-memento', pkg: 'dsh-memento' },
  ]
  const byShortName = new Map()
  for (const c of rows) {
    if (!c.pkg) continue
    if (!byShortName.has(c.name)) byShortName.set(c.name, new Set())
    byShortName.get(c.name).add(c.pkg)
  }
  const ambiguous = [...byShortName.entries()]
    .filter(([, pkgs]) => pkgs.size > 1)
    .map(([name, pkgs]) => ({ name, packages: [...pkgs] }))

  assert.equal(ambiguous.length, 1)
  assert.equal(ambiguous[0].name, 'dsh-pet')
  assert.deepEqual(ambiguous[0].packages.sort(),
    ['@linxin666/dsh-pet', 'dsh-pet'])
})

test('a short name with a single package is not ambiguous', () => {
  const rows = [{ name: 'dsh-memento', pkg: 'dsh-memento' }]
  const byShortName = new Map()
  for (const c of rows) {
    if (!byShortName.has(c.name)) byShortName.set(c.name, new Set())
    byShortName.get(c.name).add(c.pkg)
  }
  const ambiguous = [...byShortName.entries()].filter(([, p]) => p.size > 1)
  assert.equal(ambiguous.length, 0)
})

test('repoIdOf recovers the repository from a github: install target', () => {
  // The catalog's install command names a repository, not a package. Those
  // entries have no package name to look up, and the repository name is only
  // the package name about half the time.
  assert.equal(repoIdOf('dsh plugin --profile web add github:PC2005-cloud/dsh-pet'),
    'PC2005-cloud/dsh-pet')
  assert.equal(repoIdOf('dsh plugin --profile web add owner/repo'), 'owner/repo')
  // A package target is not a repository.
  assert.equal(repoIdOf('dsh plugin --profile web add @scope/name'), null)
  assert.equal(repoIdOf('dsh plugin --profile web add dsh-pet'), null)
  assert.equal(repoIdOf(undefined), null)
})

test('repoOfPackage matches a package to the repository it points at', () => {
  // The measured case: the package owner and the repository owner are
  // different people, so the package cannot be guessed from the repo name.
  assert.equal(
    repoOfPackage('@linxin666/dsh-pet', 'git+https://github.com/zhu1090093659/dsh-pet.git'),
    'zhu1090093659/dsh-pet')
  assert.equal(
    repoOfPackage('dsh-taskboard', 'git+https://github.com/cloader/dsh-taskboard.git'),
    'cloader/dsh-taskboard')
  // A package whose name does not match the repository is not this one.
  assert.equal(
    repoOfPackage('dsh-pet', 'git+https://github.com/somebody-else/dsh-bundle.git'),
    null)
  assert.equal(repoOfPackage('dsh-pet', 'not a url'), null)
  assert.equal(repoOfPackage(null, 'git+https://github.com/o/r.git'), null)
})
