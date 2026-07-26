import { describe, it, expect } from 'vitest';
import { summaryHtmlToInline, inlineToSummaryHtml, splitDetailsRuns, splitDetailsParts } from '../details';

describe('summaryHtmlToInline', () => {
  it('<b>와 <code>를 스타일 인라인 노드로 바꾼다', () => {
    expect(summaryHtmlToInline('<b>Q1.</b> <code>fx.Provide()</code>는 왜?')).toEqual([
      { type: 'text', text: 'Q1.', styles: { bold: true } },
      { type: 'text', text: ' ', styles: {} },
      { type: 'text', text: 'fx.Provide()', styles: { code: true } },
      { type: 'text', text: '는 왜?', styles: {} },
    ]);
  });
});

describe('inlineToSummaryHtml', () => {
  it('스타일 인라인 노드를 <b>/<code> HTML로 되돌린다', () => {
    const html = inlineToSummaryHtml([
      { type: 'text', text: 'Q1.', styles: { bold: true } },
      { type: 'text', text: ' ', styles: {} },
      { type: 'text', text: 'fx.Provide()', styles: { code: true } },
      { type: 'text', text: '는 왜?', styles: {} },
    ]);
    expect(html).toBe('<b>Q1.</b> <code>fx.Provide()</code>는 왜?');
  });

  it('원문 summary를 왕복해도 그대로다', () => {
    const original = '<b>Q7.</b> 같은 <code>*DBConnection</code> 타입인 커넥션을 주입받으려면?';
    expect(inlineToSummaryHtml(summaryHtmlToInline(original))).toBe(original);
  });

  it('꺾쇠와 앰퍼샌드는 이스케이프한다', () => {
    const nodes = summaryHtmlToInline('a &lt; b &amp;&amp; c');
    expect(inlineToSummaryHtml(nodes)).toBe('a &lt; b &amp;&amp; c');
  });
});

describe('splitDetailsRuns', () => {
  it('<details> 구간과 일반 구간을 나눈다', () => {
    const md = '앞\n\n<details>\n<summary>Q</summary>\n\nA\n\n</details>\n\n뒤\n';
    expect(splitDetailsRuns(md)).toEqual([
      { kind: 'plain', text: '앞\n' },
      { kind: 'details', text: '<details>\n<summary>Q</summary>\n\nA\n\n</details>' },
      { kind: 'plain', text: '\n뒤\n' },
    ]);
  });

  it('연속된 details를 각각 분리한다', () => {
    const md = '<details>\n<summary>Q1</summary>\n\nA1\n\n</details>\n\n<details>\n<summary>Q2</summary>\n\nA2\n\n</details>\n';
    const runs = splitDetailsRuns(md);
    expect(runs.filter(r => r.kind === 'details')).toHaveLength(2);
  });

  it('코드펜스 안의 <details>는 구간으로 잡지 않는다', () => {
    const md = '```html\n<details>\n<summary>예시</summary>\n</details>\n```\n';
    expect(splitDetailsRuns(md)).toEqual([{ kind: 'plain', text: md }]);
  });

  it('닫히지 않은 <details>는 일반 구간으로 남긴다 (가드가 저장을 막게)', () => {
    const md = '<details>\n<summary>Q</summary>\n\nA\n';
    expect(splitDetailsRuns(md)).toEqual([{ kind: 'plain', text: md }]);
  });
});

describe('splitDetailsParts', () => {
  it('summary 안쪽 HTML과 본문 마크다운을 분리한다', () => {
    const run = '<details>\n<summary><b>Q1.</b> 왜?</summary>\n\n**A.** 답이다.\n\n</details>';
    expect(splitDetailsParts(run)).toEqual({
      summary: '<b>Q1.</b> 왜?',
      inner: '**A.** 답이다.',
    });
  });

  it('summary가 details와 같은 줄에 있어도 분리한다', () => {
    const run = '<details><summary>Q</summary>\n\nA\n\n</details>';
    expect(splitDetailsParts(run)).toEqual({ summary: 'Q', inner: 'A' });
  });

  it('여러 문단 본문을 통째로 보존한다', () => {
    const run = '<details>\n<summary>Q</summary>\n\n첫 문단\n\n- 목록\n- 항목\n\n</details>';
    expect(splitDetailsParts(run)?.inner).toBe('첫 문단\n\n- 목록\n- 항목');
  });

  it('summary가 없으면 null (details로 다루지 않는다)', () => {
    expect(splitDetailsParts('<details>\n\n본문\n\n</details>')).toBeNull();
  });
});
