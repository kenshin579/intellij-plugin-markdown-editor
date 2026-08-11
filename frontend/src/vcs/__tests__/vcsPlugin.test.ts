import { describe, it, expect } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { createVcsPlugin, setVcsMarkers, EMPTY_MARKERS } from '../vcsPlugin';

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
    setVcsMarkers(view, { ...EMPTY_MARKERS, statuses: new Map([[target, 'added' as const]]) });
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
    setVcsMarkers(view, { ...EMPTY_MARKERS, statuses: new Map([[child, 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(1);
  });

  it('deletionAtEnd는 마지막 블록에 붙는다', async () => {
    const { host, view } = await mountEditor('# T\n\npara\n');
    setVcsMarkers(view, { ...EMPTY_MARKERS, deletionAtEnd: true });
    const hit = host.querySelectorAll('.markora-vcs-deleted-after');
    expect(hit.length).toBe(1);
    expect(hit[0].getAttribute('data-content-type')).toBe('paragraph');
  });

  it('존재하지 않는 id는 무시된다', async () => {
    const { host, view } = await mountEditor('# T\n\npara\n');
    setVcsMarkers(view, { ...EMPTY_MARKERS, statuses: new Map([['no-such-id', 'added' as const]]) });
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(0);
  });
});
