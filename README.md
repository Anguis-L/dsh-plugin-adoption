# dsh-plugin-adoption

按**真实 npm 月下载量**给 DSH 插件排名，而不是按 GitHub 星数。

[![DSH 1024Store](https://img.shields.io/badge/1024Store-catalogued-blue)](https://deepseek1024.com/)

## 安装

**推荐**（这条形式会被 1024Store 计入安装量）：

```bash
dsh plugin --profile <你的profile> add github:Anguis-L/dsh-plugin-adoption
```

当前版本 **v0.1.0**。装完**重启一次** dsh（bundle 层要重启才组装），
然后在会话里直接让 agent 调用 `plugin_adoption`。

## 为什么需要它

社区的发现页按 **GitHub star** 排序。但 star 衡量的是一个仓库获得的关注，
不是实际发生的安装。实测（1024Store catalog × npm 官方下载接口，2026-10-25）：

```
按 star 排:    vision-router(1174★) > mnemon(701★) > config-manager(240★)
               > find-plugin(206★) > memento(141★) > mcp-panel(89★)
               > secure-audit(85★)

按下载量排:    mnemon(50,672) > vision-router(33,058) > find-plugin(22,038)
               > config-manager(15,291) > mcp-panel(10,058) > memento(5,966)
               > secure-audit(2,047)
```

`dsh-mcp-panel` 按 star 排第 **6**（89★），按下载排第 **4**（10,058 次/月）——
一个 89 星的插件，实际用的人比 240 星的那个更多。

**星数会说谎，下载量不会。** 这个插件把两个排序并排摆出来，并标出被星数低估的插件。

## 用法

```
plugin_adoption()                                    # 默认：dsh 关键词，12 个候选
plugin_adoption({ queries: ['memory', 'tool'] })     # 多个搜索词取并集
plugin_adoption({ limit: 30 })                       # 更多候选（会更慢，且消耗配额）
plugin_adoption({ topN: 20 })                        # 返回前 20 名
```

## 输出

```jsonc
{
  "sampled": 12,              // 候选数
  "withPackage": 9,           // 有 npm 包的
  "withDownloads": 9,         // 两个数字都拿到、可比较的
  "topByDownloads": [         // 按下载量排名
    { "name": "dsh-mnemon", "downloads": 50672, "stars": 701,
      "starRank": 2, "downloadRank": 1 }
  ],
  "underratedByStars": [      // 被星数低估的（shift > 0）
    { "name": "dsh-mcp-panel", "stars": 89, "downloads": 10058,
      "starRank": 6, "downloadRank": 5, "shift": 1 }
  ],
  "noPackage": ["owner/repo"],  // 没有 npm 包的，单列，不当成 0
  "requestFailures": [],        // 请求失败逐条列出，不静默
  "sources": { "catalog": "...", "npm": "...", "fetchedAt": "..." }
}
```

`shift = starRank - downloadRank`，正数表示「下载量排名比星数排名更高」。

## 关于配额（重要）

1024Store catalog API 匿名限额是 **50 请求/天、10 请求/分钟**（其官方文档）。
一次默认运行 = 1 次 catalog 请求 + 最多 12 次 npm 请求。

所以这个插件：

- **默认只取 12 个候选**，不会一次烧掉你当天的配额；
- 请求之间**至少间隔 1.2 秒**，不突发；
- 遇到 **429 会退避重试**（5s / 15s / 45s），然后明确报告，不死循环；
- 遇到**超时会重试一次**，DNS/连接失败不重试；
- **任何失败都写进 `requestFailures`**，不会把"网络断了"显示成"没有插件"。

最后一条是设计原则：**一份说"0 个插件"的报告，如果其实是网络故障，比一份说"我没查到"的报告危险得多**——前者会被当成结论。

## 数据来源

| 数据 | 来源 |
|---|---|
| 插件列表、star、安装数 | `api.deepseek1024.com/v1/plugins/search` |
| 月下载量 | `api.npmjs.org/downloads/point/last-month/<包名>` |

两个都是公开只读接口，无需鉴权。

## 局限

- **没有 npm 包的插件无法参与比较**，已单列在 `noPackage`——"没发布包"和"没人下载"是两件事。
- star 来自 catalog 快照，下载量是 npm 的当月口径，两者时间窗不同。
- 下载量包含 CI、镜像、自动化安装，不完全等于"人在用"。
- 采样取决于 `queries`，不是全量。

## 相关

[dsh-plugin-trust-audit](https://github.com/Anguis-L/dsh-plugin-trust-audit) —— 审计插件 HTTP 路由是否真的做了鉴权栅栏。
