# 安装

## 给人看

### 前置

| 项 | 要求 |
|---|---|
| DSH | 0.2.1-rc.3 或更新（桌面版 / Web 版都行） |
| Node | ≥ 22.5（自带 `node:sqlite`）；更老的 Node 需另装可选依赖 `sql.js` |

### 三选一

**A. GUI（桌面版推荐）**

设置 → 插件 → 安装 → 选本仓库目录 → 重启 DSH。

**B. `dsh plugin`（Web / TUI profile）**

```sh
dsh plugin --profile <profile> add link:<本仓库绝对路径>
```

> 桌面版的 `desktop` profile 由 Electron 独占管理，这条命令会被拒绝，请用 A 或 C。

**C. 手工（不熟悉 pnpm 不建议）**

在 `~/.dsh/profiles/<profile>/package.json` 里改两处：

```jsonc
{
  "dependencies": { "dsh-memory-rules": "link:<本仓库绝对路径，反斜杠改正斜杠>" },
  "dsh": { "profile": { "bundles": ["...其他", "dsh-memory-rules"] } }
}
```

然后在该目录执行 `pnpm install --no-frozen-lockfile`，重启 DSH。

**两处缺一不生效**：`dependencies` 管解析，`bundles` 管加载。

### 首次启动会发生什么

- 在 `~/.dsh/memory/memory.db` 建表；
- 写入一条提示词 `用户硬性协作流程`（内容为中性占位模板，可在「记忆与规则 → 提示词」里改）；
- 每轮对话开始前，把少量相关记忆注入系统提示；
- 左侧导航出现「记忆与规则」，含「信念库」「提示词」两个标签。

### 卸载

```sh
dsh plugin --profile <profile> remove dsh-memory-rules
```

数据不跟着删。要清干净：退出 DSH 后手动删 `~/.dsh/memory`。

---

## 给 agent 执行

你负责配置，**不能重启 DSH**（重启会终止你自己）。最后一步交给人。

### 1. 探测

```powershell
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profile = 'desktop'
$profDir = Join-Path $dshHome "profiles\$profile"
$plugDir = Join-Path $dshHome 'plugins\dsh-memory-rules'

"DSH_HOME      : $(Test-Path $dshHome)"
"profile dir   : $(Test-Path $profDir)"
"already there : $(Test-Path $plugDir)"
"existing data : $(Test-Path (Join-Path $dshHome 'memory\memory.db'))"
```

- `profile dir = False`：去 `~/.dsh/profiles/` 看实际名字，替换本文件里的 `desktop`。
- `existing data = True`：装过旧版，数据会复用，**不要删** `~/.dsh/memory`。

### 2. 判断写权限

```powershell
try { New-Item -ItemType Directory -Force -Path (Join-Path $dshHome 'plugins') | Out-Null; "WRITABLE" }
catch { "BLOCKED: $($_.Exception.Message)" }
```

### 3. 路径 A：有权限

```powershell
Copy-Item -Recurse -Force '<本仓库绝对路径>' $plugDir
```

用 Node 改 package.json（不要手写 JSON 字符串）：

```js
// patch-profile.mjs —— 放工作区，用完删
import fs from 'node:fs'
const file = process.argv[2], link = process.argv[3]
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
p.dependencies ??= {}
p.dependencies['dsh-memory-rules'] = link
p.dsh ??= {}; p.dsh.profile ??= {}; p.dsh.profile.bundles ??= []
if (!p.dsh.profile.bundles.includes('dsh-memory-rules')) p.dsh.profile.bundles.push('dsh-memory-rules')
fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n')
```

```powershell
$node = (Get-ChildItem "$dshHome\dsh-runtimes\*\dependencies\node\bin\node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$env:DSH_PROFILE_PKG = Join-Path $profDir 'package.json'
$env:DSH_PLUG_LINK   = "link:$(($plugDir -replace '\\','/'))"
node .\patch-profile.mjs $env:DSH_PROFILE_PKG $env:DSH_PLUG_LINK
node -e "const p=require(process.env.DSH_PROFILE_PKG);console.log(p.dependencies['dsh-memory-rules'], p.dsh.profile.bundles.includes('dsh-memory-rules'))"
```

第二行必须输出 `link:... true`。

```powershell
$pnpm = (Get-ChildItem "$dshHome\dsh-runtimes\*\dependencies\pnpm\bin\pnpm.mjs" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
Push-Location $profDir; node $pnpm install --no-frozen-lockfile; Pop-Location
Test-Path (Join-Path $profDir 'node_modules\dsh-memory-rules')
```

最后一行必须是 `True`。

然后告诉人：

> 插件已配置完成。请完全退出 DeepSeek Harness（托盘右键退出，不是关窗口），再重新打开。
> 打开后看左侧导航是否多出「记忆与规则」。

### 4. 路径 B：无权限

不要绕过沙箱。把命令交给人执行，并附上要改的两处。

### 5. 失败分支

| 现象 | 处理 |
|---|---|
| `profile "desktop" is managed exclusively by the Electron application` | 桌面版禁 CLI，改手工或 GUI |
| `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` | 没在 profile 目录执行 |
| `node_modules\dsh-memory-rules` 为 False | 检查 JSON 是否合法，重跑 install |
| 重启后无「记忆与规则」 | `bundles` 没写，或没真正重启 |
| `incompatible-version` | DSH 版本过低，不建议强装 |

### 6. 回滚

从 package.json 删掉两处 → 删 `~/.dsh/plugins/dsh-memory-rules` → 重启。
