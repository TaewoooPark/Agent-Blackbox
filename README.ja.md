# Agent-Blackbox

**あなたのコーディングエージェントのブラックボックスを開きます。**

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.zh.md">中文</a> ·
  <b>日本語</b>
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
  <img src="https://img.shields.io/badge/Codex-000000?style=flat-square&logo=openai&logoColor=white&labelColor=000000" alt="Codex">
  <img src="https://img.shields.io/badge/OpenCode-000000?style=flat-square&labelColor=000000&color=000000" alt="OpenCode">
  <img src="https://img.shields.io/badge/Local--first-000000?style=flat-square&labelColor=000000&color=000000" alt="Local-first">
  <img src="https://img.shields.io/badge/API%20key%20不要-000000?style=flat-square&labelColor=000000&color=000000" alt="No API key">
</p>

Agent-Blackbox は、**コーディングエージェントのためのローカルファースト（local-first）なフライトレコーダー兼コンテキスト効率プロファイラ**です。すべての実行を**ライブで再生可能な操作グラフ**に変えます—何を読み、変更し、実行し、判断し、委譲し、詰まり、検証したか—それをエージェント自身の要約ではなく**観測されたイベント**から再構成します。さらに、その実行を**二つの軸**で採点します：コンテキストウィンドウをどれだけ経済的に使ったか、*そして*タスクが本当に着地したか。判断には**タスク種別**（research / debug / ops…）と**あなた自身の過去の実行**に合う物差しを使い、次の実行をより安く・速くする方法を具体的に示します。

**[Claude Code](https://www.claude.com/product/claude-code)、[Codex](https://developers.openai.com/codex/)、[OpenCode](https://opencode.ai) に対応** — 同じレコーダー、同じマップ、同じ効率スコア。1 つだけでも、すべて同時でも記録できます。

> *「トランスクリプトはエージェントが*言ったこと*、ブラックボックスはエージェントが*やったこと*—そしてその*コスト*。」*

[**taewoopark.com** — 作者サイト](https://taewoopark.com)

<p align="center">
  <img src="./docs/screenshots/hero-open-blackbox.jpeg" alt="Agent-Blackbox hero image: a pale session-map dashboard fading into the headline 'Open your agent's black box.'" width="100%">
</p>

---

## なぜ Agent-Blackbox か

エージェントに「今の作業はいくらかかった?」と**訊いて**はいけません。2026 年、8 つのフロンティアモデルをエージェンティックコーディング（SWE-bench Verified）で分析した研究によると、モデルが自分のトークン使用量を予測する精度は相関係数わずか **0.39 ── しかも実際のコストを体系的に過小評価**します。同じタスク・同じモデルでも実行ごとにトークンは **最大 30 倍** ばらつき、専門家の難易度評価も実コストとほとんど一致しません。しかもエージェンティック実行はすでに通常のコーディングの **約 1000 倍** のトークンを消費し、その大半は*入力*コンテキストです。

> だから訊くな ── **計れ。** Agent-Blackbox は各実行を観測されたセッションマップに再構成し、そのコストを正確に採点し、修正を書き戻します。

<sub>Bai et al., *How Do AI Agents Spend Your Money? Analyzing and Predicting Token Consumption in Agentic Coding Tasks*, [arXiv:2604.22750](https://arxiv.org/abs/2604.22750) (2026).</sub>

<p align="center">
  <img src="./docs/screenshots/session-map.jpeg" alt="Agent-Blackbox セッションマップ — Mark Lombardi のナラティブ構造で描かれた複雑な OpenCode 実行。" width="100%">
</p>

---

## クイックスタート

**1 コマンド。Claude Code、Codex、OpenCode に対応**（Node 20+ が必要）：

```bash
# Claude Code を記録 — インストール不要；デーモンが
# すでに書き出されているセッショントランスクリプト（~/.claude/projects/）を追尾する
npx @taewooopark/agent-blackbox up --host claude-code

# …または Codex を記録（CLI とデスクトップアプリ、レコーダー導入不要）
npx @taewooopark/agent-blackbox up --host codex

# …または OpenCode を記録（レコーダーを OpenCode のグローバルプラグインディレクトリに導入）
npx @taewooopark/agent-blackbox up

# …または両方のホストを一度に、1 つのダッシュボードへ記録
npx @taewooopark/agent-blackbox up --host all
```

いずれの場合もデーモンを起動し、**ダッシュボードを開きます**（`http://127.0.0.1:5173/`；`--no-open` で無効化）。あとは普段どおりエージェントを使えば、マップがライブで埋まっていきます：

```bash
claude            # Claude Code、任意のフォルダで — 設定不要、実行するだけ
opencode          # …または OpenCode（ターミナルでもデスクトップアプリでも）
```

- **Claude Code はインストールが一切不要** — デーモンが CLI のすでに書き出す JSONL トランスクリプトを追尾するので、`claude` を実行した瞬間に、どのフォルダ・どのセッションでも記録されます。（`--optimize` を付けると、オプトインの実行内アクチュエータフックも導入されます。）
- **Codex もレコーダー導入不要** — `--host codex` が CLI とデスクトップアプリの `$CODEX_HOME/sessions`（既定 `~/.codex/sessions`）を追尾します。`--optimize` で任意のアクチュエータを導入し、`/hooks` で一度信頼します。
- **OpenCode** は**グローバル**プラグインディレクトリ（`~/.config/opencode/plugins/`）に置かれたレコーダーで記録します — どのセッション・どのフォルダでも、デスクトップアプリも含めて。
- **Gajae-Code** *(実験的)* — `--host gjc` で [Gajae-Code](https://github.com/Yeachan-Heo/gajae-code) のセッションを追尾します（`~/.gjc/agent/sessions/`、インストール不要）。`--host all` にも含まれます。

記録を止めるには `npx @taewooopark/agent-blackbox uninstall`。

<details>
<summary><b>OpenCode を 1 プロジェクトに限定、またはソースから実行</b></summary>

```bash
# OpenCode を 1 プロジェクトだけ記録（レコーダーはグローバルでなく <dir>/.opencode に導入）
npx @taewooopark/agent-blackbox up --project /path/to/your/project

# ソースから（開発 / コントリビュート）
git clone https://github.com/TaewoooPark/Agent-Blackbox
cd Agent-Blackbox && npm install && npm run build:cli
node packages/cli/dist/cli.js up --host claude-code   # または: up | up --host all
```
</details>

マップがライブで組み上がります。以上。

### レシピ

```bash
# Claude Code をただ観察 — 一度起動したら、`claude` を好きな場所で使う
npx @taewooopark/agent-blackbox up --host claude-code
claude   # 任意のフォルダで；ダッシュボードがライブで埋まる

# 両方のホストをまとめて記録し、無料/ローカルモデルに合わせた修正も出させる
npx @taewooopark/agent-blackbox up --host all --suggest ollama --suggest-model qwen2.5-coder

# マルチエージェント — 普段のセッションで委譲すれば各サブエージェントが自分のレーンに分岐
claude "探索・実装・テストをサブエージェントに委譲してから要約して。"

# 続行 — 実行を開き Handoff をクリック、Markdown を次のセッションへ貼る

# ポート変更（47831/5173 が使用中の場合 — レコーダーは自動で再スタンプされる）
npx @taewooopark/agent-blackbox up --host claude-code --port 48000 --ui-port 4000

# 記録を停止（グローバルレコーダー + Claude Code のフックを削除）
npx @taewooopark/agent-blackbox uninstall
```

---

## 一度に二つ

**1 · エージェントが実際にやったことを見る。** コーディングエージェントは多数のファイルを読み、コマンドを走らせ、コードを編集し、サブエージェントを起こし、最後にきれいな要約を渡します。あなたの窓はスクロールするトランスクリプトと、信じるしかない要約だけ。Agent-Blackbox はそれを、一目で読める**セッションマップ**に置き換えます。

**2 · そのコストを見て—削る。** コンテキストはお金、レイテンシ、そして硬いウィンドウ上限そのものです。Agent-Blackbox は各実行のコンテキスト使用効率（キャッシュ再利用、重複読み込み、読み込み対編集の増幅、巨大なツール出力、リトライの無駄）を採点し、**具体的な最適化**を提示します—既定はルールベース、または **API キー不要の無料ローカルモデル**が個別に作成します。

| トランスクリプトを読む | Agent-Blackbox |
|---|---|
| 線形ログをスクロール | 一目で読む**セッションマップ** |
| エージェントの要約を信じる | **観測イベント**から再構成 |
| 「テストは通りました」 | **失敗 → 修正 → 成功**ループを直接見る |
| 長い実行で見失う | 任意の瞬間を**スクラブ・再生** |
| 不透明なひと塊 | **サブエージェント系譜**—誰が何を委譲したか |
| コストが分からない | **コンテキスト効率スコア** + 回収可能トークン |
| 「本当にできた？」 | 二つ目の **outcome** スコア—効率的だが失敗 ≠ 無駄は多いが出荷 |
| すべてのタスクを同じ物差しで測る | **タスク別**（research / debug / ops）+ **自分の過去実行**との比較 |
| 「なぜこんなに高い？」 | **具体的な修正**、必要ならローカルモデルが作成 |
| 続けるには全部読み直し | ワンクリック**ハンドオフ**要約 |
| コードとプロンプトが端末を離れる | **ローカルファースト**、最小収集、**API キー不要** |

---

## ライブで起きる

このマップは事後検死ではありません。**エージェントが働いている最中**に作られます：レコーダーがイベントをローカルデーモンへストリームし、ダッシュボードが WebSocket で更新されます—モーメントが現れ、ファイルが弧で結ばれ、トークンが刻まれ、失敗したテストがオックスブラッドで記され、修正がそれを解消します。リロードも再生も不要。

それが核心です：**飛行が空中にあるうちにブラックボックスを開く。**

---

## できること

- **ライブセッションマップ** — 意味あるモーメントの背骨としてリアルタイムに形成。連続する繰り返しは集約（`Created 12 files`、`Tests passed ×6`）され、大きな実行も一望できます。
- **ナラティブ構造の美学** — フラットでモノクロの "Mark Lombardi" 図：中空のリングノード、リング同士をつなぐ弧、セリフのラベル。紙の上の黒鉛（ライト）またはインクの上のシルバーポイント（ダーク）；唯一のアクセントは**リスク/失敗にのみ使うオックスブラッド**。
- **再生** — 航法図のようなタイムラインを任意の地点へドラッグすると、グラフとファイルがその瞬間の状態に戻ります。
- **クリックでフォーカス** — モーメントを選ぶと詳細ポップオーバー（証拠・ファイル・トークン）、エージェントを選ぶとそのレーンだけを分離、ファイルをクリックするとそれに触れた全モーメントが各ノードのリングから伸びる弧で強調されます。
- **サブエージェント系譜** — 実際の委譲（`task` ツール / 子セッション / workflow fan-out）が自分の枝に分岐し、実作業をしたサブエージェントに帰属します。各レーンは**役割**で命名されます—spawn type、またはタスクプロンプトから抽出（`"You are a literature-search specialist…"` → `literature-search specialist`）—ので、数十の並列エージェントも段落ではなく役割として読めます。密な実行は**読めるズーム**で開き（`%` ボタンはツリー全体に fit）、完了したレーンは ACTIVE のままではなく **DONE** と表示されます。
- **マップ操作** — 入力デバイスに適応するパン・ズームキャンバスです。**トラックパッド：**二本指スワイプでパン、ピンチでズーム。**マウス：**ホイールでズーム（カーソル下をアンカー）、中ボタン（ホイール）ドラッグでパン。どちらでも、空白をドラッグしてノードを矩形**選択**し、ノードクリックでフォーカスできます。ツールバーの `−` / `%` / `+` でズーム（**%** はツリー全体に fit）、**Tracing** は最新ノードを追従またはビュー固定、**Auto layout** は再センタリングします。
- **コンテキスト効率** — **11 指標**（コンテキスト圧、キャッシュヒット、重複読み込み、読み込み増幅、巨大注入、リトライの無駄、産出密度、ツールオーバーヘッド、編集チャーン、大ファイル読み込み、未使用読み込み）からなるライブスコアとワンタップ最適化ノーテーション—**ルールベース、または API キー不要の無料モデルが個別に作成**。`--suggest free` は OpenCode Zen + Ollama cloud + ローカルモデルの独立 quota pool をローテーションし、rate limit になったモデルを冷却して failover するため、長いセッションでも無料の助言が持続します。
- **タスク別・多軸採点** — スコアは**タスクに合う物差し**で判断されます（research 実行は広く読むことで罰せられず、debug 実行はリトライ/手戻りを重く見ます）。別の **outcome** スコアは*タスクが本当に着地したか？*を答え、効率的だが失敗した実行と、無駄は多いが出荷した実行を別物として読ませます。各実行は**同じプロジェクト・同じ種類の過去実行**とも比較されます—*"research の普段 87 点に対して 40 点。"*（完全な参照：**[docs/analysis.md](docs/analysis.md)**。）
- **カスタムチェック** — `.agent-blackbox/rules.json` を置くと、組み込みルールの上にプロジェクトルールを追加できます（例：*`node_modules` を絶対に読まない*、*コミット前にテストを実行*）。検出結果はスコアとは別にパネルへ表示されます。
- **ハンドオフ書き出し** — 構造化された継続要約（目的、関与ファイル、判断、コマンド、失敗、ブロッカー、次の安全な一手）をワンクリックで Markdown コピー。
- **ラン選択** — 1 つのプロジェクトログに複数の実行。コンソールは最も新しい*アクティブ*な実行に追従し、過去の実行も固定できます。
- **完全なイベント網羅** — どのモデルでも、あらゆる行動（読み込み・編集・bash・スキル・カスタム/MCP ツール・権限・todo・サブエージェント、**slash commands、`/compact` コンテキスト圧縮、エージェント/モデル切替**）がホストイベント基準で捕捉されます。既知のノイズ（LSP、pty、file-watcher、MCP registry）はフィルタされ、まだモデル化されていないイベントもラベル付きノードとして表れ、黙って落ちることはありません。
- **ワンコマンド起動** — `npm run up` でレコーダープラグイン導入＋デーモン起動＋ダッシュボード配信。

<p align="center">
  <img src="./docs/screenshots/features.jpeg" alt="Agent-Blackbox 4分割概要：ライトのセッションマップ・ダークモード・コンテキスト効率の副操縦士・ハンドオフ。" width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/focus.jpeg" alt="フォーカスの2分割：モーメントをクリックするとマップが暗転し詳細が出る、エージェントを選ぶとレーンが分離。" width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/replay.jpeg" alt="2分割：タイムラインを中盤までスクラブしてその時点まで巻き戻した再生（OMO サブエージェントが展開し、失敗したテストのモーメントがオックスブラッドで表示）と、'Sharpen advice with a model' で無料モデルが生成した範囲読み込み提案を示す副操縦士。" width="100%">
</p>

---

## コンテキスト効率 — 元が取れる部分

すべての実行は、観測されたサイズとトークンスナップショットから採点されます—エージェントの自己申告ではありません。フラグの立った各指標は具体的な修正へと展開します。

| 指標 | 何を捉えるか |
|---|---|
| **コンテキスト圧** | プロンプトがピークでどれだけ膨らんだか |
| **キャッシュヒット率** | プロンプトのうちキャッシュ提供の割合 |
| **重複読み込み** | 同じファイルを複数回取り込んだ（回収可能トークン付き） |
| **読み込み増幅** | 編集よりはるかに多く読んだ—ファイルでなく該当範囲を |
| **巨大注入** | 単一のツール出力がウィンドウを溢れさせた |
| **リトライの無駄** | 原因修正前に失敗コマンドを再実行 |
| **産出密度** | 1k トークンごとに生んだ具体的変更量 |
| **ツールオーバーヘッド** | 具体的な成果に対するツール呼び出し量 |
| **編集チャーン** | 1 ファイルを何度も書き直す（手戻り / 方針未定） |
| **大ファイル読み込み** | 単一の大きすぎるファイルを丸ごと取り込んだ — 範囲で読む |
| **未使用読み込み** | 読んだが編集しなかったテキスト — 広い探索はサブエージェントへ |

スコアは**タスク別かつ多軸**です—research 実行を edit 実行の物差しで評価せず、「コンテキストをうまく使ったか」と「タスクが着地したか」を分けます：

- **タスク archetype**（research / debug / ops / feature / edit）がスコアを条件づけ、research 実行の広い読み込みを罰しません。分類が十分に確信できた時だけ chip として表示されます。
- **有効性** — 二つ目のスコア（*タスクは本当に着地したか？*）は outcome + verification + failure シグナルから計算され、confidence flag を伴います。効率的だが失敗した実行と、無駄は多いが出荷した実行を別々に読めます。
- **相対基準** — *"research の普段 87 点に対して 40 点"* のように、**同じプロジェクトの同種実行**と比較します。
- **カスタムチェック** — `.agent-blackbox/rules.json` でプロジェクトルールを追加できます（例："never read node_modules"、"run tests before committing"）。

完全な参照は **[docs/analysis.md](docs/analysis.md)** を参照してください — すべての指標と閾値、archetype profile、有効性 heuristic、`rules.json` schema、そして既知の制限まで載っています。

提案は**既定でルールベース**（常時動作、依存なし）。モデルに個別作成させるには—**API キー不要**で—`up` をローカル/無料モデルに向けます：

```bash
# 無料で持続する既定：独立 quota pool の無料モデルをローテーション
npx @taewooopark/agent-blackbox up --suggest free

# Ollama：ローカル、キー不要
npx @taewooopark/agent-blackbox up --suggest ollama --suggest-model qwen2.5-coder

# 任意の OpenAI 互換ローカルサーバ（LM Studio、llama.cpp）
npx @taewooopark/agent-blackbox up --suggest openai-compat --suggest-base-url http://127.0.0.1:1234

# インストール済みバイナリで OpenCode の無料モデルを再利用
npx @taewooopark/agent-blackbox up --suggest opencode --suggest-model opencode/deepseek-v4-flash-free
```

**`--suggest free`**（および既定の `auto`）は、**無料**モデルの pool を**独立 quota pool**にまたがってローテーションします — OpenCode Zen（`opencode/*-free`）+ Ollama cloud + ローカルモデル。呼び出しごとに 1 モデルを使い、負荷を分散するために回転し、rate limit（429）に当たったモデルは 10 分間 cooldown して failover します。すべての pool が尽きた時だけルールベースに戻ります。したがって AI 助言は無料のまま長いセッションでも動き続け、単一 quota を見張る必要がありません。ローカルモデルにも送られるのは**マスキング済みの派生ダイジェスト**だけです：指標の状態・件数・サイズに加え、粗い**オフェンダーラベル—ファイルの basename とコマンドの動詞**（例：`billing.ts ×2`、`deploy ×2`。何を直すべきか示すため）—ただし**ファイル内容・ディレクトリパス・コマンド引数・プロンプト・秘密は決して送りません**。

### 助言の根拠

助言は一般論ではありません。常時オンのルールベースの土台もローカルモデルのプロンプトも、指標ごとの**修正プレイブック**を内蔵し、すべての助言はこの実行の実数値を引用し、問題のファイル/コマンドを名指しし、具体的なメカニズムと期待効果を述べるよう強制されます。プレイブックは以下のコンテキストエンジニアリング研究・本番事例から抽出しています：

| 出典 | 貢献 | 関連指標 |
|---|---|---|
| Anthropic — [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | **コンパクション**（解決済みのターンを要約 → 新しいウィンドウで再開）、処理済みツール出力のクリア、**サブエージェントのコンテキスト分離**（子で探索し ~1–2k トークンの要約のみ返す）、**ジャストインタイム取得**（grep/glob で必要時に読み、全ファイルの事前ロードを避ける） | `context-pressure`、`read-amplification`、`redundant-reads`、`yield-density` |
| Manus — [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | **KV キャッシュ命中率**が主要なコストレバー（キャッシュ済みトークンは約 10× 安い）、プロンプト接頭辞をバイト単位で安定（タイムスタンプ・揮発データを置かない）、追記のみのコンテキスト、ツールの追加/削除でなくマスキング、ファイルシステムを外部メモリに、各ステップで目標の**リサイテーション** | `cache-hit`、`large-injections`、`retry-waste` |
| Liu ほか — [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) | モデルは長いコンテキストの**中間を体系的に活用しきれない**（U 字の精度、30%+ 低下）—— ゆえに「足す」より刈り込み/再配置・目標のリサイテーションを推奨 | `context-pressure`、`yield-density` |
| Anthropic — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 最小で**重複のないツールセット**と明確なツール境界；探索的な呼び出しの連鎖でなく関連動作をまとめる | `tool-overhead` |
| Schulhoff ほか — [The Prompt Report: A Systematic Survey of Prompt Engineering Techniques](https://arxiv.org/abs/2406.06608) | 対比的な few-shot（悪い・曖昧 vs 良い・具体）、与えた数値への接地、厳密な構造化出力 —— 小型ローカルモデルでも具体的で実行可能な JSON を返させる | *（助言プロンプト自体を形作る）* |

小型ローカルモデルでエンドツーエンド検証済み：「重複読み込み」の指摘が「各ファイルは一度だけ読む」から **「`calculator.js` を 2 回読み込み（約 282 回収可能）—— 一度だけ読んでキャッシュし、編集後はファイル全体ではなく変更された行範囲のみ再読する。」** に変わります。

### ループを閉じる — 修正を書き戻す *(実験的)*

手で再適用しなければならない助言は摩擦です。`optimize` は発見を小さな **cache-safe** メモリブロックに変え、エージェントがすでにコンテキストとして読むファイル — **Claude Code なら `CLAUDE.md`、OpenCode なら `AGENTS.md`** — に書き込みます。すると*次の*実行は、無駄が起きる前に避けられます。これは**実行をまたいで蓄積**されます：繰り返し現れたパターンは `×N` として上位に来て、一回限りのものは薄れていくため、このブロックは直近 1 回ではなくプロジェクトの実際の癖を反映します。レコーダーの actuator 側です：観測 → 診断 → **書く → 測る → 効かなければ戻す**。

```bash
# 書き込む内容をプレビュー（変更なし）
npm run optimize -- --project ~/code/my-app

# 適用：CLAUDE.md / AGENTS.md に管理ブロックを追加 + ベースラインスコア記録
npm run optimize -- --project ~/code/my-app --apply

# 次の実行後に効いたか確認 — 明確なスコア低下なら自動ロールバック
npm run optimize -- --project ~/code/my-app --check

# いつでも取り消し
npm run optimize -- --project ~/code/my-app --revert
```

ブロックは**ファイル末尾の marker の間**に書かれるため、安定した prompt-cache prefix を乱しません。具体的な offender（1 回だけ読むべきファイル、scope を絞るべき大きな出力、再利用すべき検証済み build/test コマンド）を名指しし、完全に可逆です — すべての書き込みは明示され、opt-in で、黙って行われることはありません。

ダッシュボード派なら、右レールの **Optimize future runs** ボタンがポップアップを開き、何かを書く前に*正確な*ブロックをプレビューします — 回収可能トークン目標と対象パス付き — そのままワンクリックで適用・更新・取り消しできます。助言ではなく、実際に取り消し可能なファイル変更です：

<p align="center">
  <img src="./docs/screenshots/optimize-modal.jpeg" alt="Agent-Blackbox ダッシュボードの 'Optimize future runs' ポップアップ：'Not applied' バッジ、対象の AGENTS.md パス、そして書き込まれるメモリブロックのプレビュー（検証済みの 'npm test' コマンドを再利用、calculator.js・parser.js・calculator.test.js は一度だけ読み、以降は変更行範囲のみ再読込）と 'Apply to AGENTS.md'・'Cancel' ボタンが、フェードしたセッションマップの上に表示される。" width="380">
</p>

#### 実際の実行で測定

実際の **oh-my-openagent `ultrawork`** 実行での公平な前後比較です（Claude Sonnet が多エージェントチーム全体を駆動；同じタスク — *"modulo operation を end-to-end で追加"*）。Run A の explore サブエージェントは 9 ファイルを再読込しました。Agent-Blackbox はそれを検出し、*「`calculator.js`、`parser.js`、`formatter.js` は一度だけ読め」*を `AGENTS.md` に固定しました。Run B — **同じタスク、同じモデル、完全に新しい cold session、追加されたのはメモリだけ** — では各ファイルを一度だけ読みました：

| | 前 (run A) | 後 (run B) |
|---|---|---|
| コンテキスト効率スコア | 80 | **99** |
| 冗長な再読込 | 9 ファイル（~1.8k 回収可能） | **なし** |
| 総トークン | 939k | **521k**（−44%） |
| ツール呼び出し/イベント | 619 | **253** |
| 産出密度 | 63/k | **154/k** |

両実行とも、同一の pristine repo（間で git reset）と brand-new OpenCode session から開始しました — 引き継いだ文脈はありません。冗長な再読込の消滅（9 ファイル → なし）は、メモリが直接効いた部分です。OMO は stochastic なので token/event の低下の一部は run-to-run variance ですが、ABB が固定したレバーはまさに消えた無駄です。

<table>
<tr>
<td width="50%"><img src="./docs/screenshots/optimize-before.jpeg" alt="前：80 点、冗長な再読込 9 ファイル（calculator.js・parser.js・formatter.js ×3）をフラグ、939k トークン。" width="100%"></td>
<td width="50%"><img src="./docs/screenshots/optimize-after.jpeg" alt="後：99 点、『無駄は検出されず』、521k トークン。" width="100%"></td>
</tr>
</table>

> ⚠️ この `--check` の 2 実行 cycle は**メカニズム検証用のベンチマーク**であり、本番ワークフローではありません。同じタスクを再実行して測るとトークンを 2 倍使います。実運用では一度適用し、そのメモリがそのリポジトリの*以後の別タスク*（再利用するコマンド、一度だけ読むファイル）で**追加実行なし**に効きます。

### 実行内オプティマイザ — 再実行なしでライブに無駄を削る *(opt-in)*

上の cross-run メモリは*未来*のタスクで効きます。実行内オプティマイザは**現在の実行の中で**無駄を削ります — レコーダーが純粋な受動観測者ではなくなり、OpenCode tool hooks を通じて再読込を安く提供します。`AGENT_BLACKBOX_OPTIMIZE=1`（またはインストール時の `--optimize`）で有効化し、既定では off です。

- **再読込を no-op または diff として提供。** エージェントがこの実行で既に読んだファイルを再度読むと、`tool.execute.after` hook が結果を書き換えます：*変更なし* → 「以前のコピーを再利用せよ」という 1 行 note；*編集済み* → 変更された行範囲だけ。120 行ファイルで測定：**未変更の再読込は 96% 少ないトークン、編集済みの再読込は 94% 少ないトークン** — 同じ実行内で、再実行なし。
- **構造上正しい。** 再読込は決してブロックしません（本当に必要な場合があるため）。no-op/diff は、最後にそのファイルを提供してから**compaction が起きていない**時だけ発火します — 内容がまだコンテキストにあると証明できる場合です。compaction 後は、エージェントが失っている可能性があるため full file を再提供します。
- **Working-set memory をライブ注入。** `experimental.chat.system.transform` により、観測イベントから派生した小さく常に最新のブロック（hot files + verified commands）を system prompt に追加し、エージェントが再読込より記憶を優先できるようにします。

#### 次にやること

- **Longitudinal trend** — Agent-Blackbox はすべての実行を記録します。実際の作業における効率スコアを時系列で可視化し、memory + optimizer の導入後に上がるか示せます — benchmark ではなく実作業の測定。
- **Compaction をまたぐ diff-serving** — 小さなローカル content cache を持ち、compaction 後の再読込も diff として提供できるようにする（現在は full file に fallback）。

---

## oh-my-openagent と組み合わせる — 重い多エージェント実行をプロファイルして削減

[**oh-my-openagent (OMO)**](https://github.com/code-yeongyu/oh-my-openagent) は OpenCode を多エージェントの *tokenmaxxer* ハーネスに変えます — 11 の専門エージェント、並列実行、複雑な仕事を仕上げるためにトークンを惜しみなく注ぐ執拗なループ。Agent-Blackbox はまさにそのワークロードのための計器です：**OMO がアクセルを踏み、Agent-Blackbox がダイノでありテレメトリ。**

どちらも OpenCode プラグインで、設定なしで共存します — レコーダーを入れたまま OMO を走らせれば、チーム全員が現れます：

- **チーム全体が見える。** SDK で生成された各サブエージェント（Sisyphus, explore, librarian, plan, oracle…）が自分のレーンを持ち、委譲が幹から分岐し、ファイルが弧で結ばれます。この複雑さのために作られた地図です。
- **コストを見て — 削る。** 「tokenmaxxer」実行こそコンテキスト経済が最も効く場面です。Agent-Blackbox が採点し（コンテキスト圧力・重複再読込・読み込み増幅・ツールオーバーヘッド）、正確な原因を名指しします — ハーネスの内側からは見えないコストを。
- **ループを閉じる。** 発見を `AGENTS.md` に固定して次の実行に効かせ、実行内オプティマイザ（`AGENT_BLACKBOX_OPTIMIZE=1`）を有効にして再読込をノーオペ/差分で返す — *同じ*実行の中で節約、再実行なしで。

実際の OMO `ultrawork` 実行を Agent-Blackbox がライブ記録した様子 — 左に名前付きの専門エージェントレーン、右に回収可能トークンと個別最適化提案付きのコンテキスト効率スコア：

<p align="center">
  <img src="./docs/screenshots/omo-synergy.jpeg" alt="実際の oh-my-openagent ultrawork セッションをプロファイルする Agent-Blackbox：左の列に名前付きの専門エージェントレーン（Sisyphus - ultraworker, plan）、1 つのレーンを選択するとその枝だけが明るく残り他はフェード、右の列に 72 のコンテキスト効率スコアと冗長な再読込・リトライ浪費のフラグおよび回収可能トークンを表示。" width="100%">
</p>

```bash
# どちらもグローバル導入 — ABB を一度起動したら OMO を普段どおり。:5173 で確認。
npx @taewooopark/agent-blackbox up --suggest free
opencode "ultrawork: refactor the auth module and add tests"   # OMO とレコーダーが同時に動作
```

---

## ハンドオフ — どこでも引き継ぐ

別の場所で続けるとき—チームメイト、次のエージェント、あるいはコンテキストリセット後の同じエージェント—構造化された**ハンドオフ**を書き出します：

<p align="center">
  <img src="./docs/screenshots/handoff.jpeg" alt="Agent-Blackbox ハンドオフ要約 — 目的・観測・関与ファイル・判断・コマンド・ブロッカー・次の安全な一手を載せた紙のカード、ワンクリックで Markdown コピー。" width="100%">
</p>

---

## 仕組み

```
 Claude Code transcripts (tailed) ─┐
 Codex rollout sessions (tailed) ──┼─▶ host adapter ─▶ daemon ─▶ dashboard
 OpenCode hooks → recorder plugin ─┘
                                       redact+normalize  NDJSON    live session map
                                                         + graph   + efficiency
```

- **`packages/core`** — 正規 `TraceEvent`、ワークフローグラフモデル、マスキング、再生、監査、ハンドオフ生成、コンテキスト効率エンジン。
- **`packages/claude-code-adapter`** — Claude Code が書き出す JSONL トランスクリプト（`~/.claude/projects/`）を追尾し、正規・マスキング済みイベントに変換する — プラグイン不要、インストール不要。オプションのフックで実行内アクチュエータを追加。
- **`packages/codex-adapter`** — Codex CLI/デスクトップアプリの rollout セッション（`$CODEX_HOME/sessions`）を追尾し、token・patch・search・MCP・compaction・subagent 信号を正規化。任意の信頼済みフックで安全な再読抑制と working-set コンテキストを追加。
- **`packages/opencode-adapter`** — ホストイベントとツール呼び出しを正規・マスキング済みイベント（内容ではなく*サイズ*のみ）に変換し、デーモンへベストエフォート（リトライ付き）で送る軽量 OpenCode プラグイン。
- **`apps/daemon`** — イベントをローカル NDJSON ログへ取り込み、グラフ化、任意地点へ再生、効率レポート計算、提案ルーティング、WebSocket でライブスナップショット送出。
- **`apps/dashboard`** — オペレーターコンソール：ライブセッションマップ、再生、インスペクタ、効率副操縦士、ハンドオフ。

---

## 哲学 — 観測せよ、語り手を信じるな

> **真実は観測イベントから引き出せ、自由記述の自己申告からではなく。**

- **語りでなく行動。** すべてのノードはエージェントが実際に発したイベント—読み込み、編集、コマンドと終了コード、委譲。
- **コストも証拠。** 効率スコアとすべての提案は、観測されたサイズとトークンスナップショットから来ます。
- **ローカルファースト、キー不要。** トレースはあなたのマシンに残ります。プロンプト・秘密・ファイル内容は既定でマスキング、任意のモデル提案もローカルで動きマスキング済みダイジェストのみ受け取ります。
- **ホスト非依存のコア。** 正規イベント＋グラフのコアに軽量アダプタ—同じブラックボックスがどのハーネスの背後にも。**Claude Code と OpenCode** が最初の 2 つです。

---

## デーモン API

| メソッド & パス | 用途 |
|---|---|
| `POST /events` | 正規 `TraceEvent` を取り込む |
| `GET /events` | 永続イベントログ |
| `GET /graph?seq=<n>` | あるシーケンスまでのグラフ再生 |
| `GET /snapshot?seq=<n>` | イベント・グラフ・監査チェック・効率 + **effectiveness** レポート・**baselines**・**rule packs**・ハンドオフ Markdown |
| `GET /audit` | Promise / claim checks |
| `GET /efficiency?seq=<n>` | コンテキスト効率レポート（スコア + 指標 + archetype） |
| `POST /suggest` | 投稿レポート + 任意の causal timeline への最適化提案（決定論的またはローカルモデル） |
| `GET·POST /optimize[/apply\|/revert]?runId=<id>` | 実行のメモリブロックをプレビュー / 適用 / 取り消し（可逆ファイル書き込み） |
| `GET /handoff` | 生成されたハンドオフ Markdown |
| `WS /stream` | 取り込みごとにライブスナップショット送出 |

---

## プロジェクト構成

```text
apps/
  daemon/             ローカル取り込み、再生、効率、提案ルーティング、静的ダッシュボード、websocket
  dashboard/          オペレーターコンソール（セッションマップ、再生、インスペクタ、効率、ハンドオフ）
packages/
  core/               正規イベント、グラフ、マスキング、再生、監査、ハンドオフ、効率、
                      archetypes、effectiveness、baselines、累積メモリ、timeline、rule packs
  storage/            NDJSON 永続化
  claude-code-adapter/ Claude Code transcript tailer + 実行内 actuator hooks
  codex-adapter/      Codex CLI/app rollout tailer + 実行内 actuator hooks
  opencode-adapter/   OpenCode plugin / SDK bridge
```

デーモンが書き込むプロジェクト別状態（すべてローカル、best-effort、可逆）は `<project>/.agent-blackbox/` に置かれます：`optimization.json` + `efficiency-profile.json`（累積メモリ）、そして追加できる `rules.json`（カスタムチェック）。実行をまたぐ baseline は、デーモンのイベントストア横の `baselines.json` に保存されます。**[docs/analysis.md](docs/analysis.md)** を参照してください。

---

## 開発

```bash
npm install
npm run check   # 型チェック + テスト
npm run build
```

---

## ロードマップ

- 同じ正規コア上で、より多くの host adapters（PI、その他 harness）を追加 — **Claude Code、Codex、OpenCode** は現在出荷済み。
- **最近出荷：**二つ目の **outcome** 軸、**task-archetype** scoring、**プロジェクト別 baselines**（"普段の実行との比較"）、**累積型** optimize memory、**custom rule packs** — 詳細は **[docs/analysis.md](docs/analysis.md)**。
- 多数の実行にまたがる **fleet-wide** 効率トレンドチャート（各実行の baseline データはすでにローカルに保存され、longitudinal view が次）。
- より深い audit：claim-vs-evidence 検証と risky-command 表示を拡充。

---

## 連絡先

<p align="center">
  <a href="https://github.com/TaewoooPark"><img src="https://img.shields.io/badge/-GitHub-181717?style=for-the-badge&logo=github&logoColor=white&cacheSeconds=3600" alt="GitHub"></a>
  <a href="https://x.com/theoverstrcture"><img src="https://img.shields.io/badge/-X-000000?style=for-the-badge&logo=x&logoColor=white&cacheSeconds=3600" alt="X (Twitter)"></a>
  <a href="https://www.linkedin.com/in/taewoo-park-427a05352"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white&cacheSeconds=3600" alt="LinkedIn"></a>
  <a href="https://www.instagram.com/t.wo0_x/"><img src="https://img.shields.io/badge/-Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white&cacheSeconds=3600" alt="Instagram"></a>
  <a href="https://taewoopark.com"><img src="https://img.shields.io/badge/-taewoopark.com-000000?style=for-the-badge&logo=safari&logoColor=white&cacheSeconds=3600" alt="Personal site"></a>
  <a href="mailto:ptw151125@kaist.ac.kr"><img src="https://img.shields.io/badge/-Email-D14836?style=for-the-badge&logo=gmail&logoColor=white&cacheSeconds=3600" alt="Email"></a>
</p>

<p align="center"><sub>ローカルファースト。API キー不要。観測せよ、語り手を信じるな。</sub></p>
