/**
 * dsh-plugin-adoption — rank DSH plugins by real npm downloads, not stars.
 *
 * A discovery surface that orders by GitHub stars is measurably wrong as a
 * proxy for "is anyone using this". See lib/adoption.mjs for the measured
 * example and the full rationale.
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
  ctx.inject(['tools'], scoped => {
    scoped.effect(() => scoped.tools.register({
      name: 'plugin_adoption',
      description:
        '按真实 npm 月下载量给 DSH 插件排名，而不是按 GitHub 星数。'
        + '从 1024Store catalog 取插件列表，对每个有 npm 包的查官方月下载量，'
        + '给出两个排序的对照，并标出「被星数低估」的插件。\n'
        + '为什么需要：社区发现页按 star 排序，但实测 star 排名和下载量排名不一致 —— '
        + '例如 dsh-mcp-panel 按 star 排第 6（89★），按下载排第 4（10,058 次/月）。'
        + '星数衡量关注，下载量衡量实际安装。\n'
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
          description: '返回前 N 名。默认 15。',
        },
      },
      output: textOutput,
      async execute(args) {
        const queries = Array.isArray(args?.queries) ? args.queries : undefined
        const limit = Number(args?.limit) || undefined
        const topN = Number(args?.topN) || undefined
        return adoption({ queries, limit, topN })
      },
    }), 'dsh-plugin-adoption: tool')
  })
}
