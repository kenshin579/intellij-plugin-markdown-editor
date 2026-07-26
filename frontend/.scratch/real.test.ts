import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../src/editor/schema';
import { postParse, preSerialize } from '../src/markdown/customParse';
import { parseMarkdownWithDetails, serializeBlocksWithDetails } from '../src/markdown/details';
import { maskTableImages, unmaskTableImages } from '../src/markdown/tableImage';
import { maskTableBreaks, unmaskBreakTokens } from '../src/markdown/tableLineBreak';
import { splitFrontmatter } from '../src/bridge/transform';
import { checkSaveSafety } from '../src/markdown/saveGuard';

const FILES = [
  '/Users/user/src/workspace_markora/blog-v2.advenoh.pe.kr/contents/go/go-fx-의존성-주입/index.md',
  '/Users/user/src/workspace_markora/blog-v2.advenoh.pe.kr/contents/cloud/grafana-완벽-가이드-1-prometheus와-grafana-기초/index.md',
];

describe('실제 파일', () => {
  for (const path of FILES) {
    it(path.split('/').slice(-2)[0], async () => {
      const { body } = splitFrontmatter(readFileSync(path, 'utf8'));
      const editor = BlockNoteEditor.create({ schema } as any);
      const blocks = await parseMarkdownWithDetails(editor, maskTableBreaks(maskTableImages(body)));
      editor.replaceBlocks(editor.document, postParse(blocks as any) as any);
      const next = unmaskTableImages(unmaskBreakTokens(
        await serializeBlocksWithDetails(editor, preSerialize(editor.document as any) as any)));
      const g = checkSaveSafety(body, next, body);
      const n = (s: string, re: RegExp) => (s.match(re) ?? []).length;
      console.log(`  <details>  ${n(body, /<details>/g)} → ${n(next, /<details>/g)}`);
      console.log(`  <summary>  ${n(body, /<summary>/g)} → ${n(next, /<summary>/g)}`);
      console.log(`  주석       ${n(body, /<!--/g)} → ${n(next, /<!--/g)}`);
      console.log(`  Q10 텍스트 보존: ${/조립된 인스턴스를 테스트로 꺼낼 때/.test(next)}`);
      console.log(`  safe: ${g.safe}  ${g.reason ?? ''}`);
    });
  }
});
