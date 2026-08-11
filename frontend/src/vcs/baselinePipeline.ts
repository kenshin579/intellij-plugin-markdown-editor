import type { BlockNoteEditor } from '@blocknote/core';
import { splitFrontmatter } from '../bridge/transform';
import { rewriteImagePathsForDisplay, dirOf } from '../bridge/imageMap';
import { maskTableImages } from '../markdown/tableImage';
import { maskTableBreaks } from '../markdown/tableLineBreak';
import { parseMarkdownWithDetails } from '../markdown/details';
import { postParse } from '../markdown/customParse';
import type { AnyBlock } from './blockKey';

/**
 * 마크다운 원문을 블록 리스트로 변환한다.
 *
 * 순서는 Editor.tsx 초기 로드 경로(bridge.loadFile + parseMarkdownWithDetails + postParse)와
 * 정확히 같아야 한다. 어긋나면 baseline과 현재 문서가 다른 변환을 거쳐 변경이 오탐한다.
 *
 * rewriteImagePathsForDisplay는 반드시 적용해야 한다. 생략하면 baseline의 이미지는
 * 상대경로, 현재 문서는 local-image 절대 URL이 되어 이미지가 든 블록이 전부 오탐한다.
 * 반환되는 map/htmlMap은 버린다 — 저장 경로의 imageMap을 오염시키면 안 된다.
 */
export async function markdownToBlocks(
  editor: BlockNoteEditor<any, any, any>,
  filePath: string,
  serverUrl: string,
  raw: string,
): Promise<AnyBlock[]> {
  const { body } = splitFrontmatter(raw);
  const mdDir = dirOf(filePath);
  const { body: rewritten } = rewriteImagePathsForDisplay(body, mdDir, serverUrl);
  const blocks = await parseMarkdownWithDetails(editor, maskTableBreaks(maskTableImages(rewritten)));
  return postParse(blocks as any) as AnyBlock[];
}
