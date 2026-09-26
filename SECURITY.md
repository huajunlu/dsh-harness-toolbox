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
| 秘密泄露 | **不读取 `.credentials.yaml`、不读取任何凭据文件、不读取环境变量**；余额查询所需的密钥仅通过官方 seam `ctx.credentials.resolve(...)` 解析（见下节）；代理环境变量只回传存在性与变量名，**不回传值**；诊断复制文本不含密钥；本仓库禁止提交 `.dsh` 数据目录、启动器 `state.txt`（含界面令牌） |
| 第三方数据 | `$DSH_HOME/dsh-usage/*.json` 严格校验顶层 `version` 字段，schema 不符时安全忽略（`available:false`），不抛错、不半渲染；用量改为聚合 DSH 自身会话日志后，该文件仅作兜底 |
| 客户端健壮性 | 每个页签包在独立错误边界里；单模块注册失败被 registry 隔离 |

## 余额查询中的密钥使用（v0.1.5 起，明确备案）

「API 用量」页在 DSH **未登录平台账号**时会回退到 API Key 直连官方余额接口。该路径的安全边界：

1. **只走官方 seam**：`ctx.credentials.resolve('DEEPSEEK_API_KEY')`——不读取 `.credentials.yaml`、不读环境变量、不遍历文件系统；
2. **只发一次固定请求**：`GET https://api.deepseek.com/user/balance`（URL 硬编码，不接受任何外部输入），超时 10s；
3. **密钥不外泄**：不写入日志、不进入任何 HTTP 响应、不落盘、不缓存明文（缓存只存映射后的余额数字）；失败时只回报 HTTP 状态码，**不回传响应正文**（正文可能回显凭据线索）；
4. **可关闭**：把凭据库中的 `DEEPSEEK_API_KEY` 移除即可让该路径失效（余额卡片退回"未登录"提示），无需改动插件；
5. **优先级**：平台账户服务（`deepseekAccount`）优先；只有它不可用/未登录时才会用到密钥路径。

测试覆盖：模块测试断言"响应 JSON 中绝不含密钥"、"只请求固定 URL"、"鉴权失败时不回退旧快照"。

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
