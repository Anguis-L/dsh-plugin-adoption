/**
 * dsh-plugin-adoption — rank DSH plugins by real npm downloads, not stars.
 *
 * A discovery surface that orders by GitHub stars is measurably wrong as a
 * proxy for "is anyone using this". See lib/adoption.mjs for the measured
 * example and the full rationale.
 *
 * It also carries a second, deliberately separate dimension: the dsh-xray
 * capability grade (C0-C3) plus the individual capability flags, so a ranking
 * can say which widely-installed plugins are also able to execute commands,
 * read API keys, or patch the runtime. See lib/xray.mjs and lib/risk.mjs.
 *
 * This file is the host half: it registers one tool and no HTTP route.
 */
import { adoption } from './lib/adoption.mjs'

export const name = 'dsh-plugin-adoption'

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

export function apply(ctx) {
  // Register the ranking tool.
  //
  // `ctx.tools` is a hard dependency of this plugin, so it is read directly
  // rather than through `ctx.inject(['tools'], ...)`. Both work in the host,
  // but the injected form hides the call from static analysers: the dsh-xray
  // registry reported this plugin as registering zero tools, because it only
  // recognises a literal `ctx.tools.register(`.
  ctx.tools.register({
    name: 'plugin_adoption',
    description:
      '按真实 npm 月下载量给 DSH 插件排名，而不是按 GitHub 星数。'
      + '从 1024Store catalog 取插件列表，对每个有 npm 包的查官方月下载量，'
      + '给出两个排序的对照，并标出「被星数低估」的插件。\n'
      + '为什么需要：社区发现页按 star 排序，但实测 star 排名和下载量排名不一致 —— '
      + '例如 dsh-mcp-panel 按 star 排第 6（89★），按下载排第 4（10,058 次/月）。'
      + '星数衡量关注，下载量衡量实际安装。\n'
      + '第二维度（能力面风险）：接入 dsh-xray 的公开扫描结果，给每个插件带上 C0-C3 等级'
      + '和具体能力 flags（exec / token_env / prompt_surface / net_server / api_intercept 等），'
      + '新增「按能力面风险排序」和一个「同时高下载量 且 高风险」的名单 —— '
      + '后者回答的是「哪些被大量安装的插件具备敏感能力」。\n'
      + '第三维度（版本线）：一位真实用户说他的筛选顺序是「先看这插件跟哪条 tools 版本线走，再看下载量」——'
      + '本工具原来只覆盖第二步。现在会读每个插件声明的 @deepseek-ai/dsh-tools peerDependency，'
      + '判断本机这条线是否接受它：不接受的标 blocked 并直接给出「哪个已发布版本能装」，'
      + '省掉反复重装试错。本机版本从宿主自己的 package.json 读出，不写死。\n'
      + '能力面数据来自第三方静态扫描，回答「这个插件能做什么」，不回答「它是不是恶意」。'
      + '未分级的插件一律标 unknown，不会当成安全（C0）处理。\n'
      + '只发只读 GET，不写任何东西；没有 npm 包的插件会单列，不会当成 0。',
    parameters: {
      queries: {
        type: 'array',
        description: 'catalog 搜索词，取并集作为候选池。最多 6 个，每个是一次 catalog 请求。默认 ["dsh"]。',
        items: { type: 'string' },
      },
      limit: {
        type: 'number',
        description: '每个搜索词取多少条候选。默认 60。注意：每条候选可能触发一次 npm 查询。',
      },
      topN: {
        type: 'number',
        description: '每个视角返回前 N 名。默认 15。',
      },
      capability: {
        type: 'string',
        description:
          '能力面数据的取法。auto（默认）= 先取 dsh-xray 全量快照（约 14.9MB，实测 13.8s 冷 / 1.5s 热），'
          + '失败则降级为逐仓库 badge 查询；bulk = 只要全量，失败就没有数据；'
          + 'badge = 跳过全量文件，只查 badge（快得多，但只有 level、没有 flags，且只覆盖有仓库地址的候选）；'
          + 'off = 关闭该维度（等同本插件旧版行为）。',
      },
      versionLine: {
        type: 'string',
        description:
          '版本线维度的开关。auto（默认）= 查每个候选声明的 @deepseek-ai/dsh-tools peerDependency，'
          + '判断本机装的这条线是否接受它，不接受就标 blocked 并给出「哪个已发布版本能装」；'
          + 'off = 关闭该维度。'
          + '注意：本机版本是从宿主自己的 package.json 读出来的，不写死；'
          + '读不到时可用 localVersion 参数或 DSH_TOOLS_VERSION 环境变量指定。'
          + '为控制请求数，单次最多查 24 个候选，未查的标 unknown（不是「装得上」）。',
      },
      localVersion: {
        type: 'string',
        description:
          '手动指定本机 dsh-tools 版本（如 "0.2.1-rc.2"），用于读不到宿主 package.json 的环境。不填则自动探测。',
      },
    },
    output: textOutput,
    async execute(args) {
      const queries = Array.isArray(args?.queries) ? args.queries : undefined
      const limit = Number(args?.limit) || undefined
      const topN = Number(args?.topN) || undefined
      const capability = typeof args?.capability === 'string' ? args.capability : undefined
      const versionLine = typeof args?.versionLine === 'string' ? args.versionLine : undefined
      const localVersion = typeof args?.localVersion === 'string' ? args.localVersion : undefined
      return adoption({ queries, limit, topN, capability, versionLine, localVersion })
    },
  })
}
