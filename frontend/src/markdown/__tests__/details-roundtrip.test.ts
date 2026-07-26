// <details> 접기 블록 파싱/직렬화 라운드트립 테스트 (실제 BlockNote 사용).
import { describe, it, expect } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { parseMarkdownWithDetails, serializeBlocksWithDetails } from '../details';
import { postParse, preSerialize } from '../customParse';

const newEditor = () => BlockNoteEditor.create({ schema } as any);

async function roundtrip(md: string): Promise<string> {
  const editor = newEditor();
  const blocks = await parseMarkdownWithDetails(editor, md);
  return serializeBlocksWithDetails(editor, blocks as any);
}

const QUIZ = `# 5. 퀴즈

앞말이다.

<details>
<summary><b>Q1.</b> <code>fx.Provide()</code>는 왜 아무것도 실행하지 않나?</summary>

**A.** \`fx.Provide\`는 등록만 하고 실행은 미루기 때문이다. (2.2)

</details>

<details>
<summary><b>Q2.</b> <code>fx.Supply</code>와 무엇이 다른가?</summary>

**A.** 이미 만들어진 값을 등록한다.

- 설정 구조체
- 상수

</details>

# 6. 마무리
`;

describe('parseMarkdownWithDetails', () => {
  it('<details>를 접기 블록(toggleListItem)으로 만든다', async () => {
    const blocks: any[] = await parseMarkdownWithDetails(newEditor(), QUIZ) as any;
    const toggles = blocks.filter(b => b.type === 'toggleListItem');
    expect(toggles).toHaveLength(2);
  });

  it('summary의 <b>/<code>가 스타일로 살아난다', async () => {
    const blocks: any[] = await parseMarkdownWithDetails(newEditor(), QUIZ) as any;
    const first = blocks.find(b => b.type === 'toggleListItem');
    expect(first.content[0]).toEqual({ type: 'text', text: 'Q1.', styles: { bold: true } });
    expect(first.content.some((n: any) => n.styles?.code && n.text === 'fx.Provide()')).toBe(true);
  });

  it('본문이 편집 가능한 자식 블록으로 들어간다', async () => {
    const blocks: any[] = await parseMarkdownWithDetails(newEditor(), QUIZ) as any;
    const second = blocks.filter(b => b.type === 'toggleListItem')[1];
    // 문단 1개 + 목록 2개
    expect(second.children.map((c: any) => c.type)).toEqual([
      'paragraph', 'bulletListItem', 'bulletListItem',
    ]);
  });

  it('details 바깥 블록은 그대로 파싱된다', async () => {
    const blocks: any[] = await parseMarkdownWithDetails(newEditor(), QUIZ) as any;
    expect(blocks[0].type).toBe('heading');
    expect(blocks.at(-1).type).toBe('heading');
  });
});

describe('serializeBlocksWithDetails', () => {
  // 리스트 마커(`-`→`*`)와 loose list 변환은 markora 기존 파이프라인의 동작이라
  // details 와 무관하게 발생한다. 그래서 완전 동일성 검증은 리스트 없는 문서로 한다.
  const EXACT = `# 5. 퀴즈

앞말이다.

<details>
<summary><b>Q1.</b> <code>fx.Provide()</code>는 왜 아무것도 실행하지 않나?</summary>

**A.** \`fx.Provide\`는 등록만 하고 실행은 미루기 때문이다. (2.2)

</details>

<details>
<summary><b>Q2.</b> <code>fx.Supply</code>와 무엇이 다른가?</summary>

**A.** 이미 만들어진 값을 등록한다.

</details>

# 6. 마무리
`;

  it('퀴즈 문서를 편집 없이 왕복하면 원문과 같다', async () => {
    expect(await roundtrip(EXACT)).toBe(EXACT);
  });

  it('details가 없는 문서는 기존 직렬화와 동일하게 동작한다', async () => {
    const md = '# 제목\n\n문단이다.\n\n> 인용\n';
    expect(await roundtrip(md)).toBe(md);
  });

  it('본문이 빈 details도 왕복한다', async () => {
    const md = '<details>\n<summary>답 없음</summary>\n\n</details>\n';
    expect(await roundtrip(md)).toBe(md);
  });

  it('본문에 리스트가 있어도 details 구조와 항목이 보존된다', async () => {
    const out = await roundtrip(QUIZ);
    expect((out.match(/<details>/g) ?? [])).toHaveLength(2);
    expect((out.match(/<\/details>/g) ?? [])).toHaveLength(2);
    expect(out).toContain('<summary><b>Q2.</b> <code>fx.Supply</code>와 무엇이 다른가?</summary>');
    expect(out).toContain('설정 구조체');
    expect(out).toContain('상수');
  });
});

// Editor.tsx 의 실제 흐름(파싱 → postParse → replaceBlocks → preSerialize → 직렬화)을
// 그대로 재현한다. 위 테스트들은 블록 객체를 바로 직렬화하므로 ProseMirror 문서에
// 삽입될 때 접기 블록의 자식 구조가 살아남는지는 검증하지 못한다.
describe('Editor 실제 흐름 (replaceBlocks 경유)', () => {
  async function editorRoundtrip(md: string): Promise<string> {
    const editor = newEditor();
    const blocks = await parseMarkdownWithDetails(editor, md);
    editor.replaceBlocks(editor.document, postParse(blocks as any) as any);
    return serializeBlocksWithDetails(editor, preSerialize(editor.document as any) as any);
  }

  it('접기 블록이 문서 삽입을 거쳐도 <details>로 복원된다', async () => {
    const md = '<details>\n<summary><b>Q.</b> <code>x</code>는?</summary>\n\n**A.** 답이다.\n\n</details>\n';
    expect(await editorRoundtrip(md)).toBe(md);
  });

  it('자식 여러 개도 순서대로 보존된다', async () => {
    const md = '<details>\n<summary>Q</summary>\n\n첫 문단\n\n둘째 문단\n\n</details>\n';
    expect(await editorRoundtrip(md)).toBe(md);
  });

  it('details와 일반 블록이 섞여도 순서가 유지된다', async () => {
    const md = '# 앞\n\n<details>\n<summary>Q</summary>\n\nA\n\n</details>\n\n# 뒤\n';
    expect(await editorRoundtrip(md)).toBe(md);
  });

  it('HTML 주석도 문서 삽입을 거쳐 위치 그대로 복원된다', async () => {
    const md = '# 앞\n\n<!-- slides -->\n\n# 뒤\n';
    expect(await editorRoundtrip(md)).toBe(md);
  });
});

describe('HTML 주석 보존', () => {
  it('단독 주석은 htmlComment 블록이 된다', async () => {
    const blocks: any[] = await parseMarkdownWithDetails(newEditor(), '앞\n\n<!-- slides -->\n\n뒤\n') as any;
    const c = blocks.find(b => b.type === 'htmlComment');
    expect(c).toBeTruthy();
    expect(c.props.source).toBe('<!-- slides -->');
  });

  it('주석 문서를 왕복하면 원문과 같다', async () => {
    const md = '# 글\n\n<!-- slides -->\n\n본문\n';
    expect(await roundtrip(md)).toBe(md);
  });

  it('여러 줄 주석도 왕복한다', async () => {
    const md = '<!--\n메모 여러 줄\n-->\n';
    expect(await roundtrip(md)).toBe(md);
  });

  it('details와 주석이 함께 있어도 둘 다 보존된다', async () => {
    const md = '<details>\n<summary>Q</summary>\n\nA\n\n</details>\n\n<!-- slides -->\n';
    expect(await roundtrip(md)).toBe(md);
  });
});
