// <details> 접기 블록 지원 (렌더 + 무손실 라운드트립)
//
// BlockNote의 마크다운 파서는 raw HTML 블록을 버리므로 <details>/<summary>가 통째로
// 사라진다(saveGuard 가 그 저장을 막는다). 이 모듈은 로드 시 <details> 구간을 직접
// 인식해 BlockNote 기본 toggleListItem 블록으로 조립하고, 저장 시 원래 HTML 구조로
// 되돌린다. 안쪽 본문은 일반 마크다운으로 파싱되므로 그대로 편집할 수 있다.
//
// CommonMark 에서 아래 문서는 HTML 블록 하나가 아니라 세 덩어리로 쪼개진다(빈 줄이
// HTML 블록을 끝낸다). 그래서 파서에 맡기지 않고 구간을 직접 잡아야 한다.
//
//   <details>                      ← HTML 블록
//   <summary>질문</summary>
//                                  ← 빈 줄
//   **답변**                        ← 일반 마크다운 문단
//                                  ← 빈 줄
//   </details>                     ← HTML 블록

import type { BlockNoteEditor } from '@blocknote/core';
import { parseMarkdownWithBlockquotes, serializeBlocksWithBlockquotes } from './blockquote';

type InlineNode = { type: 'text'; text: string; styles: Record<string, any> };
type AnyBlock = { type: string; props?: Record<string, any>; content?: any; children?: AnyBlock[] };

// BlockNote 기본 접기 블록. 스키마에 이미 들어 있어(defaultBlockSpecs) 접기 UI·자식
// 편집·키보드 동작을 그대로 쓴다. 이 모듈은 마크다운 ↔ <details> 변환만 담당한다.
const TOGGLE = 'toggleListItem';

// summary 안에서 쓰이는 인라인 태그 → BlockNote 스타일 키.
// blog-v2 전체를 조사한 결과 실제로 등장하는 것은 <b> 와 <code> 뿐이지만,
// 동의 태그(<strong>/<em>/<i>)도 같은 스타일로 받아 둔다.
const TAG_TO_STYLE: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  code: 'code',
};

const ENTITIES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
  '&amp;': '&', // 반드시 마지막에 처리 (아래 순서 의존)
};

export function decodeEntities(s: string): string {
  return s.replace(/&(?:lt|gt|quot|#39|apos|nbsp|amp);/g, m => ENTITIES[m] ?? m);
}

// <summary> 안쪽 HTML을 BlockNote 인라인 콘텐츠로 바꾼다.
// 지원하지 않는 태그는 태그만 버리고 안쪽 텍스트는 살린다(내용 손실 방지).
export function summaryHtmlToInline(html: string): InlineNode[] {
  const out: InlineNode[] = [];
  const styleStack: string[] = [];
  const TOKEN_RE = /<\/?([A-Za-z][A-Za-z0-9]*)\b[^>]*>/g;

  const pushText = (raw: string) => {
    if (raw === '') return;
    const styles: Record<string, any> = {};
    for (const s of styleStack) styles[s] = true;
    out.push({ type: 'text', text: decodeEntities(raw), styles });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(html)) !== null) {
    pushText(html.slice(last, m.index));
    const style = TAG_TO_STYLE[m[1].toLowerCase()];
    if (style) {
      if (m[0].startsWith('</')) {
        const i = styleStack.lastIndexOf(style);
        if (i !== -1) styleStack.splice(i, 1);
      } else {
        styleStack.push(style);
      }
    }
    last = m.index + m[0].length;
  }
  pushText(html.slice(last));
  return out;
}

// summary 로 쓸 때 안전한 최소 이스케이프. HTML 블록 안이므로 텍스트의 꺾쇠/앰퍼샌드가
// 태그로 해석되지 않도록 되돌린다. 따옴표는 속성값이 아니라 굳이 건드리지 않는다.
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// summaryHtmlToInline 의 역방향. 스타일이 여럿 걸린 경우 bold→italic→code 순으로 감싼다.
// (같은 순서를 쓰면 왕복이 안정적이다)
const STYLE_TO_TAG: [string, string][] = [['bold', 'b'], ['italic', 'i'], ['code', 'code']];

export type DetailsRun = { kind: 'details' | 'plain'; text: string };

const OPEN_RE = /^ {0,3}<details\b[^>]*>\s*$/i;
const CLOSE_RE = /^ {0,3}<\/details>\s*$/i;
const FENCE_RE = /^ {0,3}(```|~~~)/;

// 본문을 <details>…</details> 구간과 나머지 구간으로 나눈다.
// - 코드펜스 안은 건드리지 않는다.
// - 중첩 <details>는 가장 바깥 짝까지 한 구간으로 잡는다.
// - 닫는 태그를 못 찾으면 details 로 인정하지 않고 일반 구간에 남긴다. 그러면
//   BlockNote 가 그 HTML을 버리고 saveGuard 가 저장을 막는다(조용한 손실보다 낫다).
export function splitDetailsRuns(body: string): DetailsRun[] {
  const lines = body.split('\n');
  const runs: DetailsRun[] = [];
  let plain: string[] = [];
  let inFence = false;

  const flushPlain = () => {
    if (plain.length === 0) return;
    runs.push({ kind: 'plain', text: plain.join('\n') });
    plain = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence || !OPEN_RE.test(line)) { plain.push(line); continue; }

    // 짝이 맞는 </details> 를 찾는다(중첩 고려, 펜스 무시).
    let depth = 0;
    let end = -1;
    let scanFence = false;
    for (let j = i; j < lines.length; j++) {
      if (FENCE_RE.test(lines[j])) { scanFence = !scanFence; continue; }
      if (scanFence) continue;
      if (OPEN_RE.test(lines[j])) depth++;
      else if (CLOSE_RE.test(lines[j]) && --depth === 0) { end = j; break; }
    }
    if (end === -1) { plain.push(line); continue; } // 안 닫힘 → 일반 구간

    flushPlain();
    runs.push({ kind: 'details', text: lines.slice(i, end + 1).join('\n') });
    i = end;
  }
  flushPlain();
  return runs;
}

export interface DetailsParts {
  summary: string; // <summary> 안쪽 raw HTML
  inner: string;   // 본문 마크다운 (앞뒤 빈 줄 제거)
}

// details 구간 한 덩어리에서 summary 와 본문을 떼어낸다.
// <summary> 가 없으면 null — 접기 블록으로 다룰 수 없으므로 호출부가 일반 구간으로
// 되돌려 saveGuard 에 맡긴다.
export function splitDetailsParts(run: string): DetailsParts | null {
  const m = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(run);
  if (!m) return null;
  const afterSummary = run.slice(m.index + m[0].length);
  const closeAt = afterSummary.lastIndexOf('</details>');
  const inner = closeAt === -1 ? afterSummary : afterSummary.slice(0, closeAt);
  return { summary: m[1].trim(), inner: inner.replace(/^\s*\n/, '').trimEnd() };
}

export function inlineToSummaryHtml(nodes: InlineNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type !== 'text') continue;
    let piece = escapeText(n.text);
    for (const [style, tag] of STYLE_TO_TAG) {
      if (n.styles?.[style]) piece = `<${tag}>${piece}</${tag}>`;
    }
    out += piece;
  }
  return out;
}

// 원문 마크다운을 파싱하되 <details> 구간은 접기 블록으로 조립한다.
// 나머지 구간과 details 안쪽 본문은 모두 기존 blockquote 파이프라인에 재위임하므로
// 인용·목록·코드블록이 details 안에서도 평소대로 동작한다.
export async function parseMarkdownWithDetails(
  editor: BlockNoteEditor<any, any, any>,
  body: string,
): Promise<AnyBlock[]> {
  const out: AnyBlock[] = [];
  for (const run of splitDetailsRuns(body)) {
    const parts = run.kind === 'details' ? splitDetailsParts(run.text) : null;
    if (!parts) {
      // 일반 구간, 또는 <summary> 가 없어 접기로 만들 수 없는 details
      out.push(...(await parseMarkdownWithBlockquotes(editor, run.text)));
      continue;
    }
    out.push({
      type: TOGGLE,
      props: {},
      content: summaryHtmlToInline(parts.summary),
      children: parts.inner === ''
        ? []
        : await parseMarkdownWithBlockquotes(editor, parts.inner),
    });
  }
  return out;
}

// 접기 블록 하나를 원래 <details> 구조로 되돌린다.
async function serializeDetails(
  editor: BlockNoteEditor<any, any, any>,
  block: AnyBlock,
): Promise<string> {
  const summary = inlineToSummaryHtml((block.content as InlineNode[]) ?? []);
  const children = block.children ?? [];
  const head = `<details>\n<summary>${summary}</summary>\n`;
  if (children.length === 0) return `${head}\n</details>`;
  const inner = (await serializeBlocksWithBlockquotes(editor, children)).trimEnd();
  return `${head}\n${inner}\n\n</details>`;
}

// 블록 트리를 마크다운으로 직렬화하되 접기 블록만 <details> 복원을 거친다.
// 인접한 비-접기 블록은 묶어서 기존 blockquote 직렬화에 한 번에 넘긴다.
export async function serializeBlocksWithDetails(
  editor: BlockNoteEditor<any, any, any>,
  blocks: AnyBlock[],
): Promise<string> {
  const parts: string[] = [];
  let buffer: AnyBlock[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    parts.push((await serializeBlocksWithBlockquotes(editor, buffer)).trimEnd());
    buffer = [];
  };
  for (const block of blocks) {
    if (block.type === TOGGLE) {
      await flush();
      parts.push(await serializeDetails(editor, block));
    } else {
      buffer.push(block);
    }
  }
  await flush();
  return parts.join('\n\n') + '\n';
}
