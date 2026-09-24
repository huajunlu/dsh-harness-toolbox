# DeepSeek Harness 工具箱（dsh-harness-toolbox）

> ⚠️ **非官方社区插件**：本项目由社区开发者维护，与 DeepSeek 官方无关。名称中的 “DeepSeek Harness” 指其所适配的宿主产品。

[English](#english) | 中文

给 DeepSeek Harness Web 界面加一个设置分区「**Harness 工具箱**」，五个页签、模块化可扩展：

| 页签 | 能力 |
| --- | --- |
| 🔼 **更新中心** | 实时校验 npm 最新版本（latest / next / alpha 三通道）、一键升级（停服 → 备份 → 安装 → 重启 → 健康检查 → **失败自动回滚**）、升级历史 |
| 📊 **API 用量** | 今日 token 四桶、近 30 天趋势、分模型明细、账户余额、消费估算（只读聚合 `@linxin666/dsh-usage` 台账） |
| 🩺 **环境体检** | Node/系统/安装模式/路径/端口、npm registry 连通延迟、代理变量存在性、**一键复制诊断**（不含任何密钥） |
| 🛠 **服务工具** | 打开日志/运行时/配置目录、一键重启服务（同样带健康检查） |
| ℹ️ **关于** | 版本、署名、非官方声明、模块清单 |

## 安装

要求：DeepSeek Harness ≥ 0.1.5-rc.1，Windows（服务工具的打开目录动作为 v0.1 范围），启动器 `local` 运行时模式（升级/重启依赖它）。

```powershell
# 1. 放进 profile 依赖（三选一）
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add file:<本仓库路径>            # 复制安装
# 或 pnpm add link:<本仓库路径>       # 链接安装（开发推荐）

# 2. 在 package.json 的 dsh.profile.bundles 里加一行
#    "dsh-harness-toolbox"
# 3. 重启 dsh web（或等待 patchReload: live 热加载）
```

插件入口在：**设置 → Harness 工具箱**。

## 架构：新增一个功能有多简单

```
lib/
├── index.js            # 宿主入口：只做装配
├── registry.js         # ★ 模块注册表（可扩展性核心）
├── security.js         # 回环围栏 + 一次性 nonce
├── http.js / paths.js / semver-lite.js
└── modules/
    ├── updater.js      # 更新中心（宿主半）
    ├── usage.js        # API 用量（只读聚合）
    ├── diagnose.js     # 环境体检
    ├── service.js      # 服务工具
    └── about.js        # 关于
lib/client.js           # 浏览器半：底部 TABS 数组即页签注册表
scripts/upgrade.mjs     # 升级执行器（分离进程状态机）
```

**新增功能 = 两步：**

1. 宿主：新建 `lib/modules/my-feature.js`，导出 `registerMyFeature(ctx) → disposer`，在 `registry.js` 的 `MODULES` 数组加一行；
2. 客户端：在 `client.js` 写一个 Tab 组件，在 `TABS` 数组加一行。

每个模块独立 `try/catch` 隔离：单模块注册失败只降级自身，不会让整个设置页白屏。

## 安全设计

- **回环围栏**：全部 API 要求 socket 回环 + Host 回环 + 拒绝 `sec-fetch-site: cross-site` + Origin 同源校验；
- **破坏性操作**（升级/重启）额外要求：`application/json` content-type（跨站 HTML 表单发不出）+ 10 分钟时效**一次性 nonce**；
- **升级执行器**是分离进程：停服 → 备份清单 → `npm install` → 重启 → 90s 健康检查 → 失败自动 `npm ci` 回滚 → 手动恢复指引写 `last-upgrade-error.txt`；
- **固定命令**：只执行 `npm install @deepseek-ai/dsh@<semver校验过的版本>`，无 shell 拼接，版本号过 `^\d+\.\d+\.\d+(-...)?$` 白名单；
- **零密钥**：不读取任何凭据；代理环境变量只回传“存在性与变量名”，不回传值；
- **数据契约**：第三方台账严格校验 `version` 字段，schema 不符安全忽略。

详见 [SECURITY.md](SECURITY.md)。

## 数据来源与鸣谢

- API 用量页读取 [@linxin666/dsh-usage](https://github.com/zhu1090093659/dsh-web) 写入的 `$DSH_HOME/dsh-usage/*.json`（Apache-2.0，本插件仅只读其数据文件，不复制其代码）；
- 界面沿用 DeepSeek Harness 官方 `--dsw-alias-*` 设计令牌。

## 开发

```bash
node scripts/smoke.mjs   # 冒烟：semver / 围栏 / nonce / 注册表隔离 / 台账防御路径
```

## License

MIT © LHJ

---

<a name="english"></a>
# DeepSeek Harness Toolbox (unofficial)

> ⚠️ Unofficial community plugin, not affiliated with DeepSeek. “DeepSeek Harness” refers to the host product.

A settings section for the DeepSeek Harness web GUI with five tabs: **Updates** (dist-tag aware checker + one-click upgrade with stop → backup → install → restart → health-check → auto-rollback), **API Usage** (read-only aggregation of the `dsh-usage` ledger), **Diagnostics** (env card, registry latency, copyable report with no secrets), **Service** (open log/runtime/config, restart with health-check), and **About**.

Modular by construction: add a host file under `lib/modules/` + one registry row, and a tab component + one `TABS` row. Every module is individually isolated. All endpoints sit behind a loopback fence; destructive POSTs additionally require JSON content-type and a one-shot nonce. See [SECURITY.md](SECURITY.md).

MIT © LHJ
