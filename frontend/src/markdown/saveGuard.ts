// 저장 직전 손실 가드 (옵션 C: 즉시 출혈 방지)
//
// blocksToMarkdownLossy 라운드트립은 BlockNote가 모델링하지 못하는 구조(HTML 블록 등)를
// 삭제·파괴한다. Editor는 편집이 일어날 때마다 본문 전체를 이 손실 변환으로 재직렬화해
// 파일을 통째로 덮어쓰므로, 한 번의 사소한 편집만으로도 내용이 영구히 손실될 수 있다.
// (frontmatter는 BlockNote를 거치지 않으므로 이 가드의 대상이 아니다 — 패널에서 따로 다룬다.)
//
// 이 가드는 저장 직전 직렬화 결과(next)를 마지막으로 알려진 정상 본문(previous) 및
// 디스크 현재 본문(disk)과 비교하여 명백한 손실이 감지되면 저장을 차단한다.
// 검사는 세 레이어다: (1) raw HTML 블록 소실, (2) 외부 편집 클로버, (3) 대량 내용 손실.

import { findLostHtmlBlocks, type LostHtmlBlock } from './htmlBlocks';

export interface SaveGuardResult {
  safe: boolean;
  reason?: string;
  lostChars: number;
  lostRatio: number;
}

// previous 대비 이 비율 이상 사라지고(SHRINK_RATIO) 절대 손실도 MIN_ABSOLUTE_LOSS자
// 이상일 때만 차단한다. 작은 문서에서의 정상적인 대량 삭제 오탐을 줄이기 위함.
const SHRINK_RATIO = 0.5;
const MIN_ABSOLUTE_LOSS = 50;

// 외부 편집 클로버 가드: 저장 직전 디스크 내용이 markora의 마지막 동기화본과
// 달라졌다면(터미널/다른 프로세스가 편집), lossy 직렬화 결과가 디스크 내용을
// 잘라먹는 것을 막기 위해 더 민감한 줄 수 기준을 적용한다.
const EXTERNAL_LINE_SHRINK_RATIO = 0.3;
const MIN_ABSOLUTE_LINE_LOSS = 10;

function lineCount(s: string): number {
  return s.length === 0 ? 0 : s.split('\n').length;
}

// 두 손실 목록을 합치되, 같은 태그는 손실이 큰 쪽만 남긴다.
function merge(a: LostHtmlBlock[], b: LostHtmlBlock[]): LostHtmlBlock[] {
  const worst = new Map<string, number>();
  for (const { tag, lost } of [...a, ...b]) {
    worst.set(tag, Math.max(worst.get(tag) ?? 0, lost));
  }
  return [...worst].map(([tag, lost]) => ({ tag, lost }));
}

// previous: markora가 마지막으로 정상이라 판단한 내용(lastKnownContent)
// next:     이번에 저장하려는 직렬화 결과
// disk:     (선택) 저장 직전 디스크에서 다시 읽은 현재 본문. 외부 편집 클로버 검출용.
export function checkSaveSafety(previous: string, next: string, disk?: string): SaveGuardResult {
  const prevLen = previous.length;
  const lostChars = prevLen - next.length;
  const lostRatio = prevLen > 0 ? lostChars / prevLen : 0;

  // 1) raw HTML 블록 손실 감지: BlockNote 파서가 <details> 등 raw HTML을 버린 경우.
  //    길이 기반 검사(레이어 3)보다 먼저 봐야 한다 — 테이블 셀 패딩이 손실분을 상쇄해
  //    HTML을 통째로 잃고도 글자 수는 오히려 늘어나 길이 검사를 그냥 통과하기 때문이다.
  //
  //    previous 와 disk 양쪽을 본다. previous 만 보면, markora 가 dirty 라 외부 변경을
  //    reload 하지 않은 사이 터미널이 추가한 HTML 블록을 놓친다(previous 에 흔적이 없다).
  //    다만 두 기준은 문자열 공간이 다르다: previous/next 는 이미지 재작성 후라 <img> 가
  //    마크다운 이미지로 바뀌어 있고, disk 는 재작성 전 원본이라 <img> 가 살아 있다.
  //    그래서 disk 쪽 비교에서만 img 를 제외해야 정상 저장이 매번 차단되지 않는다.
  const lostHtml = merge(
    findLostHtmlBlocks(previous, next),
    findLostHtmlBlocks(disk ?? previous, next).filter(l => l.tag !== 'img'),
  );
  if (lostHtml.length > 0) {
    const detail = lostHtml
      .map(l => `${l.tag === '!--' ? '<!--…-->' : `<${l.tag}>`}×${l.lost}`)
      .join(', ');
    return {
      safe: false,
      reason: `raw HTML dropped by parser: ${detail}`,
      lostChars,
      lostRatio,
    };
  }

  // 2) 외부 편집 클로버 감지: 디스크가 마지막 동기화본과 달라졌다면(외부 편집),
  //    저장본(next)이 디스크 대비 대량의 줄/문자를 잃을 때 차단한다. 이 가드가
  //    previous 기준 검사(레이어 3)보다 먼저 동작해야 stale한 previous 때문에
  //    50% 미만으로 보이는 외부 클로버(예: 디스크 621줄 → 346줄)를 잡을 수 있다.
  if (disk !== undefined && disk !== previous) {
    const diskLines = lineCount(disk);
    const nextLines = lineCount(next);
    const lostLines = diskLines - nextLines;
    const lostLineRatio = diskLines > 0 ? lostLines / diskLines : 0;
    const diskLostChars = disk.length - next.length;
    const diskLostRatio = disk.length > 0 ? diskLostChars / disk.length : 0;
    const lineLoss = lostLines >= MIN_ABSOLUTE_LINE_LOSS && lostLineRatio >= EXTERNAL_LINE_SHRINK_RATIO;
    const charLoss = diskLostChars >= MIN_ABSOLUTE_LOSS && diskLostRatio >= SHRINK_RATIO;
    if (lineLoss || charLoss) {
      return {
        safe: false,
        reason: `external edit would be overwritten (disk ${diskLines} lines → ${nextLines} lines)`,
        lostChars: diskLostChars,
        lostRatio: diskLostRatio,
      };
    }
  }

  // 3) 대량 내용 손실 감지 (예: HTML 블록 삭제로 문서 절반 이상 증발)
  if (lostChars >= MIN_ABSOLUTE_LOSS && lostRatio >= SHRINK_RATIO) {
    return {
      safe: false,
      reason: `large content loss (${lostChars} chars, ${Math.round(lostRatio * 100)}%)`,
      lostChars,
      lostRatio,
    };
  }

  return { safe: true, lostChars, lostRatio };
}
