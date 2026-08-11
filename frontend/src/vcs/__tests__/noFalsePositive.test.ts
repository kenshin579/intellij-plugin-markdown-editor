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
