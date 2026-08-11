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
