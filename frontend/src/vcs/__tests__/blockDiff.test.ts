import { describe, it, expect } from 'vitest';
import { diffBlocks, MAX_DIFF_SPAN } from '../blockDiff';

describe('diffBlocks', () => {
  it('동일하면 변경이 없다', () => {
    const r = diffBlocks(['A', 'B', 'C'], ['A', 'B', 'C']);
    expect(r.statuses.size).toBe(0);
    expect(r.deletionsBefore.size).toBe(0);
    expect(r.deletionAtEnd).toBe(false);
  });

  it('가운데 블록 추가 → added', () => {
    const r = diffBlocks(['A', 'C'], ['A', 'B', 'C']);
    expect([...r.statuses]).toEqual([[1, 'added']]);
    expect(r.deletionsBefore.size).toBe(0);
  });

  it('가운데 블록 교체 → modified', () => {
    const r = diffBlocks(['A', 'B', 'C'], ['A', 'X', 'C']);
    expect([...r.statuses]).toEqual([[1, 'modified']]);
    expect(r.deletionsBefore.size).toBe(0);
  });

  it('가운데 블록 삭제 → 뒤따르는 블록 앞에 삭제 표시', () => {
    const r = diffBlocks(['A', 'B', 'C'], ['A', 'C']);
    expect(r.statuses.size).toBe(0);
    expect([...r.deletionsBefore]).toEqual([1]);
    expect(r.deletionAtEnd).toBe(false);
  });

  it('맨 앞 블록 삭제 → index 0 앞에 삭제 표시', () => {
    const r = diffBlocks(['X', 'A'], ['A']);
    expect([...r.deletionsBefore]).toEqual([0]);
  });

  it('맨 끝 블록 삭제 → deletionAtEnd', () => {
    const r = diffBlocks(['A', 'B'], ['A']);
    expect(r.deletionsBefore.size).toBe(0);
    expect(r.deletionAtEnd).toBe(true);
  });

  it('여러 개 삭제 + 하나 추가 → 하나는 modified, 남은 삭제는 삼각형', () => {
    const r = diffBlocks(['A', 'B', 'C', 'D'], ['A', 'X']);
    expect(r.statuses.get(1)).toBe('modified');
    expect([...r.deletionsBefore]).toEqual([1]);
  });

  it('삭제 1 + 추가 2 → 하나는 modified, 나머지는 added', () => {
    const r = diffBlocks(['A', 'B', 'Z'], ['A', 'X', 'Y', 'Z']);
    expect(r.statuses.get(1)).toBe('modified');
    expect(r.statuses.get(2)).toBe('added');
    expect(r.deletionsBefore.size).toBe(0);
  });

  it('타입이 달라도 위치가 같으면 modified로 짝짓는다', () => {
    // 키는 불투명한 문자열이므로 타입 구분 없이 위치로만 짝짓는다
    const r = diffBlocks(['0 {"type":"paragraph"}'], ['0 {"type":"heading"}']);
    expect([...r.statuses]).toEqual([[0, 'modified']]);
  });

  it('baseline이 비면 전부 added', () => {
    const r = diffBlocks([], ['A', 'B']);
    expect([...r.statuses]).toEqual([[0, 'added'], [1, 'added']]);
  });

  it('현재가 비면 deletionAtEnd', () => {
    const r = diffBlocks(['A', 'B'], []);
    expect(r.statuses.size).toBe(0);
    expect(r.deletionAtEnd).toBe(true);
  });

  it('앞뒤 공통 구간이 길어도 결과가 같다', () => {
    const head = Array.from({ length: 50 }, (_, i) => `H${i}`);
    const tail = Array.from({ length: 50 }, (_, i) => `T${i}`);
    const r = diffBlocks([...head, 'B', ...tail], [...head, 'X', ...tail]);
    expect([...r.statuses]).toEqual([[50, 'modified']]);
  });

  it('양쪽 변경 구간이 모두 상한을 넘으면 마커를 생략한다', () => {
    const base = Array.from({ length: MAX_DIFF_SPAN + 1 }, (_, i) => `b${i}`);
    const curr = Array.from({ length: MAX_DIFF_SPAN + 1 }, (_, i) => `c${i}`);
    const r = diffBlocks(base, curr);
    expect(r.statuses.size).toBe(0);
    expect(r.deletionsBefore.size).toBe(0);
    expect(r.deletionAtEnd).toBe(false);
  });
});
