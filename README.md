# dsh-plugin-adoption

Rank DSH plugins by **real monthly npm downloads** instead of GitHub stars.
It carries two further independent dimensions: **capability-surface risk
(C0–C3)** and **version line (will it even install?)**.

[![DSH 1024Store](https://img.shields.io/badge/1024Store-catalogued-blue)](https://deepseek1024.com/)
[![CI](https://github.com/Anguis-L/dsh-plugin-adoption/actions/workflows/ci.yml/badge.svg)](https://github.com/Anguis-L/dsh-plugin-adoption/actions/workflows/ci.yml)

> 中文说明见 [README.zh.md](README.zh.md)。

## What it does and does not do

This plugin **reads** public sources and **ranks** what it finds. It does
not write, install, modify or rate-limit anything.

| | |
|---|---|
| Reads | the 1024Store catalog API (public, read-only), npm's official downloads endpoint (public, read-only), and the dsh-xray capability snapshot (public, read-only) |
| Writes | nothing — no file, no config, no registry state, no other plugin |
| Network | GET only, to the public APIs, the npm registry and dsh-xray |
| Registers | one tool, `plugin_adoption`. No HTTP route of its own |
| Modifies other plugins | never. It reports a ranking; it does not enforce one |

The two numbers it compares measure different things and the report says so
every time: **stars** measure the attention a repository received,
**downloads** measure installs that actually happened. Neither is a quality
score, and this plugin does not produce one — it reports the disagreement
between the two orderings and leaves the judgement to the caller.

Two things it deliberately does not do: it does not count plugins without an
npm package as zero (they are listed separately, under `noPackage`), and it
does not hide a failed request behind an empty result (they appear in
`requestFailures`, with the count of candidates that were actually compared).
The same rule governs the capability dimension: an ungraded plugin is reported
as `unknown`, never as `C0`.

The catalog API allows 50 anonymous requests a day, so a default run samples
a bounded number of candidates rather than the whole catalog.

## Install

**Recommended** — a prebuilt tarball, so there is no build step and no npm
publish in the way:

```bash
dsh plugin --profile <your-profile> add \
  https://github.com/Anguis-L/dsh-plugin-adoption/releases/download/v0.1.0/dsh-plugin-adoption-0.1.0.tgz
```

Verified end to end on a real DSH host: the command above installs in ~4s, and
`dsh --profile <profile> --dump-config` then shows the bundle layer:

```
# == dsh-plugin-adoption
- id: plugin-adoption
  name: dsh-plugin-adoption
```

Installing from the repository also works, and that form is the one 1024Store's
install analytics counts:

```bash
dsh plugin --profile <your-profile> add github:Anguis-L/dsh-plugin-adoption
```

<!-- npm-install:this package is also published to npm; the form below is what the
     market feed's install extractor recognises, so it is listed once the package
     exists on the registry. -->
```bash
dsh plugin --profile <your-profile> add dsh-plugin-adoption
```

Version **v0.1.0**. Restart `dsh` once after installing (the bundle layer is
assembled at startup), then ask the agent to call `plugin_adoption`.

## Why this exists

Community discovery surfaces order by **GitHub stars**. But a star measures the
attention a repository got, not an install that happened. Measured against the
live catalog on 2026-10-25:

![demo](assets/demo-en.png)

```
by stars:     vision-router(1174) > mnemon(701) > config-manager(240)
              > find-plugin(206) > memento(141) > mcp-panel(89) > secure-audit(85)

by downloads: mnemon(50,672) > vision-router(33,058) > find-plugin(22,038)
              > config-manager(15,291) > mcp-panel(10,058) > memento(5,966)
              > secure-audit(2,047)
```

`dsh-mcp-panel` is **6th by stars (89) but 4th by downloads (10,058/month)** —
an 89-star plugin that more people actually run than a 240-star one.

**Stars can mislead; downloads don't.** This plugin puts both orderings side by
side and flags what star ordering under-rates.

## Finding the right package

Many catalog entries install from a **repository** rather than a package:

```
dsh plugin --profile web add github:zhu1090093659/dsh-pet
```

A repository is not a package, and its name is the package name only about
half the time — measured on 40 random catalog entries, 20 resolved that way.
The rest are forks and re-publications, where the package scope and the
repository owner are simply different people:

| repository | package | monthly |
|---|---|---|
| `zhu1090093659/dsh-pet` | `@linxin666/dsh-pet` | 131,855 |
| `PC2005-cloud/dsh-pet` | `dsh-pet` | 66,953 |
| `cloader/dsh-taskboard` | `dsh-taskboard` | 5,978 |
| `PerryLink/dsh-memento` | `dsh-memento` | 6,198 |

Guessing from the repository name would attribute the first one's 131,855
downloads to the wrong package, or drop it entirely.

So the name is **read from the registry** rather than guessed: npm's search
response carries each package's `repository.url`, and the package whose
repository points at *this* repository is the one that belongs to it. This is
the same binding the 1024Store catalog uses.

The npm search endpoint is a different service from the catalog API, so this
does not touch the catalog's 50/day anonymous quota. Entries with no
published package still come back empty — that is a fact about the plugin,
not an error, and they stay in `noPackage` rather than being counted as zero.

The report says how many entries were recovered this way
(`packageResolved`), so it is visible when a number came from the registry
rather than from the catalog's own install command.

## Usage

```
plugin_adoption()                                 # default: query "dsh", 12 candidates
plugin_adoption({ queries: ['memory', 'tool'] })  # union of several searches
plugin_adoption({ limit: 30 })                    # more candidates (slower, costs quota)
plugin_adoption({ topN: 20 })                     # top 20 in each view
plugin_adoption({ capability: 'badge' })          # skip the 14.9MB bulk file; badges only
plugin_adoption({ capability: 'off' })            # disable the capability dimension
plugin_adoption({ versionLine: 'off' })           # disable the version-line dimension
plugin_adoption({ localVersion: '0.2.1-rc.2' })   # state the host version when it cannot be read
```

## Third dimension: version line

This one came from a real user comment:

> "I check which tools version line a plugin rides before I look at downloads.
> Popular ones get stuck on an old line and will not install — that is not a
> network problem. Pinning an exact version beats reinstalling until it works."

**His order is version line → downloads, and this tool only covered the second
step.** It now covers the first.

It reads `peerDependencies["@deepseek-ai/dsh-tools"]` from the plugin's
`package.json` and decides whether the line **installed here** accepts it.

| status | meaning | what to do |
|---|---|---|
| `ok` | the range accepts the installed version | install it |
| `blocked` | the range rejects it | it will not install; the report names **which published version does** |
| `no-constraint` | no such peerDependency declared | not constrained by this line (the majority) |
| `undecidable` | declared, but not a version range (`workspace:*`, git URL, tag) | human judgement only |
| `unknown` | could not find out (no package name / registry silent / over budget) | **not "installs fine"** |

### The trap: the installed version is a prerelease

The host here is `0.2.1-rc.2`. semver's rule is that **a prerelease is only
accepted by a range that names a prerelease on the same major.minor.patch**. So
— verified line by line against npm's own `semver`:

```
0.2.1-rc.2  satisfies  "^0.2.1"        -> false
0.2.1-rc.2  satisfies  "*"             -> false   <- looks most permissive, still rejects
0.2.1-rc.2  satisfies  ">=0.1.0"       -> false   <- same
0.2.1-rc.2  satisfies  "^0.2.1-rc.1"   -> true    <- only this shape accepts
```

That is why `dsh-bili-scroll`, which declares `"*"`, is reported `blocked`. It
looks counter-intuitive and matches npm exactly — and writing "installs fine"
there would send the user into a failed install.

### The installed version is read, not hard-coded

Order: the `DSH_TOOLS_VERSION` environment variable → Node resolving
`@deepseek-ai/dsh-tools/package.json` → a list of candidate paths (including
Electron's `process.resourcesPath`, the profile tree, and the install directory).
When nothing readable is found the report **says so**; guessing a line would make
every plugin look `blocked`.

> ⚠️ Known limit: the Desktop build packs `dsh-tools` into `app.asar`, which
> **only the Electron host process can read**. On such an install, if the host
> exposes no resolvable path either, state the version once via
> `DSH_TOOLS_VERSION` or the `localVersion` argument.

### The package name must be exact

Repository name ≠ npm package name (guessing hits about 50%). So a name is only
accepted from a trustworthy source: the catalog's `install` field, or
`resolvePackage` verifying that the registry's `repository.url` really points at
this repository. A miss is reported `unknown`, never guessed — a wrong name would
read someone else's peerDependencies as this plugin's.

### Request cost

One packument GET per candidate, **at most 24 per run**; the rest are marked
`unknown` with the count stated in `versionLines.note`. Every request shares the
same 1.2s pacing clock.

## Second dimension: capability-surface risk

Stars and downloads both answer "how many people use this". Neither answers
**"what can it do once installed on my machine"**.
[dsh-xray](https://unstone.github.io/dsh-xray/) publishes that by scanning each
plugin repository, and this plugin joins it onto the candidate pool.

| Level | Meaning (quoted from the dsh-xray legend) |
|---|---|
| C0 | No notable capability surface. |
| C1 | Ordinary: registers tools/services, calls external domains. |
| C2 | Powerful: prompt surface, API interception, subprocess, exec, credential reads or install scripts. |
| C3 | Powerful capabilities combined with sensitive behavior. |

This supplies a dimension neither the store nor the catalog has: of the store's
6,896 plugins only 624 have a download number, and none carries capability
data, while dsh-xray knows the capabilities but not who installs them.

The report therefore gains two views:

- `topByRisk` — ordered by capability risk, worst first (ties broken by downloads)
- `highAdoptionAndHighRisk` — plugins that are **both widely installed and
  sensitive**. This is the genuinely useful line: which widely-installed plugins
  can do sensitive things. The threshold is not invented: it is **half the
  median download count of the candidate pool**, and the number used is
  reported alongside so a reader can re-judge where the line should sit.

The governing rule: **ungraded is not safe**. A plugin with `level: null` lands
in the `unknown` bucket and is never sorted onto the "harmless" side — the same
principle as "no npm package is not zero downloads".

In dsh-xray, `level: -1` is a **skipped** sentinel (measured: 349 records —
324 `skipped: no scannable code`, 23 `skipped: download failed`, 2 scanner
errors). Those were never graded, so they are also `unknown`, and the original
`status` is preserved in `ungradedReason`.

### Data volume and degradation

Measured on 2026-10-26: `data.json` is **14,855,325 bytes**, **13.8 s** cold,
~**1.5 s** warm over the GitHub CDN's gzip path; `JSON.parse` costs 145 ms /
25.3 MB of heap, and ~**15 MB** stays resident after projection into a `Map`.

The `capability` parameter selects the path:

| Value | Behaviour |
|---|---|
| `auto` (default) | bulk snapshot first; on failure fall back to per-repository badge lookups |
| `bulk` | bulk only; if it fails there is no capability data, and the report says so |
| `badge` | skip the bulk file; query `badge/<owner>__<repo>.json` (~92 bytes, 300–700 ms each). **Level only, no flags**, and only for candidates that have a repository URL |
| `off` | disable the dimension entirely |

Every row produced by a degraded path carries `partial: true`, and
`capabilitySource.used` states which path ran, so a level-only answer is never
presented as if it were the full picture.

**Three separate failure exits**, none of which silently becomes an empty array:

- `requestFailures` — any request failure (including exhausted 429 backoff, timeouts)
- `capabilityFailures` — failures specific to the capability join
- `capabilitySource.reason` — why the whole dimension is unavailable
  (`too-large` / `invalid-json` / `http-500` / …)

A repository missing from dsh-xray is **data**
(`note: "dsh-xray did not index this repository"`), reported separately from a
transport failure — "I could not find out" and "it has none" are different facts.

## Output

```jsonc
{
  "sampled": 12,               // candidates found
  "withPackage": 9,            // that have an npm package
  "withDownloads": 9,          // both numbers available, comparable
  "topByDownloads": [          // each row now carries its capability
    { "name": "dsh-mnemon", "downloads": 50672, "stars": 701,
      "starRank": 2, "downloadRank": 1,
      "capability": { "level": 2, "bucket": "elevated",
                      "sensitive": ["exec", "token_env"] } }
  ],
  "topByRisk": [               // second dimension: worst capability first
    { "name": "dsh-x", "level": 3, "bucket": "high", "riskScore": 305,
      "downloads": 45866, "sensitive": ["runtime_patch", "exec"],
      "ungradedReason": null }
  ],
  "highAdoptionAndHighRisk": { // widely installed AND sensitive
    "threshold": 14448,
    "basis": "69 of the candidates have downloads; median 28897, halved",
    "rows": [ /* same row shape */ ]
  },
  "capabilitySource": {        // how this dimension's data was obtained
    "mode": "auto", "used": "bulk", "available": true,
    "graded": 102, "ungraded": 1, "legend": { "0": "C0 …", "3": "C3 …" }
  },
  "dangerousCombos": [         // how often each combination occurs here
    { "id": "exec+token_env", "ecosystemCount": 1135, "inCandidates": 5 }
  ],
  "versionLines": {            // third dimension: version line
    "enabled": true,
    "localVersion": "0.2.1-rc.2",              // read, not hard-coded
    "localVersionSource": "env:DSH_TOOLS_VERSION",
    "queried": 24,
    "skippedForBudget": 0,
    "statusCounts": { "ok": 8, "blocked": 6, "no-constraint": 9,
                      "undecidable": 1, "unknown": 0 },
    "blockedPlugins": [                        // will not install, plus what would
      { "name": "dsh-find-plugin", "pkg": "dsh-find-plugin",
        "declaredRange": "^0.1.0-rc.6 || ^0.1.1-rc.1 || …",
        "installable": { "matching": ["0.1.0"], "highest": "0.1.0", "total": 1 } }
    ],
    "note": null
  },
  "underratedByStars": [       // shift > 0
    { "name": "dsh-mcp-panel", "stars": 89, "downloads": 10058,
      "starRank": 6, "downloadRank": 5, "shift": 1 }
  ],
  "noPackage": ["owner/repo"], // no npm package; listed, never treated as 0
  "requestFailures": [],       // every request failure, never silent
  "capabilityFailures": [],    // capability-join failures, kept separate
  "sources": { "catalog": "...", "npm": "...", "xray": "...", "fetchedAt": "..." }
}
```

Each `topByDownloads` row carries both extra dimensions:

```jsonc
{ "name": "dsh-find-plugin", "downloads": 22038,
  "versionLine": {
    "status": "blocked", "pkg": "dsh-find-plugin", "localVersion": "0.2.1-rc.2",
    "declaredRange": "^0.1.0-rc.6 || ^0.1.1-rc.1 || …",
    "satisfies": false, "blocking": true,
    "installable": { "matching": ["0.1.0"], "highest": "0.1.0", "total": 1 },
    "reason": "the declared range does not accept the installed 0.2.1-rc.2" } }
```

`shift = starRank - downloadRank`. Positive means downloads rank it higher than
stars do.

## About quota (important)

The 1024Store catalog API is anonymous at **50 requests/day, 10/minute** (its
own docs). One default run = 1 catalog call + at most 12 npm calls.

So this plugin:

- Samples **12 candidates by default**, so a first run cannot exhaust your day
- Paces requests **1.2s apart**, never bursted
- **Backs off on 429** (5s / 15s / 45s), then reports — never spins
- Retries once on **timeout**; does not retry DNS or connection failures
- Writes **every failure into `requestFailures`** — a network fault must not
  render as "0 plugins"

That last one is the design principle: **a report that says "0 plugins" when the
network actually failed is more dangerous than one that says "I could not tell"**,
because the first reads as a finding.

## Data sources

| Data | Source |
|---|---|
| Plugin list, stars, install counts | `api.deepseek1024.com/v1/plugins/search` |
| Monthly downloads | `api.npmjs.org/downloads/point/last-month/<pkg>` |
| Capability level + flags | `unstone.github.io/dsh-xray/data.json` (bulk) or `.../badge/<owner>__<repo>.json` (degraded) |
| Version line (peerDependencies) | the packument at `registry.npmjs.org/<pkg>` |
| Installed dsh-tools version | the host's own `package.json` (auto-detected), or `DSH_TOOLS_VERSION` |

All are public read-only endpoints. No authentication.

## Limitations

- **Plugins without an npm package cannot be compared**; they are listed under
  `noPackage` — "not published" and "nobody downloaded it" are different facts.
- Stars come from a catalog snapshot; downloads are npm's current-month window.
  The two time windows differ.
- Downloads include CI, mirrors, and automated installs — not purely "humans using it".
- Sampling depends on `queries`; it is not the full catalog.
- **The capability grade is third-party static analysis, not a security rating.**
  It answers "what can this plugin do", not "is it malicious". C0 is not proof
  of harmlessness either — it only means no notable surface was detected, and
  static scanning cannot see behaviour that only appears at run time.
- The sensitive-flag subset (`SENSITIVE_FLAGS`) and the risk ordering weights are
  **this plugin's judgement**, not dsh-xray's; only the C0–C3 grades are the
  publisher's. The two are labelled separately in the code so you can disagree
  with one without discarding the other.
- The badge fallback yields **level only, no flags**, so `sensitive` is always
  empty on that path — empty means "not fetched this time", not "no sensitive
  capabilities".
- **The version line decides whether npm would refuse the install, not whether
  the plugin then runs.** A satisfied range is necessary, not sufficient: a
  wrong peer declaration or a changed runtime API can still install and break.
- The version line reads the `latest` version's peer block (that is what gets
  installed). Historical versions declare different ranges; this report does not
  expand them one by one.
- At most 24 candidates are checked per run; the rest are `unknown`, **not
  "installs fine"**.

## Development

```bash
node --check index.js && for f in lib/*.mjs; do node --check "$f"; done
node --test test/logic.test.mjs test/capability.test.mjs test/version.test.mjs
```

The tests are **offline on purpose**: running them against the live API would
spend the caller's 50/day anonymous quota, which is exactly what this plugin
exists to avoid.

## Related

[dsh-plugin-trust-audit](https://github.com/Anguis-L/dsh-plugin-trust-audit) —
audit whether DSH plugin HTTP routes are actually fenced.

## License

MIT
