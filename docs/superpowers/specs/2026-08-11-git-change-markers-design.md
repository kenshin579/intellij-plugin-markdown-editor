# Git 변경분 마커(gutter change marker) 표시 설계

- 날짜: 2026-08-11
- 상태: 구현 완료 (자동 테스트 397개 통과 · `./gradlew build` 성공 · runIde 에서 마커 표시 확인)
- 미확인 항목: 라이트 테마 대비, 커밋/브랜치 전환 시 baseline 갱신, 실제 삭제 상황의 삼각형 렌더
- 대상 저장소: `markora/` (Kotlin + frontend)

## 배경 / 문제

JetBrains IDE는 VCS 하위 파일을 편집할 때 gutter에 변경 마커를 그린다. 추가된 줄은 초록 바, 수정된 줄은 파란 바, 삭제 지점은 삼각형이다. "이번에 내가 뭘 건드렸는지"를 문서를 훑으며 즉시 파악할 수 있어 실사용 가치가 크다.

Markora 탭에는 이 표시가 없다. 같은 `.md` 파일이라도 기본 `Markdown Split Editor` 탭에서는 마커가 보이고 Markora 탭에서는 안 보인다.

### 근본 원인

IDE의 gutter 마커는 `Document` 위에 붙는 `LineStatusTracker`가 그린다. 즉 **텍스트 에디터(`TextEditor`)의 기능**이다.

Markora의 에디터는 `MarkdownFileEditor : UserDataHolderBase(), FileEditor`로, `TextEditor`가 아니라 JCEF 브라우저 패널 한 장을 `getComponent()`로 돌려주는 구조다. gutter 컬럼 자체가 존재하지 않으므로 IDE가 대신 그려줄 방법이 없다. **직접 그려야 한다.**

### 진짜 난제: 라인 → 블록 매핑

마커를 그리는 것보다 "어디에 그릴지"가 어렵다. 두 가지 불일치가 겹친다.

**1. 블록은 소스 위치를 갖지 않는다.** 마크다운 → BlockNote 블록 변환(`parseMarkdownWithDetails` → `postParse`)은 소스 라인 정보를 버린다. git diff가 알려주는 "원본 12번째 줄이 바뀜"을 화면상 어느 블록에 대응시킬 방법이 현재 코드에 없다.

**2. 마크다운 왕복이 문자 단위로 무손실이 아니다.** `saveGuard`가 존재하는 이유가 이것이다. HEAD blob 원문과 에디터가 직렬화한 텍스트를 라인 단위로 비교하면, 사용자가 건드리지도 않은 줄이 변환 차이 때문에 "변경됨"으로 대량 오탐한다.

### 유리한 조건

`frontend/src/search/searchPlugin.ts`가 이미 ProseMirror decoration으로 문서를 변경하지 않고 하이라이트를 입히는 선례를 만들어 두었다. 마커 렌더링은 이 패턴을 그대로 재사용한다.

`.bn-editor`가 `padding-inline: 54px`을 가지므로 좌측에 54px 여백이 이미 있다. BlockNote의 drag handle과 `+` 버튼은 이 여백의 안쪽(콘텐츠 바로 옆)에 붙으므로, 가장 왼쪽 끝 몇 px은 gutter로 쓸 수 있다. 별도 컬럼 레이아웃이 필요 없다.

## 목표 / 스코프

- **표시 전용.** 추가/수정/삭제 위치를 시각적으로 표시한다. 마커 클릭 시 이전 내용 팝업이나 rollback은 범위 밖.
- **블록 단위 해상도.** 소스 라인 단위가 아니라 BlockNote 블록 단위로 표시한다.
- **본문(body)만 대상.** frontmatter 변경 표시는 범위 밖(`FrontmatterPanel`이 별도 컴포넌트라 렌더링이 다른 작업).
- **IDE 팔레트 연동은 범위 밖.** 1차는 CSS 변수 하드코딩(라이트/다크 2세트).

### 블록 단위 해상도의 대가

받아들이기로 한 손해를 명시한다.

- 표는 통째로 한 블록이다. 셀 하나만 고쳐도 표 전체에 마커가 붙는다.
- 코드블록 / Mermaid / KaTeX 블록도 각각 한 블록이다. 다이어그램 한 줄 수정 시 블록 전체가 표시된다.
- 하드랩된 여러 줄 문단은 한 블록이다.

리스트는 항목별로 블록이 나뉘므로 자연스럽게 맞는다. 위 손해는 정보 손실이 아니라 과잉 표시이므로 "내가 뭘 건드렸나"를 훑는 목적에는 무해하다고 판단했다.

### 얻는 것

블록 단위로 확정하면 **양쪽을 동일한 파싱 파이프라인에 통과시킨 뒤 블록끼리 비교**할 수 있다. 그러면:

- 라인 → 블록 매핑 문제가 사라진다(매핑이 필요 없어진다).
- **왕복 노이즈가 자동 상쇄된다.** baseline과 현재 문서가 똑같은 변환을 거치므로, 변환이 만들어낸 차이는 diff에 나타나지 않고 사람이 만든 차이만 남는다.

이 두 번째 항목이 이 설계 전체의 전제다.

## 접근법

### 선택: Kotlin은 baseline 원문만 제공, diff는 프론트에서

Kotlin이 HEAD 원문을 그대로 넘기고, 프론트가 그 원문을 **현재 문서와 완전히 동일한 파이프라인**으로 파싱해 블록 리스트를 만든 뒤 `editor.document`와 비교한다.

```
Kotlin                          Frontend
──────                          ────────
ChangeListManager
  .getChange(file)
  ?.beforeRevision?.content
       │
       │  GET /markora/api/vcs/baseline?path=...
       └──────────────────────────▶ splitFrontmatter
                                    rewriteImagePathsForDisplay
                                    maskTableImages / maskTableBreaks
                                    parseMarkdownWithDetails
                                    postParse
                                         │
                                    baseline 블록 리스트 (캐시)
                                         │
                                         ├──▶ blockKey[]  ─┐
                                         │                 ├─▶ blockDiff ─▶ 상태 맵
                     editor.document ────┴──▶ blockKey[]  ─┘                  │
                                                                              ▼
                                                                    vcsPlugin (Decoration)
```

`editor.tryParseMarkdownToBlocks`는 블록 배열을 반환할 뿐 문서를 변경하지 않는다(`parseMarkdownWithBlockquotes`에서 확인). 따라서 같은 `editor` 인스턴스로 baseline을 파싱해도 안전하다. 이 성질이 성립해야 이 접근법이 가능하다.

### 기각한 대안

**`LineStatusTracker`에서 라인 범위를 받아온다.** `LineStatusTrackerManager.getInstance(project).getLineStatusTracker(document).getRanges()`로 IDE와 100% 동일한 판정을 짧은 코드로 얻을 수 있다. 그러나 받는 것이 라인 범위라 블록으로 매핑할 방법이 없고 — 블록 단위 해상도를 택해 피한 바로 그 문제다 — 왕복 노이즈도 그대로 노출된다.

**Kotlin에서 baseline까지 파싱해 블록 diff를 Kotlin이 수행.** 마크다운 → 블록 변환 로직이 프론트에만 존재하므로 Kotlin에 재구현해야 한다. 진실의 소스가 둘로 갈라져 영구히 어긋난다.

## 설계

### 컴포넌트 경계

기존 `frontend/src/search/` 디렉터리 구조를 대칭시킨다.

**Kotlin — 신규 1개 파일**

`src/main/kotlin/com/github/kenshin579/markora/controller/VcsBaselineController.kt`

`PreviewStaticServer.process()`에 `api/vcs/baseline` 라우팅을 직접 추가한다(자동 발견 없음).

요청: `GET /markora/api/vcs/baseline?path=<절대경로>`

응답:

| 조건 | status | content |
|------|--------|---------|
| `ProjectLevelVcsManager.getVcsFor(file) == null` | `unavailable` | `null` |
| change 없음 (VCS 하위, 미변경) | `unchanged` | 현재 디스크 본문 (= HEAD 본문) |
| change 있고 `beforeRevision == null` (신규 파일) | `untracked` | `null` |
| change 있고 `beforeRevision` 존재 | `changed` | HEAD 원문 |

`unchanged`에도 본문을 실어 보낸다. `null`로 두면 자동저장(1초 디바운스)이 실행되기 전에 편집한 내용이 마커에 반영되지 않는 구간이 생긴다. 미변경 파일은 디스크 본문이 곧 HEAD 본문이므로 그대로 넘기면 되고, 프론트는 `changed`와 `unchanged`를 동일하게 처리한다.

`unavailable`은 재조회 자체가 무의미하므로 프론트가 폴링을 끈다. `untracked`는 비교 대상이 없어 마커가 0개다.

**프론트 — 신규 디렉터리 `frontend/src/vcs/`**

| 파일 | 역할 | 성격 |
|------|------|------|
| `blockKey.ts` | 블록 하나 → 안정적 문자열 키 | 순수 함수 |
| `blockDiff.ts` | 키 배열 2개 → 블록별 상태 + 삭제 위치 | 순수 함수 |
| `vcsPlugin.ts` | 상태 맵 → `Decoration.node` | ProseMirror 플러그인 |
| `useVcsMarkers.ts` | baseline fetch / 캐시 / 파싱 / diff 호출 | 부수효과 전담 |

추가 변경: `bridge/markora.ts`에 `fetchVcsBaseline()` 추가(mock bridge 포함), `styles.css`에 마커 스타일.

이 경계의 핵심은 **버그가 날 곳이 전부 순수 함수 안에 있다**는 점이다. 블록 키 생성과 diff 판정이 이 기능의 어려운 부분 전부이며, 둘 다 입력→출력이 명확해 vitest로 완전히 덮인다.

`Editor.tsx`는 이미 343줄에 `useEffect` 8개다. VCS 로직을 직접 넣으면 더 두꺼워지므로 훅 한 줄 호출로만 끝낸다.

### 블록 키 (`blockKey.ts`)

BlockNote의 `block.id`는 파싱할 때마다 새로 생성되므로 키로 쓸 수 없다. 내용 기반이어야 한다.

**블록 JSON을 정규화하는 동기 함수**로 구현한다. `id` 제거, `type` + `props` + inline content(텍스트 + 스타일)를 재귀 직렬화.

블록을 개별 마크다운으로 직렬화해 문자열을 키로 쓰는 대안도 있으나, 블록 수만큼 async 호출이 들고 details/table 마스킹이 단일 블록 직렬화에서 전체 직렬화와 다르게 동작할 위험이 있어 채택하지 않는다.

**children은 키에 포함하지 않는다.** 포함시키면 자식이 바뀔 때 부모까지 변경으로 잡혀 마커가 이중으로 뜬다. 대신 키에 depth를 섞어 서로 다른 레벨의 블록이 잘못 매칭되지 않게 한다(들여쓰기만 바꿔도 수정으로 잡히는데, 이는 의도한 동작이다).

### baseline 전처리 — 이미지 경로 재작성 (필수)

`loadFile()`은 본문의 상대경로 이미지를 `api/local-image?path=<절대경로>` URL로 재작성한다. baseline은 별도 엔드포인트로 받으므로 이 변환을 거치지 않는다.

**그대로 두면 이미지가 포함된 모든 블록이 변경으로 오탐한다.** baseline에도 `rewriteImagePathsForDisplay`를 동일하게 적용하되, 반환된 `map` / `htmlMap`은 버려 `imageMap`을 오염시키지 않는다(해당 함수는 순수하므로 안전).

같은 이유로 baseline 원문에 `splitFrontmatter`를 적용해 body만 비교한다. 적용하지 않으면 첫 블록들이 통째로 어긋난다.

전처리 순서는 `loadFile()` + 초기 로드 경로와 정확히 동일해야 한다:

```
splitFrontmatter → rewriteImagePathsForDisplay → maskTableImages
  → maskTableBreaks → parseMarkdownWithDetails → postParse
```

### diff 알고리즘 (`blockDiff.ts`)

**평탄화.** 블록 트리를 깊이 우선으로 평탄화한 뒤 diff한다. 중첩 블록(toggle, quote, 리스트)도 개별 마커를 받는다. decoration은 노드 단위라 문제없다.

**prefix/suffix 절단.** 공통 prefix와 suffix를 먼저 잘라낸다. 실제 편집은 거의 항상 국소적이므로 이것만으로 비교 대상이 몇 개로 줄고, 남은 구간에 평범한 LCS를 돌리면 충분하다. Myers 직접 구현이나 diff 라이브러리 추가는 불필요하다 — **외부 의존성 0**.

**modified 승격.** LCS는 추가/삭제만 내놓는다. 삭제 run과 추가 run이 인접하면 앞에서부터 짝지어 `modified`로 승격하고, 남는 쪽만 `added` / `deleted`로 둔다.

짝지을 때 **블록 타입은 보지 않는다.** 문단을 제목으로 바꾸면 타입이 달라지지만 사용자에게는 명백히 "수정"이고, IDE도 라인 내용이 완전히 달라져도 같은 위치면 modified로 칠한다.

**삭제 마커 위치.** 승격 후 남은 삭제 run 직후의 첫 생존 블록 상단 경계에 놓는다. 삭제 run이 문서 끝이면 마지막 블록 하단에 놓는다. 문서가 완전히 비면 표시하지 않는다.

**크기 가드.** prefix/suffix 절단 후 남은 두 구간의 **곱**이 1000×1000을 초과하면 LCS를 건너뛰고 마커를 생략한다(조용히).

가드를 곱으로 잡는 이유: LCS 비용은 `O(n·m)`이라 한쪽만 작아도 다른 쪽이 크면 비싸다. "양쪽 모두 1000 초과"로 잡으면 999×50000 같은 비대칭 입력이 통과하는데, 실측으로 271ms / 400MB가 나왔다 — 재계산 디바운스 주기(300ms)보다 오래 걸린다. 큰 내용을 좁은 선택 영역에 붙여넣으면 실제로 이 형태가 만들어진다. 곱으로 잡으면 의도했던 1000×1000 용량(8ms / 5.5MB)은 그대로 두고 비대칭 케이스만 막는다.

### 갱신 트리거

**baseline 쪽** — git 상태가 바뀔 때만 재조회한다. Kotlin에서 `ChangeListListener.TOPIC`을 구독해 `changeListUpdateDone()`에서 `window.markora.vcsChanged()`를 푸시한다. 기존 `applyTheme` / `reloadFromDisk`와 동일한 패턴이므로 새 메커니즘이 없다. 커밋, 브랜치 전환, stage 모두 이 경로로 들어온다. 프론트는 baseline 캐시를 무효화하고 재fetch + 재파싱한다.

**현재 문서 쪽** — `editor.onChange`에 **300ms 디바운스**로 실시간 재계산한다. baseline 블록 리스트가 캐시돼 있으므로 재계산 비용은 키 생성과 LCS뿐이고, prefix/suffix 절단 덕에 국소 편집은 사실상 공짜다.

저장 시에만 갱신하는 안도 검토했으나 기각했다. 자동저장이 1초 디바운스라 방금 고친 문단에 마커가 한 박자 늦게 뜬다.

외부 편집 reload(`bridge.onReloadRequest`) 직후에도 재계산한다.

**디바운스가 만드는 과도 상태.** 마커 상태는 블록 `id`로 조회하는데, 사용자가 문단 중간에서 Enter를 누르면 BlockNote가 나뉜 쪽에 새 `id`를 부여한다. 그 블록은 다음 재계산까지 최대 300ms 동안 마커가 없다. 반대로 오래된 `id`는 조회에서 그냥 빗나가므로 잘못된 블록에 마커가 붙는 일은 없다 — 표시가 늦을 뿐 틀리지는 않는다. 마커가 장식이고 파괴적이지 않으므로 이 과도 상태는 받아들인다.

### 렌더링

`searchPlugin`의 명령형 API를 따라 `setVcsStatus(view, statusMap)` 하나로 상태를 주입한다. 플러그인이 문서를 순회하며 블록 `id`로 상태를 조회해 `Decoration.node`에 클래스를 붙인다.

diff 결과는 "현재 문서의 i번째 평탄화 블록" 인덱스이므로, 플러그인에 넘기기 전에 실제 블록 `id`를 키로 하는 맵으로 변환한다.

CSS `::before`가 `.bn-editor`의 54px 좌측 여백 바깥쪽 끝에 3px 세로 바를 그린다.

| 상태 | 표시 |
|------|------|
| `added` | 초록 세로 바 |
| `modified` | 파란 세로 바 |
| `deleted` | 블록 경계의 작은 삼각형(▸) |

색은 CSS 변수로 라이트/다크 2세트를 하드코딩한다. IntelliJ의 `EditorColors.ADDED_LINES_COLOR` / `MODIFIED_LINES_COLOR`로 IDE 테마의 실제 gutter 색을 받아오는 것도 가능하고 기존 `EditorColorsListener` 경로에 얹으면 되지만, `applyTheme` 시그니처 변경이 필요해 후속 작업으로 남긴다.

### 실패 처리

**전부 조용히 처리한다.** baseline fetch 실패, `unavailable`, `untracked` — 모두 마커 0개이며 상태바에 아무것도 표시하지 않는다. VCS 표시가 안 된다고 편집 흐름을 방해할 이유가 없다.

- `unavailable`인 경우에만 재조회를 중단하되, **연속 2회**부터 중단한다. 프로젝트 기동 직후에는 VCS 루트 매핑이 아직 등록되지 않아 일시적으로 `unavailable`이 나올 수 있다. 첫 응답만으로 영구히 끄면 그 탭은 파일을 닫았다 열기 전까지 마커가 영영 없고, 실패가 조용해서 사용자는 이유조차 알 수 없다. 성공 응답이 오면 카운터를 0으로 되돌린다.
- 신규 파일(`untracked`)에 마커가 없는 것은 IDE와 동일한 동작이다.
- 파일이 미저장 상태여도 baseline은 HEAD 그대로다(정상).
- `ContentRevision.getContent()`는 느린 연산이며 `VcsException`을 던질 수 있다. Netty 핸들러는 EDT가 아닌 워커 스레드에서 실행되므로 블로킹은 문제없다. 예외는 잡아서 `unavailable`로 응답한다.

## 테스트

### 핵심: 오탐 회귀 방지

`markdown/__tests__/roundtrip.test.ts` 패턴을 빌려 **"baseline과 현재가 같은 문서면 변경 0개"** 를 실제 문서 여러 개(표, 이미지, details, 코드블록, Mermaid, KaTeX, 중첩 리스트 포함)로 검증한다.

왕복 노이즈 상쇄가 실제로 성립하는지가 이 설계 전체의 전제이므로, 깨지면 즉시 알아야 한다.

### 단위 테스트

`blockKey.test.ts`
- `id`가 달라도 같은 키가 나온다
- children이 키에 포함되지 않는다
- depth가 키에 반영된다

이미지 경로 재작성이 오탐을 일으키지 않는지는 `blockKey` 단위 테스트가 아니라 위의 오탐 회귀 테스트에서 검증한다. 재작성은 `blockKey` 호출 전에 파이프라인이 양쪽 모두에 적용하므로, 그 단계를 포함한 통합 경로로 확인해야 의미가 있다.

`blockDiff.test.ts`
- 순수 추가 / 순수 삭제 / 수정
- 인접한 삭제 run + 추가 run의 modified 승격
- 타입이 다른 블록 간 승격
- 삭제 마커 위치(중간 / 문서 끝)
- prefix/suffix 절단이 결과를 바꾸지 않는다
- 크기 가드 동작

### Kotlin

`VcsBaselineController`의 상태 분기 테스트는 IDE fixture 비용이 커서 자동화하지 않는다. `runIde` 수동 검증으로 갈음한다.

## 실측으로 확정된 사항

계획 작성 중 실제 코드로 확인했다.

- ProseMirror 문서 구조는 `blockGroup > blockContainer(attrs.id) > <contentNode>` 이며, 중첩 블록은 부모 `blockContainer` **안쪽**에 들어간다. 따라서 decoration을 `blockContainer`에 걸면 자식 높이까지 덮인다. **첫 자식(content 노드)에 걸어야** 하며, 그러면 DOM `.bn-block-content`에 클래스가 붙어 그 블록 자신의 높이만 차지한다. heading / bulletListItem / codeBlock에서 확인했고, 중첩 자식이 독립적으로 마커를 받는 것도 확인했다.
- `ContentRevision.getContent()`는 read action **바깥에서** 호출한다. 느린 연산을 read action 안에 두면 write action을 막아 UI가 멎을 수 있다. read action 안에서는 어느 리비전을 읽을지만 결정한다.

### baseline도 전용 에디터 인스턴스를 거쳐야 한다

`editor.document`는 ProseMirror가 기본 props를 채워 정규화한 블록을 돌려주는 반면, `tryParseMarkdownToBlocks` 직후의 블록은 그렇지 않다. baseline 블록을 파싱 직후 상태로 두고 현재 문서와 비교하면 props 차이로 전부 오탐한다.

따라서 baseline도 자기 `BlockNoteEditor` 인스턴스에 `replaceBlocks`로 통과시켜 같은 정규화를 거치게 한다. 인스턴스는 지연 생성해 재사용하며, 재파싱은 git 상태가 바뀔 때만 일어난다.

### `.bn-block-content` 의 유사요소는 쓸 수 없다 — 상태 바는 `border-left` 로 그린다

이 요소의 `::before` 와 `::after` 는 **둘 다 BlockNote 소유**다. 실물로 확인했다:

| 유사요소 | BlockNote 용도 |
|---|---|
| `::before` | 리스트 불릿 (`bulletListItem` 에서 `content: "•"`, `width: 24px`) |
| `::after` | 빈 블록 플레이스홀더 (`content: "Enter text or type '/' for commands"`) |

여기에 마커를 얹으면 속성별로 승자가 갈려 **남의 콘텐츠가 우리 상자에 갇힌다.** `::before` 에 얹었을 때는 불릿이 24px 색 덩어리가 됐고, `::after` 로 옮겼더니 플레이스홀더가 3px 폭에 갇혀 세로로 한 글자씩 쏟아졌다. 자리를 옮겨 다니는 건 두더지잡기다.

그래서 상태 바는 유사요소를 쓰지 않고 `border-left` 로 그린다:

```
margin-left: -50px        상자 왼쪽 끝을 4px 로 (IDE gutter 위치)
border-left: 3px          4~7px 를 바가 차지
padding-left: 47px        본문을 다시 54px 로 복원
width: calc(100% + 50px)  box-sizing:border-box + 고정폭이라 필수.
                          없으면 오른쪽 끝이 50px 줄어 표시된 블록만 줄바꿈이 달라진다
```

검증값(실측): 세 타입 모두 바 x=4, 오른쪽 끝과 본문 시작이 미표시 블록과 정확히 일치, 리스트 불릿 들여쓰기 보존.

삭제 표시만 유사요소가 필요한데, 블록 래퍼(`.bn-block-outer`)의 것은 BlockNote 가 쓰지 않는 것을 확인해 거기 둔다. 클래스는 안쪽 `.bn-block-content` 에 붙으므로 `:has(> .bn-block > .markora-vcs-deleted-*)` 로 역참조하되, 자손이 아니라 직계 경로여야 부모 블록까지 잘못 매칭되지 않는다.

### 절대 위치 유사요소를 `top:0; bottom:0` 로 늘리지 말 것

이건 위 방식으로 바꾸기 전에 먼저 밟은 함정이다. `.bn-block-content` 가 row flex 컨테이너라, 이걸 포함 블록으로 갖는 절대 위치 유사요소에서 `top: 0; bottom: 0` 조합은 Chromium 에서 **높이가 0 으로 붕괴한다.** 배경색·좌표·폭은 모두 정상 계산되고 `getComputedStyle` 도 정상값을 돌려주는데 그릴 면적만 없어서, 마커가 아무 신호 없이 사라진다. 필요하면 `height: 100%` 를 쓴다.

같은 뿌리의 선례: 커스텀 블록(mermaid/katex)이 row flex item 이라 `flex: 1` 없이는 폭이 안 늘어나는 문제.

### 이 세 가지는 자동 테스트로 못 잡는다

`vitest` 는 `css: false` 로 돌아 스타일을 아예 로드하지 않는다. `styles.css` 의 주석이 유일한 방어선이므로 배경까지 적어 두었다. 이 영역을 손대면 `runIde` 나 브라우저로 실물을 봐야 한다.

**브라우저로 보는 법**: 페이지는 IDE 내장 서버가 HTTP 로 서빙하므로 일반 브라우저에서 직접 열어 devtools 로 검사할 수 있다 — `http://localhost:<port>/markora/resources/blocknote/dist/index.html?filePath=<enc>&serverUrl=<enc>&dark=true`. 포트는 63342 부터 스캔하면 찾힌다. JCEF 콘솔을 봐야 하면 `MarkdownHtmlPanel.setupHandlers()` 에 `CefDisplayHandlerAdapter.onConsoleMessage` 를 임시로 달아 `idea.log` 로 넘긴다.

## 구현 중 확인해야 할 항목

CSS가 로드되지 않는 vitest 환경에서는 확인할 수 없어 `./gradlew runIde` 샌드박스에서 봐야 하는 항목:

1. 3px 마커 바와 BlockNote drag handle의 좌표 충돌 여부(hover 메뉴 offset이 버전에 따라 다름)
2. 마커가 붙은 블록에 준 `position: relative`가 코드블록의 언어 선택 `<select>` 위치를 흔들지 않는지
3. 다크 테마에서 마커 색 대비

## 알려진 한계

**여러 프로젝트가 동시에 열려 있으면 잘못된 프로젝트를 고른다.** `VcsBaselineController`는 `ProjectManager.getInstance().openProjects.firstOrNull()`로 프로젝트를 잡는데, 이는 요청된 파일이 속한 프로젝트가 아니라 그냥 첫 번째로 열린 프로젝트다. 창이 여러 개면 `ProjectLevelVcsManager.getVcsFor()`가 엉뚱한 프로젝트에 대고 물어, 실제로는 VCS 하위인 파일을 `unavailable`로 보고할 수 있다.

이 관용구는 `MarkdownFileController.handleSave`에서 그대로 가져온 것이라 이 기능이 새로 만든 문제는 아니다. 다만 파일 읽기/저장보다 VCS 조회가 프로젝트 스코프에 더 민감하다. 고치려면 `ProjectLocator.getInstance().guessProjectForFile(virtualFile)`로 파일에서 프로젝트를 역추적해야 하는데, 그러면 형제 컨트롤러들과 관용구가 갈라지므로 세 곳을 함께 바꾸는 별도 작업으로 다루는 게 맞다.

## 후속 작업 (범위 밖)

- 마커 클릭 시 이전 내용 팝업 + rollback
- IDE 팔레트(`EditorColors.ADDED_LINES_COLOR`) 연동
- frontmatter 변경 표시
- 블록 내부 라인 단위 해상도(표/코드블록 내부)
