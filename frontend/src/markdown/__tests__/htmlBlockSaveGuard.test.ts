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

describe('처리 대상 raw HTML 은 보존된다', () => {
  it('<details>·질문 텍스트·HTML 주석이 모두 살아남는다', async () => {
    const next = await roundtrip(BODY);
    expect(next).toContain('<details>');
    expect(next).toContain('<summary><b>Q1.</b>');
    expect(next).toContain('아무것도 실행하지 않나');
    expect(next).toContain('<!-- slides -->');
  });

  it('퀴즈 문서 저장이 더 이상 차단되지 않는다', async () => {
    const next = await roundtrip(BODY);
    expect(checkSaveSafety(BODY, next).safe).toBe(true);
  });
});

describe('아직 처리하지 않는 raw HTML 은 가드가 막는다', () => {
  it('<div> 래퍼는 소실되며 저장이 차단된다', async () => {
    const body = '# 글\n\n<div align="center">\n\n본문이 충분히 길게 이어진다\n\n</div>\n';
    const next = await roundtrip(body);
    // 오탐이 아니라 진짜 손실임을 먼저 확인한다
    expect(next).not.toContain('<div');
    const guard = checkSaveSafety(body, next);
    expect(guard.safe).toBe(false);
    expect(guard.reason).toMatch(/html/i);
    expect(guard.reason).toMatch(/div/);
  });

  it('길이가 거의 안 줄어도 차단한다 — 길이 기반 검사로는 못 잡는다', async () => {
    const body = '# 글\n\n<div>\n\n' + '본문이 아주 길게 이어지는 문단이다. '.repeat(10) + '\n\n</div>\n';
    const next = await roundtrip(body);
    const shrinkRatio = (body.length - next.length) / body.length;
    expect(shrinkRatio).toBeLessThan(0.5);
    expect(checkSaveSafety(body, next).safe).toBe(false);
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
