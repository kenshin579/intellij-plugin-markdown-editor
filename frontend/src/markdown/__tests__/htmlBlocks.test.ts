import { describe, it, expect } from 'vitest';
import { countHtmlBlocks, findLostHtmlBlocks } from '../htmlBlocks';

describe('countHtmlBlocks', () => {
  it('줄 시작의 여는/닫는 HTML 태그를 각각 센다', () => {
    const md = '<details>\n<summary>Q</summary>\n\nA\n\n</details>\n';
    const c = countHtmlBlocks(md);
    expect(c.get('details')).toBe(1);
    expect(c.get('/details')).toBe(1);
    expect(c.get('summary')).toBe(1);
  });

  it('HTML 주석을 센다 (blog-v2의 <!-- slides --> 마커)', () => {
    const c = countHtmlBlocks('본문\n\n<!-- slides -->\n\n더 본문\n');
    expect(c.get('!--')).toBe(1);
  });

  it('코드펜스 안의 HTML은 세지 않는다', () => {
    const md = '```html\n<details>\n<summary>예시</summary>\n</details>\n```\n';
    expect(countHtmlBlocks(md).size).toBe(0);
  });
});

describe('findLostHtmlBlocks', () => {
  it('사라진 시그니처를 손실량과 함께 보고한다', () => {
    const previous = '<details>\n<summary>Q</summary>\n\nA\n\n</details>\n';
    const next = 'A\n';
    expect(findLostHtmlBlocks(previous, next)).toEqual([
      { tag: 'details', lost: 1 },
      { tag: 'summary', lost: 1 },
      { tag: '/details', lost: 1 },
    ]);
  });
});
