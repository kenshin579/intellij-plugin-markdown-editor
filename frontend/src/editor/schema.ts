import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  createCodeBlockSpec,
} from '@blocknote/core';
import { KatexBlock } from '../blocks/KatexBlock';
import { MermaidBlock } from '../blocks/MermaidBlock';
import { HtmlCommentBlock } from '../blocks/HtmlCommentBlock';
import { KatexInline } from '../inline/KatexInline';
import { InlineImage } from '../inline/InlineImage';
import { codeBlockOptions } from './codeBlock';

const { codeBlock: _ignoredDefaultCodeBlock, ...restDefaultBlockSpecs } = defaultBlockSpecs;

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...restDefaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    katex: KatexBlock(),
    mermaid: MermaidBlock(),
    htmlComment: HtmlCommentBlock(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, katexInline: KatexInline, inlineImage: InlineImage },
});
