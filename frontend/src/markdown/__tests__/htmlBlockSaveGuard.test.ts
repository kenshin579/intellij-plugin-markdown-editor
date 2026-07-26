// raw HTML 블록 저장 손실 엔드투엔드 회귀 테스트.
//
// Editor.tsx 의 저장 경로를 그대로 재현해, 파서가 다루지 못하는 raw HTML 이 남아 있으면
// saveGuard 가 그 저장을 차단하는지 검증한다. <details> 는 details.ts 가 접기 블록으로
// 처리하므로 이제 보존되지만, HTML 주석 등 나머지는 여전히 소실되며 가드가 막아야 한다.
import { describe, it, expect } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { postParse, preSerialize } from '../customParse';
import { parseMarkdownWithDetails, serializeBlocksWithDetails } from '../details';
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
  const blocks = await parseMarkdownWithDetails(editor, maskTableBreaks(maskTableImages(body)));
  const parsed = postParse(blocks as any);
  return unmaskTableImages(unmaskBreakTokens(
    await serializeBlocksWithDetails(editor, preSerialize(parsed as any) as any),
  ));
}

describe('raw HTML 블록 저장 손실 (엔드투엔드)', () => {
  it('<details>와 질문 텍스트는 접기 블록 처리로 보존된다', async () => {
    const next = await roundtrip(BODY);
    expect(next).toContain('<details>');
    expect(next).toContain('<summary><b>Q1.</b>');
    expect(next).toContain('아무것도 실행하지 않나');
  });

  it('HTML 주석은 여전히 소실된다 — 아직 처리 대상이 아니다', async () => {
    const next = await roundtrip(BODY);
    expect(next).not.toContain('<!-- slides -->');
  });

  it('길이 기반 가드로는 못 잡는 주석 손실을 HTML 가드가 차단한다', async () => {
    const next = await roundtrip(BODY);
    // 주석 한 줄이 사라져도 감소폭은 차단 기준(50%)에 한참 못 미쳐 길이 검사는 통과한다.
    const shrinkRatio = (BODY.length - next.length) / BODY.length;
    expect(shrinkRatio).toBeLessThan(0.5);

    const guard = checkSaveSafety(BODY, next);
    expect(guard.safe).toBe(false);
    expect(guard.reason).toMatch(/html/i);
  });

  it('주석이 없으면 details 문서는 저장이 허용된다', async () => {
    const body = BODY.replace('<!-- slides -->\n\n', '');
    const next = await roundtrip(body);
    expect(checkSaveSafety(body, next).safe).toBe(true);
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
