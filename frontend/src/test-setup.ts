import '@testing-library/jest-dom/vitest';

// Node 25의 내장 전역 localStorage(node --localstorage-file 관련 경고 참고)가 happy-dom의
// 정상 동작하는 구현을 밀어내고, getItem이 없는 반쪽짜리 getter/setter만 남긴다.
// BlockNote의 toggleListItem(ToggleWrapper)이 mount 시 이를 읽으므로(<details> 렌더링),
// mount를 쓰는 테스트가 실패한다. 여기서 최소 메모리 구현으로 덮어써 우회한다.
// localStorage가 정상 동작하는 환경에서는 아무 것도 하지 않는다(no-op) — 지우지 말 것.
if (typeof (window.localStorage as any)?.getItem !== 'function') {
  const store = new Map<string, string>();
  (window as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
}
