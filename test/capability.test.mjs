/**
 * Offline tests for the capability-risk dimension (lib/xray.mjs, lib/risk.mjs).
 *
 * No network: every fixture below is a real dsh-xray record captured on
 * 2026-10-26 (trimmed to the fields this plugin keeps), so these tests pin the
 * actual data shape rather than a shape invented to match the code.
 *
 * Run: node --test test/logic.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  XRAY_DATA_URL, LEVEL_LEGEND, SENSITIVE_FLAGS, DANGEROUS_COMBOS,
  isSensitiveFlag, flagIdOf, projectRecord, maxLevelOf, indexXray,
  repoKeyOf, loadXray, clearXrayCache,
} from '../lib/xray.mjs'
import {
  riskScore, riskBucket, dangerCombos, rankByRisk,
  highAdoptionAndRisk, sensitiveOf,
} from '../lib/risk.mjs'

// ─────────────────────────── real records, trimmed ───────────────────────────
// Captured from https://unstone.github.io/dsh-xray/data.json on 2026-10-26.
const REAL_C2_EXEC_TOKEN = {
  repo: 'morluto/rea',
  level: 2,
  status: 'ok',
  flags: [
    { id: 'exec', evidence: '×191 in authored code' },
    { id: 'eval', evidence: '×1 in authored code' },
    { id: 'token_env', evidence: 'GH_TOKEN, REA_BROWSER_VERIFIER_SECRET' },
    { id: 'net_server', evidence: '×8 in authored code' },
  ],
  files_scanned: 593,
}
const REAL_C3 = {
  repo: 'nexu-io/open-design',
  level: 3,
  status: 'ok',
  flags: [
    { id: 'runtime_patch', evidence: './cordis.patch.yml' },
    { id: 'install_script', evidence: 'postinstall: node ./scripts/postinstall.mjs' },
    { id: 'exec', evidence: '×50 in authored code' },
    { id: 'token_env', evidence: 'ANTHROPIC_API_KEY, GEMINI_API_KEY' },
  ],
  files_scanned: 597,
}
const REAL_C0 = { repo: 'some/clean-plugin', level: 0, status: 'ok', flags: [], files_scanned: 12 }


// ────────────────────────────── flag narrowing ──────────────────────────────

test('flagIdOf accepts both spellings dsh-xray uses', () => {
  // Objects carry the id plus an evidence string; a bare string is the shape
  // the publisher also uses for flag listings elsewhere.
  assert.equal(flagIdOf({ id: 'exec', evidence: '×191' }), 'exec')
  assert.equal(flagIdOf('exec'), 'exec')
  assert.equal(flagIdOf({ evidence: 'no id' }), null)
  assert.equal(flagIdOf(null), null)
  assert.equal(flagIdOf(42), null)
})

test('isSensitiveFlag only admits the declared sensitive subset', () => {
  assert.equal(isSensitiveFlag('exec'), true)
  assert.equal(isSensitiveFlag('token_env'), true)
  assert.equal(isSensitiveFlag('runtime_patch'), true)
  // A tooling-only marker is not in the subset: it describes code that does
  // not ship, so it cannot execute on the user's machine.
  assert.equal(isSensitiveFlag('token_env_tooling'), false)
  assert.equal(isSensitiveFlag('dev_surface'), false)
  assert.equal(isSensitiveFlag(undefined), false)
})

test('every sensitive flag id is a real dsh-xray flag', () => {
  // Guards against a typo silently shrinking the sensitive surface. The flag
  // ids below are the ones present in the 2026-10-26 snapshot.
  const REAL_FLAG_IDS = new Set([
    'exec', 'eval', 'base64_decode', 'net_server', 'token_env', 'install_script',
    'dev_surface', 'runtime_patch', 'token_env_tooling', 'eval_tooling',
    'dev_manifest', 'exec_bundled', 'exec_tooling', 'base64_decode_tooling',
    'prompt_surface', 'subprocess_service', 'tool_gate', 'net_server_tooling',
    'no_manifest', 'net_server_bundled', 'eval_bundled', 'exec_ref', 'api_intercept',
    'base64_decode_bundled',
  ])
  for (const f of SENSITIVE_FLAGS) {
    assert.ok(REAL_FLAG_IDS.has(f), `sensitive flag "${f}" is not a real dsh-xray flag id`)
  }
})


// ─────────────────────────────── projection ───────────────────────────────

test('projectRecord keeps level, flags and the sensitive subset', () => {
  const rec = projectRecord(REAL_C2_EXEC_TOKEN)
  assert.equal(rec.repo, 'morluto/rea')
  assert.equal(rec.level, 2)
  assert.deepEqual(rec.flags.sort(), ['eval', 'exec', 'net_server', 'token_env'])
  assert.deepEqual(rec.sensitive.sort(), ['eval', 'exec', 'net_server', 'token_env'])
  assert.equal(rec.filesScanned, 593)
})

test('projectRecord refuses a record with no repo or no level', () => {
  // A malformed record must not become `{level: null}` — that later reads as
  // "scanned and found harmless", which is the silent-empty mistake.
  assert.equal(projectRecord(null), null)
  assert.equal(projectRecord({ level: 2 }), null)
  assert.equal(projectRecord({ repo: '   ', level: 2 }), null)
  // A record with a repo but no level IS kept: it says "not graded".
  const ungraded = projectRecord({ repo: 'a/b' })
  assert.equal(ungraded.repo, 'a/b')
  assert.equal(ungraded.level, null)
})

test('projectRecord de-duplicates repeated flag ids', () => {
  const rec = projectRecord({ repo: 'a/b', level: 2, flags: [{ id: 'exec' }, { id: 'exec' }, 'exec'] })
  assert.deepEqual(rec.flags, ['exec'])
})

test('projectRecord reports an unscannable record as no level, not level 0', () => {
  const rec = projectRecord({ repo: 'a/b', level: null, status: 'no_manifest', flags: [] })
  assert.equal(rec.level, null)
  assert.equal(rec.status, 'no_manifest')
  // riskScore of an ungraded record must be null, never 0.
  assert.equal(riskScore(rec), null)
})

test('level -1 is the publisher skipped-sentinel, not a C0 grade', () => {
  // Measured on the 2026-10-26 snapshot: 349 of 21,801 records carry level -1
  // with status "skipped: no scannable code" (324), "skipped: download failed"
  // (23) or a scanner error (2). Folding those into C0 would report an
  // unscanned repository as harmless — the silent-empty failure this plugin
  // exists to avoid.
  const skipped = projectRecord({
    repo: 'AdamPlatin123/dsh-plugin-radar',
    level: -1,
    status: 'skipped: no scannable code',
    files_scanned: 0,
    flags: [],
  })
  assert.equal(skipped.level, null)
  assert.equal(skipped.ungradedReason, 'skipped: no scannable code')
  assert.equal(riskScore(skipped), null)
  assert.equal(riskBucket(skipped), 'unknown')

  // The same for the download-failure case.
  const failed = projectRecord({ repo: 'a/b', level: -1, status: 'skipped: download failed' })
  assert.equal(failed.level, null)
  assert.equal(failed.ungradedReason, 'skipped: download failed')

  // A real grade keeps its level and carries no ungraded reason.
  const graded = projectRecord(REAL_C2_EXEC_TOKEN)
  assert.equal(graded.level, 2)
  assert.equal(graded.ungradedReason, null)
})

test('an out-of-range level is refused rather than ranked', () => {
  assert.equal(projectRecord({ repo: 'a/b', level: 7 }).level, null)
  assert.equal(projectRecord({ repo: 'a/b', level: -5 }).level, null)
  assert.equal(projectRecord({ repo: 'a/b', level: 1.5 }).level, null)
})


// ─────────────────────────────── repo keys ───────────────────────────────

test('repoKeyOf normalises every spelling the two sources use', () => {
  // The catalog writes github:owner/repo#path:sub; dsh-xray keys owner/repo.
  // Both must land on the same key or the join silently misses.
  assert.equal(repoKeyOf('github:nexu-io/open-design#path:packages/dsh-runtime'),
    'nexu-io/open-design')
  assert.equal(repoKeyOf('https://github.com/nexu-io/open-design'), 'nexu-io/open-design')
  assert.equal(repoKeyOf('git+https://github.com/o/r.git'), 'o/r')
  assert.equal(repoKeyOf('nexu-io/open-design'), 'nexu-io/open-design')
  assert.equal(repoKeyOf('Morluto/REA'), 'morluto/rea')
  assert.equal(repoKeyOf('gitlab:o/r'), 'o/r')
})

test('repoKeyOf rejects things that are not repositories', () => {
  assert.equal(repoKeyOf('@scope/name'), null)   // a package, not a repo
  assert.equal(repoKeyOf('dsh-mnemon'), null)    // a bare package name
  assert.equal(repoKeyOf(''), null)
  assert.equal(repoKeyOf(null), null)
  assert.equal(repoKeyOf(42), null)
})


// ─────────────────────────────── indexing ───────────────────────────────

test('indexXray keys records by normalised repository', () => {
  const doc = {
    generated_at: '2026-10-25T08:00:07+00:00',
    scanned: 21452,
    total: 21801,
    plugins: [REAL_C2_EXEC_TOKEN, REAL_C3, REAL_C0],
  }
  const idx = indexXray(doc)
  assert.equal(idx.byRepo.size, 3)
  assert.equal(idx.byRepo.get('morluto/rea').level, 2)
  assert.equal(idx.byRepo.get('nexu-io/open-design').level, 3)
  assert.equal(idx.generatedAt, '2026-10-25T08:00:07+00:00')
  assert.equal(idx.scanned, 21452)
  assert.equal(idx.skipped, 0)
})

test('indexXray returns null when there is no plugins array', () => {
  // null, not an empty Map: "the document was unusable" and "the ecosystem has
  // no plugins" must not look the same to the caller.
  assert.equal(indexXray({}), null)
  assert.equal(indexXray(null), null)
  assert.equal(indexXray({ plugins: 'nope' }), null)
})

test('indexXray counts skipped records instead of dropping them silently', () => {
  const idx = indexXray({ plugins: [REAL_C3, { level: 2 }, null] })
  assert.equal(idx.byRepo.size, 1)
  assert.equal(idx.skipped, 2)
})


// ────────────────────────────── risk scoring ──────────────────────────────

test('riskScore is level-first and orders C3 > C2 > C1 > C0', () => {
  const c3 = riskScore({ level: 3, sensitive: [] })
  const c2 = riskScore({ level: 2, sensitive: [] })
  const c1 = riskScore({ level: 1, sensitive: [] })
  const c0 = riskScore({ level: 0, sensitive: [] })
  assert.ok(c3 > c2 && c2 > c1 && c1 > c0)
  assert.equal(c0, 0)   // graded C0 is a real zero, unlike ungraded
})

test('riskScore returns null for an ungraded plugin, never 0', () => {
  // The whole point of the dimension: no grade is not a clean bill of health.
  assert.equal(riskScore({ level: null, sensitive: [] }), null)
  assert.equal(riskScore(null), null)
  assert.equal(riskScore({}), null)
})

test('riskScore uses the sensitive count only to break ties within a level', () => {
  const plain = riskScore({ level: 2, sensitive: [] })
  const one = riskScore({ level: 2, sensitive: ['exec'] })
  const two = riskScore({ level: 2, sensitive: ['exec', 'token_env'] })
  assert.ok(one > plain)
  assert.ok(two > one)
  // But a busier C2 never overtakes a C3: the level dominates.
  const busyC2 = riskScore({ level: 2, sensitive: new Array(40).fill('exec') })
  const quietC3 = riskScore({ level: 3, sensitive: [] })
  assert.ok(quietC3 > busyC2, 'level must dominate the flag count')
})

test('riskBucket names the four report buckets', () => {
  assert.equal(riskBucket({ level: 3, available: true }), 'high')
  assert.equal(riskBucket({ level: 2, available: true }), 'elevated')
  assert.equal(riskBucket({ level: 1, available: true }), 'low')
  assert.equal(riskBucket({ level: 0, available: true }), 'low')
  assert.equal(riskBucket({ level: null, available: true }), 'unknown')
})

test('riskBucket reports unknown, not low, when the data source failed', () => {
  // A failed download must never launder an ungraded plugin into "low".
  assert.equal(riskBucket({ level: 2, available: false }), 'unknown')
  assert.equal(riskBucket({ level: null, available: false }), 'unknown')
  assert.equal(riskBucket(null), 'unknown')
})


// ────────────────────────── dangerous combinations ──────────────────────────

test('dangerCombos finds the measured exec+token_env pair', () => {
  const flags = projectRecord(REAL_C2_EXEC_TOKEN).flags
  const found = dangerCombos(flags, DANGEROUS_COMBOS)
  assert.ok(found.some(c => c.id === 'exec+token_env'),
    'exec+token_env is the measured combination and must be detected')
})

test('dangerCombos requires every flag in the combination', () => {
  const combos = [{ id: 'exec+token_env', flags: ['exec', 'token_env'], why: 'x' }]
  assert.equal(dangerCombos(['exec'], combos).length, 0)
  assert.equal(dangerCombos(['exec', 'token_env'], combos).length, 1)
  assert.equal(dangerCombos([], combos).length, 0)
  assert.equal(dangerCombos(undefined, combos).length, 0)
})

test('DANGEROUS_COMBOS entries each name a real measured combination', () => {
  // The two with counts were measured on the live snapshot; the other two are
  // included for their rationale and carry count: null rather than a guess.
  const withCounts = DANGEROUS_COMBOS.filter(c => c.count !== null)
  assert.ok(withCounts.length >= 2)
  const execToken = DANGEROUS_COMBOS.find(c => c.id === 'exec+token_env')
  assert.equal(execToken.count, 1135)
  const promptExec = DANGEROUS_COMBOS.find(c => c.id === 'prompt_surface+exec')
  assert.equal(promptExec.count, 1064)
  for (const c of DANGEROUS_COMBOS) {
    assert.ok(c.why.length > 0, `${c.id} must say why the combination matters`)
    assert.ok(c.flags.length >= 2)
  }
})


// ─────────────────────────────── ordering ───────────────────────────────

test('rankByRisk puts the worst capability surface first', () => {
  const rows = [
    { id: 'a', downloads: 1000, stars: 10, capability: { level: 0, available: true, sensitive: [] } },
    { id: 'b', downloads: 10, stars: 1, capability: { level: 3, available: true, sensitive: ['exec'] } },
    { id: 'c', downloads: 500, stars: 5, capability: { level: 2, available: true, sensitive: [] } },
  ]
  const out = rankByRisk(rows)
  assert.deepEqual(out.map(r => r.id), ['b', 'c', 'a'])
})

test('rankByRisk keeps ungraded rows and sorts them last', () => {
  const rows = [
    { id: 'ungraded', downloads: 99999, stars: 999, capability: { level: null, available: true, sensitive: [] } },
    { id: 'clean', downloads: 1, stars: 1, capability: { level: 0, available: true, sensitive: [] } },
  ]
  const out = rankByRisk(rows)
  // Kept, not dropped: a reader has to see that it exists.
  assert.equal(out.length, 2)
  assert.deepEqual(out.map(r => r.id), ['clean', 'ungraded'])
})

test('rankByRisk breaks ties on downloads, then stars, then id', () => {
  const mk = (id, downloads, stars) => ({ id, downloads, stars, capability: { level: 2, available: true, sensitive: [] } })
  const out = rankByRisk([mk('x', 5, 1), mk('y', 500, 1), mk('z', 5, 9)])
  assert.deepEqual(out.map(r => r.id), ['y', 'z', 'x'])
  // Fully equal rows fall back to id so two runs are diffable.
  const stable = rankByRisk([mk('b', 5, 1), mk('a', 5, 1)])
  assert.deepEqual(stable.map(r => r.id), ['a', 'b'])
})

test('rankByRisk does not mutate its input', () => {
  const rows = [
    { id: 'a', downloads: 1, stars: 1, capability: { level: 0, available: true } },
    { id: 'b', downloads: 2, stars: 2, capability: { level: 3, available: true } },
  ]
  const snapshot = rows.map(r => r.id)
  rankByRisk(rows)
  assert.deepEqual(rows.map(r => r.id), snapshot)
})


// ──────────────────────── high adoption AND high risk ────────────────────────

test('highAdoptionAndRisk finds the intersection, and only that', () => {
  const candidates = [
    // widely installed + powerful: the row we want
    { id: 'big-risky', downloads: 50000, capability: { level: 3, available: true } },
    // widely installed but harmless: not a risk finding
    { id: 'big-clean', downloads: 40000, capability: { level: 0, available: true } },
    // powerful but barely installed: informative, not this list
    { id: 'small-risky', downloads: 3, capability: { level: 3, available: true } },
    // installed a lot but ungraded: cannot claim it is risky
    { id: 'big-unknown', downloads: 30000, capability: { level: null, available: true } },
  ]
  const out = highAdoptionAndRisk(candidates)
  // Downloads present: 3, 30000, 40000, 50000 -> median 35000 (even count, so
  // the mean of the two middle values), bar = half of that.
  assert.equal(out.threshold, 17500)
  assert.deepEqual(out.rows.map(r => r.id), ['big-risky'])
})

test('highAdoptionAndRisk says so instead of inventing a bar when nothing has downloads', () => {
  const out = highAdoptionAndRisk([
    { id: 'a', downloads: null, capability: { level: 3, available: true } },
  ])
  assert.equal(out.threshold, null)
  assert.equal(out.basis, 'no-download-data')
  assert.deepEqual(out.rows, [])
})

test('highAdoptionAndRisk uses a true median for an even-length pool', () => {
  // A pool whose second-smallest value sits between the true bar and the
  // upper-median bar. With the correct mean-of-two-middles median (42500) the
  // bar is 21250 and `mid` qualifies; a naive sorted[Math.floor(n/2)] would
  // take 60000, set the bar at 30000, and silently drop `mid`.
  const out = highAdoptionAndRisk([
    { id: 'lo', downloads: 100, capability: { level: 3, available: true } },
    { id: 'mid', downloads: 25000, capability: { level: 3, available: true } },
    { id: 'hi', downloads: 60000, capability: { level: 3, available: true } },
    { id: 'top', downloads: 90000, capability: { level: 3, available: true } },
  ])
  assert.equal(out.threshold, 21250)   // median (25000+60000)/2 = 42500, halved
  assert.deepEqual(out.rows.map(r => r.id).sort(), ['hi', 'mid', 'top'])

  // An odd-length pool uses the middle element directly.
  const odd = highAdoptionAndRisk([
    { id: 'a', downloads: 100, capability: { level: 2, available: true } },
    { id: 'b', downloads: 40000, capability: { level: 2, available: true } },
    { id: 'c', downloads: 90000, capability: { level: 2, available: true } },
  ])
  assert.equal(odd.threshold, 20000)   // median 40000, halved
  assert.deepEqual(odd.rows.map(r => r.id).sort(), ['b', 'c'])
})

test('highAdoptionAndRisk excludes ungraded plugins from the risky list', () => {
  // An ungraded plugin is unknown, not risky — including it would be the same
  // silent-empty error in the other direction.
  const out = highAdoptionAndRisk([
    { id: 'graded', downloads: 100, capability: { level: 2, available: true } },
    { id: 'ungraded', downloads: 100, capability: { level: null, available: true } },
  ])
  assert.deepEqual(out.rows.map(r => r.id), ['graded'])
})

test('sensitiveOf returns the present sensitive flags in declared order', () => {
  const flags = ['dev_surface', 'token_env', 'exec', 'runtime_patch']
  assert.deepEqual(sensitiveOf(flags), ['runtime_patch', 'token_env', 'exec'])
  assert.deepEqual(sensitiveOf([]), [])
  assert.deepEqual(sensitiveOf(undefined), [])
})


// ───────────────────────── level fallback helper ─────────────────────────

test('maxLevelOf returns the highest level present, or null', () => {
  assert.equal(maxLevelOf([2, 3, 1]), 3)
  assert.equal(maxLevelOf([0]), 0)
  assert.equal(maxLevelOf([]), null)
  assert.equal(maxLevelOf([null, undefined]), null)
})


// ─────────────────────────────── legend ───────────────────────────────

test('LEVEL_LEGEND covers every grade and does not invent one', () => {
  assert.deepEqual(Object.keys(LEVEL_LEGEND).sort(), ['0', '1', '2', '3'])
  for (const v of Object.values(LEVEL_LEGEND)) {
    assert.ok(/^C[0-3]\s/.test(v), 'each legend entry must name its grade')
  }
})


// ─────────────────────── loadXray failure policy ───────────────────────
// The loader memoises a successful bulk index for the process lifetime, so
// every test below starts from a cleared cache. Without this the tests would
// only pass in one execution order — the kind of fragility that turns a green
// suite into a lie the first time somebody adds a test above these.

test('loadXray reports unavailable instead of an empty index', async () => {
  // Point the loader at a URL that cannot resolve, and assert the failure
  // policy: available=false, a reason, a failure recorded — never a Map that
  // reads as "this ecosystem has no plugins".
  clearXrayCache()
  const failures = []
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw Object.assign(new Error('nope'), { name: 'TypeError' }) }
  try {
    const xray = await loadXray({ failures })
    assert.equal(xray.available, false)
    assert.equal(typeof xray.reason, 'string')
    assert.equal(xray.byRepo.size, 0)
    assert.ok(failures.length > 0, 'a transport failure must land in requestFailures')
  } finally {
    globalThis.fetch = original
    clearXrayCache()
  }
})

test('loadXray rejects a body that is not JSON rather than pretending it parsed', async () => {
  clearXrayCache()
  const failures = []
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('<html>rate limited</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  })
  try {
    const xray = await loadXray({ failures })
    assert.equal(xray.available, false)
    assert.equal(xray.reason, 'invalid-json')
    assert.ok(failures.some(f => f.includes('not valid JSON')))
  } finally {
    globalThis.fetch = original
    clearXrayCache()
  }
})

test('loadXray enforces the size ceiling before buffering', async () => {
  clearXrayCache()
  const failures = []
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('x'.repeat(200), {
    status: 200, headers: { 'content-length': '999999999' },
  })
  try {
    const xray = await loadXray({ failures, maxBytes: 1024 })
    assert.equal(xray.available, false)
    assert.equal(xray.reason, 'too-large')
    assert.ok(failures.some(f => f.includes('exceeds')))
  } finally {
    globalThis.fetch = original
    clearXrayCache()
  }
})

test('loadXray indexes a valid document and reports its provenance', async () => {
  clearXrayCache()
  const failures = []
  const doc = { generated_at: '2026-10-25T08:00:07+00:00', scanned: 21452, total: 21801, plugins: [REAL_C3] }
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(doc), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  try {
    const xray = await loadXray({ failures })
    assert.equal(xray.available, true)
    assert.equal(xray.byRepo.get('nexu-io/open-design').level, 3)
    assert.equal(xray.scanned, 21452)
    assert.equal(failures.length, 0)
  } finally {
    globalThis.fetch = original
    clearXrayCache()
  }
})

test('XRAY_DATA_URL is the published capability file', () => {
  assert.equal(XRAY_DATA_URL, 'https://unstone.github.io/dsh-xray/data.json')
})

test('a successful bulk load is reused, so a second question costs no download', async () => {
  // The bulk file is 14 MB; a second tool call must not re-fetch it.
  clearXrayCache()
  const doc = { generated_at: '2026-10-25T08:00:07+00:00', scanned: 21452, total: 21801, plugins: [REAL_C3] }
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify(doc), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const first = await loadXray({ failures: [] })
    const second = await loadXray({ failures: [] })
    assert.equal(calls, 1, 'the second load must come from the cache, not the network')
    assert.equal(first.available, true)
    assert.equal(second.available, true)
    assert.equal(second.byRepo.get('nexu-io/open-design').level, 3)
    // Cached entries carry the snapshot date, so a stale grade is always
    // attributable to a specific daily scan.
    assert.equal(second.generatedAt, '2026-10-25T08:00:07+00:00')
  } finally {
    globalThis.fetch = original
    clearXrayCache()
  }
})

test('a failed bulk load is not cached, so the next call retries', async () => {
  // Caching a failure would poison the rest of the session: one flaky moment
  // and every later question would report "no capability data" without trying.
  clearXrayCache()
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw Object.assign(new Error('flaky'), { name: 'TypeError' })
  }
  try {
    const first = await loadXray({ failures: [] })
    const second = await loadXray({ failures: [] })
    assert.equal(first.available, false)
    assert.equal(second.available, false)
    assert.equal(calls, 2, 'the failed load must not have been cached')
  } finally {
    globalThis.fetch = original
    clearXrayCache()
  }
})
