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
  <img src="https://img.shields.io/badge/OpenCode-000000?style=flat-square&labelColor=000000&color=000000" alt="OpenCode">
  <img src="https://img.shields.io/badge/Local--first-000000?style=flat-square&labelColor=000000&color=000000" alt="Local-first">
  <img src="https://img.shields.io/badge/API%20key%20不要-000000?style=flat-square&labelColor=000000&color=000000" alt="No API key">
</p>

Agent-Blackbox は、**コーディングエージェントのためのローカルファースト（local-first）なフライトレコーダー兼コンテキスト効率プロファイラ**です。すべての実行を—何を読み、変更し、実行し、判断し、委譲し、詰まり、検証したか—エージェント自身の要約ではなく**観測されたイベント**から再構成し、**ライブで再生可能な操作グラフ**に変えます。さらに、その実行が**コンテキストウィンドウをどれだけ無駄なく使ったか**を計測し、次の実行をより安く・速くする方法を具体的に示します。

**[Claude Code](https://www.claude.com/product/claude-code) と [OpenCode](https://opencode.ai) に対応** — 同じレコーダー、同じマップ、同じ効率スコア。どちらか一方でも、両方同時でも記録できます。

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

**1 コマンド。Claude Code と OpenCode に対応**（Node 20+ が必要）：

```bash
# Claude Code を記録 — インストール不要；デーモンが
# すでに書き出されているセッショントランスクリプト（~/.claude/projects/）を追尾する
npx @taewooopark/agent-blackbox up --host claude-code

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
- **OpenCode** は**グローバル**プラグインディレクトリ（`~/.config/opencode/plugins/`）に置かれたレコーダーで記録します — どのセッション・どのフォルダでも、デスクトップアプリも含めて。

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
- **サブエージェント系譜** — 実際の委譲（`task` ツール / 子セッション）が自分の枝に分岐し、実作業をしたサブエージェントに帰属します。
- **コンテキスト効率** — ライブスコア + 指標メーター（コンテキスト圧、キャッシュヒット、重複読み込み、読み込み増幅、巨大注入、リトライの無駄、産出密度）とワンタップ最適化ノーテーション—**ルールベース、または無料/ローカルモデルへルーティング（API キー不要）**。
- **ハンドオフ書き出し** — 構造化された継続要約（目的、関与ファイル、判断、コマンド、失敗、ブロッカー、次の安全な一手）をワンクリックで Markdown コピー。
- **ラン選択** — 1 つのプロジェクトログに複数の実行。コンソールは最も新しい*アクティブ*な実行に追従し、過去の実行も固定できます。
- **完全なイベント網羅** — どのモデルでも、あらゆる行動（読み込み・編集・bash・スキル・カスタム/MCP ツール・権限・todo・サブエージェント）がホストイベント基準で捕捉されます（モデル非依存）。
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

提案は**既定でルールベース**（常時動作、依存なし）。モデルに個別作成させるには—**API キー不要**で—`up` をローカル/無料モデルに向けます：

```bash
# Ollama（推奨）：ローカル、キー不要
npx @taewooopark/agent-blackbox up --suggest ollama --suggest-model qwen2.5-coder

# 任意の OpenAI 互換ローカルサーバ（LM Studio、llama.cpp）
npx @taewooopark/agent-blackbox up --suggest openai-compat --suggest-base-url http://127.0.0.1:1234

# インストール済みバイナリで OpenCode の無料モデルを再利用
npx @taewooopark/agent-blackbox up --suggest opencode --suggest-model opencode/deepseek-v4-flash-free
```

`--suggest auto`（既定）は上記を順に探し、ルールベースへフォールバックします。ローカルモデルにも送られるのは**マスキング済みの派生ダイジェスト**だけです：指標の状態・件数・サイズに加え、粗い**オフェンダーラベル—ファイルの basename とコマンドの動詞**（例：`billing.ts ×2`、`deploy ×2`。何を直すべきか示すため）—ただし**ファイル内容・ディレクトリパス・コマンド引数・プロンプト・秘密は決して送りません**。

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

発見を手で移す必要はなく、**ダッシュボードから直接** — 右の列の **Optimize future runs** ボタンを押すと、`AGENTS.md` に書き込まれるブロックを*そのままプレビュー*し（回収可能トークンと対象パス付き）、ワンクリックで適用・更新・取り消しまで行えます。助言ではなく、実際に取り消し可能なファイル変更です：

<p align="center">
  <img src="./docs/screenshots/optimize-modal.jpeg" alt="Agent-Blackbox ダッシュボードの 'Optimize future runs' ポップアップ：'Not applied' バッジ、対象の AGENTS.md パス、そして書き込まれるメモリブロックのプレビュー（検証済みの 'npm test' コマンドを再利用、calculator.js・parser.js・calculator.test.js は一度だけ読み、以降は変更行範囲のみ再読込）と 'Apply to AGENTS.md'・'Cancel' ボタンが、フェードしたセッションマップの上に表示される。" width="100%">
</p>

**実測 — 同じ OMO `ultrawork` タスクの公平な前後比較**（Claude Sonnet、同一タスク・コールドセッション、`AGENTS.md` だけ追加）：Run A では explore サブエージェントが 9 ファイルを再読込 → ABB が*「これらは一度だけ読め」*を `AGENTS.md` に固定 → 同じタスクをコールドで再実行した Run B では再読込が消滅。両実行とも同一のクリーンなリポジトリ（途中で git reset）と新規セッションから開始 — 引き継いだ文脈なし。

| | 前 (run A) | 後 (run B) |
|---|---|---|
| コンテキスト効率スコア | 80 | **99** |
| 冗長な再読込 | 9 ファイル（~1.8k 回収可能） | **なし** |
| 総トークン | 939k | **521k**（−44%） |
| ツール呼び出し/イベント | 619 | **253** |

<table>
<tr>
<td width="50%"><img src="./docs/screenshots/optimize-before.jpeg" alt="前：80 点、冗長な再読込 9 ファイル（calculator.js・parser.js・formatter.js ×3）をフラグ、939k トークン。" width="100%"></td>
<td width="50%"><img src="./docs/screenshots/optimize-after.jpeg" alt="後：99 点、『無駄は検出されず』、521k トークン。" width="100%"></td>
</tr>
</table>

> ⚠️ この 2 回実行の比較は**メカニズム検証用のベンチマーク**（同じタスクを再実行するとトークンを 2 倍使う）。実運用では一度適用すれば、そのリポジトリの*以降の別*タスクで再実行なしに効く。

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
 OpenCode hooks → recorder plugin ─┴─▶ host adapter ─▶ daemon ─▶ dashboard
                                       redact+normalize  NDJSON    live session map
                                                         + graph   + efficiency
```

- **`packages/core`** — 正規 `TraceEvent`、ワークフローグラフモデル、マスキング、再生、監査、ハンドオフ生成、コンテキスト効率エンジン。
- **`packages/claude-code-adapter`** — Claude Code が書き出す JSONL トランスクリプト（`~/.claude/projects/`）を追尾し、正規・マスキング済みイベントに変換する — プラグイン不要、インストール不要。オプションのフックで実行内アクチュエータを追加。
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
| `GET /snapshot?seq=<n>` | イベント・グラフ・監査・効率レポート・ハンドオフ |
| `GET /efficiency?seq=<n>` | コンテキスト効率レポート（スコア＋指標） |
| `POST /suggest` | 投稿レポートへの最適化提案（決定論的またはローカルモデル） |
| `GET /handoff` | 生成されたハンドオフ Markdown |
| `WS /stream` | 取り込みごとにライブスナップショット送出 |

---

## 開発

```bash
npm install
npm run check   # 型チェック + テスト
npm run build
```

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
