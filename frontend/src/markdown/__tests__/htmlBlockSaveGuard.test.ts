// raw HTML 블록 저장 손실 엔드투엔드 회귀 테스트.
//
// 실제 BlockNote 파싱/직렬화를 거쳐, <details> 퀴즈 섹션을 가진 문서를 편집 없이
// 라운드트립했을 때 (1) HTML이 실제로 소실되고 (2) saveGuard가 그 저장을 차단하는지
// 검증한다. 유닛 테스트와 달리 파서 동작 변화까지 잡아낸다.
import { describe, it, expect } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { postParse, preSerialize } from '../customParse';
import { parseMarkdownWithBlockquotes, serializeBlocksWithBlockquotes } from '../blockquote';
import { maskTableImages, unmaskTableImages } from '../tableImage';
import { maskTableBreaks, unmaskBreakTokens } from '../tableLineBreak';
import { checkSaveSafety } from '../saveGuard';

// blog-v2 go-fx 글의 퀴즈 섹션 구조를 그대로 축약한 것.
// <details> 여는 블록 / 마크다운 답변 문단 / </details> 닫는 블록으로 쪼개지는
// CommonMark 구조가 핵심이라 빈 줄 위치를 바꾸면 안 된다.
const BODY = `# 5. 퀴즈

여기까지 읽었으면 아래 질문에 답할 수 있어야 한다.

<details>
<summary><b>Q1.</b> <code>fx.Provide()</code>는 왜 아무것도 실행하지 않나?</summary>

**A.** \`fx.Provide\`는 등록만 하고 실행은 미루는 lazy 등록이기 때문이다. (2.2)

</details>

<!-- slides -->

| 메서드 | 역할 |
|--------|------|
| \`fx.Provide\` | lazy 등록 |
| \`fx.Invoke\` | eager 실행 |
`;

// Editor.tsx 의 저장 경로와 동일한 순서로 본문을 재직렬화한다.
async function roundtrip(body: string): Promise<string> {
  const editor = BlockNoteEditor.create({ schema } as any);
  const blocks = await parseMarkdownWithBlockquotes(editor, maskTableBreaks(maskTableImages(body)));
  const parsed = postParse(blocks as any);
  return unmaskTableImages(unmaskBreakTokens(
    await serializeBlocksWithBlockquotes(editor, preSerialize(parsed as any) as any),
  ));
}

describe('raw HTML 블록 저장 손실 (엔드투엔드)', () => {
  it('BlockNote 라운드트립은 <details>/<summary>/주석을 실제로 잃는다', async () => {
    const next = await roundtrip(BODY);
    expect(next).not.toContain('<details>');
    expect(next).not.toContain('<summary');
    expect(next).not.toContain('<!-- slides -->');
    // 질문 텍스트까지 통째로 사라진다 (증상의 본체)
    expect(next).not.toContain('아무것도 실행하지 않나');
  });

  it('길이 기반 가드로는 못 잡는 손실을 HTML 가드가 차단한다', async () => {
    const next = await roundtrip(BODY);
    // 테이블 셀 패딩이 손실분을 상쇄해 감소폭이 차단 기준(50%)에 한참 못 미친다.
    // 실제 go-fx 글(738줄)에서는 패딩 증가가 손실을 넘어서 총 글자 수가 오히려 늘었다.
    // 어느 쪽이든 길이 기반 검사만으로는 통과해버린다는 게 요점.
    const shrinkRatio = (BODY.length - next.length) / BODY.length;
    expect(shrinkRatio).toBeLessThan(0.5);

    const guard = checkSaveSafety(BODY, next);
    expect(guard.safe).toBe(false);
    expect(guard.reason).toMatch(/html/i);
    expect(guard.reason).toMatch(/details/);
  });
});

// 스캐너는 줄 시작의 `<태그` 를 세므로 autolink(`<https://…>`)도 태그로 집계된다.
// 라운드트립에서 살아남으면 전후 개수가 같아 차단되지 않는다 — 그 전제를 고정한다.
describe('오탐 방지: 꺾쇠로 시작하는 마크다운', () => {
  it.each([
    ['autolink URL', '문서\n\n<https://example.com>\n\n끝\n'],
    ['autolink 이메일', '문서\n\n<foo@bar.com>\n\n끝\n'],
  ])('%s 는 보존되므로 저장을 막지 않는다', async (_name, md) => {
    const next = await roundtrip(md);
    expect(next).toContain(md.trim().split('\n\n')[1]);
    expect(checkSaveSafety(md, next).safe).toBe(true);
  });

  it.each([
    ['<TODO>', '문서\n\n<TODO> 나중에 채운다\n\n끝\n'],
    ['<T>', '문서\n\n<T> 는 타입 파라미터다\n\n끝\n'],
  ])('%s 는 파서가 실제로 지우므로 차단이 맞다', async (_name, md) => {
    const next = await roundtrip(md);
    // 오탐이 아니라 진짜 손실임을 먼저 확인한다
    expect(next).not.toContain('<');
    expect(checkSaveSafety(md, next).safe).toBe(false);
  });
});
