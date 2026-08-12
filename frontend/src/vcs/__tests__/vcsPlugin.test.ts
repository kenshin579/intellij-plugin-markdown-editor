import { describe, it, expect, vi } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { createVcsPlugin, setVcsMarkers, createEmptyMarkers } from '../vcsPlugin';

async function mountEditor(md: string) {
  const editor = BlockNoteEditor.create({ schema });
  const blocks = await editor.tryParseMarkdownToBlocks(md);
  editor.replaceBlocks(editor.document, blocks as any);
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  const view = editor.prosemirrorView!;
  view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, createVcsPlugin()] }));
  return { editor, view, host };
}

describe('vcsPlugin', () => {
  it('상태가 비면 아무 클래스도 붙지 않는다', async () => {
    const { host } = await mountEditor('# T\n\npara\n');
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(0);
  });

  it('added 상태인 블록의 .bn-block-content에 클래스가 붙는다', async () => {
    const { editor, view, host } = await mountEditor('# T\n\npara\n');
    const target = editor.document[1].id;
    setVcsMarkers(view, { ...createEmptyMarkers(), statuses: new Map([[target, 'added' as const]]) });
    const hit = host.querySelectorAll('.markora-vcs-added');
    expect(hit.length).toBe(1);
    expect(hit[0].classList.contains('bn-block-content')).toBe(true);
    expect(hit[0].getAttribute('data-content-type')).toBe('paragraph');
  });

  it('modified와 삭제 표시가 한 블록에 함께 붙을 수 있다', async () => {
    const { editor, view, host } = await mountEditor('# T\n\npara\n');
    const target = editor.document[1].id;
    setVcsMarkers(view, {
      statuses: new Map([[target, 'modified' as const]]),
      deletionsBefore: new Set([target]),
      deletionAtEnd: false,
    });
    const el = host.querySelector('.markora-vcs-modified')!;
    expect(el.classList.contains('markora-vcs-deleted-before')).toBe(true);
  });

  it('중첩 자식 블록도 독립적으로 마커를 받는다', async () => {
    const { editor, view, host } = await mountEditor('- a\n  - b\n');
    const child = editor.document[0].children[0].id;
    setVcsMarkers(view, { ...createEmptyMarkers(), statuses: new Map([[child, 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(1);
  });

  it('deletionAtEnd는 마지막 블록에 붙는다', async () => {
    const { host, view } = await mountEditor('# T\n\npara\n');
    setVcsMarkers(view, { ...createEmptyMarkers(), deletionAtEnd: true });
    const hit = host.querySelectorAll('.markora-vcs-deleted-after');
    expect(hit.length).toBe(1);
    expect(hit[0].getAttribute('data-content-type')).toBe('paragraph');
  });

  it('존재하지 않는 id는 무시된다', async () => {
    const { host, view } = await mountEditor('# T\n\npara\n');
    setVcsMarkers(view, { ...createEmptyMarkers(), statuses: new Map([['no-such-id', 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(0);
  });

  // --- auto-save 회귀 방지 ---------------------------------------------------
  // setVcsMarkers는 setMeta만 사용하는 step 없는 트랜잭션을 디스패치해야 한다. 이 성질이
  // 깨지면(누군가 문서를 건드리는 단계를 "친절하게" 추가하면) Tiptap의 "update" 이벤트가
  // 발생해 Editor.tsx의 scheduleSave()가 마커 갱신마다 실행되어 스퓨리어스 auto-save가 생긴다.

  it('setVcsMarkers가 만드는 트랜잭션은 docChanged가 false이고 editor.onChange를 트리거하지 않는다', async () => {
    const { editor, view } = await mountEditor('# T\n\npara\n');
    const target = editor.document[1].id;

    const captured: { docChanged: boolean }[] = [];
    const originalDispatch = view.dispatch.bind(view);
    (view as any).dispatch = (tr: any) => {
      captured.push({ docChanged: tr.docChanged });
      return originalDispatch(tr);
    };

    const onChangeSpy = vi.fn();
    const unsubscribe = editor.onChange(onChangeSpy);

    setVcsMarkers(view, { ...createEmptyMarkers(), statuses: new Map([[target, 'added' as const]]) });

    (view as any).dispatch = originalDispatch;
    unsubscribe();

    expect(captured.length).toBe(1);
    expect(captured[0].docChanged).toBe(false);
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  // --- 문서 변경 전후 마커 유지 ------------------------------------------------
  // Task 9는 디바운스 tick 사이에도 마커가 남아 있다가 다음 재계산까지 버텨야 한다는 것에
  // 의존한다: 문서를 바꾸지 않는 트랜잭션 뒤에는 그대로 유지되고, 문서가 바뀌어도 대상
  // 블록의 id가 살아있으면(예: 같은 블록 내부 편집) 새 위치에 다시 붙어야 한다.

  it('문서를 바꾸지 않는 트랜잭션 뒤에도 마커가 유지된다', async () => {
    const { editor, view, host } = await mountEditor('# T\n\npara\n');
    const target = editor.document[1].id;
    setVcsMarkers(view, { ...createEmptyMarkers(), statuses: new Map([[target, 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(1);

    // step이 없는 트랜잭션 — docChanged는 false.
    view.dispatch(view.state.tr);

    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(1);
  });

  it('문서가 바뀌어도 대상 블록 id가 남아있으면 마커가 새 위치에 다시 붙는다', async () => {
    const { editor, view, host } = await mountEditor('# T\n\npara\n');
    const target = editor.document[1].id;
    setVcsMarkers(view, { ...createEmptyMarkers(), statuses: new Map([[target, 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(1);

    // 같은 블록(id 유지)의 내용을 바꾸는 문서 변경 트랜잭션.
    editor.updateBlock(target, { content: [{ type: 'text', text: 'para changed', styles: {} }] } as any);

    const hit = host.querySelectorAll('.markora-vcs-added');
    expect(hit.length).toBe(1);
    expect(hit[0].textContent).toContain('para changed');
  });
});
