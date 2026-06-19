# Agent-Blackbox

**당신의 코딩 에이전트의 블랙박스를 열어드립니다.**

<p align="center">
  <a href="./README.md">English</a> ·
  <b>한국어</b> ·
  <a href="./README.zh.md">中文</a> ·
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
  <img src="https://img.shields.io/badge/API%20key%20불필요-000000?style=flat-square&labelColor=000000&color=000000" alt="No API key">
</p>

Agent-Blackbox는 **코딩 에이전트를 위한 로컬 우선(local-first) 플라이트 레코더이자 컨텍스트 효율 프로파일러**입니다. 모든 에이전트 실행을 — 무엇을 읽고, 바꾸고, 실행하고, 결정하고, 위임하고, 막혔고, 검증했는지 — 에이전트 자신의 요약이 아니라 **관측된 이벤트로 재구성한 실시간·리플레이 가능한 작업 그래프**로 바꿉니다. 그리고 그 실행이 **컨텍스트 윈도를 얼마나 economically 썼는지 측정**해, 다음 실행을 더 싸고 빠르게 만들 방법을 구체적으로 알려줍니다.

> *"트랜스크립트는 에이전트가 한 *말*이고, 블랙박스는 에이전트가 한 *일* — 그리고 그 *비용*이다."*

[**taewoopark.com** — 제작자 사이트](https://taewoopark.com)

<p align="center">
  <img src="./docs/screenshots/session-map.jpeg" alt="Agent-Blackbox 세션 맵 — Mark Lombardi 내러티브 구조로 렌더된 복잡한 OpenCode 실행." width="100%">
</p>

---

## 한 번에 두 가지

**1 · 에이전트가 실제로 한 일을 본다.** 코딩 에이전트는 파일 수십 개를 읽고, 명령을 돌리고, 코드를 고치고, 서브에이전트를 띄운 뒤 깔끔한 요약을 건넵니다. 당신이 가진 창은 스크롤되는 트랜스크립트와 믿어야만 하는 요약뿐입니다. Agent-Blackbox는 이를 한눈에 읽히는 **세션 맵**으로 대체합니다.

**2 · 그 비용을 보고 — 줄인다.** 컨텍스트는 곧 돈, 지연시간, 그리고 단단한 윈도 한계입니다. Agent-Blackbox는 각 실행이 컨텍스트를 얼마나 economically 썼는지(캐시 재사용, 중복 재읽기, 읽기-수정 증폭, 거대 도구 출력, 재시도 낭비) 점수화하고 **구체적인 최적화**를 제시합니다 — 기본은 규칙 기반, 또는 **API 키 없는 무료 로컬 모델**이 맞춤 작성.

| 트랜스크립트 읽기 | Agent-Blackbox |
|---|---|
| 선형 로그 스크롤 | 한눈에 읽는 **세션 맵** |
| 에이전트 요약을 믿음 | **관측 이벤트**로 재구성 |
| "테스트 통과했어요" | **실패 → 수정 → 통과** 루프를 직접 봄 |
| 긴 실행에서 길을 잃음 | 어느 순간이든 **스크럽·리플레이** |
| 불투명한 한 덩어리 | **서브에이전트 계보** — 누가 무엇을 위임했나 |
| 비용을 알 수 없음 | **컨텍스트 효율 점수** + 회수 가능 토큰 |
| "왜 이렇게 비싸지?" | **구체적 수정안**, 원하면 로컬 모델이 작성 |
| 이어가려면 전부 다시 읽음 | 원클릭 **핸드오프** 요약 |
| 코드·프롬프트가 머신을 떠남 | **로컬 우선**, 최소 캡처, **API 키 불필요** |

---

## 실시간으로 펼쳐지는 화면

맵은 사후 부검이 아닙니다. **에이전트가 일하는 동안** 만들어집니다: 레코더가 이벤트를 로컬 데몬으로 스트리밍하고, 대시보드가 WebSocket으로 갱신됩니다 — 모먼트가 나타나고, 휘어지는 아크로 파일이 연결되고, 토큰이 올라가고, 실패한 테스트가 옥스블러드로 표시되며, 수정이 그것을 해소합니다. 새로고침도 리플레이도 필요 없습니다.

그게 핵심입니다: **비행이 끝나기 전에 블랙박스를 연다.**

---

## 제공 기능

- **실시간 세션 맵** — 의미 있는 모먼트의 척추로 실시간 형성. 연속 반복은 집계(`Created 12 files`, `Tests passed ×6`)되어 큰 실행도 스캔 가능.
- **내러티브 구조 미학** — 평평한 모노크롬 "Mark Lombardi" 다이어그램: 속 빈 링 노드, 휘어지는 링-투-링 아크, 세리프 라벨. 종이 위 그라파이트(라이트) 또는 잉크 위 실버포인트(다크); 유일한 색은 **위험/실패 전용 옥스블러드**.
- **리플레이** — 항법도식 타임라인을 어느 지점으로든 끌면 그래프와 파일이 그 시점 상태로.
- **클릭 포커싱** — 모먼트 선택 시 상세 팝오버(증거·파일·토큰), 에이전트 선택 시 해당 레인만 분리, 파일 클릭 시 그 파일을 건드린 모든 모먼트가 각 노드의 링에서 뻗는 아크로 강조.
- **서브에이전트 계보** — 실제 위임(`task` 도구 / 자식 세션)이 자기 분기로 갈라지고, 일을 한 서브에이전트에 귀속.
- **컨텍스트 효율** — 실시간 점수 + 지표 미터(컨텍스트 압력, 캐시 적중, 중복 읽기, 읽기 증폭, 거대 주입, 재시도 낭비, 산출 밀도)와 원탭 최적화 노테이션 — **규칙 기반, 또는 무료/로컬 모델 라우팅(API 키 불필요)**.
- **핸드오프 내보내기** — 구조화된 인계 요약(목표·관여 파일·결정·명령·실패·블로커·다음 안전한 행동)을 원클릭으로 Markdown 복사.
- **런 피커** — 한 프로젝트 로그에 여러 실행, 콘솔은 가장 최근 *활성* 실행을 따르고 과거 실행도 고정 가능.
- **전체 이벤트 커버리지** — 어떤 모델을 쓰든 모든 행동(읽기·수정·bash·스킬·커스텀/MCP 도구·권한·todo·서브에이전트)이 호스트 이벤트 기준으로 캡처됨(모델 무관).
- **원커맨드 부트스트랩** — `npm run up` 한 줄로 레코더 플러그인 설치 + 데몬 시작 + 대시보드 서빙.

<p align="center">
  <img src="./docs/screenshots/features.jpeg" alt="Agent-Blackbox 4분할 개요: 라이트 세션 맵 · 다크 모드 · 컨텍스트 효율 코파일럿 · 핸드오프." width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/focus.jpeg" alt="포커싱 2분할: 모먼트 클릭 시 맵 dim + 상세 팝오버, 에이전트 선택 시 해당 레인 분리." width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/replay.jpeg" alt="2분할: 타임라인을 중간으로 스크럽한 리플레이, 그리고 로컬 모델로 최적화한 코파일럿." width="100%">
</p>

---

## 컨텍스트 효율 — 스스로 본전을 뽑는 부분

모든 실행은 관측된 크기와 토큰 스냅샷으로 점수를 받습니다 — 에이전트의 자기보고가 아닙니다. 플래그된 지표는 각각 구체적 수정안으로 펼쳐집니다.

| 지표 | 무엇을 잡나 |
|---|---|
| **컨텍스트 압력** | 프롬프트가 최고조에 얼마나 커졌나 |
| **캐시 적중률** | 프롬프트 중 캐시로 제공된 비율 |
| **중복 재읽기** | 같은 파일을 한 번 이상 끌어옴(회수 가능 토큰 포함) |
| **읽기 증폭** | 수정한 양보다 훨씬 많이 읽음 — 파일 말고 구간만 |
| **거대 주입** | 단일 도구 출력이 윈도를 침수 |
| **재시도 낭비** | 원인 수정 전에 실패 명령을 재실행 |
| **산출 밀도** | 1k 토큰당 만든 구체적 변경량 |

제안은 **기본 규칙 기반**(항상 동작, 의존성 없음). 모델이 맞춤 작성하게 하려면 — **API 키 없이** — `up`을 로컬/무료 모델로 가리키면 됩니다:

```bash
# Ollama (권장): 로컬, 키 불필요
npm run up -- --project /path --suggest ollama --suggest-model qwen2.5-coder

# OpenAI 호환 localhost 서버 (LM Studio, llama.cpp)
npm run up -- --project /path --suggest openai-compat --suggest-base-url http://127.0.0.1:1234

# 설치된 바이너리로 OpenCode 무료 모델 재사용
npm run up -- --project /path --suggest opencode --suggest-model opencode/deepseek-v4-flash-free
```

`--suggest auto`(기본)는 위 순서로 탐지 후 규칙 기반으로 폴백합니다. 로컬 모델에도 **redact된 파생 다이제스트**(상태·횟수·크기 — 파일 내용·경로·명령은 절대 안 보냄)만 전송됩니다.

---

## 빠른 시작

```bash
git clone https://github.com/TaewoooPark/Agent-Blackbox
cd Agent-Blackbox
npm install
npm run build

# 한 줄: 레코더 플러그인 설치 + 데몬 시작 + 대시보드 서빙
npm run up -- --project /path/to/your/project
```

출력된 대시보드 URL(기본 `http://127.0.0.1:5173/`)을 열고, 그 프로젝트 안에서 에이전트를 실행하세요(`up`이 정확한 줄을 출력합니다):

```bash
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 \
  opencode run --dir /path/to/your/project \
  "관련 코드를 읽고, 테스트를 돌리고, 결과를 요약해줘."
```

맵이 실시간으로 조립됩니다. 끝.

### 레시피

```bash
# 그냥 관찰 — 아무 프로젝트나 가리키고 시작
npm run up -- --project ~/code/my-app

# 최적화 — 무거운 작업 후 우측 레일의 효율 점수+수정안 확인
npm run up -- --project ~/code/my-app --suggest ollama --suggest-model qwen2.5-coder

# 멀티 에이전트 — 위임하면 각 서브에이전트가 자기 레인으로 분기
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 opencode run --dir ~/code/my-app \
  "탐색·구현·테스트를 서브에이전트에 위임한 뒤 요약해줘."

# 이어가기 — 실행을 열고 Handoff 클릭, Markdown을 다음 세션에 붙여넣기

# 포트 변경 (47831/5173이 점유된 경우)
npm run up -- --project ~/code/my-app --port 48000 --ui-port 4000
```

다른 곳에서 이어가야 할 때 — 팀원, 다음 에이전트, 혹은 컨텍스트 리셋 후 같은 에이전트 — 구조화된 **핸드오프**를 내보내세요:

<p align="center">
  <img src="./docs/screenshots/handoff.jpeg" alt="Agent-Blackbox 핸드오프 요약 — 목표·관측치·관여 파일·결정·명령·블로커·다음 안전한 행동을 담은 종이 카드, 원클릭 Markdown 복사." width="100%">
</p>

---

## 동작 방식

```
 opencode run ──hooks──▶  recorder plugin  ──events──▶   daemon   ──/stream──▶  dashboard
                          redact + normalize            NDJSON 로그           실시간 세션 맵
                          (호스트 어댑터)                + 그래프/리플레이      + 효율
                                                        + 효율 리포트         (이 UI)
```

- **`packages/core`** — 정규 `TraceEvent`, 워크플로 그래프 모델, redaction, 리플레이, audit, 핸드오프 생성, 컨텍스트 효율 엔진.
- **`packages/opencode-adapter`** — 호스트 이벤트와 도구 호출을 정규·redact 이벤트(내용이 아닌 *크기*만 포함)로 바꿔 데몬에 best-effort 전송하는 얇은 OpenCode 플러그인.
- **`apps/daemon`** — 이벤트를 로컬 NDJSON 로그로 적재, 그래프 생성, 임의 지점 리플레이, 효율 리포트 계산, 제안 라우팅, WebSocket 실시간 스냅샷 푸시.
- **`apps/dashboard`** — 오퍼레이터 콘솔: 실시간 세션 맵, 리플레이, 인스펙터, 효율 코파일럿, 핸드오프.

---

## 철학 — 관측하라, 화자를 믿지 마라

> **진실은 관측된 이벤트에서 끌어내라, 자유서술 자기보고가 아니라.**

- **서술이 아니라 행동.** 모든 노드는 에이전트가 실제로 내보낸 이벤트 — 읽기, 수정, 명령과 종료코드, 위임 — 입니다.
- **비용도 증거다.** 효율 점수와 모든 제안은 관측된 크기·토큰 스냅샷에서 나옵니다.
- **로컬 우선, 키 불필요.** 트레이스는 머신에 남습니다. 프롬프트·비밀·파일 내용은 기본 redact, 선택적 모델 제안도 로컬에서 돌고 redact 다이제스트만 받습니다.
- **호스트 무관 코어.** 정규 이벤트+그래프 코어에 얇은 어댑터 — 같은 블랙박스가 어떤 하네스 뒤에도. OpenCode가 첫 번째.

---

## 데몬 API

| 메서드 & 경로 | 용도 |
|---|---|
| `POST /events` | 정규 `TraceEvent` 적재 |
| `GET /events` | 영속 이벤트 로그 |
| `GET /graph?seq=<n>` | 시퀀스까지 그래프 리플레이 |
| `GET /snapshot?seq=<n>` | 이벤트·그래프·audit·효율 리포트·핸드오프 |
| `GET /efficiency?seq=<n>` | 컨텍스트 효율 리포트(점수+지표) |
| `POST /suggest` | 게시된 리포트에 대한 최적화 제안(결정론 또는 로컬 모델) |
| `GET /handoff` | 생성된 핸드오프 Markdown |
| `WS /stream` | 적재마다 실시간 스냅샷 푸시 |

---

## 개발

```bash
npm install
npm run check   # 타입체크 + 테스트
npm run build
```

---

## 컨택

<p align="center">
  <a href="https://github.com/TaewoooPark"><img src="https://img.shields.io/badge/-GitHub-181717?style=for-the-badge&logo=github&logoColor=white&cacheSeconds=3600" alt="GitHub"></a>
  <a href="https://x.com/theoverstrcture"><img src="https://img.shields.io/badge/-X-000000?style=for-the-badge&logo=x&logoColor=white&cacheSeconds=3600" alt="X (Twitter)"></a>
  <a href="https://www.linkedin.com/in/taewoo-park-427a05352"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white&cacheSeconds=3600" alt="LinkedIn"></a>
  <a href="https://www.instagram.com/t.wo0_x/"><img src="https://img.shields.io/badge/-Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white&cacheSeconds=3600" alt="Instagram"></a>
  <a href="https://taewoopark.com"><img src="https://img.shields.io/badge/-taewoopark.com-000000?style=for-the-badge&logo=safari&logoColor=white&cacheSeconds=3600" alt="Personal site"></a>
  <a href="mailto:ptw151125@kaist.ac.kr"><img src="https://img.shields.io/badge/-Email-D14836?style=for-the-badge&logo=gmail&logoColor=white&cacheSeconds=3600" alt="Email"></a>
</p>

<p align="center"><sub>로컬 우선. API 키 불필요. 관측하라, 화자를 믿지 마라.</sub></p>
