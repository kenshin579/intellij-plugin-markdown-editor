// baseline 조회 → 파싱 → diff → 마커 주입을 묶는 훅. 부수효과는 전부 여기에만 둔다.
//
// baseline은 전용 BlockNoteEditor 인스턴스에 replaceBlocks로 통과시킨다. editor.document는
// ProseMirror가 기본 props를 채워 정규화한 블록을 돌려주므로, 파싱 직후 블록과 그대로
// 비교하면 전부 변경으로 오탐한다. 양쪽 모두 PM 정규화를 거쳐야 한다.

import { useCallback, useEffect, useRef } from 'react';
import { BlockNoteEditor } from '@blocknote/core';
import type { MarkoraBridge } from '../types';
import { schema } from '../editor/schema';
import { markdownToBlocks } from './baselinePipeline';
import { flattenBlocks, type AnyBlock } from './blockKey';
import { diffBlocks } from './blockDiff';
import { createVcsPlugin, setVcsMarkers, createEmptyMarkers, type VcsMarkerState } from './vcsPlugin';

const RECOMPUTE_DEBOUNCE_MS = 300;
const BASELINE_RELOAD_DEBOUNCE_MS = 500;
// 'unavailable'이 이 횟수만큼 연속으로 오면 재조회를 끈다. 프로젝트 기동 직후에는 VCS
// 루트 매핑이 아직 등록되지 않아 첫 응답만 일시적으로 unavailable일 수 있으므로 1로 두면
// 그 탭은 파일을 닫았다 열기 전까지 영영 마커를 못 받는다(실패가 조용해 사용자도 모른다).
const UNAVAILABLE_LATCH_THRESHOLD = 2;

export function useVcsMarkers(editor: BlockNoteEditor<any, any, any>, bridge: MarkoraBridge): void {
  const baselineKeysRef = useRef<string[] | null>(null);
  // 마지막으로 파싱한 baseline 원문. 같으면 재파싱을 건너뛴다.
  const lastBaselineRawRef = useRef<string | null>(null);
  // 'unavailable' 응답이 연속 UNAVAILABLE_LATCH_THRESHOLD회 오면 이 파일에 대한 재조회를 완전히 끈다.
  const disabledRef = useRef(false);
  // 연속 unavailable 횟수. non-unavailable 응답을 받으면 0으로 리셋된다.
  const unavailableCountRef = useRef(0);
  const baselineEditorRef = useRef<BlockNoteEditor<any, any, any> | null>(null);
  const timerRef = useRef<number | null>(null);
  const baselineTimerRef = useRef<number | null>(null);

  // 플러그인을 view에 한 번 등록한다 (데코레이션 전용 — 문서 변경 없음).
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const plugin = createVcsPlugin();
    view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, plugin] }));
    return () => {
      const v = editor.prosemirrorView;
      if (!v) return;
      v.updateState(v.state.reconfigure({ plugins: v.state.plugins.filter((p) => p !== plugin) }));
    };
  }, [editor]);

  const recompute = useCallback(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const base = baselineKeysRef.current;
    if (!base) {
      setVcsMarkers(view, createEmptyMarkers());
      return;
    }
    const current = flattenBlocks(editor.document as unknown as AnyBlock[]);
    const result = diffBlocks(base, current.map((b) => b.key));

    const next: VcsMarkerState = {
      statuses: new Map(),
      deletionsBefore: new Set(),
      deletionAtEnd: result.deletionAtEnd,
    };
    for (const [index, status] of result.statuses) {
      const block = current[index];
      if (block?.id) next.statuses.set(block.id, status);
    }
    for (const index of result.deletionsBefore) {
      const block = current[index];
      if (block?.id) next.deletionsBefore.add(block.id);
    }
    setVcsMarkers(view, next);
  }, [editor]);

  const scheduleRecompute = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      recompute();
    }, RECOMPUTE_DEBOUNCE_MS);
  }, [recompute]);

  const loadBaseline = useCallback(async () => {
    if (disabledRef.current) return;
    try {
      const { status, content } = await bridge.fetchVcsBaseline();
      if (status === 'unavailable') {
        // 프로젝트 기동 직후에는 VCS 루트 매핑이 아직 등록되지 않아 일시적으로
        // unavailable이 나올 수 있다. 첫 응답만으로 영구히 끄면 그 탭은 파일을 닫았다
        // 열기 전까지 마커가 영영 없고, 실패가 조용해서 사용자는 이유도 알 수 없다.
        // 연속 UNAVAILABLE_LATCH_THRESHOLD회째부터 latch한다.
        unavailableCountRef.current += 1;
        if (unavailableCountRef.current >= UNAVAILABLE_LATCH_THRESHOLD) disabledRef.current = true;
        baselineKeysRef.current = null;
        lastBaselineRawRef.current = null;
      } else if (content === null) {
        // untracked — 비교 대상이 없다.
        unavailableCountRef.current = 0;
        baselineKeysRef.current = null;
        lastBaselineRawRef.current = null;
      } else {
        unavailableCountRef.current = 0;
        // 같은 baseline을 다시 파싱하지 않는다. Kotlin의 changeListUpdateDone은 편집 중
        // 분당 여러 번 발화하는데(자동저장 → VFS 변경 → changelist 갱신) HEAD 본문은
        // 커밋/브랜치 전환 전까지 그대로다. 원문이 같으면 파싱도 diff도 건너뛴다.
        if (content === lastBaselineRawRef.current) return;
        const { filePath, serverUrl } = bridge.getContext();
        if (!baselineEditorRef.current) {
          baselineEditorRef.current = BlockNoteEditor.create({ schema });
        }
        const be = baselineEditorRef.current;
        const blocks = await markdownToBlocks(be, filePath, serverUrl, content);
        be.replaceBlocks(be.document, blocks as any);
        baselineKeysRef.current = flattenBlocks(be.document as unknown as AnyBlock[]).map((b) => b.key);
        lastBaselineRawRef.current = content;
      }
    } catch (e) {
      // VCS 표시 실패가 편집을 방해해선 안 된다. 마커만 없앤다.
      console.warn('VCS baseline load failed:', e);
      baselineKeysRef.current = null;
      lastBaselineRawRef.current = null;
    }
    recompute();
  }, [bridge, recompute]);

  // vcsChanged 발화 자체가 잦으므로 fetch도 디바운스한다. 위의 원문 비교가 파싱은
  // 막아주지만, 매 발화마다 HTTP 왕복을 도는 것까지 막지는 못한다.
  const scheduleBaselineReload = useCallback(() => {
    if (baselineTimerRef.current) window.clearTimeout(baselineTimerRef.current);
    baselineTimerRef.current = window.setTimeout(() => {
      baselineTimerRef.current = null;
      void loadBaseline();
    }, BASELINE_RELOAD_DEBOUNCE_MS);
  }, [loadBaseline]);

  useEffect(() => { void loadBaseline(); }, [loadBaseline]);

  useEffect(() => editor.onChange(() => scheduleRecompute()), [editor, scheduleRecompute]);

  useEffect(() => bridge.onVcsChange(() => scheduleBaselineReload()), [bridge, scheduleBaselineReload]);

  useEffect(() => bridge.onReloadRequest(() => scheduleRecompute()), [bridge, scheduleRecompute]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (baselineTimerRef.current) window.clearTimeout(baselineTimerRef.current);
  }, []);
}
