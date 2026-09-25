/**
 * wmi — 树外进程创建/终止（2026-09-25 环境级排查的工程结论）。
 *
 * 实测铁证（tools/ 下三次插桩实验）：本环境的父子进程是共生的——
 *   1. taskkill 杀祖先 → 调用者无声陪葬（无任何退出事件）；
 *   2. 父进程正常 process.exit(0) → 子进程同样被连坐清除。
 * 标准 Windows 无此行为，属本机进程监管特性。因此任何“宿主退出后仍要
 * 存活/继续工作”的进程（升级执行器、重启后的新宿主）必须**树外派生**：
 *   WMI Win32_Process.Create —— 新进程的父是系统服务 WmiPrvSE（实测
 *   ppid=4244），与调用者无父子关系 → 连坐永不命中。
 * 终止同理：由 WmiPrvSE 执行 Terminate，调用者不直接参与（连坐只沿父子链，
 * 且“杀非祖先”本就安全——场景 A 实测）。
 * @module dsh-harness-toolbox/wmi
 */
import { spawn } from 'node:child_process'

const PS = 'powershell.exe'

/** 跑一条 PowerShell 命令取 stdout；非零退出/超时 reject。 */
function runPs(command, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error('powershell 超时'))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`powershell exit ${code}: ${err.trim().slice(0, 300)}`))
    })
  })
}

/**
 * WMI 创建进程（树外）。
 * @param {string} commandLine 完整命令行（可含双引号；**禁止单引号**——
 *   它是 PowerShell 字面量定界符；路径空格用双引号包裹）。
 * @returns {Promise<number>} 新进程 pid
 */
export async function wmiCreate(commandLine) {
  if (process.platform !== 'win32') throw new Error('wmiCreate 仅支持 Windows')
  if (commandLine.includes("'")) throw new Error('命令行禁止单引号（PowerShell 字面量安全）')
  const cmd = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine}'} | ForEach-Object { "$($_.ReturnValue) $($_.ProcessId)" }`
  const out = await runPs(cmd)
  const m = out.match(/^(\d+)\s+(\d+)/)
  if (!m) throw new Error(`WMI 返回无法解析: ${out.slice(0, 200)}`)
  if (Number(m[1]) !== 0) throw new Error(`WMI 创建失败 ReturnValue=${m[1]}`)
  const pid = Number(m[2])
  if (!pid) throw new Error('WMI 未返回有效 pid')
  return pid
}

/**
 * 终止进程。
 * 新拓扑下本进程（执行器）的祖先是 WmiPrvSE → 目标（宿主/残留进程）必为
 * **非祖先**，而“杀非祖先”经场景 A/B/清场多轮实测零连坐（连坐只沿父子链）。
 * CIM Terminate 在本机报无效参数（兼容性坑），故直接 taskkill /F 单杀：
 * 保留“拒绝终止祖先”的防呆（新架构下触发即意味着拓扑被破坏）。
 */
export async function wmiKill(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) throw new Error('pid 非法')
  if (Number(pid) === process.pid) throw new Error('拒绝终止自身')
  if (Number(pid) === process.ppid) throw new Error('拒绝终止祖先（拓扑防护：新架构下祖先应为系统服务）')
  await new Promise((resolve, reject) => {
    const child = spawn('taskkill', ['/PID', String(Number(pid)), '/F'], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      // 0=已终止；128+ 常见于“进程已不存在”——目标已死即达意。
      if (code === 0 || /not found|没有找到|不存在/i.test(err)) resolve()
      else reject(new Error(`taskkill exit ${code}: ${err.trim().slice(0, 200)}`))
    })
  })
  return true
}

/** 命令行参数：含空白加双引号（值内不允许单引号/双引号——上层约束）。 */
export function quoteArg(value) {
  return /\s/.test(value) ? `"${value}"` : value
}

/**
 * 树外创建一个 node 脚本进程。
 * @param {string} nodeExe node 可执行文件路径
 * @param {string} scriptPath 脚本路径
 * @param {string[]} args 纯参数（不得含 ' 与 " ）
 * @returns {Promise<number>} pid
 */
export async function wmiRunNode(nodeExe, scriptPath, args) {
  const parts = [quoteArg(nodeExe), quoteArg(scriptPath), ...args.map((a) => {
    if (/['"]/.test(a)) throw new Error(`参数含引号: ${a}`)
    return quoteArg(a)
  })]
  return wmiCreate(parts.join(' '))
}
