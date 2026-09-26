/**
 * dsh-harness-toolbox 客户端半区 —— 设置面板「Harness 工具箱」分区。
 *
 * 打包形态：无构建步骤，直接以 __ModuleLoader__ 工厂格式分发；react 与
 * jsx-runtime 由宿主模块表提供（与官方各 client 包同一契约）。
 *
 * 结构（可扩展性核心）：底部 TABS 数组即页签注册表 —— 新增功能 =
 * 写一个 Tab 组件 + 数组加一行，Section 与导航无需改动。
 *
 * 安全：只发同源 fetch；破坏性操作的 nonce 由宿主 status/state 响应携带，
 * 客户端不缓存、不伪造；升级/重启期间连接必然中断，UI 将中断建模为
 * 正常状态（连接丢失 → 重试 → 恢复后展示终态），而非错误。
 *
 * 视觉：全部走 --dsw-alias-* 设计令牌，深浅色自适应；字阶 18/15/13/12，
 * 卡片 16px 圆角、按钮 8px 圆角，与官方「插件」页页签同构。
 */
window.__ModuleLoader__.load({
	id: "dsh-harness-toolbox",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const h = react.createElement;
		const NS = "dsh-harness-toolbox";
		// API 前缀与宿主 lib/prefix.js 同构（按包名推导）；deploy.mjs 对本文件
		// 做包名全文替换，dev 部署时 id/NS/前缀三处同步落到 -devN。
		const API = "/api/dsh-harness-toolbox";

		/* ────────────────────── 文案（zh 主源，en 全量镜像） ────────────────────── */

		const zh = {
			"nav": "Harness 工具箱",
			"title": "DeepSeek Harness 工具箱",
			"byline": "by LHJ · v0.1.4",
			"tab.updater": "更新中心",
			"tab.usage": "API 用量",
			"tab.diagnose": "环境体检",
			"tab.service": "服务工具",
			"tab.about": "关于",
			"common.loading": "加载中…",
			"common.error": "加载失败",
			"common.retry": "重试",
			"common.working": "处理中…",
			"common.copy": "一键复制诊断信息",
			"common.copied": "已复制到剪贴板",
			"common.refresh": "刷新",
			"updater.current": "当前版本",
			"updater.target": "目标版本",
			"updater.badge.new": "发现新版本",
			"updater.badge.uptodate": "已是最新",
			"updater.check": "检查更新",
			"updater.upgrade": "立即升级",
			"updater.confirm": "确认升级",
			"updater.cancel": "取消",
			"updater.confirmHint": "将停止服务并安装新版本，所有进行中的会话与任务会中断；升级前自动备份，失败自动回滚。",
			"updater.channel": "更新通道",
			"updater.checked": "检查于",
			"updater.never": "尚未检查",
			"updater.stale": "正在检查…",
			"updater.history": "升级历史",
			"updater.history.empty": "暂无升级记录",
			"updater.history.ok": "成功",
			"updater.history.fail": "失败",
			"updater.noUpdate": "当前通道没有更新，享受此刻的稳定。",
			"updater.needCheck": "尚未获取远端版本信息，点击「检查更新」。",
			"updater.unsupported": "当前安装形态不支持一键升级（仅支持启动器本地运行时）。",
			"updater.nonce": "会话凭据失效，已刷新状态，请重试。",
			"updater.lost": "服务正在重启，等待恢复…",
			"updater.done": "升级完成，页面即将自动刷新。",
			"updater.deadService": "服务长时间未恢复。请关闭本页，重新双击桌面上的 DeepSeek Harness 启动器快捷方式。",
			"updater.secureNote": "升级在服务端执行：停服 → 校验安装 → 自动重启 → 失败自动回滚。",
			"phase.stopping": "停止服务",
			"phase.backing-up": "备份清单",
			"phase.installing": "安装新版本",
			"phase.restarting": "重启服务",
			"phase.verifying": "健康检查",
			"phase.rolling-back": "失败回滚",
			"phase.done": "完成",
			"phase.rolled-back": "已回滚到旧版本",
			"phase.failed": "失败",
			"usage.today": "今日用量",
			"usage.input": "输入",
			"usage.output": "输出",
			"usage.cacheRead": "缓存读",
			"usage.cacheWrite": "缓存写",
			"usage.reasoning": "推理",
			"usage.source": "数据源",
			"usage.logsUnit": "个会话日志",
			"usage.meterUnit": "次计量",
			"usage.tornFrames": "个半截帧已跳过",
			"usage.stale": "已过期",
			"usage.staleBalance": "余额来自外部插件快照，该插件已不在本 profile 中运行，数据仅供参考",
			"usage.providerTable": "供应商与余额（近 30 天）",
			"usage.balanceScope": "钱包余额是供应商能力，仅部分供应商提供查询接口",
			"usage.balanceLive": "实时",
			"usage.balanceUnsupported": "无余额接口",
			"usage.signedOut": "未登录 DeepSeek 平台账号，无法查询钱包余额；登录后点刷新即可看到实时余额。",
			"usage.balanceFailed": "余额查询失败（平台未返回数据），可稍后点刷新重试。",
			"usage.balanceUnavailable": "无法查询余额：DSH 账户服务未挂载，且外部快照已过期。",
			"usage.topUp": "前往充值 ↗",
			"usage.usageDetail": "用量明细 ↗",
			"usage.no-usage-source": "未找到任何用量数据源：会话日志与外部台账都不可读。",
			"usage.calls": "调用次数",
			"usage.trend": "近 30 天 tokens",
			"usage.models": "分模型（近 30 天）",
			"usage.balances": "账户余额",
			"usage.spend": "累计消费估算",
			"usage.unavailable": "用量数据不可用",
			"usage.no-ledger": "未发现用量台账：请先安装并启用 @linxin666/dsh-usage 插件。",
			"usage.schema-mismatch": "台账格式与本插件不兼容，已安全忽略。",
			"usage.internal": "读取失败",
			"diagnose.copyHint": "复制内容不包含任何密钥或令牌。",
			"diagnose.node": "Node 版本",
			"diagnose.platform": "系统 / 架构",
			"diagnose.os": "系统版本",
			"diagnose.installMode": "安装模式",
			"diagnose.runtimeDir": "运行时目录",
			"diagnose.dshHome": "配置目录",
			"diagnose.port": "服务端口",
			"diagnose.registry": "npm registry",
			"diagnose.latency": "连通延迟",
			"diagnose.proxy": "代理环境变量",
			"diagnose.proxyNone": "未设置",
			"diagnose.memory": "内存（进程 / 系统空闲）",
			"service.open.log": "打开服务日志",
			"service.open.runtime": "打开运行时目录",
			"service.open.home": "打开配置目录",
			"service.restart": "重启服务",
			"service.confirmRestart": "确认重启",
			"service.restartHint": "重启会中断所有进行中的会话与任务，页面将短暂断开后自动恢复。",
			"service.unsupported": "当前安装形态不支持一键重启。",
			"about.author": "作者",
			"about.license": "许可证",
			"about.repo": "源码仓库",
			"about.security": "安全政策",
			"about.modules": "已加载模块",
			"about.unofficial": "非官方社区插件",
			"about.host": "宿主进程 PID",
		};

		const en = {
			"nav": "Harness Toolbox",
			"title": "DeepSeek Harness Toolbox",
			"byline": "by LHJ · v0.1.4",
			"tab.updater": "Updates",
			"tab.usage": "API Usage",
			"tab.diagnose": "Diagnostics",
			"tab.service": "Service",
			"tab.about": "About",
			"common.loading": "Loading…",
			"common.error": "Failed to load",
			"common.retry": "Retry",
			"common.working": "Working…",
			"common.copy": "Copy diagnostics",
			"common.copied": "Copied to clipboard",
			"common.refresh": "Refresh",
			"updater.current": "Current",
			"updater.target": "Target",
			"updater.badge.new": "Update available",
			"updater.badge.uptodate": "Up to date",
			"updater.check": "Check for updates",
			"updater.upgrade": "Upgrade now",
			"updater.confirm": "Confirm upgrade",
			"updater.cancel": "Cancel",
			"updater.confirmHint": "The service stops and the new version installs; running sessions and jobs are interrupted. Manifests are backed up first and a failed upgrade rolls back automatically.",
			"updater.channel": "Channel",
			"updater.checked": "Checked",
			"updater.never": "Not checked yet",
			"updater.stale": "Checking…",
			"updater.history": "Upgrade history",
			"updater.history.empty": "No upgrades yet",
			"updater.history.ok": "OK",
			"updater.history.fail": "Failed",
			"updater.noUpdate": "This channel has no update. Enjoy the stability.",
			"updater.needCheck": "Remote versions not fetched yet — hit “Check for updates”.",
			"updater.unsupported": "One-click upgrade requires the launcher-managed local runtime.",
			"updater.nonce": "Session credential expired; status refreshed — please retry.",
			"updater.lost": "Service is restarting, waiting for recovery…",
			"updater.done": "Upgrade complete; the page will refresh shortly.",
			"updater.deadService": "The service has not recovered. Close this page and double-click the DeepSeek Harness launcher shortcut again.",
			"updater.secureNote": "Upgrades run server-side: stop → verify install → restart → auto-rollback on failure.",
			"phase.stopping": "Stopping service",
			"phase.backing-up": "Backing up manifests",
			"phase.installing": "Installing new version",
			"phase.restarting": "Restarting service",
			"phase.verifying": "Health check",
			"phase.rolling-back": "Rolling back",
			"phase.done": "Done",
			"phase.rolled-back": "Rolled back",
			"phase.failed": "Failed",
			"usage.today": "Today",
			"usage.input": "Input",
			"usage.output": "Output",
			"usage.cacheRead": "Cache read",
			"usage.cacheWrite": "Cache write",
			"usage.reasoning": "Reasoning",
			"usage.source": "Source",
			"usage.logsUnit": "session logs",
			"usage.meterUnit": "metered calls",
			"usage.tornFrames": "torn frames skipped",
			"usage.stale": "stale",
			"usage.staleBalance": "Balances come from an external plugin snapshot whose plugin no longer runs in this profile; treat them as historical",
			"usage.providerTable": "Providers & balances (30 days)",
			"usage.balanceScope": "Wallet balance is a provider capability; only some providers expose it",
			"usage.balanceLive": "live",
			"usage.balanceUnsupported": "no balance API",
			"usage.signedOut": "Not signed in to the DeepSeek platform account, so the wallet balance is unavailable; sign in and refresh.",
			"usage.balanceFailed": "Balance query failed (the platform returned no data); refresh to retry.",
			"usage.balanceUnavailable": "Balance unavailable: the DSH account service is not mounted and the external snapshot is stale.",
			"usage.topUp": "Top up ↗",
			"usage.usageDetail": "Usage details ↗",
			"usage.no-usage-source": "No usage source found: neither session logs nor an external ledger is readable.",
			"usage.calls": "Calls",
			"usage.trend": "Tokens, last 30 days",
			"usage.models": "By model (30 days)",
			"usage.balances": "Balances",
			"usage.spend": "Estimated spend",
			"usage.unavailable": "Usage data unavailable",
			"usage.no-ledger": "No ledger found: install and enable @linxin666/dsh-usage first.",
			"usage.schema-mismatch": "Ledger schema mismatch; safely ignored.",
			"usage.internal": "Read failed",
			"diagnose.copyHint": "The copied text contains no keys or tokens.",
			"diagnose.node": "Node",
			"diagnose.platform": "Platform / arch",
			"diagnose.os": "OS release",
			"diagnose.installMode": "Install mode",
			"diagnose.runtimeDir": "Runtime dir",
			"diagnose.dshHome": "Config dir",
			"diagnose.port": "Port",
			"diagnose.registry": "npm registry",
			"diagnose.latency": "Registry latency",
			"diagnose.proxy": "Proxy env vars",
			"diagnose.proxyNone": "None",
			"diagnose.memory": "Memory (RSS / free)",
			"service.open.log": "Open service log",
			"service.open.runtime": "Open runtime folder",
			"service.open.home": "Open config folder",
			"service.restart": "Restart service",
			"service.confirmRestart": "Confirm restart",
			"service.restartHint": "Restart interrupts all running sessions and jobs; the page reconnects automatically.",
			"service.unsupported": "One-click restart requires the local runtime.",
			"about.author": "Author",
			"about.license": "License",
			"about.repo": "Repository",
			"about.security": "Security policy",
			"about.modules": "Loaded modules",
			"about.unofficial": "Unofficial community plugin",
			"about.host": "Host PID",
		};

		/* ────────────────────── 样式（全部走官方设计令牌） ────────────────────── */

		const S = {
			section: { maxWidth: 760, display: "flex", flexDirection: "column", gap: 14, color: "var(--dsw-alias-label-primary)" },
			head: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
			heading: { fontSize: 18, fontWeight: 600, lineHeight: 1.4, margin: 0 },
			byline: { fontSize: 12, fontWeight: 400, color: "var(--dsw-alias-label-tertiary)" },
			tabBar: { display: "flex", gap: 22, borderBottom: ".5px solid var(--dsw-alias-border-l2)", alignItems: "flex-end", overflowX: "auto" },
			tab: (active) => ({
				font: "inherit", fontSize: 13, lineHeight: "20px", padding: "7px 1px 9px", position: "relative",
				cursor: "pointer", background: "none", border: "none", whiteSpace: "nowrap",
				color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
			}),
			tabUnderline: { position: "absolute", bottom: -1, left: 0, right: 0, height: 2, background: "var(--dsw-alias-label-primary)", borderRadius: "2px 2px 0 0" },
			dot: { position: "absolute", top: 5, right: -9, width: 6, height: 6, borderRadius: "50%", background: "#e5484d" },
			card: { border: ".5px solid var(--dsw-alias-border-l4)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 16, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 },
			cardTitle: { fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
			row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 13, lineHeight: 1.6, flexWrap: "wrap" },
			label: { color: "var(--dsw-alias-label-secondary)", fontWeight: 500 },
			value: { color: "var(--dsw-alias-label-primary)" },
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
			monoChip: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", background: "var(--dsw-alias-bg-layer-4)", padding: "2px 8px", borderRadius: 6, fontSize: 12 },
			hint: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.7 },
			badge: (tone) => ({
				fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, whiteSpace: "nowrap",
				background: tone === "good" ? "#e6f4ea" : tone === "bad" ? "#fdeceb" : "var(--dsw-alias-bg-layer-4)",
				color: tone === "good" ? "#1a7f37" : tone === "bad" ? "#c62a21" : "var(--dsw-alias-label-secondary)",
			}),
			btn: (primary, disabled) => ({
				font: "inherit", fontSize: 13, lineHeight: 1.5, borderRadius: 8, padding: "5px 14px", cursor: disabled ? "default" : "pointer",
				fontWeight: primary ? 500 : 400, opacity: disabled ? 0.5 : 1,
				background: primary ? "var(--dsw-alias-label-primary)" : "transparent",
				color: primary ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-label-primary)",
				border: primary ? "1px solid transparent" : "1px solid var(--dsw-alias-border-l2)",
			}),
			btnDanger: (disabled) => ({
				font: "inherit", fontSize: 13, lineHeight: 1.5, borderRadius: 8, padding: "5px 14px", cursor: disabled ? "default" : "pointer",
				fontWeight: 500, opacity: disabled ? 0.5 : 1,
				background: "var(--dsw-alias-label-error, #c62a21)", color: "#fff", border: "1px solid transparent",
			}),
			btnRow: { display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" },
		 pills: { display: "flex", gap: 6, flexWrap: "wrap" },
			pill: (active) => ({
				font: "inherit", fontSize: 12, padding: "3px 10px", borderRadius: 99, cursor: "pointer",
				background: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-bg-layer-4)",
				color: active ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-label-secondary)",
				border: "1px solid " + (active ? "transparent" : "var(--dsw-alias-border-l2)"),
			}),
			steps: { display: "flex", flexDirection: "column", gap: 6 },
			step: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 },
			stepDot: (state) => ({
				width: 8, height: 8, borderRadius: "50%", flex: "none",
				background: state === "done" ? "#1a7f37" : state === "active" ? "var(--dsw-alias-brand-primary)" : state === "bad" ? "#c62a21" : "var(--dsw-alias-border-l3)",
			}),
			trend: { display: "flex", alignItems: "flex-end", gap: 2, height: 72 },
			trendBar: { flex: 1, borderRadius: "2px 2px 0 0", background: "var(--dsw-alias-brand-primary)", minHeight: 1 },
			table: { fontSize: 13, display: "flex", flexDirection: "column", gap: 4 },
			tableRow: { display: "grid", gridTemplateColumns: "1fr 90px 60px", gap: 8, alignItems: "center" },
			ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
			chips: { display: "flex", gap: 8, flexWrap: "wrap" },
			chip: { fontSize: 12, padding: "4px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-4)", color: "var(--dsw-alias-label-primary)" },
			keyval: { fontSize: 13, display: "grid", gridTemplateColumns: "140px 1fr", gap: "6px 12px" },
			empty: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)", padding: "8px 0" },
			link: { color: "var(--dsw-alias-brand-primary)", textDecoration: "none" },
			notice: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.7, borderLeft: "2px solid var(--dsw-alias-border-l3)", paddingLeft: 10 },
			// 错误/失败提示必须醒目（实战教训：灰色小字的失败提示用户当「没反应」）。
			err: { fontSize: 12, color: "#e5484d", lineHeight: 1.7, borderLeft: "2px solid #e5484d", paddingLeft: 10, background: "rgba(229,72,77,.07)", borderRadius: "0 8px 8px 0", padding: "6px 10px" },
		};

		/* ────────────────────── 工具 ────────────────────── */

		async function api(path, options) {
			const response = await fetch(API + path, {
				...options,
				signal: AbortSignal.timeout(20_000),
				headers: options && options.body ? { "content-type": "application/json" } : undefined,
			});
			let body = null;
			try { body = await response.json(); } catch { /* 非 JSON 应答 */ }
			if (!response.ok && body && body.error) {
				const error = new Error(body.error);
				error.body = body;
				throw error;
			}
			if (!response.ok) throw new Error("HTTP " + response.status);
			return body;
		}

		const formatTokens = (n) => {
			const value = Number(n) || 0;
			if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
			if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
			if (value >= 1e3) return (value / 1e3).toFixed(1) + "K";
			return String(value);
		};

		const formatTime = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toLocaleString() : "—");

		/* ────────────────────── 错误边界（模块级隔离，F12） ────────────────────── */

		class Boundary extends react.Component {
			constructor(props) { super(props); this.state = { error: null }; }
			static getDerivedStateFromError(error) { return { error }; }
			render() {
				if (this.state.error) {
					return h("div", { style: S.card },
						h("div", { style: S.cardTitle }, "⚠️ " + (this.props.t("common.error"))),
						h("div", { style: S.hint }, String(this.state.error && this.state.error.message || this.state.error)),
						h("div", { style: S.btnRow },
							h("button", { style: S.btn(false, false), onClick: () => this.setState({ error: null }) }, this.props.t("common.retry"))
						)
					);
				}
				return this.props.children;
			}
		}

		/* ────────────────────── 页签 1：更新中心 ────────────────────── */

		const PHASES = ["stopping", "backing-up", "installing", "restarting", "verifying"];

		function UpdaterTab({ t }) {
			const [status, setStatus] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [confirming, setConfirming] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [progress, setProgress] = react.useState(null);
			const [connLost, setConnLost] = react.useState(false);
			const timerRef = react.useRef(null);
			// 断连时间戳与60s 出口提示位（ref 免闭包陈旧）。
			const connLostAtRef = react.useRef(null);
			const connLostLongRef = react.useRef(false);

			const load = react.useCallback(async () => {
				try {
					const body = await api("/status");
					setStatus(body);
					setError(null);
					return body;
				} catch (err) {
					setError(err.message);
					return null;
				}
			}, []);

			// 进度轮询：连接中断是升级的预期副作用，建模为等待而非报错；
			// 断连超 60s 仍未恢复 → 给出人工出口（防止「永远等待 = 没反应」）。
			const poll = react.useCallback(async () => {
				try {
					const body = await api("/state");
					setConnLost(false);
					connLostAtRef.current = null;
					connLostLongRef.current = false;
					setProgress(body);
					const phase = body.state && body.state.phase;
					if (phase === "done" || phase === "rolled-back" || phase === "failed") {
						clearInterval(timerRef.current);
						timerRef.current = null;
						const reason = body.state.reason ? "：" + body.state.reason : "";
						if (phase === "done") {
							setNotice(t("updater.done"));
							// 刷新前探测首页：若重启后令牌已轮换（401），不硬刷
							// 出裸错误页，改给人工出口（经启动器重开）。
							setTimeout(async () => {
								try {
									const probe = await fetch("/", { method: "GET", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(5000) });
									if (probe.status === 401) {
										setNotice("✕ " + t("updater.deadService"));
										return;
									}
								} catch { /* 网络抖动也直接尝试刷新 */ }
								window.location.reload();
							}, 2500);
						} else if (phase === "rolled-back") {
							setNotice("⚠️ " + t("phase.rolled-back") + reason);
						} else {
							setNotice("✕ " + t("phase.failed") + reason);
						}
					}
				} catch {
					if (connLostAtRef.current === null) {
						connLostAtRef.current = Date.now();
						setConnLost(true);
					} else if (!connLostLongRef.current && Date.now() - connLostAtRef.current > 60000) {
						connLostLongRef.current = true;
						setConnLost("long");
					}
				}
			}, [t]);

			react.useEffect(() => {
				load().then((body) => { if (body && body.stale) doCheck(false); });
				return () => clearInterval(timerRef.current);
			}, []);

			async function doCheck(showBusy = true) {
				if (showBusy) setBusy(true);
				try {
					const body = await api("/check", { method: "POST", body: "{}" });
					// 502 时 body.ok=false 但携带 status 字段，仍尽量展示。
					if (body && body.distTags) { setStatus(body); setError(body.ok === false ? body.error : null); }
					else await load();
				} catch (err) {
					setError(err.message);
				} finally {
					if (showBusy) setBusy(false);
				}
			}

			async function setChannel(channel) {
				try {
					const body = await api("/channel", { method: "POST", body: JSON.stringify({ channel }) });
					setStatus(body);
				} catch (err) { setError(err.message); }
			}

			async function startUpgrade() {
				setBusy(true);
				setConfirming(false);
				try {
					const body = await api("/upgrade", { method: "POST", body: JSON.stringify({ nonce: status && status.nonce }) });
					setProgress({ state: body.state, history: [] });
					setNotice(null);
					clearInterval(timerRef.current);
					timerRef.current = setInterval(poll, 1500);
					poll();
				} catch (err) {
					const msg = (err && err.body && err.body.error) ? err.body.error
						: (err && err.message ? err.message : String(err));
					if (/进行中|in progress/i.test(msg)) {
						// 服务端已有升级在途（重复点击或恢复现场）→ 接管进度视图，
						// 而不是只吐一行小字让用户以为「没反应」。
						setNotice(null);
						clearInterval(timerRef.current);
						timerRef.current = setInterval(poll, 1500);
						poll();
					} else {
						setNotice("⚠️ " + msg);
						if (/nonce/.test(msg)) await load();
					}
				} finally {
					setBusy(false);
				}
			}

			const running = progress && progress.state && ["stopping", "backing-up", "installing", "restarting", "verifying", "rolling-back"].includes(progress.state.phase);
			const currentPhase = running || (progress && progress.state) ? progress.state.phase : null;

			if (!status && error) {
				return h("div", { style: S.card },
					h("div", { style: S.hint }, t("common.error") + "：" + error),
					h("div", { style: S.btnRow }, h("button", { style: S.btn(false, false), onClick: load }, t("common.retry")))
				);
			}
			if (!status) return h("div", { style: S.empty }, t("common.loading"));

			return h("div", { style: S.section },
				// 版本卡
				h("div", { style: S.card },
					h("div", { style: S.row },
						h("span", { style: S.cardTitle }, t("tab.updater")),
						status.updateAvailable
							? h("span", { style: S.badge("good") }, t("updater.badge.new"))
							: h("span", { style: S.badge() }, t("updater.badge.uptodate"))
					),
					h("div", { style: S.row },
						h("span", { style: S.label }, t("updater.current")),
						h("span", { style: S.monoChip }, status.current || "—"),
						h("span", { style: S.label }, t("updater.target")),
						h("span", { style: S.monoChip }, status.target || "—")
					),
					h("div", { style: S.row },
						h("span", { style: S.label }, t("updater.channel")),
						h("span", { style: S.pills },
							["latest", "next", "alpha"].map((channel) =>
								h("button", {
									key: channel,
									style: S.pill(status.channel === channel),
									disabled: running || busy,
									onClick: () => setChannel(channel),
								}, channel + (status.distTags && status.distTags[channel] ? " · " + status.distTags[channel] : ""))
							)
						)
					),
					h("div", { style: S.hint },
						t("updater.checked") + "：" + (status.checkedAt ? formatTime(status.checkedAt) : t("updater.never")) +
						(status.updateAvailable ? "" : " · " + (status.stale ? t("updater.stale") : t("updater.noUpdate")))
					),
					!status.upgradeSupported ? h("div", { style: S.notice }, t("updater.unsupported")) : null,
					h("div", { style: S.btnRow },
						h("button", { style: S.btn(false, busy || running), disabled: busy || running, onClick: () => doCheck() }, busy ? t("common.working") : t("updater.check")),
						status.upgradeSupported && status.updateAvailable
							? (confirming
								? h(react.Fragment, null,
									h("button", { style: S.btn(false, false), onClick: () => setConfirming(false) }, t("updater.cancel")),
									h("button", { style: S.btn(true, busy), disabled: busy, onClick: startUpgrade }, busy ? t("common.working") : t("updater.confirm"))
								)
								: h("button", { style: S.btn(true, busy), disabled: busy, onClick: () => setConfirming(true) }, busy ? t("common.working") : t("updater.upgrade"))
							)
							: null
					),
					confirming ? h("div", { style: S.notice }, t("updater.confirmHint")) : null,
					notice ? h("div", { style: /^[⚠✕]/.test(notice) ? S.err : S.notice }, notice) : null
				),
				// 进度卡
				running || connLost
					? h("div", { style: S.card },
						h("div", { style: S.cardTitle }, connLost ? t("updater.lost") : t("phase." + (currentPhase || "stopping"))),
						connLost
							? h("div", { style: connLost === "long" ? S.err : S.hint },
								connLost === "long" ? t("updater.deadService") : "…")
							: h("div", { style: S.steps },
								PHASES.map((phase, index) => {
									const currentIndex = PHASES.indexOf(currentPhase);
									const state = currentPhase === "rolling-back" ? (index === 0 ? "bad" : "idle")
										: PHASES.indexOf(phase) < currentIndex ? "done"
										: phase === currentPhase ? "active" : "idle";
									return h("div", { key: phase, style: S.step },
										h("span", { style: S.stepDot(state) }),
										h("span", { style: { color: state === "idle" ? "var(--dsw-alias-label-tertiary)" : "inherit" } }, t("phase." + phase))
									);
								})
							),
						h("div", { style: S.hint }, t("updater.secureNote"))
					)
					: null,
				// 历史
				status.history && status.history.length > 0
					? h("div", { style: S.card },
						h("div", { style: S.cardTitle }, t("updater.history")),
						status.history.slice(0, 5).map((entry, index) =>
							h("div", { key: index, style: S.row },
								h("span", { style: S.mono }, formatTime(entry.at)),
								h("span", { style: S.value }, entry.mode === "restart" ? "restart" : (entry.from || "?") + " → " + (entry.target || "?")),
								h("span", { style: S.badge(entry.ok ? "good" : "bad") }, entry.ok ? t("updater.history.ok") : t("updater.history.fail"))
							)
						)
					)
					: null
			);
		}

		/* ────────────────────── 页签 2：API 用量 ────────────────────── */

		function UsageTab({ t }) {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			const load = react.useCallback(async (fresh) => {
				if (fresh) setBusy(true);
				try {
					// fresh=1 让宿主端跳过量日志缓存强制重扫（刷新按钮的语义）。
					setData(await api("/usage" + (fresh ? "?fresh=1" : "")));
					setError(null);
				} catch (err) { setError(err.message); }
				finally { if (fresh) setBusy(false); }
			}, []);

			react.useEffect(() => { load(false); }, [load]);

			if (error) {
				return h("div", { style: S.card },
					h("div", { style: S.hint }, t("common.error") + "：" + error),
					h("div", { style: S.btnRow }, h("button", { style: S.btn(false, false), onClick: () => load(true) }, t("common.retry")))
				);
			}
			if (!data) return h("div", { style: S.empty }, t("common.loading"));

			if (!data.available) {
				return h("div", { style: S.card },
					h("div", { style: S.cardTitle }, t("usage.unavailable")),
					h("div", { style: S.hint }, data.hint || t("usage." + (data.reason || "internal"))),
					h("div", { style: S.btnRow }, h("button", { style: S.btn(false, busy), disabled: busy, onClick: () => load(true) }, busy ? t("common.working") : t("common.refresh")))
				);
			}

			const buckets = data.today && data.today.buckets ? data.today.buckets : {};
			const maxTrend = Math.max(1, ...(data.trend || []).map((row) => row.total));
			const totalTrend = (data.trend || []).reduce((sum, row) => sum + row.total, 0);
			const scan = data.scan || null;
			const staleBalance = (data.balances || []).find((b) => b.stale) || null;
			const liveBalance = data.balanceSource === "live";
			const links = data.accountLinks || null;
			const openLink = (href, label) => (href ? h("a", { href, target: "_blank", rel: "noreferrer", style: S.link }, label) : null);

			return h("div", { style: S.section },
				// 今日四桶
				h("div", { style: S.card },
					h("div", { style: S.row },
						h("span", { style: S.cardTitle }, t("usage.today") + " · " + (data.today ? data.today.day : "")),
						h("span", { style: S.badge() }, t("usage.calls") + " " + (data.today ? data.today.calls : 0))
					),
					h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 } },
						[["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cacheReadTokens"], ["cacheWrite", "cacheWriteTokens"], ["reasoning", "reasoningTokens"]]
							.map(([key, field]) =>
								h("div", { key, style: { display: "flex", flexDirection: "column", gap: 2 } },
									h("span", { style: S.hint }, t("usage." + key)),
									h("span", { style: { ...S.mono, fontSize: 16, fontWeight: 600 } }, formatTokens(buckets[field]))
								)
							)
					),
					// 数据源与扫描信息：让"实时"可见、可核对
					h("div", { style: S.hint },
						t("usage.source") + "：" + (data.sourceLabel || "—") +
						(scan ? " · " + scan.files + " " + t("usage.logsUnit") + " · " + scan.usageEvents + " " + t("usage.meterUnit") + " · " + scan.elapsedMs + "ms" : "") +
						(scan && scan.failedFrames > 0 ? " · " + scan.failedFrames + " " + t("usage.tornFrames") : "")
					),
					data.note ? h("div", { style: S.notice }, data.note) : null
				),
				// 30 天趋势
				h("div", { style: S.card },
					h("div", { style: S.row },
						h("span", { style: S.cardTitle }, t("usage.trend")),
						h("span", { style: S.hint }, "Σ " + formatTokens(totalTrend))
					),
					h("div", { style: S.trend },
						(data.trend || []).map((row) =>
							h("div", {
								key: row.day,
								style: { ...S.trendBar, height: Math.max(2, Math.round((row.total / maxTrend) * 100)) + "%" },
								title: row.day + "：" + formatTokens(row.total) + " tokens / " + row.calls + " calls",
							})
						)
					)
				),
				// 分模型
				data.models && data.models.length > 0
					? h("div", { style: S.card },
						h("div", { style: S.cardTitle }, t("usage.models")),
						h("div", { style: S.table },
							data.models.slice(0, 8).map((row, index) =>
								h("div", { key: index, style: S.tableRow },
									h("span", { style: S.ellipsis, title: row.provider + " / " + row.model }, row.provider + " / " + row.model),
									h("span", { style: { ...S.mono, textAlign: "right" } }, formatTokens(row.total)),
									h("span", { style: { ...S.hint, textAlign: "right" } }, row.calls + "×")
								)
							)
						)
					)
					: null,
				// 供应商与余额可得性（余额是供应商能力，不是所有供应商都有公开接口）
				data.providers && data.providers.length > 0
					? h("div", { style: S.card },
						h("div", { style: S.row },
							h("span", { style: S.cardTitle }, t("usage.providerTable")),
							h("span", { style: S.hint }, t("usage.balanceScope"))
						),
						h("div", { style: S.table },
							data.providers.map((row, index) =>
								h("div", { key: index, style: { ...S.tableRow, gridTemplateColumns: "1fr 90px 56px 84px" } },
									h("span", { style: S.ellipsis, title: row.models.join(", ") }, row.provider),
									h("span", { style: { ...S.mono, textAlign: "right" } }, formatTokens(row.total)),
									h("span", { style: { ...S.hint, textAlign: "right" } }, row.calls + "×"),
									row.balanceSupported
										? h("span", { style: S.badge("good") }, t("usage.balanceLive"))
										: h("span", { style: { ...S.hint, textAlign: "right" } }, t("usage.balanceUnsupported"))
								)
							)
						)
					)
					: null,
				// 账户余额与消费（实时优先；不可用时才显示过期快照并注明）
				(data.balances && data.balances.length > 0) || data.spend || data.balanceNote
					? h("div", { style: S.card },
						h("div", { style: S.row },
							h("span", { style: S.cardTitle }, t("usage.balances")),
							liveBalance
								? h("span", { style: S.badge("good") }, t("usage.balanceLive"))
								: staleBalance
									? h("span", { style: S.badge("bad") }, t("usage.stale"))
									: null
						),
						data.balances && data.balances.length > 0
							? h("div", { style: S.chips },
								data.balances.map((balance, index) =>
									h("span", { key: index, style: S.chip }, balance.displayName + "　" + balance.totalBalance + " " + balance.currency)
								)
							)
							: null,
						data.balanceNote === "signed-out"
							? h("div", { style: S.notice }, t("usage.signedOut"))
							: data.balanceNote === "failed"
								? h("div", { style: S.notice }, t("usage.balanceFailed"))
								: staleBalance
									? h("div", { style: S.notice },
										t("usage.staleBalance") + (staleBalance.updatedAt ? "（" + formatTime(staleBalance.updatedAt) + "）" : ""))
									: data.balanceNote === "service-absent"
										? h("div", { style: S.notice }, t("usage.balanceUnavailable"))
										: null,
						links && (links.topUpUrl || links.usageUrl)
							? h("div", { style: { ...S.hint, display: "flex", gap: 14 } },
								openLink(links.topUpUrl, t("usage.topUp")),
								openLink(links.usageUrl, t("usage.usageDetail"))
							)
							: null,
						data.spend
							? h("div", { style: S.row },
								h("span", { style: S.label }, t("usage.spend")),
								h("span", { style: { ...S.mono, fontWeight: 600 } }, "¥ " + Number(data.spend.accruedCny || 0).toFixed(2))
							)
							: null
					)
					: null,
				h("div", { style: S.btnRow },
					h("button", { style: S.btn(false, busy), disabled: busy, onClick: () => load(true) }, busy ? t("common.working") : t("common.refresh"))
				)
			);
		}

		/* ────────────────────── 页签 3：环境体检 ────────────────────── */

		function DiagnoseTab({ t }) {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [copied, setCopied] = react.useState(false);

			const load = react.useCallback(async () => {
				try { setData(await api("/diagnose")); setError(null); }
				catch (err) { setError(err.message); }
			}, []);

			react.useEffect(() => { load(); }, [load]);

			if (error) {
				return h("div", { style: S.card },
					h("div", { style: S.hint }, t("common.error") + "：" + error),
					h("div", { style: S.btnRow }, h("button", { style: S.btn(false, false), onClick: load }, t("common.retry")))
				);
			}
			if (!data) return h("div", { style: S.empty }, t("common.loading"));

			const rows = [
				["diagnose.node", data.node],
				["diagnose.platform", data.platform],
				["diagnose.os", data.osRelease],
				["diagnose.installMode", data.harness && data.harness.installMode],
				["diagnose.runtimeDir", data.harness && data.harness.runtimeDir],
				["diagnose.dshHome", data.paths && data.paths.dshHome],
				["diagnose.port", data.server && data.server.port],
				["diagnose.registry", data.registry],
				["diagnose.latency", data.probe ? (data.probe.ok ? data.probe.latencyMs + " ms" : "✕ " + (data.probe.error || "")) : "—"],
				["diagnose.proxy", data.proxy && data.proxy.hasProxy ? data.proxy.variables.filter((n) => n.toUpperCase() !== "NO_PROXY").join(", ") : t("diagnose.proxyNone")],
				["diagnose.memory", data.memory ? data.memory.rssMb + " / " + data.memory.systemFreeMb + " MB" : "—"],
			];

			async function copyAll() {
				const text = [
					"DeepSeek Harness Toolbox — diagnostics",
					"plugin: " + (data.pluginVersion || "0.1.0"),
					...rows.map(([key, value]) => t(key) + ": " + (value === undefined || value === null ? "—" : value)),
				].join("\n");
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch { /* 剪贴板被拒：静默 */ }
			}

			return h("div", { style: S.section },
				h("div", { style: S.card },
					h("div", { style: S.cardTitle }, t("tab.diagnose")),
					h("div", { style: S.keyval },
						...rows.map(([key, value]) => [
							h("span", { key: key + "-k", style: S.label }, t(key)),
							h("span", { key: key + "-v", style: { ...S.value, ...(key === "diagnose.runtimeDir" || key === "diagnose.dshHome" || key === "diagnose.registry" ? S.mono : {}) , wordBreak: "break-all" } },
								value === undefined || value === null || value === "" ? "—" : String(value))
						])
					)
				),
				h("div", { style: S.hint }, t("diagnose.copyHint")),
				h("div", { style: S.btnRow },
					h("button", { style: S.btn(true, false), onClick: copyAll }, copied ? t("common.copied") : t("common.copy")),
					h("button", { style: S.btn(false, false), onClick: load }, t("common.refresh"))
				)
			);
		}

		/* ────────────────────── 页签 4：服务工具 ────────────────────── */

		function ServiceTab({ t }) {
			const [state, setState] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [confirming, setConfirming] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [connLost, setConnLost] = react.useState(false);

			const load = react.useCallback(async () => {
				try { setState(await api("/service-state", { method: "POST", body: "{}" })); setError(null); }
				catch (err) { setError(err.message); }
			}, []);

			react.useEffect(() => { load(); }, [load]);

			// 重启后轮询恢复（服务回来即可；state 终态由更新中心展示）。
			react.useEffect(() => {
				if (!connLost) return undefined;
				const timer = setInterval(async () => {
					try {
						await api("/state");
						setConnLost(false);
						setNotice("✓ 服务已恢复");
					} catch { /* 继续等 */ }
				}, 2000);
				return () => clearInterval(timer);
			}, [connLost]);

			if (error) {
				return h("div", { style: S.card },
					h("div", { style: S.hint }, t("common.error") + "：" + error),
					h("div", { style: S.btnRow }, h("button", { style: S.btn(false, false), onClick: load }, t("common.retry")))
				);
			}
			if (!state) return h("div", { style: S.empty }, t("common.loading"));

			async function action(name) {
				setBusy(true);
				try {
					await api("/service", { method: "POST", body: JSON.stringify({ action: name }) });
					setNotice("✓ " + name);
				} catch (err) { setNotice("⚠️ " + err.message); }
				finally { setBusy(false); }
			}

			async function restart() {
				setBusy(true);
				setConfirming(false);
				try {
					await api("/service", { method: "POST", body: JSON.stringify({ action: "restart", nonce: state.nonce }) });
					setConnLost(true);
					setNotice(null);
				} catch (err) {
					setNotice("⚠️ " + err.message);
					load();
				} finally { setBusy(false); }
			}

			return h("div", { style: S.section },
				h("div", { style: S.card },
					h("div", { style: S.cardTitle }, t("tab.service")),
					h("div", { style: S.btnRow, justifyContent: "flex-start" },
						state.targets.log
							? h("button", { style: S.btn(false, busy), disabled: busy, onClick: () => action("open-log") }, t("service.open.log"))
							: null,
						state.targets.runtime
							? h("button", { style: S.btn(false, busy), disabled: busy, onClick: () => action("open-runtime") }, t("service.open.runtime"))
							: null,
						state.targets.home
							? h("button", { style: S.btn(false, busy), disabled: busy, onClick: () => action("open-home") }, t("service.open.home"))
							: null
					),
					h("div", { style: { borderTop: ".5px solid var(--dsw-alias-border-l2)", paddingTop: 10 } },
						h("div", { style: S.row },
							h("span", { style: S.hint }, t("service.restartHint")),
							confirming
								? h("span", { style: S.btnRow },
									h("button", { style: S.btn(false, false), onClick: () => setConfirming(false) }, t("updater.cancel")),
									h("button", { style: S.btnDanger(busy), disabled: busy, onClick: restart }, t("service.confirmRestart"))
								)
								: h("button", {
									style: S.btnDanger(!state.restartSupported || busy),
									disabled: !state.restartSupported || busy,
									onClick: () => setConfirming(true),
								}, t("service.restart"))
						),
						!state.restartSupported ? h("div", { style: S.notice }, t("service.unsupported")) : null
					),
					connLost ? h("div", { style: S.notice }, t("updater.lost")) : null,
					notice ? h("div", { style: S.notice }, notice) : null
				)
			);
		}

		/* ────────────────────── 页签 5：关于 ────────────────────── */

		function AboutTab({ t }) {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);

			react.useEffect(() => {
				api("/about").then(setData).catch((err) => setError(err.message));
			}, []);

			if (error) return h("div", { style: S.card }, h("div", { style: S.hint }, t("common.error") + "：" + error));
			if (!data) return h("div", { style: S.empty }, t("common.loading"));

			return h("div", { style: S.section },
				h("div", { style: S.card },
					h("div", { style: S.head },
						h("span", { style: S.cardTitle }, data.plugin.name + " v" + data.plugin.version),
						h("span", { style: S.badge("bad") }, t("about.unofficial"))
					),
					h("div", { style: S.notice }, data.disclaimer.zh),
					h("div", { style: S.keyval },
						h("span", { style: S.label }, t("about.author")), h("span", { style: S.value }, data.author),
						h("span", { style: S.label }, t("about.license")), h("span", { style: S.value }, data.license),
						h("span", { style: S.label }, t("about.host")), h("span", { style: S.mono }, String(data.hostPid)),
						h("span", { style: S.label }, t("about.repo")),
						h("a", { href: data.repository, target: "_blank", rel: "noreferrer", style: S.link }, data.repository),
						h("span", { style: S.label }, t("about.security")),
						h("a", { href: data.security, target: "_blank", rel: "noreferrer", style: S.link }, "SECURITY.md")
					)
				),
				h("div", { style: S.card },
					h("div", { style: S.cardTitle }, t("about.modules")),
					h("div", { style: S.pills },
						data.modules.map((mod) => h("span", { key: mod.id, style: S.chip }, mod.label))
					)
				)
			);
		}

		/* ────────────────────── 页签注册表（可扩展性核心） ────────────────────── */

		const TABS = [
			{ id: "updater", labelKey: "tab.updater", component: UpdaterTab, badge: (status) => status && status.updateAvailable },
			{ id: "usage", labelKey: "tab.usage", component: UsageTab },
			{ id: "diagnose", labelKey: "tab.diagnose", component: DiagnoseTab },
			{ id: "service", labelKey: "tab.service", component: ServiceTab },
			{ id: "about", labelKey: "tab.about", component: AboutTab },
		];

		/* ────────────────────── 分区外壳 ────────────────────── */

		function Section({ t }) {
			const [active, setActive] = react.useState(TABS[0].id);
			// 更新红点：仅更新中心需要跨页签的远端状态，挂载时取一次 status。
			const [updaterStatus, setUpdaterStatus] = react.useState(null);
			react.useEffect(() => {
				api("/status").then(setUpdaterStatus).catch(() => {});
			}, []);
			const current = TABS.find((tab) => tab.id === active) || TABS[0];
			const Panel = current.component;

			return h("div", { style: S.section },
				h("div", { style: S.head },
					h("span", { style: S.heading }, t("title")),
					h("span", { style: S.byline }, t("byline"))
				),
				h("div", { role: "tablist", style: S.tabBar },
					TABS.map((tab) =>
						h("button", {
							key: tab.id,
							role: "tab",
							"aria-selected": tab.id === active,
							style: S.tab(tab.id === active),
							onClick: () => setActive(tab.id),
						},
							t(tab.labelKey),
							tab.id === active ? h("span", { style: S.tabUnderline }) : null,
							tab.badge && tab.badge(updaterStatus) ? h("span", { style: S.dot, title: "update" }) : null
						)
					)
				),
				h("div", { role: "tabpanel" },
					h(Boundary, { t }, h(Panel, { t }))
				)
			);
		}

		/* ────────────────────── 插件装载 ────────────────────── */

		/** cordis 服务依赖：分区注册需要 slots，文案需要 locale。 */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			// 字典：注册失败（locale 未就绪）时降级为直通，分区仍可渲染。
			let t;
			try {
				ctx.locale.register(NS, { zh, en });
				t = ctx.locale.bind(NS);
			} catch {
				t = (key) => zh[key] !== undefined ? zh[key] : key;
			}

			ctx.slots.inject("settings.section", () => {
				try {
					const unregister = ctx.slots.register({
						name: "settings.section",
						id: "harness-toolbox",
						order: 200,
						label: () => t("nav"),
						locale: NS,
					}, (ownerProps) => h(Section, { t, ...ownerProps }));
					return typeof unregister === "function" ? unregister : () => {};
				} catch {
					return () => {};
				}
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
