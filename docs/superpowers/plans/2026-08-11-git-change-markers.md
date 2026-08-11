# Git 변경분 마커 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markora 에디터에서 Git baseline(HEAD) 대비 추가/수정/삭제된 BlockNote 블록에 IDE gutter와 같은 좌측 마커를 표시한다.

**Architecture:** Kotlin이 HEAD 원문을 HTTP로 넘기고, 프론트가 그 원문을 **현재 문서와 완전히 동일한 파싱 파이프라인**(별도 BlockNote 인스턴스 포함)에 통과시켜 블록 리스트를 만든 뒤, 내용 기반 키 배열끼리 LCS diff를 돌린다. 결과를 ProseMirror `Decoration.node`로 `.bn-block-content`에 클래스로 입힌다. 양쪽이 같은 변환을 거치므로 마크다운 왕복 노이즈가 상쇄되고, 라인→블록 매핑이 불필요해진다.

**Tech Stack:** Kotlin / IntelliJ Platform (`ChangeListManager`, `ChangeListListener`, Netty `HttpRequestHandler`), TypeScript / React 18 / BlockNote 0.49 / ProseMirror, Vitest + happy-dom

**설계 문서:** `docs/superpowers/specs/2026-08-11-git-change-markers-design.md`

---

## 사전 확인된 사실 (구현 시 재조사 불필요)

실제 코드로 실측해 확인한 내용이다. 이 위에서 계획이 작성됐다.

- BlockNote 0.49의 ProseMirror 문서 구조는 `blockGroup > blockContainer(attrs.id) > <contentNode>` 이며, 중첩 블록은 부모 `blockContainer` **안쪽**에 `blockGroup`으로 들어간다.
- `Decoration.node(pos+1, pos+1+firstChild.nodeSize)` 로 `blockContainer`의 첫 자식(content 노드)에 걸면 DOM `.bn-block-content` 에 클래스가 붙는다. **중첩 자식은 부모 마커에 덮이지 않고 각자 자기 마커를 받는다.** heading / bulletListItem / codeBlock 모두 확인됨.
- `editor.tryParseMarkdownToBlocks()` 와 `parseMarkdownWithBlockquotes()` 는 블록 배열만 반환하고 문서를 변경하지 않는다.
- `BlockNoteEditor.create({ schema })` 는 mount 없이도 `replaceBlocks` / `document` 가 동작한다 (`src/markdown/__tests__/integration.test.ts` 선례).
- `.bn-editor` 는 `padding-inline: 54px` 을 가진다.

**Kotlin 태스크(5~7, 11) 빌드 주의.** 이 호스트의 기본 `java`는 25이고 Gradle 8.13은 JDK 25에서 실행을 거부하며 `* What went wrong: 25.0.2` 같은 모호한 메시지로 실패한다. `build.gradle.kts`에 `jvmToolchain(21)`이 있어도 Gradle **데몬 자체**가 호스트 java로 뜨므로 소용없다. 모든 Gradle 명령 앞에 붙일 것:

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
```

(2026-08-11 기준 이 경로에 21.0.11 존재 확인. `/usr/libexec/java_home -V`에는 25만 잡히므로 경로를 직접 지정해야 한다.)

## 파일 구조

**신규 (frontend)**

| 파일 | 책임 |
|------|------|
| `frontend/src/vcs/blockKey.ts` | 블록 → 내용 기반 비교 키, 트리 평탄화. 순수 함수. |
| `frontend/src/vcs/blockDiff.ts` | 키 배열 2개 → 블록별 상태 + 삭제 위치. 순수 함수. |
| `frontend/src/vcs/baselinePipeline.ts` | 마크다운 원문 → 정규화된 블록 리스트 (로드 경로와 동일 순서). |
| `frontend/src/vcs/vcsPlugin.ts` | 상태 맵 → `Decoration.node`. ProseMirror 플러그인. |
| `frontend/src/vcs/useVcsMarkers.ts` | fetch / 캐시 / 디바운스 / 재계산. 부수효과 전담. |
| `frontend/src/vcs/__tests__/blockKey.test.ts` | |
| `frontend/src/vcs/__tests__/blockDiff.test.ts` | |
| `frontend/src/vcs/__tests__/noFalsePositive.test.ts` | **설계 전제 검증.** |
| `frontend/src/vcs/__tests__/vcsPlugin.test.ts` | |

**신규 (Kotlin)**

| 파일 | 책임 |
|------|------|
| `src/main/kotlin/com/github/kenshin579/markora/controller/VcsBaselineController.kt` | baseline 조회 엔드포인트 |

**수정**

| 파일 | 변경 |
|------|------|
| `src/main/kotlin/.../controller/HttpResponses.kt` | `escapeJsonString()` 추가 |
| `src/main/kotlin/.../controller/MarkdownFileController.kt` | 인라인 이스케이프 → `escapeJsonString()` |
| `src/main/kotlin/.../controller/PreviewStaticServer.kt` | `api/vcs` 라우팅 |
| `src/main/kotlin/.../editor/MarkdownHtmlPanel.kt` | `ChangeListListener` 구독 |
| `frontend/src/types.ts` | `VcsBaseline` 타입, bridge 메서드, `window.markora.vcsChanged` |
| `frontend/src/bridge/markora.ts` | `fetchVcsBaseline()`, `onVcsChange()` (mock 포함) |
| `frontend/src/editor/Editor.tsx` | 훅 1줄 호출 |
| `frontend/src/styles.css` | 마커 스타일 |

## 작업 순서 근거

Task 1~2를 먼저 한다. **"같은 문서면 변경 0개"** 라는 설계 전제가 실제로 성립하는지가 나머지 전부의 조건이기 때문이다. 전제가 깨지면 Task 3 이후를 만들 이유가 없다.

---

### Task 1: 블록 키 생성 (`blockKey.ts`)

**Files:**
- Create: `frontend/src/vcs/blockKey.ts`
- Test: `frontend/src/vcs/__tests__/blockKey.test.ts`

모든 명령은 `markora/frontend/` 에서 실행한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/vcs/__tests__/blockKey.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { blockKey, flattenBlocks } from '../blockKey';

describe('blockKey', () => {
  it('id가 달라도 같은 키를 만든다', () => {
    const a = { id: 'aaa', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'hi', styles: {} }] };
    const b = { id: 'bbb', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'hi', styles: {} }] };
    expect(blockKey(a, 0)).toBe(blockKey(b, 0));
  });

  it('내용이 다르면 키가 다르다', () => {
    const a = { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'hi', styles: {} }] };
    const b = { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'ho', styles: {} }] };
    expect(blockKey(a, 0)).not.toBe(blockKey(b, 0));
  });

  it('타입이 다르면 키가 다르다', () => {
    const a = { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'hi', styles: {} }] };
    const b = { type: 'heading', props: {}, content: [{ type: 'text', text: 'hi', styles: {} }] };
    expect(blockKey(a, 0)).not.toBe(blockKey(b, 0));
  });

  it('props가 다르면 키가 다르다', () => {
    const a = { type: 'mermaid', props: { source: 'graph TD\nA-->B' } };
    const b = { type: 'mermaid', props: { source: 'graph TD\nA-->C' } };
    expect(blockKey(a, 0)).not.toBe(blockKey(b, 0));
  });

  it('props 키 순서가 달라도 같은 키를 만든다', () => {
    const a = { type: 'heading', props: { level: 1, textColor: 'default' } };
    const b = { type: 'heading', props: { textColor: 'default', level: 1 } };
    expect(blockKey(a, 0)).toBe(blockKey(b, 0));
  });

  it('children은 키에 포함하지 않는다', () => {
    const a = { type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'x', styles: {} }], children: [] };
    const b = {
      type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'x', styles: {} }],
      children: [{ type: 'paragraph', props: {}, content: [{ type: 'text', text: 'child', styles: {} }] }],
    };
    expect(blockKey(a, 0)).toBe(blockKey(b, 0));
  });

  it('depth가 다르면 키가 다르다', () => {
    const b = { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'x', styles: {} }] };
    expect(blockKey(b, 0)).not.toBe(blockKey(b, 1));
  });
});

describe('flattenBlocks', () => {
  it('깊이 우선으로 부모 → 자식 순서로 평탄화한다', () => {
    const blocks = [
      {
        id: 'p1', type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'a', styles: {} }],
        children: [
          { id: 'c1', type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'b', styles: {} }] },
        ],
      },
      { id: 'p2', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'c', styles: {} }] },
    ];
    expect(flattenBlocks(blocks).map((x) => x.id)).toEqual(['p1', 'c1', 'p2']);
  });

  it('자식은 부모보다 depth가 1 크다', () => {
    const blocks = [
      {
        id: 'p1', type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'a', styles: {} }],
        children: [{ id: 'c1', type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'a', styles: {} }] }],
      },
    ];
    const out = flattenBlocks(blocks);
    // 같은 타입·내용이지만 depth가 달라 키가 갈린다
    expect(out[0].key).not.toBe(out[1].key);
  });

  it('id가 없는 블록은 빈 문자열 id를 갖는다', () => {
    expect(flattenBlocks([{ type: 'paragraph', props: {} }])[0].id).toBe('');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/vcs/__tests__/blockKey.test.ts`
Expected: FAIL — `Failed to resolve import "../blockKey"`

- [ ] **Step 3: 구현**

`frontend/src/vcs/blockKey.ts`:

```ts
// 블록을 내용 기반으로 식별하는 키를 만든다.
//
// BlockNote의 block.id는 파싱할 때마다 새로 생성되므로 baseline↔현재 비교에 쓸 수 없다.
// 대신 type/props/content를 정규화해 문자열화한다. children은 제외한다 — 포함하면
// 자식이 바뀔 때 부모까지 변경으로 잡혀 마커가 이중으로 뜬다. 대신 depth를 섞어
// 서로 다른 레벨의 블록이 잘못 매칭되지 않게 한다.

export interface AnyBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: AnyBlock[];
}

export interface KeyedBlock {
  /** BlockNote block id — decoration 대상 식별용. baseline 쪽 값은 사용하지 않는다. */
  id: string;
  /** 내용 기반 비교 키 */
  key: string;
}

// 객체 키를 정렬하고 id/children/undefined를 제거해 안정적인 JSON을 만든다.
// 재귀적으로 적용되므로 테이블 셀 등 중첩 구조도 함께 정규화된다.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) {
    if (k === 'id' || k === 'children') continue;
    if (src[k] === undefined) continue;
    out[k] = normalize(src[k]);
  }
  return out;
}

export function blockKey(block: AnyBlock, depth: number): string {
  const shape = {
    type: block.type,
    props: block.props ?? {},
    content: block.content ?? null,
  };
  return `${depth} ${JSON.stringify(normalize(shape))}`;
}

/** 블록 트리를 깊이 우선(부모 → 자식)으로 평탄화한다. */
export function flattenBlocks(blocks: AnyBlock[], depth = 0, out: KeyedBlock[] = []): KeyedBlock[] {
  for (const b of blocks) {
    out.push({ id: b.id ?? '', key: blockKey(b, depth) });
    if (b.children && b.children.length > 0) flattenBlocks(b.children, depth + 1, out);
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/vcs/__tests__/blockKey.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/vcs/blockKey.ts frontend/src/vcs/__tests__/blockKey.test.ts
git commit -m "feat(vcs): 블록 내용 기반 비교 키와 트리 평탄화 추가"
```

---

### Task 2: baseline 파이프라인 + 설계 전제 검증

**이 태스크가 설계 전체의 관문이다.** baseline과 현재 문서가 같은 내용일 때 diff가 0이어야 한다. 여기서 실패하면 Task 3 이후를 진행하지 말고 사용자에게 보고한다.

핵심은 **baseline도 자기 `BlockNoteEditor` 인스턴스에 `replaceBlocks`로 통과시키는 것**이다. `editor.document`는 ProseMirror가 기본 props를 채워 정규화한 블록을 돌려주는 반면, `tryParseMarkdownToBlocks` 직후의 블록은 그렇지 않다. 양쪽 모두 PM 정규화를 거쳐야 키가 일치한다.

**Files:**
- Create: `frontend/src/vcs/baselinePipeline.ts`
- Test: `frontend/src/vcs/__tests__/noFalsePositive.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/vcs/__tests__/noFalsePositive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { markdownToBlocks } from '../baselinePipeline';
import { flattenBlocks } from '../blockKey';

const FILE_PATH = '/proj/docs/doc.md';
const SERVER_URL = 'http://localhost:63342/markora/';

/** 현재 문서 측: 파이프라인 통과 후 실제 에디터 문서에 반영해 PM 정규화까지 거친다. */
async function currentKeys(md: string): Promise<string[]> {
  const editor = BlockNoteEditor.create({ schema });
  const blocks = await markdownToBlocks(editor, FILE_PATH, SERVER_URL, md);
  editor.replaceBlocks(editor.document, blocks as any);
  return flattenBlocks(editor.document as any).map((b) => b.key);
}

/** baseline 측: 별도 에디터 인스턴스로 동일 처리한다. */
async function baselineKeys(md: string): Promise<string[]> {
  const editor = BlockNoteEditor.create({ schema });
  const blocks = await markdownToBlocks(editor, FILE_PATH, SERVER_URL, md);
  editor.replaceBlocks(editor.document, blocks as any);
  return flattenBlocks(editor.document as any).map((b) => b.key);
}

const SAMPLES: Array<[string, string]> = [
  ['표준 마크다운', '# Title\n\nHello **world**.\n\n- a\n- b\n'],
  ['중첩 리스트', '- a\n  - b\n    - c\n- d\n'],
  ['표', '| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |\n'],
  ['코드블록', '```kotlin\nval x = 1\n```\n'],
  ['mermaid', '```mermaid\ngraph TD\nA-->B\n```\n'],
  ['math 블록', '```math\nx^2 + y^2 = z^2\n```\n'],
  ['인라인 수식', '식: $x^2$ 끝.\n'],
  ['인용', '> quoted line\n> second\n'],
  ['상대경로 이미지', '![alt](images/pic.png)\n'],
  ['details', '<details>\n<summary>제목</summary>\n\n본문\n\n</details>\n'],
  ['frontmatter 포함', '---\ntitle: T\n---\n\n# Body\n\npara\n'],
  ['한글 혼합 문서', '# 제목\n\n한글 문단입니다.\n\n- 항목 하나\n- 항목 둘\n'],
];

describe('설계 전제: 같은 문서면 변경 0개', () => {
  for (const [name, md] of SAMPLES) {
    it(name, async () => {
      const [base, curr] = await Promise.all([baselineKeys(md), currentKeys(md)]);
      expect(curr).toEqual(base);
    });
  }
});

describe('실제 변경은 감지된다', () => {
  it('문단 내용이 바뀌면 키가 달라진다', async () => {
    const base = await baselineKeys('# T\n\nold text\n');
    const curr = await currentKeys('# T\n\nnew text\n');
    expect(curr).not.toEqual(base);
    expect(curr[0]).toBe(base[0]); // 제목은 그대로
  });

  it('블록이 추가되면 길이가 늘어난다', async () => {
    const base = await baselineKeys('# T\n\na\n');
    const curr = await currentKeys('# T\n\na\n\nb\n');
    expect(curr.length).toBe(base.length + 1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/vcs/__tests__/noFalsePositive.test.ts`
Expected: FAIL — `Failed to resolve import "../baselinePipeline"`

- [ ] **Step 3: 구현**

`frontend/src/vcs/baselinePipeline.ts`:

```ts
import type { BlockNoteEditor } from '@blocknote/core';
import { splitFrontmatter } from '../bridge/transform';
import { rewriteImagePathsForDisplay } from '../bridge/imageMap';
import { maskTableImages } from '../markdown/tableImage';
import { maskTableBreaks } from '../markdown/tableLineBreak';
import { parseMarkdownWithDetails } from '../markdown/details';
import { postParse } from '../markdown/customParse';
import type { AnyBlock } from './blockKey';

/**
 * 마크다운 원문을 블록 리스트로 변환한다.
 *
 * 순서는 Editor.tsx 초기 로드 경로(bridge.loadFile + parseMarkdownWithDetails + postParse)와
 * 정확히 같아야 한다. 어긋나면 baseline과 현재 문서가 다른 변환을 거쳐 변경이 오탐한다.
 *
 * rewriteImagePathsForDisplay는 반드시 적용해야 한다. 생략하면 baseline의 이미지는
 * 상대경로, 현재 문서는 local-image 절대 URL이 되어 이미지가 든 블록이 전부 오탐한다.
 * 반환되는 map/htmlMap은 버린다 — 저장 경로의 imageMap을 오염시키면 안 된다.
 */
export async function markdownToBlocks(
  editor: BlockNoteEditor<any, any, any>,
  filePath: string,
  serverUrl: string,
  raw: string,
): Promise<AnyBlock[]> {
  const { body } = splitFrontmatter(raw);
  const normalized = filePath.replace(/\\/g, '/');
  const mdDir = normalized.substring(0, normalized.lastIndexOf('/'));
  const { body: rewritten } = rewriteImagePathsForDisplay(body, mdDir, serverUrl);
  const blocks = await parseMarkdownWithDetails(editor, maskTableBreaks(maskTableImages(rewritten)));
  return postParse(blocks as any) as AnyBlock[];
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/vcs/__tests__/noFalsePositive.test.ts`
Expected: PASS — 14 tests

**실패 시 대응:** 어떤 샘플이 실패했는지 기록하고 두 키 배열을 diff해 어느 필드가 갈리는지 확인한다. 특정 블록 타입의 props만 문제라면 `blockKey`의 `normalize`에서 해당 필드를 제외하는 것을 검토한다. **전 샘플이 실패하면 전제 자체가 틀린 것이므로 진행을 멈추고 보고한다.**

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/vcs/baselinePipeline.ts frontend/src/vcs/__tests__/noFalsePositive.test.ts
git commit -m "feat(vcs): baseline 파싱 파이프라인 추가 및 오탐 없음 검증"
```

---

### Task 3: 블록 diff (`blockDiff.ts`)

**Files:**
- Create: `frontend/src/vcs/blockDiff.ts`
- Test: `frontend/src/vcs/__tests__/blockDiff.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/vcs/__tests__/blockDiff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffBlocks, MAX_DIFF_SPAN } from '../blockDiff';

describe('diffBlocks', () => {
  it('동일하면 변경이 없다', () => {
    const r = diffBlocks(['A', 'B', 'C'], ['A', 'B', 'C']);
    expect(r.statuses.size).toBe(0);
    expect(r.deletionsBefore.size).toBe(0);
    expect(r.deletionAtEnd).toBe(false);
  });

  it('가운데 블록 추가 → added', () => {
    const r = diffBlocks(['A', 'C'], ['A', 'B', 'C']);
    expect([...r.statuses]).toEqual([[1, 'added']]);
    expect(r.deletionsBefore.size).toBe(0);
  });

  it('가운데 블록 교체 → modified', () => {
    const r = diffBlocks(['A', 'B', 'C'], ['A', 'X', 'C']);
    expect([...r.statuses]).toEqual([[1, 'modified']]);
    expect(r.deletionsBefore.size).toBe(0);
  });

  it('가운데 블록 삭제 → 뒤따르는 블록 앞에 삭제 표시', () => {
    const r = diffBlocks(['A', 'B', 'C'], ['A', 'C']);
    expect(r.statuses.size).toBe(0);
    expect([...r.deletionsBefore]).toEqual([1]);
    expect(r.deletionAtEnd).toBe(false);
  });

  it('맨 앞 블록 삭제 → index 0 앞에 삭제 표시', () => {
    const r = diffBlocks(['X', 'A'], ['A']);
    expect([...r.deletionsBefore]).toEqual([0]);
  });

  it('맨 끝 블록 삭제 → deletionAtEnd', () => {
    const r = diffBlocks(['A', 'B'], ['A']);
    expect(r.deletionsBefore.size).toBe(0);
    expect(r.deletionAtEnd).toBe(true);
  });

  it('여러 개 삭제 + 하나 추가 → 하나는 modified, 남은 삭제는 삼각형', () => {
    const r = diffBlocks(['A', 'B', 'C', 'D'], ['A', 'X']);
    expect(r.statuses.get(1)).toBe('modified');
    expect([...r.deletionsBefore]).toEqual([1]);
  });

  it('삭제 1 + 추가 2 → 하나는 modified, 나머지는 added', () => {
    const r = diffBlocks(['A', 'B', 'Z'], ['A', 'X', 'Y', 'Z']);
    expect(r.statuses.get(1)).toBe('modified');
    expect(r.statuses.get(2)).toBe('added');
    expect(r.deletionsBefore.size).toBe(0);
  });

  it('타입이 달라도 위치가 같으면 modified로 짝짓는다', () => {
    // 키는 불투명한 문자열이므로 타입 구분 없이 위치로만 짝짓는다
    const r = diffBlocks(['0 {"type":"paragraph"}'], ['0 {"type":"heading"}']);
    expect([...r.statuses]).toEqual([[0, 'modified']]);
  });

  it('baseline이 비면 전부 added', () => {
    const r = diffBlocks([], ['A', 'B']);
    expect([...r.statuses]).toEqual([[0, 'added'], [1, 'added']]);
  });

  it('현재가 비면 deletionAtEnd', () => {
    const r = diffBlocks(['A', 'B'], []);
    expect(r.statuses.size).toBe(0);
    expect(r.deletionAtEnd).toBe(true);
  });

  it('앞뒤 공통 구간이 길어도 결과가 같다', () => {
    const head = Array.from({ length: 50 }, (_, i) => `H${i}`);
    const tail = Array.from({ length: 50 }, (_, i) => `T${i}`);
    const r = diffBlocks([...head, 'B', ...tail], [...head, 'X', ...tail]);
    expect([...r.statuses]).toEqual([[50, 'modified']]);
  });

  it('양쪽 변경 구간이 모두 상한을 넘으면 마커를 생략한다', () => {
    const base = Array.from({ length: MAX_DIFF_SPAN + 1 }, (_, i) => `b${i}`);
    const curr = Array.from({ length: MAX_DIFF_SPAN + 1 }, (_, i) => `c${i}`);
    const r = diffBlocks(base, curr);
    expect(r.statuses.size).toBe(0);
    expect(r.deletionsBefore.size).toBe(0);
    expect(r.deletionAtEnd).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/vcs/__tests__/blockDiff.test.ts`
Expected: FAIL — `Failed to resolve import "../blockDiff"`

- [ ] **Step 3: 구현**

`frontend/src/vcs/blockDiff.ts`:

```ts
// baseline 키 배열과 현재 키 배열을 비교해 블록별 변경 상태를 만든다.
//
// 공통 prefix/suffix를 먼저 잘라낸다. 실제 편집은 거의 항상 국소적이므로 이것만으로
// 비교 대상이 몇 개로 줄고, 남은 구간에 평범한 LCS를 돌리면 충분하다.

export type BlockStatus = 'added' | 'modified';

export interface DiffResult {
  /** 현재 블록 리스트의 인덱스 → 상태. 변경 없는 블록은 없다. */
  statuses: Map<number, BlockStatus>;
  /** 이 인덱스의 블록 '앞' 경계에 삭제가 있었다. */
  deletionsBefore: Set<number>;
  /** 문서 끝에 삭제가 있었다. */
  deletionAtEnd: boolean;
}

/**
 * 절단 후 남은 두 구간의 곱이 이 값의 제곱을 넘으면 마커를 생략한다.
 * LCS 비용이 O(n·m)이므로 가드는 한쪽 길이가 아니라 셀 개수에 걸어야 한다.
 */
export const MAX_DIFF_SPAN = 1000;

type Op =
  | { kind: 'equal'; currIdx: number }
  | { kind: 'del' }
  | { kind: 'ins'; currIdx: number };

function emptyResult(): DiffResult {
  return { statuses: new Map(), deletionsBefore: new Set(), deletionAtEnd: false };
}

// dp[i][j] = a[i..] 와 b[j..] 의 LCS 길이
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function editScript(a: string[], b: string[], currOffset: number): Op[] {
  const dp = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', currIdx: currOffset + j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del' });
      i++;
    } else {
      ops.push({ kind: 'ins', currIdx: currOffset + j });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: 'del' });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: 'ins', currIdx: currOffset + j });
    j++;
  }
  return ops;
}

export function diffBlocks(baseKeys: string[], currKeys: string[]): DiffResult {
  const result = emptyResult();

  let p = 0;
  const maxP = Math.min(baseKeys.length, currKeys.length);
  while (p < maxP && baseKeys[p] === currKeys[p]) p++;

  let s = 0;
  const maxS = Math.min(baseKeys.length - p, currKeys.length - p);
  while (s < maxS && baseKeys[baseKeys.length - 1 - s] === currKeys[currKeys.length - 1 - s]) s++;

  const baseMid = baseKeys.slice(p, baseKeys.length - s);
  const currMid = currKeys.slice(p, currKeys.length - s);
  if (baseMid.length === 0 && currMid.length === 0) return result;
  if (baseMid.length * currMid.length > MAX_DIFF_SPAN * MAX_DIFF_SPAN) return result;

  const ops = editScript(baseMid, currMid, p);
  // 변경 구간 뒤에 남아 있는 첫 현재 인덱스. 삭제 run이 문서 뒤쪽 공통 구간에
  // 맞닿아 있을 때 삼각형을 붙일 자리다.
  const afterMid = currKeys.length - s;

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === 'equal') {
      i++;
      continue;
    }
    if (op.kind === 'ins') {
      let j = i;
      while (j < ops.length && ops[j].kind === 'ins') j++;
      for (let k = i; k < j; k++) {
        result.statuses.set((ops[k] as { currIdx: number }).currIdx, 'added');
      }
      i = j;
      continue;
    }

    // 삭제 run — 바로 뒤에 붙은 추가 run과 앞에서부터 짝지어 modified로 승격한다.
    let d = i;
    while (d < ops.length && ops[d].kind === 'del') d++;
    let n = d;
    while (n < ops.length && ops[n].kind === 'ins') n++;

    const delCount = d - i;
    const insIdx = ops.slice(d, n).map((o) => (o as { currIdx: number }).currIdx);
    const paired = Math.min(delCount, insIdx.length);
    for (let k = 0; k < insIdx.length; k++) {
      result.statuses.set(insIdx[k], k < paired ? 'modified' : 'added');
    }

    if (delCount > paired) {
      let anchor: number;
      if (insIdx.length > 0) {
        anchor = insIdx[0];
      } else {
        const next = ops.slice(n).find((o) => o.kind !== 'del') as { currIdx: number } | undefined;
        anchor = next ? next.currIdx : afterMid;
      }
      if (anchor >= currKeys.length) result.deletionAtEnd = true;
      else result.deletionsBefore.add(anchor);
    }
    i = n;
  }

  return result;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/vcs/__tests__/blockDiff.test.ts`
Expected: PASS — 13 tests (아래 보강에서 2개가 더해져 최종 15개가 된다)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/vcs/blockDiff.ts frontend/src/vcs/__tests__/blockDiff.test.ts
git commit -m "feat(vcs): 블록 LCS diff와 modified 승격 휴리스틱 추가"
```

**구현 후 보강 (코드 리뷰 결과 반영).** 위 코드에서 세 가지가 더 바뀌었다.

1. 크기 가드를 곱 기준으로 교체 — 위 코드 블록에 이미 반영돼 있다. 원래의 `&&` 조건은 999×50000 같은 비대칭 입력을 통과시켰고 실측 271ms / 400MB가 나왔다.
2. orphan 삭제 run의 anchor를 찾을 때 쓰던 `ops.slice(n).find(...)`를 인덱스 전진 스캔으로 교체. 매번 `ops` 잔여 구간을 복사하던 것을 없앴다 — 키 입력마다 도는 경로다.
3. `Op` 판별 유니온을 우회하던 `as { currIdx: number }` 캐스팅 3개를 `currIdxOf(op)` 헬퍼로 교체. 캐스팅을 두면 run 경계 로직이 바뀔 때 컴파일러가 못 잡는다.

테스트도 2개 추가했다. 독립적인 삭제 run 두 개가 한 diff에 있을 때 `deletionsBefore`와 `deletionAtEnd`가 서로를 덮지 않는지, 그리고 modified 인덱스가 삭제 마커를 함께 갖는 공존 케이스. Task 9가 두 필드를 같이 소비하므로 고정해 둘 값어치가 있다.

---

### Task 4: ProseMirror 마커 플러그인 (`vcsPlugin.ts`)

**Files:**
- Create: `frontend/src/vcs/vcsPlugin.ts`
- Test: `frontend/src/vcs/__tests__/vcsPlugin.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/vcs/__tests__/vcsPlugin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { createVcsPlugin, setVcsMarkers, EMPTY_MARKERS } from '../vcsPlugin';

async function mountEditor(md: string) {
  const editor = BlockNoteEditor.create({ schema });
  const blocks = await editor.tryParseMarkdownToBlocks(md);
  editor.replaceBlocks(editor.document, blocks as any);
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  const view = editor.prosemirrorView!;
  view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, createVcsPlugin()] }));
  return { editor, view, host };
}

describe('vcsPlugin', () => {
  it('상태가 비면 아무 클래스도 붙지 않는다', async () => {
    const { host } = await mountEditor('# T\n\npara\n');
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(0);
  });

  it('added 상태인 블록의 .bn-block-content에 클래스가 붙는다', async () => {
    const { editor, view, host } = await mountEditor('# T\n\npara\n');
    const target = editor.document[1].id;
    setVcsMarkers(view, { ...EMPTY_MARKERS, statuses: new Map([[target, 'added' as const]]) });
    const hit = host.querySelectorAll('.markora-vcs-added');
    expect(hit.length).toBe(1);
    expect(hit[0].classList.contains('bn-block-content')).toBe(true);
    expect(hit[0].getAttribute('data-content-type')).toBe('paragraph');
  });

  it('modified와 삭제 표시가 한 블록에 함께 붙을 수 있다', async () => {
    const { editor, view, host } = await mountEditor('# T\n\npara\n');
    const target = editor.document[1].id;
    setVcsMarkers(view, {
      statuses: new Map([[target, 'modified' as const]]),
      deletionsBefore: new Set([target]),
      deletionAtEnd: false,
    });
    const el = host.querySelector('.markora-vcs-modified')!;
    expect(el.classList.contains('markora-vcs-deleted-before')).toBe(true);
  });

  it('중첩 자식 블록도 독립적으로 마커를 받는다', async () => {
    const { editor, view, host } = await mountEditor('- a\n  - b\n');
    const child = editor.document[0].children[0].id;
    setVcsMarkers(view, { ...EMPTY_MARKERS, statuses: new Map([[child, 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(1);
  });

  it('deletionAtEnd는 마지막 블록에 붙는다', async () => {
    const { host, view } = await mountEditor('# T\n\npara\n');
    setVcsMarkers(view, { ...EMPTY_MARKERS, deletionAtEnd: true });
    const hit = host.querySelectorAll('.markora-vcs-deleted-after');
    expect(hit.length).toBe(1);
    expect(hit[0].getAttribute('data-content-type')).toBe('paragraph');
  });

  it('존재하지 않는 id는 무시된다', async () => {
    const { host, view } = await mountEditor('# T\n\npara\n');
    setVcsMarkers(view, { ...EMPTY_MARKERS, statuses: new Map([['no-such-id', 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/vcs/__tests__/vcsPlugin.test.ts`
Expected: FAIL — `Failed to resolve import "../vcsPlugin"`

- [ ] **Step 3: 구현**

`frontend/src/vcs/vcsPlugin.ts`:

```ts
// VCS 변경 마커를 그리는 ProseMirror 플러그인. 문서를 변경하지 않고 decoration만 얹는다.
// search/searchPlugin.ts 와 동일한 명령형 API 패턴을 따른다.
//
// decoration은 blockContainer가 아니라 그 '첫 자식'(content 노드)에 건다. blockContainer는
// 중첩 자식까지 포함하므로 부모에 걸면 자식 높이까지 마커가 덮인다. 첫 자식에 걸면
// DOM의 .bn-block-content 에 클래스가 붙어 그 블록 자신의 높이만 차지한다.

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

export type VcsStatus = 'added' | 'modified';

export interface VcsMarkerState {
  /** BlockNote block id → 상태 */
  statuses: Map<string, VcsStatus>;
  /** 이 블록 '앞' 경계에 삭제 표시를 붙인다 */
  deletionsBefore: Set<string>;
  /** 문서 끝(마지막 블록 아래)에 삭제 표시를 붙인다 */
  deletionAtEnd: boolean;
}

export const EMPTY_MARKERS: VcsMarkerState = {
  statuses: new Map(),
  deletionsBefore: new Set(),
  deletionAtEnd: false,
};

export const vcsPluginKey = new PluginKey<VcsMarkerState>('markora-vcs');

const STATUS_CLASS: Record<VcsStatus, string> = {
  added: 'markora-vcs-added',
  modified: 'markora-vcs-modified',
};

interface BlockSpan {
  id: string;
  from: number;
  to: number;
}

function collectBlockSpans(doc: PMNode): BlockSpan[] {
  const spans: BlockSpan[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true;
    const id = node.attrs?.id as string | undefined;
    const inner = node.firstChild;
    if (!id || !inner) return true;
    spans.push({ id, from: pos + 1, to: pos + 1 + inner.nodeSize });
    return true;
  });
  return spans;
}

function buildDecorations(doc: PMNode, value: VcsMarkerState): DecorationSet {
  if (value.statuses.size === 0 && value.deletionsBefore.size === 0 && !value.deletionAtEnd) {
    return DecorationSet.empty;
  }
  const spans = collectBlockSpans(doc);
  if (spans.length === 0) return DecorationSet.empty;

  const lastIndex = spans.length - 1;
  const decos: Decoration[] = [];
  spans.forEach((span, index) => {
    const classes: string[] = [];
    const status = value.statuses.get(span.id);
    if (status) classes.push(STATUS_CLASS[status]);
    if (value.deletionsBefore.has(span.id)) classes.push('markora-vcs-deleted-before');
    if (value.deletionAtEnd && index === lastIndex) classes.push('markora-vcs-deleted-after');
    if (classes.length > 0) {
      decos.push(Decoration.node(span.from, span.to, { class: classes.join(' ') }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export function createVcsPlugin(): Plugin<VcsMarkerState> {
  return new Plugin<VcsMarkerState>({
    key: vcsPluginKey,
    state: {
      init: () => EMPTY_MARKERS,
      apply(tr: Transaction, value: VcsMarkerState): VcsMarkerState {
        const meta = tr.getMeta(vcsPluginKey) as VcsMarkerState | undefined;
        return meta ?? value;
      },
    },
    props: {
      decorations(state: EditorState) {
        return buildDecorations(state.doc, vcsPluginKey.getState(state) ?? EMPTY_MARKERS);
      },
    },
  });
}

/** 마커 상태를 교체한다. 문서는 변경되지 않는다. */
export function setVcsMarkers(view: EditorView, value: VcsMarkerState): void {
  view.dispatch(view.state.tr.setMeta(vcsPluginKey, value));
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/vcs/__tests__/vcsPlugin.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/vcs/vcsPlugin.ts frontend/src/vcs/__tests__/vcsPlugin.test.ts
git commit -m "feat(vcs): 블록 마커 ProseMirror decoration 플러그인 추가"
```

**구현 후 보강 (코드 리뷰 결과 반영).** 위 코드에서 세 가지가 바뀌었다. **Task 9는 아래 형태를 전제로 한다.**

1. `EMPTY_MARKERS` 상수를 없애고 `createEmptyMarkers(): VcsMarkerState` 팩토리로 교체했다. 모듈 수준 싱글턴이 mutable한 `Map`/`Set`을 들고 있어서, 호출부가 `state.statuses.set(...)`으로 제자리 변경하면 그 탭이 사는 동안 "비어 있음"의 의미가 영구히 깨진다. `Object.freeze`로는 못 막는다 — `Map.set`은 얼린 객체의 자체 속성을 거치지 않는다.
2. decoration 생성을 `props.decorations()`에서 `apply()`로 옮겼다. 원래 코드는 커서 이동을 포함한 **모든** 트랜잭션마다 문서 전체를 순회했다(2000 블록에서 1.0ms). `searchPlugin.ts`는 비싼 계산을 `apply()`에서 하고 `decorations()`는 캐시된 값만 읽는데, 그 패턴을 따르도록 맞췄다. 플러그인 상태가 `{ markers, decorations }`로 넓어졌다.
3. `collectBlockSpans`의 순회가 inline/text 리프까지 내려가던 것을 content 노드에서 잘라냈다.

테스트도 3개 추가했다. 가장 중요한 것은 **`setVcsMarkers`가 문서를 dirty로 만들지 않는다**는 회귀 테스트다 — 이 에디터는 `onChange`에 자동저장이 걸려 있어서, 누가 나중에 `setVcsMarkers`에 문서를 건드리는 스텝을 넣으면 마커 갱신마다 저장이 돌게 된다. `docChanged === false`와 `editor.onChange` 스파이 미호출을 양쪽 다 검증한다.

---

### Task 5: JSON 이스케이프 헬퍼 추출 (Kotlin)

`VcsBaselineController`가 `MarkdownFileController`와 같은 문자열 이스케이프를 필요로 한다. 복제 대신 공용 헬퍼로 뽑고, 제어문자 처리도 함께 넣는다(현재 인라인 구현은 `\u0000`~`\u001F` 중 `\n`/`\r`/`\t` 외를 놓쳐 잘못된 JSON을 만들 수 있다).

**Files:**
- Modify: `src/main/kotlin/com/github/kenshin579/markora/controller/HttpResponses.kt`
- Modify: `src/main/kotlin/com/github/kenshin579/markora/controller/MarkdownFileController.kt:59-66`

- [ ] **Step 1: 헬퍼 추가**

`HttpResponses.kt` 파일 끝에 추가:

```kotlin
/**
 * 문자열을 JSON 문자열 리터럴 내부에 넣을 수 있게 이스케이프한다(따옴표는 포함하지 않는다).
 * `\n`/`\r`/`\t` 외의 제어문자도 `\uXXXX`로 처리해 잘못된 JSON 생성을 막는다.
 */
internal fun escapeJsonString(raw: String): String {
    val sb = StringBuilder(raw.length + 16)
    for (ch in raw) {
        when (ch) {
            '\\' -> sb.append("\\\\")
            '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (ch < ' ') sb.append(String.format("\\u%04x", ch.code)) else sb.append(ch)
        }
    }
    return sb.toString()
}
```

- [ ] **Step 2: 기존 인라인 이스케이프 교체**

`MarkdownFileController.kt` 에서 다음 블록을 삭제한다:

```kotlin
        val escapedContent = content
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
```

같은 자리에 다음을 넣는다:

```kotlin
        val escapedContent = escapeJsonString(content)
```

- [ ] **Step 3: 컴파일 확인**

Run: `./gradlew compileKotlin`
Expected: BUILD SUCCESSFUL

- [ ] **Step 4: 커밋**

```bash
git add src/main/kotlin/com/github/kenshin579/markora/controller/HttpResponses.kt \
        src/main/kotlin/com/github/kenshin579/markora/controller/MarkdownFileController.kt
git commit -m "refactor: JSON 문자열 이스케이프를 공용 헬퍼로 추출"
```

---

### Task 6: baseline 엔드포인트 (Kotlin)

**Files:**
- Create: `src/main/kotlin/com/github/kenshin579/markora/controller/VcsBaselineController.kt`
- Modify: `src/main/kotlin/com/github/kenshin579/markora/controller/PreviewStaticServer.kt:32-41`

**설계 문서와 달라진 점:** `unchanged` 응답도 `content`(현재 디스크 본문 = HEAD 본문)를 함께 반환한다. `content: null`로 두면 자동저장(1초 디바운스) 전에 편집한 내용이 마커에 반영되지 않는 구간이 생긴다. 프론트는 `changed`와 `unchanged`를 동일하게 처리한다.

`ContentRevision.getContent()` 는 느린 연산이므로 read action **바깥에서** 호출한다. read action 안에서는 어떤 리비전을 읽을지만 정한다.

- [ ] **Step 1: 컨트롤러 작성**

`src/main/kotlin/com/github/kenshin579/markora/controller/VcsBaselineController.kt`:

```kotlin
package com.github.kenshin579.markora.controller

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.vcs.changes.ChangeListManager
import com.intellij.openapi.vcs.changes.ContentRevision
import com.intellij.openapi.vfs.LocalFileSystem
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpMethod
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.QueryStringDecoder

/**
 * 현재 파일의 VCS baseline(HEAD) 본문을 반환한다.
 *
 * 프론트는 이 본문을 현재 문서와 동일한 파싱 파이프라인에 통과시켜 블록 단위로 비교한다.
 * 라인 범위(LineStatusTracker)가 아니라 원문을 넘기는 이유는 설계 문서 참조.
 */
object VcsBaselineController {

    private val LOG = logger<VcsBaselineController>()

    private const val UNAVAILABLE = """{"status":"unavailable","content":null}"""
    private const val UNTRACKED = """{"status":"untracked","content":null}"""

    // read action 안에서는 '무엇을 읽을지'만 정한다. 실제 본문 로딩(느린 연산)은 밖에서 한다.
    private sealed interface Plan {
        object Unavailable : Plan
        object Untracked : Plan
        data class Inline(val status: String, val text: String) : Plan
        data class FromRevision(val revision: ContentRevision) : Plan
    }

    fun handle(
        urlDecoder: QueryStringDecoder,
        request: FullHttpRequest,
        context: ChannelHandlerContext
    ): Boolean {
        val path = urlDecoder.path().removePrefix(PreviewStaticServer.PREFIX)
        if (path != "api/vcs/baseline" || request.method() != HttpMethod.GET) return false

        val filePath = urlDecoder.parameters()["path"]?.firstOrNull()
        if (filePath == null) {
            send(request, context, HttpResponseStatus.BAD_REQUEST, """{"error":"Missing path parameter"}""")
            return true
        }

        val json = try {
            resolve(filePath)
        } catch (e: ProcessCanceledException) {
            // 플랫폼 규약: PCE는 제어 흐름 신호이므로 삼키지 말고 반드시 다시 던진다.
            // 아래 Exception 절이 먼저 잡으면 취소가 무시돼 플랫폼 상태가 어긋난다.
            throw e
        } catch (e: Exception) {
            // VcsException 등 — 마커를 못 그릴 뿐이므로 조용히 unavailable로 응답한다.
            LOG.warn("VCS baseline lookup failed for $filePath", e)
            UNAVAILABLE
        }
        send(request, context, HttpResponseStatus.OK, json)
        return true
    }

    private fun resolve(filePath: String): String {
        val virtualFile = LocalFileSystem.getInstance().findFileByPath(filePath) ?: return UNAVAILABLE
        val project = ProjectManager.getInstance().openProjects.firstOrNull() ?: return UNAVAILABLE

        val plan = ApplicationManager.getApplication().runReadAction(
            Computable {
                if (ProjectLevelVcsManager.getInstance(project).getVcsFor(virtualFile) == null) {
                    return@Computable Plan.Unavailable
                }
                val change = ChangeListManager.getInstance(project).getChange(virtualFile)
                // beforeRevision은 Java getter라 when 분기 사이에 스마트 캐스트가 안 된다.
                // 한 번만 읽어 지역 val에 담아야 !! 없이 넘길 수 있다.
                val beforeRevision = change?.beforeRevision
                when {
                    // VCS 하위이지만 변경 없음 → 디스크 본문이 곧 HEAD 본문이다.
                    change == null -> {
                        val text = FileDocumentManager.getInstance().getDocument(virtualFile)?.text ?: ""
                        Plan.Inline("unchanged", text)
                    }
                    // 신규 파일 — 비교 대상이 없다. IDE도 이 경우 gutter 마커를 그리지 않는다.
                    beforeRevision == null -> Plan.Untracked
                    else -> Plan.FromRevision(beforeRevision)
                }
            }
        )

        return when (plan) {
            is Plan.Unavailable -> UNAVAILABLE
            is Plan.Untracked -> UNTRACKED
            is Plan.Inline -> """{"status":"${plan.status}","content":"${escapeJsonString(plan.text)}"}"""
            is Plan.FromRevision -> {
                val text = plan.revision.content ?: return UNAVAILABLE
                """{"status":"changed","content":"${escapeJsonString(text)}"}"""
            }
        }
    }

    private fun send(
        request: FullHttpRequest,
        context: ChannelHandlerContext,
        status: HttpResponseStatus,
        json: String
    ) {
        sendTextResponse(context.channel(), request, status, "application/json", json, cors = true)
    }
}
```

- [ ] **Step 2: 라우팅 등록**

`PreviewStaticServer.kt` 의 `when` 블록에서

```kotlin
            path.startsWith("api/local-image") ->
                LocalImageController.handle(urlDecoder, request, context)
```

바로 아래에 추가:

```kotlin
            path.startsWith("api/vcs") ->
                VcsBaselineController.handle(urlDecoder, request, context)
```

- [ ] **Step 3: 컴파일 확인**

Run: `./gradlew compileKotlin`
Expected: BUILD SUCCESSFUL

`ChangeListManager` / `ProjectLevelVcsManager` 미해결 오류가 나면 `build.gradle.kts` 의 IntelliJ Platform 의존성에 VCS 번들 플러그인이 필요하다. `intellijPlatform { bundledPlugin("com.intellij.modules.vcs") }` 를 추가하고 다시 컴파일한다.

- [ ] **Step 4: 커밋**

```bash
git add src/main/kotlin/com/github/kenshin579/markora/controller/VcsBaselineController.kt \
        src/main/kotlin/com/github/kenshin579/markora/controller/PreviewStaticServer.kt
git commit -m "feat(vcs): VCS baseline 조회 엔드포인트 추가"
```

---

### Task 7: VCS 변경 알림 푸시 (Kotlin)

**Files:**
- Modify: `src/main/kotlin/com/github/kenshin579/markora/editor/MarkdownHtmlPanel.kt:34-38, 57`

- [ ] **Step 1: 구독 메서드 추가**

`MarkdownHtmlPanel.kt` 의 `init` 블록을 다음으로 교체한다:

```kotlin
    init {
        setupHandlers()
        loadEditor()
        subscribeExternalChangeReload()
        subscribeVcsChange()
    }
```

`subscribeExternalChangeReload()` 메서드 바로 아래에 추가한다:

```kotlin
    // 커밋 / 브랜치 전환 / stage 등으로 VCS 상태가 바뀌면 baseline이 달라진다.
    // ChangeListManager의 갱신 완료 시점에 JS로 알려 baseline을 다시 받게 한다.
    private fun subscribeVcsChange() {
        val connection = project.messageBus.connect(this)
        connection.subscribe(ChangeListListener.TOPIC, object : ChangeListListener {
            override fun changeListUpdateDone() {
                executeJavaScript(
                    "try { if (window.markora && typeof window.markora.vcsChanged === 'function') { window.markora.vcsChanged(); } } catch (e) { console.warn('vcsChanged failed', e); }"
                )
            }
        })
    }
```

import 추가:

```kotlin
import com.intellij.openapi.vcs.changes.ChangeListListener
```

- [ ] **Step 2: 컴파일 확인**

Run: `./gradlew compileKotlin`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: 커밋**

```bash
git add src/main/kotlin/com/github/kenshin579/markora/editor/MarkdownHtmlPanel.kt
git commit -m "feat(vcs): VCS 상태 변경 시 프론트에 baseline 갱신 알림"
```

---

### Task 8: bridge 확장 (types + markora.ts)

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/bridge/markora.ts`
- Test: `frontend/src/bridge/__tests__/markora.test.ts` (기존 파일에 추가)

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/bridge/__tests__/markora.test.ts` 파일 끝에 추가:

```ts
describe('fetchVcsBaseline', () => {
  it('엔드포인트 응답을 그대로 돌려준다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'changed', content: '# old\n' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bridge = createBridge({ filePath: '/p/a.md', serverUrl: 'http://x/', initialTheme: 'light' });
    await expect(bridge.fetchVcsBaseline()).resolves.toEqual({ status: 'changed', content: '# old\n' });
    expect(fetchMock).toHaveBeenCalledWith('http://x/api/vcs/baseline?path=%2Fp%2Fa.md');

    vi.unstubAllGlobals();
  });

  it('content가 없으면 null로 채운다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'untracked' }),
    }));
    const bridge = createBridge({ filePath: '/p/a.md', serverUrl: 'http://x/', initialTheme: 'light' });
    await expect(bridge.fetchVcsBaseline()).resolves.toEqual({ status: 'untracked', content: null });
    vi.unstubAllGlobals();
  });

  it('window.markora.vcsChanged가 리스너를 호출한다', () => {
    const bridge = createBridge({ filePath: '/p/a.md', serverUrl: 'http://x/', initialTheme: 'light' });
    const cb = vi.fn();
    const unsub = bridge.onVcsChange(cb);
    window.markora.vcsChanged();
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    window.markora.vcsChanged();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
```

파일 상단 import에 `vi`가 없으면 `import { describe, it, expect, vi } from 'vitest';` 로 보완한다.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/bridge/__tests__/markora.test.ts`
Expected: FAIL — `bridge.fetchVcsBaseline is not a function`

- [ ] **Step 3: 타입 추가**

`frontend/src/types.ts` 의 `UploadResult` 아래에 추가:

```ts
export type VcsBaselineStatus = 'changed' | 'unchanged' | 'untracked' | 'unavailable';

export interface VcsBaseline {
  status: VcsBaselineStatus;
  /** changed/unchanged일 때만 원문이 담긴다. */
  content: string | null;
}
```

`MarkoraBridge` 인터페이스의 `onReloadRequest` 아래에 추가:

```ts
  // 현재 파일의 VCS baseline(HEAD) 본문을 조회한다.
  fetchVcsBaseline(): Promise<VcsBaseline>;
  // Kotlin이 VCS 상태 변경(커밋/브랜치 전환/stage)을 감지했을 때 호출되는 콜백 등록.
  onVcsChange(cb: () => void): () => void;
```

`declare global` 의 `window.markora` 에 추가:

```ts
      // Kotlin이 VCS 상태 변경 시 호출하여 baseline 재조회를 요청.
      vcsChanged: () => void;
```

- [ ] **Step 4: bridge 구현**

`frontend/src/bridge/markora.ts` 에서:

1. import에 타입 추가 — `import type { BridgeContext, MarkoraBridge, Theme, UploadResult, VcsBaseline } from '../types';`

2. `createBridge` 안 `const reloadListeners = new Set<() => void>();` 아래에 추가:

```ts
  const vcsListeners = new Set<() => void>();
```

3. `window.markora` 객체에 `reloadFromDisk` 아래로 추가:

```ts
      vcsChanged: () => {
        vcsListeners.forEach(cb => cb());
      },
```

4. 반환 객체의 `onReloadRequest` 아래에 추가:

```ts
    async fetchVcsBaseline(): Promise<VcsBaseline> {
      const res = await fetch(
        `${ctx.serverUrl}api/vcs/baseline?path=${encodeURIComponent(ctx.filePath)}`
      );
      if (!res.ok) throw new Error(`fetchVcsBaseline failed: ${res.status}`);
      const data = await res.json();
      return { status: data.status, content: data.content ?? null };
    },

    onVcsChange(cb) {
      vcsListeners.add(cb);
      return () => vcsListeners.delete(cb);
    },
```

5. `createMockBridge` 에도 동일하게 반영한다. `const reloadListeners = ...` 아래에:

```ts
  const vcsListeners = new Set<() => void>();
```

`window.markora` 객체에:

```ts
      vcsChanged: () => vcsListeners.forEach(cb => cb()),
```

반환 객체의 `onReloadRequest` 아래에:

```ts
    async fetchVcsBaseline(): Promise<VcsBaseline> {
      return { status: 'unavailable', content: null };
    },
    onVcsChange(cb) { vcsListeners.add(cb); return () => vcsListeners.delete(cb); },
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/bridge/__tests__/markora.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/types.ts frontend/src/bridge/markora.ts frontend/src/bridge/__tests__/markora.test.ts
git commit -m "feat(vcs): bridge에 baseline 조회와 VCS 변경 알림 추가"
```

---

### Task 9: 마커 훅 배선 (`useVcsMarkers.ts`)

**Files:**
- Create: `frontend/src/vcs/useVcsMarkers.ts`
- Modify: `frontend/src/editor/Editor.tsx:256-259` 아래

- [ ] **Step 1: 훅 구현**

`frontend/src/vcs/useVcsMarkers.ts`:

```ts
// baseline 조회 → 파싱 → diff → 마커 주입을 묶는 훅. 부수효과는 전부 여기에만 둔다.
//
// baseline은 전용 BlockNoteEditor 인스턴스에 replaceBlocks로 통과시킨다. editor.document는
// ProseMirror가 기본 props를 채워 정규화한 블록을 돌려주므로, 파싱 직후 블록과 그대로
// 비교하면 전부 변경으로 오탐한다. 양쪽 모두 PM 정규화를 거쳐야 한다.

import { useCallback, useEffect, useRef } from 'react';
import { BlockNoteEditor } from '@blocknote/core';
import type { MarkoraBridge } from '../types';
import { schema } from '../editor/schema';
import { markdownToBlocks } from './baselinePipeline';
import { flattenBlocks, type AnyBlock } from './blockKey';
import { diffBlocks } from './blockDiff';
import { createVcsPlugin, setVcsMarkers, createEmptyMarkers, type VcsMarkerState } from './vcsPlugin';

const RECOMPUTE_DEBOUNCE_MS = 300;
const BASELINE_RELOAD_DEBOUNCE_MS = 500;

export function useVcsMarkers(editor: BlockNoteEditor<any, any, any>, bridge: MarkoraBridge): void {
  const baselineKeysRef = useRef<string[] | null>(null);
  // 마지막으로 파싱한 baseline 원문. 같으면 재파싱을 건너뛴다.
  const lastBaselineRawRef = useRef<string | null>(null);
  // 'unavailable' 응답을 받으면 이 파일에 대한 재조회를 완전히 끈다.
  const disabledRef = useRef(false);
  const baselineEditorRef = useRef<BlockNoteEditor<any, any, any> | null>(null);
  const timerRef = useRef<number | null>(null);
  const baselineTimerRef = useRef<number | null>(null);

  // 플러그인을 view에 한 번 등록한다 (데코레이션 전용 — 문서 변경 없음).
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const plugin = createVcsPlugin();
    view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, plugin] }));
    return () => {
      const v = editor.prosemirrorView;
      if (!v) return;
      v.updateState(v.state.reconfigure({ plugins: v.state.plugins.filter((p) => p !== plugin) }));
    };
  }, [editor]);

  const recompute = useCallback(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const base = baselineKeysRef.current;
    if (!base) {
      setVcsMarkers(view, createEmptyMarkers());
      return;
    }
    const current = flattenBlocks(editor.document as unknown as AnyBlock[]);
    const result = diffBlocks(base, current.map((b) => b.key));

    const next: VcsMarkerState = {
      statuses: new Map(),
      deletionsBefore: new Set(),
      deletionAtEnd: result.deletionAtEnd,
    };
    for (const [index, status] of result.statuses) {
      const block = current[index];
      if (block?.id) next.statuses.set(block.id, status);
    }
    for (const index of result.deletionsBefore) {
      const block = current[index];
      if (block?.id) next.deletionsBefore.add(block.id);
    }
    setVcsMarkers(view, next);
  }, [editor]);

  const scheduleRecompute = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      recompute();
    }, RECOMPUTE_DEBOUNCE_MS);
  }, [recompute]);

  const loadBaseline = useCallback(async () => {
    if (disabledRef.current) return;
    try {
      const { status, content } = await bridge.fetchVcsBaseline();
      if (status === 'unavailable') {
        disabledRef.current = true;
        baselineKeysRef.current = null;
        lastBaselineRawRef.current = null;
      } else if (content === null) {
        // untracked — 비교 대상이 없다.
        baselineKeysRef.current = null;
        lastBaselineRawRef.current = null;
      } else {
        // 같은 baseline을 다시 파싱하지 않는다. Kotlin의 changeListUpdateDone은 편집 중
        // 분당 여러 번 발화하는데(자동저장 → VFS 변경 → changelist 갱신) HEAD 본문은
        // 커밋/브랜치 전환 전까지 그대로다. 원문이 같으면 파싱도 diff도 건너뛴다.
        if (content === lastBaselineRawRef.current) return;
        const { filePath, serverUrl } = bridge.getContext();
        if (!baselineEditorRef.current) {
          baselineEditorRef.current = BlockNoteEditor.create({ schema });
        }
        const be = baselineEditorRef.current;
        const blocks = await markdownToBlocks(be, filePath, serverUrl, content);
        be.replaceBlocks(be.document, blocks as any);
        baselineKeysRef.current = flattenBlocks(be.document as unknown as AnyBlock[]).map((b) => b.key);
        lastBaselineRawRef.current = content;
      }
    } catch (e) {
      // VCS 표시 실패가 편집을 방해해선 안 된다. 마커만 없앤다.
      console.warn('VCS baseline load failed:', e);
      baselineKeysRef.current = null;
      lastBaselineRawRef.current = null;
    }
    recompute();
  }, [bridge, recompute]);

  // vcsChanged 발화 자체가 잦으므로 fetch도 디바운스한다. 위의 원문 비교가 파싱은
  // 막아주지만, 매 발화마다 HTTP 왕복을 도는 것까지 막지는 못한다.
  const scheduleBaselineReload = useCallback(() => {
    if (baselineTimerRef.current) window.clearTimeout(baselineTimerRef.current);
    baselineTimerRef.current = window.setTimeout(() => {
      baselineTimerRef.current = null;
      void loadBaseline();
    }, BASELINE_RELOAD_DEBOUNCE_MS);
  }, [loadBaseline]);

  useEffect(() => { void loadBaseline(); }, [loadBaseline]);

  useEffect(() => editor.onChange(() => scheduleRecompute()), [editor, scheduleRecompute]);

  useEffect(() => bridge.onVcsChange(() => scheduleBaselineReload()), [bridge, scheduleBaselineReload]);

  useEffect(() => bridge.onReloadRequest(() => scheduleRecompute()), [bridge, scheduleRecompute]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (baselineTimerRef.current) window.clearTimeout(baselineTimerRef.current);
  }, []);
}
```

- [ ] **Step 2: Editor.tsx 배선**

`Editor.tsx` 상단 import에 추가:

```ts
import { useVcsMarkers } from '../vcs/useVcsMarkers';
```

다음 블록(마운트 시 initialTheme 반영) 바로 아래에

```tsx
  // 마운트 시 initialTheme 즉시 반영
  useEffect(() => {
    reinitOnThemeChange(bridge.getContext().initialTheme);
  }, [bridge]);
```

이어서 추가한다:

```tsx
  // VCS 변경 마커 (baseline 조회 + 블록 diff + decoration)
  useVcsMarkers(editor, bridge);
```

- [ ] **Step 3: 타입 검사와 전체 테스트**

Run: `npx tsc --noEmit`
Expected: 오류 없음

Run: `npm test`
Expected: 전체 PASS (기존 테스트 포함)

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/vcs/useVcsMarkers.ts frontend/src/editor/Editor.tsx
git commit -m "feat(vcs): 마커 훅을 에디터에 배선"
```

---

### Task 10: 마커 스타일 (CSS)

**Files:**
- Modify: `frontend/src/styles.css` (파일 끝에 추가)

`.bn-editor` 의 좌측 여백이 54px이므로 content 박스 기준 `left: -50px` 이면 에디터 좌측 끝에서 4px 지점에 바가 놓인다. drag handle은 여백의 안쪽(콘텐츠 쪽)에 붙으므로 겹치지 않아야 하지만, 실제 확인은 Task 11에서 한다.

- [ ] **Step 1: 스타일 추가**

`frontend/src/styles.css` 끝에 추가:

```css
/* ---- VCS change markers ----
 * decoration은 .bn-block-content 에 붙는다(vcsPlugin.ts 참조). 마커 바는 ::before,
 * 삭제 삼각형은 ::after 를 쓴다 — 한 블록이 둘 다 가질 수 있다.
 * 절대 위치의 기준을 만들기 위해 마커가 붙은 블록에만 position:relative 를 준다.
 */
.markora-shell {
  --markora-vcs-added: #59a869;
  --markora-vcs-modified: #4a86c8;
}
[data-mantine-color-scheme="dark"] .markora-shell {
  --markora-vcs-added: #4f8a5b;
  --markora-vcs-modified: #3d6a99;
}

.markora-shell .bn-block-content.markora-vcs-added,
.markora-shell .bn-block-content.markora-vcs-modified,
.markora-shell .bn-block-content.markora-vcs-deleted-before,
.markora-shell .bn-block-content.markora-vcs-deleted-after {
  position: relative;
}

.markora-shell .bn-block-content.markora-vcs-added::before,
.markora-shell .bn-block-content.markora-vcs-modified::before {
  content: '';
  position: absolute;
  left: -50px;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: 1px;
  pointer-events: none;
}
.markora-shell .bn-block-content.markora-vcs-added::before {
  background: var(--markora-vcs-added);
}
.markora-shell .bn-block-content.markora-vcs-modified::before {
  background: var(--markora-vcs-modified);
}

.markora-shell .bn-block-content.markora-vcs-deleted-before::after,
.markora-shell .bn-block-content.markora-vcs-deleted-after::after {
  content: '';
  position: absolute;
  left: -52px;
  width: 0;
  height: 0;
  border-left: 6px solid var(--markora-vcs-modified);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  pointer-events: none;
}
.markora-shell .bn-block-content.markora-vcs-deleted-before::after { top: -4px; }
.markora-shell .bn-block-content.markora-vcs-deleted-after::after { bottom: -4px; }
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 성공 (`src/main/resources/blocknote/dist/` 갱신)

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/styles.css
git commit -m "feat(vcs): 변경 마커 스타일 추가"
```

---

### Task 11: runIde 수동 검증

자동 테스트로 덮이지 않는 항목이다. **CSS가 로드되지 않는 vitest 환경에서는 확인할 수 없다.**

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 샌드박스 실행**

Run: `./gradlew runIde`

샌드박스 IDE에서 git 저장소인 프로젝트를 열고 `.md` 파일을 Markora 탭으로 연다.

- [ ] **Step 2: 확인 항목**

각 항목을 확인하고 결과를 기록한다.

| # | 항목 | 기대 |
|---|------|------|
| 1 | 변경 없는 파일 | 마커 없음 |
| 2 | 문단 하나 수정 | 해당 블록에만 파란 바 |
| 3 | 문단 추가 | 해당 블록에 초록 바 |
| 4 | 문단 삭제 | 뒤따르는 블록 위에 삼각형 |
| 5 | 마지막 문단 삭제 | 마지막 블록 아래에 삼각형 |
| 6 | 중첩 리스트 자식 수정 | 자식에만 마커, 부모에는 없음 |
| 7 | 표 셀 수정 | 표 전체에 마커(의도된 동작) |
| 8 | **drag handle 충돌** | 블록에 hover 했을 때 ⋮⋮ / + 버튼이 마커 바와 겹치지 않음 |
| 9 | 다크 테마 | 마커 색이 배경과 충분히 대비됨 |
| 10 | 이미지 포함 문서 | 이미지 블록에 오탐 마커 없음 |
| 11 | 터미널에서 커밋 | 몇 초 내 마커가 사라짐 |
| 12 | 터미널에서 브랜치 전환 | baseline이 갱신되어 마커가 바뀜 |
| 13 | git 저장소 아닌 폴더의 .md | 마커 없음, 콘솔 에러 없음 |
| 14 | 새로 만든 .md (untracked) | 마커 없음 |
| 15 | 타이핑 중 반응 | 약 300ms 후 마커 갱신, 깜빡임 없음 |
| 16 | **중첩 블록으로 끝나는 문서의 끝부분 삭제** | 삼각형이 들여쓰기만큼 안쪽으로 밀리지 않고 좌측 gutter에 정렬됨 |
| 17 | 문단 중간에서 Enter로 블록 분할 | 최대 300ms 마커 공백 후 정상 복귀 (아래 설명 참조) |

- [ ] **Step 3: 문제 발생 시 대응**

- **8번 실패(drag handle 겹침):** `styles.css` 의 `left: -50px` 를 `-56px` 로 조정한다. 그래도 겹치면 `.bn-editor` 의 `padding-inline` 을 `54px 54px` → `64px 54px` 로 늘려 마커 전용 공간을 확보한다.
- **코드블록 레이아웃 깨짐(언어 선택 `<select>` 위치 이상):** `position: relative` 가 원인이다. `.markora-shell .bn-block-content[data-content-type="codeBlock"]` 에 대해서만 `position` 규칙을 빼고, 해당 블록은 `box-shadow: inset 3px 0 0 var(--markora-vcs-added)` 로 대체한다(바가 안쪽에 그려지지만 코드블록에는 자연스럽다).
- **10번 실패(이미지 오탐):** `baselinePipeline.ts` 의 `rewriteImagePathsForDisplay` 인자(`mdDir`, `serverUrl`)가 `bridge.loadFile()` 과 동일한지 확인한다.
- **15번에서 깜빡임:** `RECOMPUTE_DEBOUNCE_MS` 를 500으로 올린다.

- [ ] **Step 4: 결과 기록 및 커밋**

`docs/superpowers/specs/2026-08-11-git-change-markers-design.md` 의 상태 줄을 갱신한다:

```markdown
- 상태: 구현 완료 (자동 테스트 통과 · runIde 수동 검증 통과)
```

"구현 중 확인해야 할 항목" 섹션에 실제 확인 결과를 한 줄씩 덧붙인다.

```bash
git add docs/superpowers/specs/2026-08-11-git-change-markers-design.md
git commit -m "docs: Git 변경분 마커 구현 완료 및 수동 검증 결과 반영"
```

---

## 완료 조건

- `npm test` 전체 통과 (신규 46개 + 기존 전부)
- `npx tsc --noEmit` 오류 없음
- `./gradlew build` 성공
- Task 11의 15개 확인 항목 전부 통과
