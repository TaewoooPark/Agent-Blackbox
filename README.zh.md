# Agent-Blackbox

**打开你的编码智能体的黑匣子。**

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <b>中文</b> ·
  <a href="./README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/TaewoooPark/Agent-Blackbox?style=flat-square&logo=github&logoColor=white&labelColor=000000&color=333333" alt="GitHub stars">
  <img src="https://img.shields.io/github/last-commit/TaewoooPark/Agent-Blackbox?style=flat-square&labelColor=000000&color=333333" alt="Last commit">
  &nbsp;
  <img src="https://img.shields.io/badge/TypeScript-000000?style=flat-square&logo=typescript&logoColor=white&labelColor=000000" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-000000?style=flat-square&logo=react&logoColor=white&labelColor=000000" alt="React">
  <img src="https://img.shields.io/badge/Vite-000000?style=flat-square&logo=vite&logoColor=white&labelColor=000000" alt="Vite">
  &nbsp;
  <img src="https://img.shields.io/badge/Claude%20Code-000000?style=flat-square&labelColor=000000&color=000000" alt="Claude Code">
  <img src="https://img.shields.io/badge/OpenCode-000000?style=flat-square&labelColor=000000&color=000000" alt="OpenCode">
  <img src="https://img.shields.io/badge/Local--first-000000?style=flat-square&labelColor=000000&color=000000" alt="Local-first">
  <img src="https://img.shields.io/badge/无需%20API%20key-000000?style=flat-square&labelColor=000000&color=000000" alt="No API key">
</p>

Agent-Blackbox 是一个**面向编码智能体、本地优先（local-first）的飞行记录仪与上下文效率分析器**。它把每一次智能体运行 —— 读了什么、改了什么、跑了什么、做了什么决定、委派了什么、卡在哪里、验证了什么 —— 从**观测到的事件**（而非智能体自己的总结）重建为一张**实时、可回放的操作图**。然后它**度量这次运行用上下文窗口用得有多省**，并具体告诉你怎样让下一次更便宜、更快。

**支持 [Claude Code](https://www.claude.com/product/claude-code) 与 [OpenCode](https://opencode.ai)** —— 同一个记录器、同一张地图、同一套效率评分。记录其一，或同时记录两者。

> *"对话记录是智能体所*说*的，黑匣子是它所*做*的 —— 以及它的*代价*。"*

[**taewoopark.com** — 作者站点](https://taewoopark.com)

<p align="center">
  <img src="./docs/screenshots/session-map.jpeg" alt="Agent-Blackbox 会话图 —— 以 Mark Lombardi 叙事结构渲染的一次复杂 OpenCode 运行。" width="100%">
</p>

---

## 为什么用 Agent-Blackbox

别直接**问**智能体这次花了多少。2026 年一项针对 8 个前沿模型在智能体编码（SWE-bench Verified）上的研究发现：模型预测自己 token 用量的准确度，相关系数仅 **0.39 —— 且系统性地低估**真实账单。同一任务、同一模型，单次运行的 token 可相差 **多达 30 倍**；专家的难度评级也几乎对不上真实成本。何况智能体运行本就比普通编码烧掉 **约 1000 倍** 的 token，且绝大多数是*输入*上下文。

> 所以别问 —— **去测。** Agent-Blackbox 把每次运行重建为可观测的会话地图，精确评分它的成本，再把修复写回去。

<sub>Bai et al., *How Do AI Agents Spend Your Money? Analyzing and Predicting Token Consumption in Agentic Coding Tasks*, [arXiv:2604.22750](https://arxiv.org/abs/2604.22750) (2026).</sub>

---

## 快速开始

**一条命令 —— 同时支持 Claude Code 与 OpenCode**（需要 Node 20+）：

```bash
# 记录 Claude Code —— 无需安装任何东西；守护进程会跟读它本就写出的
# 会话记录（~/.claude/projects/）
npx @taewooopark/agent-blackbox up --host claude-code

# …或记录 OpenCode（把记录器装进 OpenCode 的全局插件目录）
npx @taewooopark/agent-blackbox up

# …或同时记录两个宿主，汇入同一个仪表盘
npx @taewooopark/agent-blackbox up --host all
```

无论哪种方式，它都会启动守护进程并**打开仪表盘**（`http://127.0.0.1:5173/`；加 `--no-open` 可跳过）。然后照你平时的方式用智能体即可，地图会实时填充：

```bash
claude            # Claude Code，在任意文件夹 —— 零配置，直接运行
opencode          # …或 OpenCode（终端或桌面应用）
```

- **Claude Code 完全无需安装** —— 守护进程会跟读 CLI 本就写出的 JSONL 会话记录，所以任意文件夹、任意会话，在你运行 `claude` 的那一刻就被记录。（加 `--optimize` 可一并安装可选的运行内执行器钩子。）
- **OpenCode** 通过装入其**全局**插件目录（`~/.config/opencode/plugins/`）的记录器进行记录 —— 任意会话、任意文件夹，连桌面应用也算。

随时用 `npx @taewooopark/agent-blackbox uninstall` 停止记录。

<details>
<summary><b>把 OpenCode 限定到单个项目，或从源码运行</b></summary>

```bash
# 只记录一个 OpenCode 项目（记录器装进 <dir>/.opencode，而非全局）
npx @taewooopark/agent-blackbox up --project /path/to/your/project

# 从源码（开发 / 贡献）
git clone https://github.com/TaewoooPark/Agent-Blackbox
cd Agent-Blackbox && npm install && npm run build:cli
node packages/cli/dist/cli.js up --host claude-code   # 或：up | up --host all
```
</details>

图会实时自我组装。就这样。

### 用法示例

```bash
# 只是观察 Claude Code —— 启动一次，然后在任意地方用 `claude`
npx @taewooopark/agent-blackbox up --host claude-code
claude   # 在任意文件夹；仪表盘实时填充

# 同时记录两个宿主，并由免费/本地模型给出定制修复
npx @taewooopark/agent-blackbox up --host all --suggest ollama --suggest-model qwen2.5-coder

# 多智能体 —— 在平常的会话里委派即可，每个子智能体分叉到自己的泳道
claude "把探索、实现、测试委派给子智能体，然后总结。"

# 续接 —— 打开运行，点 Handoff，把 Markdown 粘到下一个会话

# 换端口（若 47831/5173 被占用 —— 记录器会自动重新写入匹配的端口）
npx @taewooopark/agent-blackbox up --host claude-code --port 48000 --ui-port 4000

# 停止记录（移除全局记录器 + 任何 Claude Code 钩子）
npx @taewooopark/agent-blackbox uninstall
```

---

## 一次同时做两件事

**1 · 看见智能体真正做了什么。** 编码智能体读十几个文件、跑命令、改代码、派生子智能体，然后递给你一份漂亮的总结。你唯一的窗口只是滚动的对话记录和一份只能盲信的总结。Agent-Blackbox 用一张一眼可读的**会话图**取而代之。

**2 · 看见并削减它的代价。** 上下文就是金钱、延迟和硬性的窗口上限。Agent-Blackbox 为每次运行的上下文使用效率打分（缓存复用、重复读取、读改放大、超大工具输出、重试浪费），并给出**具体的优化建议** —— 默认基于规则，或由一个**无需 API key 的免费本地模型**量身撰写。

| 读对话记录 | Agent-Blackbox |
|---|---|
| 滚动线性日志 | 一眼可读的**会话图** |
| 盲信智能体总结 | 由**观测事件**重建 |
| "测试通过了" | 亲眼看见**失败 → 修复 → 通过**循环 |
| 长运行中迷失线索 | **拖动回放**任意时刻 |
| 一个不透明的整体 | **子智能体谱系** —— 谁委派了什么 |
| 不知道花了多少 | **上下文效率评分** + 可回收 token |
| "为什么这么贵？" | **具体修复**，可由本地模型撰写 |
| 续接需重读全部 | 一键**交接（handoff）**摘要 |
| 代码与提示离开本机 | **本地优先**、最小采集、**无需 API key** |

---

## 实时上演

这张图不是事后尸检。它在**智能体工作时**生成：记录器把事件流式传给本地守护进程，仪表盘通过 WebSocket 更新 —— 时刻出现、文件以弧线相连、token 跳动、失败的测试标为暗红、修复将其化解。无需刷新，无需回放。

这正是核心：**趁飞行尚在空中，打开黑匣子。**

---

## 你将获得

- **实时会话图** —— 以有意义的"时刻脊柱"实时成形；连续重复会聚合（`Created 12 files`、`Tests passed ×6`），即使大型运行也可扫读。
- **叙事结构美学** —— 扁平、单色的 "Mark Lombardi" 图：空心环节点、环到环的扫掠弧线、衬线标签。纸上石墨（浅色）或墨上银尖笔（深色）；唯一的强调色是**仅用于风险/失败的暗红**。
- **回放** —— 拖动导航图式时间轴到任意序列点，图与文件回到该时刻的状态。
- **点击聚焦** —— 选时刻看详情弹窗（证据、文件、token）；选智能体隔离其泳道；点文件高亮触及它的所有时刻，弧线从每个节点的环画出。
- **子智能体谱系** —— 真实委派（`task` 工具 / 子会话）分叉为各自的分支，归属于实际干活的子智能体。
- **上下文效率** —— 实时评分 + 指标计量（上下文压力、缓存命中、重复读取、读取放大、超大注入、重试浪费、产出密度）与一键优化注释 —— **基于规则，或路由到免费/本地模型（无需 API key）**。
- **交接导出** —— 结构化的续接摘要（目标、涉及文件、决定、命令、失败、阻塞、下一步安全动作），一键复制为 Markdown。
- **运行选择器** —— 一个项目日志可含多次运行；控制台跟随最近*活跃*的运行，也可固定任意历史运行。
- **完整事件覆盖** —— 无论用哪个模型，所有动作（读取、编辑、bash、技能、自定义/MCP 工具、权限、待办、子智能体）都按宿主事件捕获（与模型无关）。
- **一条命令引导** —— `npm run up` 安装记录器插件、启动守护进程、提供仪表盘。

<p align="center">
  <img src="./docs/screenshots/features.jpeg" alt="Agent-Blackbox 四格概览：浅色会话图 · 深色模式 · 上下文效率副驾 · 交接导出。" width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/focus.jpeg" alt="聚焦双格：点击时刻使图变暗并弹出详情；选择智能体隔离其泳道。" width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/replay.jpeg" alt="双格：时间轴拖到中段并回退到该时点的回放（OMO 子智能体展开，失败的测试时刻以暗红显示），以及通过 'Sharpen advice with a model' 由免费模型生成的按范围读取建议的副驾。" width="100%">
</p>

---

## 上下文效率 —— 能自己回本的部分

每次运行都由观测到的尺寸与 token 快照打分 —— 而非智能体的自述。每个被标记的指标都会展开为一条具体修复。

| 指标 | 它能抓到什么 |
|---|---|
| **上下文压力** | 提示在峰值时长到多大 |
| **缓存命中率** | 提示中由缓存提供的比例 |
| **重复读取** | 同一文件被多次拉入（含可回收 token） |
| **读取放大** | 读得远多于改的 —— 读片段，别读整文件 |
| **超大注入** | 单个工具输出淹没窗口 |
| **重试浪费** | 在修因之前重跑失败命令 |
| **产出密度** | 每 1k token 产生多少具体改动 |

建议**默认基于规则**（始终可用，无依赖）。若要让模型量身撰写 —— **无需 API key** —— 把 `up` 指向本地/免费模型：

```bash
# Ollama（推荐）：本地，无需 key
npx @taewooopark/agent-blackbox up --suggest ollama --suggest-model qwen2.5-coder

# 任意 OpenAI 兼容的本地服务（LM Studio、llama.cpp）
npx @taewooopark/agent-blackbox up --suggest openai-compat --suggest-base-url http://127.0.0.1:1234

# 用已安装的二进制复用 OpenCode 免费模型
npx @taewooopark/agent-blackbox up --suggest opencode --suggest-model opencode/deepseek-v4-flash-free
```

`--suggest auto`（默认）按上述顺序探测，并回退到规则。即便对本地模型，也只发送**脱敏的派生摘要**：指标的状态、计数、尺寸，以及粗粒度的**问题标签 —— 文件名（basename）与命令动词**（如 `billing.ts ×2`、`deploy ×2`，以便建议能指出要修复的对象）—— 但**绝不发送文件内容、目录路径、命令参数、提示词或密钥**。

### 建议的依据

这些建议不是泛泛之谈。常驻的规则兜底与本地模型提示词都内置了**按指标的修复手册**，且每条建议都被要求引用本次运行的真实数字、点名问题文件/命令、给出具体机制与预期效果。该手册提炼自以下上下文工程研究与生产实践：

| 来源 | 贡献 | 相关指标 |
|---|---|---|
| Anthropic — [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | **压缩（compaction）**（将已完成的轮次汇总 → 开启新窗口）、清理已处理的工具输出、**子智能体上下文隔离**（在子代理中探索后只回传 ~1–2k 词元的摘要）、**按需检索**（用 grep/glob 即用即取，避免预载整文件） | `context-pressure`、`read-amplification`、`redundant-reads`、`yield-density` |
| Manus — [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | **KV 缓存命中率**是首要成本杠杆（缓存词元约便宜 10×）、保持提示前缀逐字节稳定（勿放时间戳/易变数据）、仅追加的上下文、用屏蔽（mask）代替增删工具、把文件系统当外部记忆、每步**复述（recitation）**目标 | `cache-hit`、`large-injections`、`retry-waste` |
| Liu 等 — [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) | 模型会**系统性地忽视长上下文的中段**（U 形准确率，下降 30%+）—— 故建议倾向于裁剪/重排与目标复述，而非"塞更多" | `context-pressure`、`yield-density` |
| Anthropic — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 精简、**不重叠的工具集**与清晰的工具边界；把相关动作批处理，而非探索式的调用链 | `tool-overhead` |
| Schulhoff 等 — [The Prompt Report: A Systematic Survey of Prompt Engineering Techniques](https://arxiv.org/abs/2406.06608) | 对比式少样本（差而泛 vs 好而具体）、让答案锚定所给数字、严格的结构化输出 —— 让小型本地模型也能返回具体、可执行的 JSON | *（用于塑造建议器提示词本身）* |

已在小型本地模型上端到端验证：一条"重复读取"的建议从"每个文件只读一次"变为 **"`calculator.js` 被读取 2 次（约可回收 282）—— 读取一次并缓存，之后每次编辑只重读发生变化的行区间，而非整个文件。"**

---

## 与 oh-my-openagent 搭配 —— 剖析并压缩重型多智能体运行

[**oh-my-openagent (OMO)**](https://github.com/code-yeongyu/oh-my-openagent) 把 OpenCode 变成多智能体 *tokenmaxxer* 框架 —— 11 个专家、并行执行、为交付复杂工作而疯狂消耗词元的持续循环。Agent-Blackbox 正是为这种负载打造的仪表：**OMO 踩满油门，Agent-Blackbox 是测功机与遥测。**

二者都是 OpenCode 插件，零配置共存 —— 装好记录器再跑 OMO，整个团队都会显现：

- **看见整个团队。** 每个由 SDK 派生的子智能体（Sisyphus、explore、librarian、plan、oracle…）各占一条泳道；委派从主干分叉；文件以弧线相连。地图正是为这种复杂度而生。
- **看见并压缩成本。** "tokenmaxxer" 运行恰恰是上下文经济最关键之处。Agent-Blackbox 为其评分（上下文压力、重复读取、读取放大、工具开销）并点名确切元凶 —— 这是你在框架内部看不见的成本。
- **闭环。** 把发现写进 `AGENTS.md` 供下次运行使用，并开启运行内优化器（`AGENT_BLACKBOX_OPTIMIZE=1`）把重复读取作为空操作/差分返回 —— 在*同一次*运行内节省，无需重跑。

一次真实的 OMO `ultrawork` 运行，由 Agent-Blackbox 实时记录 —— 左侧是命名的专家泳道，右侧是带可回收词元与定制修复建议的上下文效率评分：

<p align="center">
  <img src="./docs/screenshots/omo-synergy.jpeg" alt="Agent-Blackbox 剖析一次真实的 oh-my-openagent ultrawork 会话：左栏列出命名的专家泳道（Sisyphus - ultraworker、plan），选中一条泳道后仅其分支保持点亮、其余地图淡出，右栏显示 72 分上下文效率评分并标记重复读取与重试浪费及可回收 token。" width="100%">
</p>

```bash
# 两者都全局安装 —— 把 ABB 启动一次，然后照常跑 OMO。在 :5173 查看。
npx @taewooopark/agent-blackbox up --suggest free
opencode "ultrawork: refactor the auth module and add tests"   # OMO 与记录器同时生效
```

无需手动搬运发现，**直接在仪表盘里** —— 右栏的 **Optimize future runs** 按钮会弹出一个窗口，*原样预览*将写入 `AGENTS.md` 的块（含可回收 token 与目标路径），一键完成应用、更新或回滚。这是真实且可逆的文件改动，而非建议：

<p align="center">
  <img src="./docs/screenshots/optimize-modal.jpeg" alt="Agent-Blackbox 仪表盘中的 'Optimize future runs' 弹窗：'Not applied' 徽章、目标 AGENTS.md 路径，以及将写入的记忆块预览（复用已验证的 'npm test' 命令；calculator.js、parser.js、calculator.test.js 只读一次，之后仅重读变更的行范围），下方是 'Apply to AGENTS.md' 与 'Cancel' 按钮，叠在淡出的会话地图之上。" width="100%">
</p>

**实测 —— 同一个 OMO `ultrawork` 任务的公平前后对比**（Claude Sonnet，相同任务、冷启动会话，仅新增 `AGENTS.md`）：Run A 的 explore 子智能体重复读取了 9 个文件 → ABB 把*"这些文件只读一次"*固定进 `AGENTS.md` → 在冷启动重跑的 Run B 中重复读取消失。两次运行都从同一干净仓库（其间 git reset）和全新会话开始 —— 没有携带上下文。

| | 之前 (run A) | 之后 (run B) |
|---|---|---|
| 上下文效率评分 | 80 | **99** |
| 重复读取 | 9 个文件（~1.8k 可回收） | **无** |
| 总 token | 939k | **521k**（−44%） |
| 工具调用/事件 | 619 | **253** |

<table>
<tr>
<td width="50%"><img src="./docs/screenshots/optimize-before.jpeg" alt="之前：80 分，标记重复读取 9 个文件（calculator.js·parser.js·formatter.js ×3），939k token。" width="100%"></td>
<td width="50%"><img src="./docs/screenshots/optimize-after.jpeg" alt="之后：99 分，'未检测到浪费'，521k token。" width="100%"></td>
</tr>
</table>

> ⚠️ 这个两次运行的对比是**验证机制的基准**（重跑同一任务会花两倍 token）。实际使用中只需应用一次，便会在该仓库*后续不同*任务中免重跑地受益。

---

## 交接 —— 在任何地方接续

需要在别处续接时 —— 队友、下一个智能体，或上下文重置后的同一智能体 —— 导出结构化**交接**：

<p align="center">
  <img src="./docs/screenshots/handoff.jpeg" alt="Agent-Blackbox 交接摘要 —— 一张纸卡，列出目标、观测、涉及文件、决定、命令、阻塞与下一步安全动作，一键复制 Markdown。" width="100%">
</p>

---

## 工作原理

```
 Claude Code transcripts (tailed) ─┐
 OpenCode hooks → recorder plugin ─┴─▶ host adapter ─▶ daemon ─▶ dashboard
                                       redact+normalize  NDJSON    live session map
                                                         + graph   + efficiency
```

- **`packages/core`** —— 规范 `TraceEvent`、工作流图模型、脱敏、回放、审计、交接生成、上下文效率引擎。
- **`packages/claude-code-adapter`** —— 跟读 Claude Code 写出的 JSONL 会话记录（`~/.claude/projects/`），并将其规范化为规范、脱敏的事件 —— 无需插件、无需安装。可选的钩子可加入运行内执行器。
- **`packages/opencode-adapter`** —— 把宿主事件与工具调用转为规范、脱敏事件（只含内容*尺寸*而非内容）并尽力（带重试）发给守护进程的轻量 OpenCode 插件。
- **`apps/daemon`** —— 把事件落入本地 NDJSON 日志、构建图、回放到任意点、计算效率报告、路由建议、通过 WebSocket 推送实时快照。
- **`apps/dashboard`** —— 运维控制台：实时会话图、回放、检查器、效率副驾、交接。

---

## 哲学 —— 观测，别信叙述者

> **从观测事件中得出真相，而非自由叙述的自述。**

- **行为，而非叙述。** 每个节点都是智能体真正发出的事件 —— 读取、编辑、命令及其退出码、委派。
- **代价也是证据。** 效率评分与每条建议都来自观测到的尺寸与 token 快照。
- **本地优先，无需 key。** 轨迹留在你的机器上。提示、密钥、文件内容默认脱敏；可选的模型建议也在本地运行，只接收脱敏摘要。
- **宿主无关的内核。** 规范事件+图内核配以轻量适配器，同一个黑匣子可坐在任何智能体框架之后 —— Claude Code 与 OpenCode 是头两个。

---

## 守护进程 API

| 方法与路径 | 用途 |
|---|---|
| `POST /events` | 摄入规范 `TraceEvent` |
| `GET /events` | 持久事件日志 |
| `GET /graph?seq=<n>` | 回放到某序列的图 |
| `GET /snapshot?seq=<n>` | 事件、图、审计、效率报告、交接 |
| `GET /efficiency?seq=<n>` | 上下文效率报告（评分+指标） |
| `POST /suggest` | 对提交报告的优化建议（确定性或本地模型） |
| `GET /handoff` | 生成的交接 Markdown |
| `WS /stream` | 每次摄入后推送实时快照 |

---

## 开发

```bash
npm install
npm run check   # 类型检查 + 测试
npm run build
```

---

## 联系

<p align="center">
  <a href="https://github.com/TaewoooPark"><img src="https://img.shields.io/badge/-GitHub-181717?style=for-the-badge&logo=github&logoColor=white&cacheSeconds=3600" alt="GitHub"></a>
  <a href="https://x.com/theoverstrcture"><img src="https://img.shields.io/badge/-X-000000?style=for-the-badge&logo=x&logoColor=white&cacheSeconds=3600" alt="X (Twitter)"></a>
  <a href="https://www.linkedin.com/in/taewoo-park-427a05352"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white&cacheSeconds=3600" alt="LinkedIn"></a>
  <a href="https://www.instagram.com/t.wo0_x/"><img src="https://img.shields.io/badge/-Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white&cacheSeconds=3600" alt="Instagram"></a>
  <a href="https://taewoopark.com"><img src="https://img.shields.io/badge/-taewoopark.com-000000?style=for-the-badge&logo=safari&logoColor=white&cacheSeconds=3600" alt="Personal site"></a>
  <a href="mailto:ptw151125@kaist.ac.kr"><img src="https://img.shields.io/badge/-Email-D14836?style=for-the-badge&logo=gmail&logoColor=white&cacheSeconds=3600" alt="Email"></a>
</p>

<p align="center"><sub>本地优先。无需 API key。观测，别信叙述者。</sub></p>
