// useVcsMarkers 통합(e2e) 테스트.
//
// 이 훅은 bridge → baseline 파싱 → diff → block id 매핑 → decoration까지 전체 체인이
// 처음으로 한 곳에서 도는 지점이다. 각 조각(blockKey/blockDiff/vcsPlugin/baselinePipeline)은
// 자기 몫만 따로 테스트되어 있으므로, 여기서는 전체가 실제로 맞물려 돌아가는지만 본다.
//
// noFalsePositive.test.ts의 패턴을 따라 현재 문서도 markdownToBlocks로 만든다 — 실제
// Editor.tsx 로드 경로와 동일한 변환을 거쳐야 baseline과 비교했을 때 오탐이 없다.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../editor/schema';
import { markdownToBlocks } from '../baselinePipeline';
import * as baselinePipelineModule from '../baselinePipeline';
import { useVcsMarkers } from '../useVcsMarkers';
import type { MarkoraBridge, Theme, VcsBaseline } from '../../types';

const FILE_PATH = '/proj/docs/doc.md';
const SERVER_URL = 'http://localhost:63342/markora/';
// useVcsMarkers.ts의 상수와 값을 맞춘다 (모듈이 export하지 않으므로 테스트에서 복제).
const BASELINE_RELOAD_DEBOUNCE_MS = 500;

async function mountCurrentEditor(md: string) {
  const editor = BlockNoteEditor.create({ schema });
  const blocks = await markdownToBlocks(editor, FILE_PATH, SERVER_URL, md);
  editor.replaceBlocks(editor.document, blocks as any);
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  return { editor, host };
}

interface StubBridge {
  bridge: MarkoraBridge;
  fetchVcsBaseline: ReturnType<typeof vi.fn>;
  setBaseline: (b: VcsBaseline) => void;
  fireVcsChange: () => void;
  fireReloadRequest: () => void;
}

function createStubBridge(): StubBridge {
  const vcsListeners = new Set<() => void>();
  const reloadListeners = new Set<() => void>();
  const themeListeners = new Set<(t: Theme) => void>();
  let baseline: VcsBaseline = { status: 'untracked', content: null };
  const fetchVcsBaseline = vi.fn(async (): Promise<VcsBaseline> => baseline);
  const bridge: MarkoraBridge = {
    getContext: () => ({ filePath: FILE_PATH, serverUrl: SERVER_URL, initialTheme: 'light' }),
    loadFile: async () => ({ body: '', frontmatter: '' }),
    peekFile: async () => '',
    saveFile: async () => {},
    uploadImage: async () => ({ url: '' }),
    onThemeChange: (cb) => { themeListeners.add(cb); return () => themeListeners.delete(cb); },
    onReloadRequest: (cb) => { reloadListeners.add(cb); return () => reloadListeners.delete(cb); },
    fetchVcsBaseline,
    onVcsChange: (cb) => { vcsListeners.add(cb); return () => vcsListeners.delete(cb); },
  };
  return {
    bridge,
    fetchVcsBaseline,
    setBaseline: (b) => { baseline = b; },
    fireVcsChange: () => vcsListeners.forEach((cb) => cb()),
    fireReloadRequest: () => reloadListeners.forEach((cb) => cb()),
  };
}

// 순수 Promise 체인(타이머 없이 이어지는 await)을 흘려보낸다. fake timers 활성 여부와
// 무관하게 동작한다 — 마이크로태스크 큐는 fake timer가 가짜로 만드는 대상이 아니다.
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('useVcsMarkers (e2e)', () => {
  it('바뀐 문단 하나에 정확히 하나의 modified 마커가 붙는다', async () => {
    const mdCurrent = '# Title\n\nParagraph one.\n\nParagraph two original.\n';
    const mdBaseline = '# Title\n\nParagraph one.\n\nParagraph two DIFFERENT.\n';
    const { editor, host } = await mountCurrentEditor(mdCurrent);
    const { bridge, fetchVcsBaseline, setBaseline } = createStubBridge();
    setBaseline({ status: 'changed', content: mdBaseline });

    renderHook(
      ({ editor: e, bridge: b }) => useVcsMarkers(e, b),
      { initialProps: { editor, bridge } },
    );

    await waitFor(() => {
      expect(host.querySelectorAll('.markora-vcs-modified').length).toBe(1);
    });

    const marked = host.querySelector('.markora-vcs-modified')!;
    expect(marked.textContent).toContain('Paragraph two original.');
    expect(host.querySelectorAll('.markora-vcs-added').length).toBe(0);
    expect(fetchVcsBaseline).toHaveBeenCalledTimes(1);
  });

  // unavailable 연속 횟수에 따른 latch 동작. 프로젝트 기동 직후에는 VCS 루트 매핑이
  // 아직 등록되지 않아 첫 응답만 일시적으로 unavailable일 수 있으므로, 1회만으로 영구히
  // latch하면 그 탭은 파일을 닫았다 열기 전까지 마커를 영영 못 받는다. 연속
  // UNAVAILABLE_LATCH_THRESHOLD(=2)회부터 latch되고, 성공 응답이 오면 카운터가 리셋된다.

  it('unavailable 1회 뒤 성공 응답이 오면 마커가 나타난다 (기동 직후 일시적 unavailable에서 복구)', async () => {
    const mdCurrent = '# T\n\npara one\n\npara two original\n';
    const mdBaseline = '# T\n\npara one\n\npara two BASELINE\n';
    const { editor, host } = await mountCurrentEditor(mdCurrent);
    const { bridge, fetchVcsBaseline, setBaseline, fireVcsChange } = createStubBridge();
    setBaseline({ status: 'unavailable', content: null });

    vi.useFakeTimers();
    try {
      renderHook(
        ({ editor: e, bridge: b }) => useVcsMarkers(e, b),
        { initialProps: { editor, bridge } },
      );
      await flushMicrotasks();

      expect(fetchVcsBaseline).toHaveBeenCalledTimes(1); // 1회차: unavailable
      expect(host.querySelectorAll('[class*="markora-vcs-"]').length).toBe(0);

      // VCS 루트 매핑이 늦게 등록된 뒤 재조회에서 성공 응답이 온다.
      setBaseline({ status: 'changed', content: mdBaseline });
      fireVcsChange();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BASELINE_RELOAD_DEBOUNCE_MS);
      });
      await flushMicrotasks();

      expect(fetchVcsBaseline).toHaveBeenCalledTimes(2); // latch되지 않아 재조회가 일어났다
      expect(host.querySelectorAll('.markora-vcs-modified').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('연속 2회 unavailable이면 latch되어 이후 onVcsChange가 발생해도 재조회하지 않는다', async () => {
    const { editor, host } = await mountCurrentEditor('# T\n\npara\n');
    const { bridge, fetchVcsBaseline, setBaseline, fireVcsChange } = createStubBridge();
    setBaseline({ status: 'unavailable', content: null });

    vi.useFakeTimers();
    try {
      renderHook(
        ({ editor: e, bridge: b }) => useVcsMarkers(e, b),
        { initialProps: { editor, bridge } },
      );
      await flushMicrotasks();
      expect(fetchVcsBaseline).toHaveBeenCalledTimes(1); // 1회차: unavailable

      // 2회차 unavailable — 이 시점에 latch된다 (threshold=2).
      fireVcsChange();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BASELINE_RELOAD_DEBOUNCE_MS);
      });
      await flushMicrotasks();
      expect(fetchVcsBaseline).toHaveBeenCalledTimes(2);
      expect(host.querySelectorAll('[class*="markora-vcs-"]').length).toBe(0);

      // 3회차 발화 — disabledRef가 켜져 있으므로 fetch가 다시 일어나지 않는다.
      fireVcsChange();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BASELINE_RELOAD_DEBOUNCE_MS);
      });
      await flushMicrotasks();
      expect(fetchVcsBaseline).toHaveBeenCalledTimes(2);
      expect(host.querySelectorAll('[class*="markora-vcs-"]').length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unavailable → 성공 → unavailable → 성공 은 latch되지 않는다 (연속 실패만 카운트된다)', async () => {
    const mdCurrent = '# T\n\npara one\n\npara two original\n';
    const mdBaseline = '# T\n\npara one\n\npara two BASELINE\n';
    const { editor, host } = await mountCurrentEditor(mdCurrent);
    const { bridge, fetchVcsBaseline, setBaseline, fireVcsChange } = createStubBridge();

    async function settle() {
      fireVcsChange();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BASELINE_RELOAD_DEBOUNCE_MS);
      });
      await flushMicrotasks();
    }

    vi.useFakeTimers();
    try {
      setBaseline({ status: 'unavailable', content: null });
      renderHook(
        ({ editor: e, bridge: b }) => useVcsMarkers(e, b),
        { initialProps: { editor, bridge } },
      );
      await flushMicrotasks(); // 1회차: unavailable (count=1)

      setBaseline({ status: 'changed', content: mdBaseline });
      await settle(); // 2회차: 성공 — count가 0으로 리셋된다
      expect(host.querySelectorAll('.markora-vcs-modified').length).toBe(1);

      setBaseline({ status: 'unavailable', content: null });
      await settle(); // 3회차: unavailable (리셋 후라 count=1, threshold 미달)
      expect(host.querySelectorAll('[class*="markora-vcs-"]').length).toBe(0);

      setBaseline({ status: 'changed', content: mdBaseline });
      await settle(); // 4회차: 성공 — latch되지 않았으므로 정상적으로 재조회되어 마커가 다시 나타난다
      expect(fetchVcsBaseline).toHaveBeenCalledTimes(4);
      expect(host.querySelectorAll('.markora-vcs-modified').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('baseline과 현재 문서가 동일하면 마커가 붙지 않는다', async () => {
    const md = '# T\n\npara one\n\npara two\n';
    const { editor, host } = await mountCurrentEditor(md);
    const { bridge, fetchVcsBaseline, setBaseline } = createStubBridge();
    setBaseline({ status: 'changed', content: md });

    renderHook(
      ({ editor: e, bridge: b }) => useVcsMarkers(e, b),
      { initialProps: { editor, bridge } },
    );

    await waitFor(() => {
      expect(fetchVcsBaseline).toHaveBeenCalledTimes(1);
    });
    // fetch 이후 파싱+diff+setVcsMarkers까지 마무리될 시간을 준다 (real timers).
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.querySelectorAll('[class*="markora-vcs-"]').length).toBe(0);
  });

  it('baseline 원문이 같으면 재조회는 일어나되 재파싱은 건너뛴다 (마커도 유지된다)', async () => {
    const mdCurrent = '# T\n\npara one\n\npara two\n';
    const mdBaseline = '# T\n\npara one\n\npara two changed\n';
    const { editor, host } = await mountCurrentEditor(mdCurrent);
    const { bridge, fetchVcsBaseline, setBaseline, fireVcsChange } = createStubBridge();
    setBaseline({ status: 'changed', content: mdBaseline });

    const parseSpy = vi.spyOn(baselinePipelineModule, 'markdownToBlocks');

    vi.useFakeTimers();
    try {
      renderHook(
        ({ editor: e, bridge: b }) => useVcsMarkers(e, b),
        { initialProps: { editor, bridge } },
      );
      await flushMicrotasks();

      expect(fetchVcsBaseline).toHaveBeenCalledTimes(1);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(host.querySelectorAll('.markora-vcs-modified').length).toBe(1);

      // 같은 baseline 원문으로 onVcsChange 재발화 (Kotlin의 changeListUpdateDone처럼
      // 잦게 발화하지만 HEAD 본문은 그대로인 상황을 재현한다).
      fireVcsChange();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BASELINE_RELOAD_DEBOUNCE_MS);
      });
      await flushMicrotasks();

      expect(fetchVcsBaseline).toHaveBeenCalledTimes(2); // fetch(HTTP 왕복)는 다시 일어난다
      expect(parseSpy).toHaveBeenCalledTimes(1); // 원문이 같아 markdownToBlocks 재호출은 없다
      // 재파싱을 건너뛰어도 이전에 계산된 마커가 사라지지(stranding) 않는다.
      expect(host.querySelectorAll('.markora-vcs-modified').length).toBe(1);
    } finally {
      vi.useRealTimers();
      parseSpy.mockRestore();
    }
  });
});
