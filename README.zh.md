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
  <img src="https://img.shields.io/badge/OpenCode-000000?style=flat-square&labelColor=000000&color=000000" alt="OpenCode">
  <img src="https://img.shields.io/badge/Local--first-000000?style=flat-square&labelColor=000000&color=000000" alt="Local-first">
  <img src="https://img.shields.io/badge/无需%20API%20key-000000?style=flat-square&labelColor=000000&color=000000" alt="No API key">
</p>

Agent-Blackbox 是一个**面向编码智能体、本地优先（local-first）的飞行记录仪与上下文效率分析器**。它把每一次智能体运行 —— 读了什么、改了什么、跑了什么、做了什么决定、委派了什么、卡在哪里、验证了什么 —— 从**观测到的事件**（而非智能体自己的总结）重建为一张**实时、可回放的操作图**。然后它**度量这次运行用上下文窗口用得有多省**，并具体告诉你怎样让下一次更便宜、更快。

> *"对话记录是智能体所*说*的，黑匣子是它所*做*的 —— 以及它的*代价*。"*

[**taewoopark.com** — 作者站点](https://taewoopark.com)

<p align="center">
  <img src="./docs/screenshots/session-map.jpeg" alt="Agent-Blackbox 会话图 —— 以 Mark Lombardi 叙事结构渲染的一次复杂 OpenCode 运行。" width="100%">
</p>

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
  <img src="./docs/screenshots/replay.jpeg" alt="双格：时间轴拖到中段的回放，以及用本地模型优化后的副驾。" width="100%">
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
npm run up -- --project /path --suggest ollama --suggest-model qwen2.5-coder

# 任意 OpenAI 兼容的本地服务（LM Studio、llama.cpp）
npm run up -- --project /path --suggest openai-compat --suggest-base-url http://127.0.0.1:1234

# 用已安装的二进制复用 OpenCode 免费模型
npm run up -- --project /path --suggest opencode --suggest-model opencode/deepseek-v4-flash-free
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

## 快速开始

```bash
git clone https://github.com/TaewoooPark/Agent-Blackbox
cd Agent-Blackbox
npm install
npm run build

# 一条命令：安装记录器插件、启动守护进程、提供仪表盘
npm run up -- --project /path/to/your/project
```

打开它打印的仪表盘 URL（默认 `http://127.0.0.1:5173/`），然后在该项目中运行你的智能体（`up` 会打印确切命令行）：

```bash
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 \
  opencode run --dir /path/to/your/project \
  "阅读相关代码，运行测试，并总结结果。"
```

图会实时自我组装。就这样。

### 用法示例

```bash
# 只是观察 —— 指向任意项目即可
npm run up -- --project ~/code/my-app

# 优化 —— 跑点重活，然后看右栏的效率评分与修复
npm run up -- --project ~/code/my-app --suggest ollama --suggest-model qwen2.5-coder

# 多智能体 —— 委派后看每个子智能体分叉到自己的泳道
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 opencode run --dir ~/code/my-app \
  "把探索、实现、测试委派给子智能体，然后总结。"

# 续接 —— 打开运行，点 Handoff，把 Markdown 粘到下一个会话

# 换端口（若 47831/5173 被占用）
npm run up -- --project ~/code/my-app --port 48000 --ui-port 4000
```

需要在别处续接时 —— 队友、下一个智能体，或上下文重置后的同一智能体 —— 导出结构化**交接**：

<p align="center">
  <img src="./docs/screenshots/handoff.jpeg" alt="Agent-Blackbox 交接摘要 —— 一张纸卡，列出目标、观测、涉及文件、决定、命令、阻塞与下一步安全动作，一键复制 Markdown。" width="100%">
</p>

---

## 工作原理

```
 opencode run ──hooks──▶  recorder plugin  ──events──▶   daemon   ──/stream──▶  dashboard
                          脱敏 + 规范化               NDJSON 日志           实时会话图
                          （宿主适配器）              + 图/回放             + 效率
                                                     + 效率报告           （此 UI）
```

- **`packages/core`** —— 规范 `TraceEvent`、工作流图模型、脱敏、回放、审计、交接生成、上下文效率引擎。
- **`packages/opencode-adapter`** —— 把宿主事件与工具调用转为规范、脱敏事件（只含内容*尺寸*而非内容）并尽力（带重试）发给守护进程的轻量 OpenCode 插件。
- **`apps/daemon`** —— 把事件落入本地 NDJSON 日志、构建图、回放到任意点、计算效率报告、路由建议、通过 WebSocket 推送实时快照。
- **`apps/dashboard`** —— 运维控制台：实时会话图、回放、检查器、效率副驾、交接。

---

## 哲学 —— 观测，别信叙述者

> **从观测事件中得出真相，而非自由叙述的自述。**

- **行为，而非叙述。** 每个节点都是智能体真正发出的事件 —— 读取、编辑、命令及其退出码、委派。
- **代价也是证据。** 效率评分与每条建议都来自观测到的尺寸与 token 快照。
- **本地优先，无需 key。** 轨迹留在你的机器上。提示、密钥、文件内容默认脱敏；可选的模型建议也在本地运行，只接收脱敏摘要。
- **宿主无关的内核。** 规范事件+图内核配以轻量适配器，同一个黑匣子可坐在任何智能体框架之后 —— OpenCode 是第一个。

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
