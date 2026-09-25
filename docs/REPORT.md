# DeepSeek Harness 工具箱 · 项目全过程报告

> **项目名**：DeepSeek Harness 工具箱（`dsh-harness-toolbox`）
> **作者**：LHJ ｜ **版本**：v0.1.0 ｜ **许可证**：MIT
> **性质**：非官方社区插件 ｜ **宿主**：DeepSeek Harness 0.1.5-rc.1（Web GUI）
> **报告日期**：2026-09-24

---

## 1. 项目概述

在 DeepSeek Harness 的设置面板中新增一个一级分区「**Harness 工具箱**」，以模块化架构承载五个可独立演进的功能页签，并以开源安全标准完成审查与测试，目标发布到 GitHub/npm。

| 页签 | 能力 | 状态 |
| --- | --- | --- |
| 🔼 更新中心 | 三通道（latest/next/alpha）版本校验、changelog 就绪、一键升级（停服→备份→安装→重启→健康检查→**失败自动回滚**）、通道切换、升级历史、红点提醒 | ✅ 全绿 |
| 📊 API 用量 | 今日 token 四桶、调用次数、近 30 天趋势、分模型明细、账户余额、消费估算（只读聚合第三方台账，schema 防御式校验） | ✅ 全绿 |
| 🩺 环境体检 | Node/系统/安装模式/运行时与配置目录/端口/registry 延迟/代理变量存在性/内存，一键复制诊断（不含任何密钥） | ✅ 全绿 |
| 🛠 服务工具 | 打开日志/运行时/配置目录、一键重启服务（带健康检查与二次确认） | ✅ 全绿 |
| ℹ️ 关于 | 版本（精确 buildId）、署名 LHJ、非官方声明、许可证、模块清单、仓库/安全政策链接 | ✅ 全绿 |

**架构核心**：新增一个功能 = 宿主侧 `lib/modules/` 加一个文件 + 注册表加一行；客户端 `TABS` 数组加一行。每个模块独立 try/catch 隔离，单模块故障只降级自身，绝不白屏整个设置页。

---

## 2. 需求演进时间线

| 轮次 | 用户输入 | 产出决策 |
| --- | --- | --- |
| 1 | "deepseekharness是什么版本" | 核实 0.1.5-rc.1 / rc.3 |
| 2 | "增加最新版本校验并提供升级按钮…给个方案+截图审核" | 方案：设置面板新增「关于与更新」分区；产出首张标注 mockup |
| 3 | "单独做个插件？" | 确认独立插件形态（不改 node_modules，扛住升级覆盖） |
| 4 | "功能太单调，增加 API 实时使用情况等，打包成多功能插件" | 扩为四模块多功能插件；发现 `dsh-usage` 已有一半数据基础（复用其台账，不重复采集） |
| 5 | "陆华君改成拼音缩写、要可扩展性、要安全审核、发布 GitHub" | 署名 LHJ；模块注册表架构；对抗式审查（F1–F16）+ SECURITY.md |
| 6 | "名字用 DeepSeek HARNESS 工具箱，用 UI 工程师视野审查美观" | 定名；UI 审查修 4 处（网格布局/基线对齐/按钮度量/导航截断） |
| 7 | "对整个项目进行对抗式审查" | 16 项发现（4 阻断/6 高/6 中低），2 项事实修正（npm 三通道、`dsh-toolbox` 包名被占→`dsh-harness-toolbox`） |
| 8 | "确认，动工。完成后整理报告 + 使用方法创意图片" | 本报告 + 创意信息图 |

---

## 3. 对抗式审查 → 设计约束的落地对照

| # | 发现 | 落地位置 | 验证 |
| --- | --- | --- | --- |
| F1 | 升级接口 = RCE 攻击面（CSRF/跨站驱动） | 回环围栏 + Origin/`sec-fetch-site` 校验 + `application/json` 强制 + **一次性 nonce**（10min 过期）+ 版本号白名单正则 + 固定包名 | 负例：伪造 nonce→403、非 JSON→415、跨站头→403 ✓ |
| F2 | Windows 文件锁：服务运行中原地 npm install 必 EPERM | 停服→备份→安装→重启 三段式，分离进程执行器 | 执行器场景 A ✓ |
| F3 | 自举悖论：升级搞挂界面则回滚按钮失效 | 健康检查（90s 任意 HTTP 应答）→ 自动 `npm ci` 回滚 → `last-upgrade-error.txt` 手动恢复手册 | 执行器场景 B ✓ |
| F4 | 凭据泄漏进开源仓库 | 白名单式 `.gitignore`；shot 脚本硬编码令牌改为从 state.txt 动态读取；代理变量只回传存在性不回传值 | 全工作区密钥模式扫描零命中 ✓ |
| F6 | 硬编码 registry 无视用户镜像 | 版本校验走 `npm view`（继承 .npmrc 镜像/代理） | 真实检查返回三通道 ✓ |
| F8 | 第三方台账 schema 脆弱 | 严格校验 `version===1`，不符返回 `available:false` 不抛错 | smoke 防御路径 ✓ |
| F9 | 商标/官方背书暗示 | 关于页 + README 顶部「非官方社区插件」声明 | UI 关于页可见 ✓ |
| F11 | 每次开页打 npm | dist-tag 结果缓存 6 小时 | status `checkedAt/stale` 字段 ✓ |
| F12 | 单模块故障白屏 | 注册表逐模块隔离 + 客户端每页签独立错误边界 | registry smoke ✓ |
| F16 | 发布面 | GitHub + npm 包名 `dsh-harness-toolbox`（已确认未被占用；`dsh-toolbox` 已被他人注册） | registry 探测 ✓ |

---

## 4. 技术实现

### 4.1 结构

```
dsh-harness-toolbox/
├── lib/
│   ├── index.js        # 宿主入口：ctx.effect 装配（官方模式，保证路由随纤维回收）
│   ├── registry.js     # ★ 模块注册表：隔离 + duplicate 竞态重试
│   ├── prefix.js       # ★ 路由前缀按包名推导（防 HMR 泄漏路由冲突）
│   ├── security.js     # 回环围栏 + 一次性 nonce
│   ├── http.js / paths.js / semver-lite.js
│   ├── client.js       # 浏览器半：__ModuleLoader__ 工厂格式，TABS 注册表
│   └── modules/{updater,usage,diagnose,service,about}.js
├── scripts/
│   ├── upgrade.mjs     # 升级执行器（分离进程状态机）
│   ├── deploy.mjs      # ★ 热部署（name 轮换 + 转发壳 + 精确探针）
│   ├── smoke.mjs       # 16 项冒烟
│   └── runner-test.mjs # 3 场景隔离集成测试
├── README.md / SECURITY.md / LICENSE / .gitignore
```

### 4.2 升级状态机

```
stopping → backing-up → installing → restarting → verifying → done
    └────────┴────────────┴────────────┴──────────→ rolling-back → rolled-back / failed
```

- 停服：`taskkill /F /T`（实测 Windows 控制台服务不响应无 /F 的优雅信号）→ 确认端口释放
- 安装：`execFile(node, [npm-cli.js, ...])` **不经 shell**，10 分钟超时，输出进 runner 日志
- 回滚：恢复备份清单 → `npm ci` 重建 → 重启验证；失败则写手动恢复命令
- 状态/历史原子落盘（tmp+rename），30 分钟陈旧锁防执行器崩溃后永久阻塞

### 4.3 安全围栏（六层）

socket 回环（XFF 永不信）→ Host 回环 → `sec-fetch-site` 拒跨站 → Origin 同源 → POST 强制 JSON → 破坏性操作一次性 nonce。

---

## 5. 测试与验证结果（全绿）

| 套件 | 结果 |
| --- | --- |
| 冒烟 `smoke.mjs` | **16/16 通过**（semver rc 序、围栏 7 例、nonce 一次性/伪造、注册表、台账防御） |
| 路由验证（真实服务） | **7/7**（status/check/usage/diagnose/service-state/about + npm 真实检查三通道） |
| 安全负例 | **3/3**（伪造 nonce 403、非 JSON 415、跨站 403） |
| 执行器集成测试 `runner-test.mjs` | **7/7 断言**（A: restart 全链路 done；B: 404→回滚→清单逐字节恢复→错误手册；C: 注入参数拒绝） |
| UI 验收 `ui-verify.cjs` | **ALL PASS**（5 页签 DOM 断言 + 截图；红点、三通道胶囊、真实用量数据、环境信息、buildId 全部正确） |
| 安全扫描 | 仓库与工作区**零密钥命中**；无 state.txt/credentials/台账混入 |

**实测关键数据**：当前 0.1.5-rc.1 → 可升级至 0.1.5-rc.3（latest）/0.1.7-rc.1（next）/0.1.7-alpha.2（alpha）；registry 延迟 654ms；今日 136 次调用、输入 355K/输出 224K/缓存读 20.7M tokens；DeepSeek 余额 13.08 CNY。

---

## 6. 实战踩坑记录（本项目最有价值的部分）

开发在**不停服、不打断会话**的约束下进行，热部署链路上踩了五个连环坑，每个都以机制级修复收场：

1. **ESM 缓存吞掉修复**：patch 热重组只换配置不重新 import，同名包永远命中旧模块。→ 部署脚本按 cordis loader 源码行为做 **name 轮换**（`-devN` 目录），强制全新 import。
2. **假阳性探针**：`/status.current` 新旧实例都返回值，无法证明接管。→ 探针改用 `/about.plugin.name`（按 package.json name 推导的精确 buildId）。
3. **目录清理造成死引用**：部署后删历史目录 → boot graph（增量只增不减）里的旧 bundle 变死链 → v0.0.0/inactive context 乱象。→ **历史目录重建为转发壳**：id/NS 保留历史名匹配启动图装载，API 前缀转发到最新活实例——浏览器装配任何 factory 都打活代码。
4. **路由泄漏**：`ctx.on('dispose')` 时序不保证纤维销毁时注销路由 → duplicate 吞错 + 陈旧 handler 引用 inactive 上下文。→ 改用官方 `ctx.effect` 模式 + 注册表对 duplicate 竞态做 500ms×10 延迟重试 + handler 全部改为注册时捕获 `webServer` 引用。
5. **Windows 停服假优雅**：无 `/F` 的 taskkill 对控制台服务无效，白等 20 秒。→ 直接 `/F /T` + 端口清场兜底。

另有两处低级但致命的 bug 被集成测试当场揪出：执行器参数键名混用（`args.serviceLog` vs `args['service-log']`，导致 `path undefined`）、测试 target 版本号含连字符过不了自己的白名单。

---

## 7. 安全自查结论（开源发布前）

- ✅ 仓库零硬编码密钥/令牌；`.gitignore` 白名单式（node_modules/本地数据/令牌/凭据全部排除）
- ✅ 全部 API 回环围栏 + 破坏性操作 nonce；无 shell 拼接；代理密码不透出
- ✅ SECURITY.md 就绪：威胁模型、防护清单、已知限制、漏洞报告渠道
- ✅ 非官方声明在关于页与 README 双处呈现
- ⚠️ 发布前建议再跑一次 [gitleaks](https://github.com/gitleaks/gitleaks)（本环境以等价模式扫描代替）与 `npm audit`
- ⚠️ 升级功能会中断进行中会话（UI 有明确警告与二次确认，执行器测试证明回滚可靠）

## 8. 已知限制与后续建议

**限制**：① 服务工具的"打开目录"仅 Windows（501 降级）；② 升级仅支持启动器 local 运行时模式；③ 热部署产生的 `-devN` 历史壳目录在宿主进程重启后即可安全删除（graph 收敛）；④ 本环境供应链策略（minimumReleaseAge）拦截 pnpm add，当前以手动部署生效，不影响功能。

**建议**：① 宿主重启一次以收敛 graph（工具箱「服务工具→重启服务」即可完成，一键重启本身也是功能验收）；② GitHub 仓库按 SECURITY.md 流程发布；③ 后续新功能按 `registry.js` / `TABS` 注册表两步接入。

---

## 附：交付物

| 交付物 | 位置 |
| --- | --- |
| 插件源码（开源仓库） | `<workspace>\dsh-harness-toolbox\` |
| 在线实例 | 已挂载于设置面板 →「Harness 工具箱」（buildId `-dev10`，v0.1.2 源码；运行实例随下次重启刷新） |
| 方案审核截图 | `shot\plan-mockup.png`（红框标注） |
| 五页签验收截图 | `shot\ui\1-更新中心 … 5-关于.png` |
| 使用方法创意信息图 | `usage-guide.png` |
| 本报告 | `REPORT.md` |
