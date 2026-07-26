import { createReactBlockSpec } from '@blocknote/react';

// HTML 주석 보존 블록.
//
// BlockNote 마크다운 파서는 <!-- … --> 를 버린다. blog-v2 는 `<!-- slides -->` 를
// 슬라이드 임베드 위치 마커로 쓰므로, 이게 사라지면 임베드가 깨지고 빌드 경고가 난다.
// 편집할 내용이 있는 블록이 아니라 위치를 지켜야 하는 마커라, 원문을 props 에 그대로
// 담아두고 화면에는 눈에 띄지 않는 칩으로만 표시한다(내용은 읽기 전용).
export const HtmlCommentBlock = createReactBlockSpec(
  {
    type: 'htmlComment',
    propSchema: { source: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block }) => {
      const source: string = block.props.source ?? '';
      // 표시용으로만 <!-- --> 껍데기를 벗기고 한 줄로 줄인다. 저장은 props.source 원문을 쓴다.
      const label = source
        .replace(/^<!--/, '')
        .replace(/-->$/, '')
        .trim()
        .replace(/\s+/g, ' ');
      return (
        <div className="markora-html-comment" title={source}>
          <span className="markora-html-comment-mark">{'<!--'}</span>
          <span className="markora-html-comment-body">{label}</span>
          <span className="markora-html-comment-mark">{'-->'}</span>
        </div>
      );
    },
  }
);
