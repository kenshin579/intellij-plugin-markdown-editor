// raw HTML 블록 스캐너 (저장 손실 가드용)
//
// BlockNote의 마크다운 파서는 remark→rehype 파이프라인에서 allowDangerousHtml 이 꺼져 있어
// raw HTML 블록(<details>, <div>, HTML 주석 등)을 통째로 버린다. 그 상태로 재직렬화해
// 저장하면 원문의 HTML이 조용히 삭제된다. 이 모듈은 본문에 있는 raw HTML 블록을 세어
// 저장 전후를 비교할 수 있게 한다.

// 줄 시작(들여쓰기 3칸 이하)의 여는/닫는 태그. CommonMark HTML 블록 조건과 맞춘다.
const TAG_LINE_RE = /^ {0,3}<(\/?)([A-Za-z][A-Za-z0-9-]*)/;
// 줄 시작의 HTML 주석. blog-v2의 `<!-- slides -->` 임베드 마커가 여기 해당한다.
const COMMENT_LINE_RE = /^ {0,3}<!--/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

// 시그니처별 등장 횟수를 센다. 여는 태그는 'details', 닫는 태그는 '/details'.
export function countHtmlBlocks(md: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

  let inFence = false;
  for (const line of md.split('\n')) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (COMMENT_LINE_RE.test(line)) { bump('!--'); continue; }
    const m = TAG_LINE_RE.exec(line);
    if (m) bump(`${m[1]}${m[2].toLowerCase()}`);
  }
  return counts;
}

export interface LostHtmlBlock {
  tag: string;
  lost: number;
}

// previous 에 있었는데 next 에서 줄어든 raw HTML 블록을 보고한다.
// BlockNote는 raw HTML을 렌더하지 않으므로 사용자가 에디터 안에서 의도적으로 지울 수
// 없다. 따라서 개수가 줄었다면 파서 손실로 간주해도 안전하다.
export function findLostHtmlBlocks(previous: string, next: string): LostHtmlBlock[] {
  const before = countHtmlBlocks(previous);
  const after = countHtmlBlocks(next);
  const lost: LostHtmlBlock[] = [];
  for (const [tag, n] of before) {
    const diff = n - (after.get(tag) ?? 0);
    if (diff > 0) lost.push({ tag, lost: diff });
  }
  return lost;
}
