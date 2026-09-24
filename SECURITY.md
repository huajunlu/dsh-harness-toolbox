# Security Policy — dsh-harness-toolbox

本文件说明工具箱的安全边界、威胁模型与漏洞报告渠道（对抗式审查 F1/F4 的固化）。

## 威胁模型

工具箱的宿主半区运行在 DeepSeek Harness 服务进程内，暴露一组 HTTP API。
**信任边界 = 回环围栏**：我们假设本机进程可信，网络对端不可信，浏览器内的跨站内容不可信。

## 防护清单

| 面 | 防护 |
| --- | --- |
| 网络暴露 | 全部路由要求 socket 远端为回环（127/8、`::1`、`::ffff:127/8`）；`X-Forwarded-For` 永不信任；Host 头必须回环主机名；`sec-fetch-site: cross-site` 拒绝；带 Origin 时必须与 Host 同源 |
| CSRF | 破坏性 POST 额外要求 `Content-Type: application/json`（跨站 HTML 表单无法发送）+ 进程内**一次性 nonce**（10 分钟过期，用后即废） |
| 命令注入 | 升级执行器不经 shell：`execFile(process.execPath, [npm-cli.js, ...args])`；目标版本号过 `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$` 白名单；包名固定为 `@deepseek-ai/dsh`；通道名过 `latest/next/alpha` 枚举 |
| 供应链 | 升级前备份 `package.json` + `package-lock.json`；安装失败自动恢复清单并 `npm ci` 回滚；回滚失败写 `last-upgrade-error.txt` 提供手动恢复命令；版本检查走用户本机 `npm config`（尊重其镜像配置） |
| 秘密泄露 | 不读取 `.credentials.yaml`、不读取任何令牌；代理环境变量只回传存在性与变量名，**不回传值**；诊断复制文本不含密钥；本仓库禁止提交 `.dsh` 数据目录、启动器 `state.txt`（含界面令牌） |
| 第三方数据 | `$DSH_HOME/dsh-usage/*.json` 严格校验顶层 `version` 字段，schema 不符时安全忽略（`available:false`），不抛错、不半渲染 |
| 客户端健壮性 | 每个页签包在独立错误边界里；单模块注册失败被 registry 隔离 |

## 已知限制（v0.1）

- 服务工具的“打开目录”仅支持 Windows（其他平台返回 501）；
- 升级/重启仅支持启动器 `local` 运行时模式；
- 回环围栏意味着**同机任意进程可调用 API**——这与宿主自身其余回环 API 的信任模型一致；如果你的机器上有不可信的本地进程，请勿安装本插件；
- 升级会中断进行中的会话与任务（UI 有明确警告与二次确认）。

## 报告漏洞

请通过 GitHub 私密报告渠道（Security tab → Report a vulnerability），或开 issue 标注 `[security]`。请勿在公开 issue 中贴出可利用细节。

## 安全发布承诺

- 发布前运行 `node scripts/smoke.mjs`（围栏/nonce/semver 用例必须全绿）；
- 仓库内容白名单式管理：`.gitignore` 排除一切本地数据与令牌文件；
- 建议消费方在安装前核对 npm 包的 `dist.integrity` 与 GitHub 源码 tag 一致。
