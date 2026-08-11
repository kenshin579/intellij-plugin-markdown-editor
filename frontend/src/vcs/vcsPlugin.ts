// VCS 변경 마커를 그리는 ProseMirror 플러그인. 문서를 변경하지 않고 decoration만 얹는다.
// search/searchPlugin.ts 와 동일한 명령형 API 패턴을 따른다.
//
// decoration은 blockContainer가 아니라 그 '첫 자식'(content 노드)에 건다. blockContainer는
// 중첩 자식까지 포함하므로 부모에 걸면 자식 높이까지 마커가 덮인다. 첫 자식에 걸면
// DOM의 .bn-block-content 에 클래스가 붙어 그 블록 자신의 높이만 차지한다.

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

export type VcsStatus = 'added' | 'modified';

export interface VcsMarkerState {
  /** BlockNote block id → 상태 */
  statuses: Map<string, VcsStatus>;
  /** 이 블록 '앞' 경계에 삭제 표시를 붙인다 */
  deletionsBefore: Set<string>;
  /** 문서 끝(마지막 블록 아래)에 삭제 표시를 붙인다 */
  deletionAtEnd: boolean;
}

export const EMPTY_MARKERS: VcsMarkerState = {
  statuses: new Map(),
  deletionsBefore: new Set(),
  deletionAtEnd: false,
};

export const vcsPluginKey = new PluginKey<VcsMarkerState>('markora-vcs');

const STATUS_CLASS: Record<VcsStatus, string> = {
  added: 'markora-vcs-added',
  modified: 'markora-vcs-modified',
};

interface BlockSpan {
  id: string;
  from: number;
  to: number;
}

function collectBlockSpans(doc: PMNode): BlockSpan[] {
  const spans: BlockSpan[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true;
    const id = node.attrs?.id as string | undefined;
    const inner = node.firstChild;
    if (!id || !inner) return true;
    spans.push({ id, from: pos + 1, to: pos + 1 + inner.nodeSize });
    return true;
  });
  return spans;
}

function buildDecorations(doc: PMNode, value: VcsMarkerState): DecorationSet {
  if (value.statuses.size === 0 && value.deletionsBefore.size === 0 && !value.deletionAtEnd) {
    return DecorationSet.empty;
  }
  const spans = collectBlockSpans(doc);
  if (spans.length === 0) return DecorationSet.empty;

  const lastIndex = spans.length - 1;
  const decos: Decoration[] = [];
  spans.forEach((span, index) => {
    const classes: string[] = [];
    const status = value.statuses.get(span.id);
    if (status) classes.push(STATUS_CLASS[status]);
    if (value.deletionsBefore.has(span.id)) classes.push('markora-vcs-deleted-before');
    if (value.deletionAtEnd && index === lastIndex) classes.push('markora-vcs-deleted-after');
    if (classes.length > 0) {
      decos.push(Decoration.node(span.from, span.to, { class: classes.join(' ') }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export function createVcsPlugin(): Plugin<VcsMarkerState> {
  return new Plugin<VcsMarkerState>({
    key: vcsPluginKey,
    state: {
      init: () => EMPTY_MARKERS,
      apply(tr: Transaction, value: VcsMarkerState): VcsMarkerState {
        const meta = tr.getMeta(vcsPluginKey) as VcsMarkerState | undefined;
        return meta ?? value;
      },
    },
    props: {
      decorations(state: EditorState) {
        return buildDecorations(state.doc, vcsPluginKey.getState(state) ?? EMPTY_MARKERS);
      },
    },
  });
}

/** 마커 상태를 교체한다. 문서는 변경되지 않는다. */
export function setVcsMarkers(view: EditorView, value: VcsMarkerState): void {
  view.dispatch(view.state.tr.setMeta(vcsPluginKey, value));
}
