// baseline 키 배열과 현재 키 배열을 비교해 블록별 변경 상태를 만든다.
//
// 공통 prefix/suffix를 먼저 잘라낸다. 실제 편집은 거의 항상 국소적이므로 이것만으로
// 비교 대상이 몇 개로 줄고, 남은 구간에 평범한 LCS를 돌리면 충분하다.

export type BlockStatus = 'added' | 'modified';

export interface DiffResult {
  /** 현재 블록 리스트의 인덱스 → 상태. 변경 없는 블록은 없다. */
  statuses: Map<number, BlockStatus>;
  /** 이 인덱스의 블록 '앞' 경계에 삭제가 있었다. */
  deletionsBefore: Set<number>;
  /** 문서 끝에 삭제가 있었다. */
  deletionAtEnd: boolean;
}

/**
 * 절단 후 남은 두 구간의 길이 곱(= LCS DP 테이블 셀 수)이 이 값의 제곱을 넘으면
 * 마커를 생략한다. 비용은 한쪽 길이가 아니라 n·m 셀 수에 좌우되므로, 한쪽만 큰
 * 비대칭 구간(예: base=999, curr=50000)도 이 예산으로 걸러진다.
 */
export const MAX_DIFF_SPAN = 1000;

type Op =
  | { kind: 'equal'; currIdx: number }
  | { kind: 'del' }
  | { kind: 'ins'; currIdx: number };

// Op이 currIdx를 갖는 종류인지 타입 수준에서 확인한다. 캐스팅으로 판별 유니온을
// 우회하면 run 경계 로직이 바뀔 때 컴파일러가 잡아주지 못한다.
function currIdxOf(op: Op): number {
  if (op.kind === 'del') throw new Error('currIdxOf: del op has no currIdx');
  return op.currIdx;
}

function emptyResult(): DiffResult {
  return { statuses: new Map(), deletionsBefore: new Set(), deletionAtEnd: false };
}

// dp[i][j] = a[i..] 와 b[j..] 의 LCS 길이
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function editScript(a: string[], b: string[], currOffset: number): Op[] {
  const dp = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', currIdx: currOffset + j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del' });
      i++;
    } else {
      ops.push({ kind: 'ins', currIdx: currOffset + j });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: 'del' });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: 'ins', currIdx: currOffset + j });
    j++;
  }
  return ops;
}

export function diffBlocks(baseKeys: string[], currKeys: string[]): DiffResult {
  const result = emptyResult();

  let p = 0;
  const maxP = Math.min(baseKeys.length, currKeys.length);
  while (p < maxP && baseKeys[p] === currKeys[p]) p++;

  let s = 0;
  const maxS = Math.min(baseKeys.length - p, currKeys.length - p);
  while (s < maxS && baseKeys[baseKeys.length - 1 - s] === currKeys[currKeys.length - 1 - s]) s++;

  const baseMid = baseKeys.slice(p, baseKeys.length - s);
  const currMid = currKeys.slice(p, currKeys.length - s);
  if (baseMid.length === 0 && currMid.length === 0) return result;
  if (baseMid.length * currMid.length > MAX_DIFF_SPAN * MAX_DIFF_SPAN) return result;

  const ops = editScript(baseMid, currMid, p);
  // 변경 구간 뒤에 남아 있는 첫 현재 인덱스. 삭제 run이 문서 뒤쪽 공통 구간에
  // 맞닿아 있을 때 삼각형을 붙일 자리다.
  const afterMid = currKeys.length - s;

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === 'equal') {
      i++;
      continue;
    }
    if (op.kind === 'ins') {
      let j = i;
      while (j < ops.length && ops[j].kind === 'ins') j++;
      for (let k = i; k < j; k++) {
        result.statuses.set(currIdxOf(ops[k]), 'added');
      }
      i = j;
      continue;
    }

    // 삭제 run — 바로 뒤에 붙은 추가 run과 앞에서부터 짝지어 modified로 승격한다.
    let d = i;
    while (d < ops.length && ops[d].kind === 'del') d++;
    let n = d;
    while (n < ops.length && ops[n].kind === 'ins') n++;

    const delCount = d - i;
    const insIdx = ops.slice(d, n).map((o) => currIdxOf(o));
    const paired = Math.min(delCount, insIdx.length);
    for (let k = 0; k < insIdx.length; k++) {
      result.statuses.set(insIdx[k], k < paired ? 'modified' : 'added');
    }

    if (delCount > paired) {
      let anchor: number;
      if (insIdx.length > 0) {
        anchor = insIdx[0];
      } else {
        let k = n;
        while (k < ops.length && ops[k].kind === 'del') k++;
        anchor = k < ops.length ? currIdxOf(ops[k]) : afterMid;
      }
      if (anchor >= currKeys.length) result.deletionAtEnd = true;
      else result.deletionsBefore.add(anchor);
    }
    i = n;
  }

  return result;
}
