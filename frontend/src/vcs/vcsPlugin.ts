// VCS 변경 마커를 그리는 ProseMirror 플러그인. 문서를 변경하지 않고 decoration만 얹는다.
// search/searchPlugin.ts 와 동일한 명령형 API 패턴을 따른다.
//
// decoration은 blockContainer가 아니라 그 '첫 자식'(content 노드)에 건다. blockContainer는
// 중첩 자식까지 포함하므로 부모에 걸면 자식 높이까지 마커가 덮인다. 첫 자식에 걸면
// DOM의 .bn-block-content 에 클래스가 붙어 그 블록 자신의 높이만 차지한다.
//
// setVcsMarkers는 tr.setMeta만 사용해 step 없는 트랜잭션을 디스패치한다. 이 트랜잭션은
// docChanged가 false이므로 Tiptap의 "update" 이벤트(→ BlockNoteEditor.onChange →
// Editor.tsx의 scheduleSave)를 유발하지 않는다 — 마커 갱신이 auto-save를 트리거하지 않는
// 이유. 이 성질은 vcsPlugin.test.ts에 회귀 테스트로 고정되어 있다.

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

/**
 * 빈 마커 상태를 새로 만든다. 모듈 수준 싱글턴을 공유하면(구 EMPTY_MARKERS) 호출자가
 * Map/Set을 제자리 변경(.set/.add)할 때 '비어 있음'의 의미가 그 에디터 탭 생애 동안
 * 영구히 깨진다. Object.freeze는 Map/Set 변경을 막지 못하므로 팩토리로 대체한다.
 */
export function createEmptyMarkers(): VcsMarkerState {
  return { statuses: new Map(), deletionsBefore: new Set(), deletionAtEnd: false };
}

interface VcsPluginState {
  markers: VcsMarkerState;
  decorations: DecorationSet;
}

export const vcsPluginKey = new PluginKey<VcsPluginState>('markora-vcs');

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
  doc.descendants((node, pos, parent, index) => {
    // blockContainer의 첫 자식은 그 블록의 콘텐츠(paragraph/heading/codeBlock 등) 자체다.
    // 내부 인라인/텍스트 노드까지 순회할 필요가 없으므로 여기서 가지치기한다. 두 번째 자식부터는
    // (있다면) 중첩된 blockGroup이므로 계속 내려가야 한다 — 이 분기가 그걸 건너뛰지 않는다.
    if (parent?.type.name === 'blockContainer' && index === 0) return false;
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

export function createVcsPlugin(): Plugin<VcsPluginState> {
  return new Plugin<VcsPluginState>({
    key: vcsPluginKey,
    state: {
      init: () => ({ markers: createEmptyMarkers(), decorations: DecorationSet.empty }),
      apply(tr: Transaction, value: VcsPluginState, _old: EditorState, newState: EditorState): VcsPluginState {
        const meta = tr.getMeta(vcsPluginKey) as VcsMarkerState | undefined;
        // searchPlugin.ts와 동일한 패턴: 비용이 드는 문서 순회는 apply()에서 필요할 때만
        // 수행하고, decorations() prop은 이미 계산된 값을 그대로 반환하는 값싼 읽기로 둔다.
        if (meta) {
          return { markers: meta, decorations: buildDecorations(newState.doc, meta) };
        }
        if (tr.docChanged) {
          return { markers: value.markers, decorations: buildDecorations(newState.doc, value.markers) };
        }
        return value;
      },
    },
    props: {
      decorations(state: EditorState) {
        return vcsPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}

/** 마커 상태를 교체한다. step 없는 setMeta 트랜잭션만 디스패치하므로 문서는 변경되지 않는다. */
export function setVcsMarkers(view: EditorView, value: VcsMarkerState): void {
  view.dispatch(view.state.tr.setMeta(vcsPluginKey, value));
}
