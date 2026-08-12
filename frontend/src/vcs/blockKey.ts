// 블록을 내용 기반으로 식별하는 키를 만든다.
//
// BlockNote의 block.id는 파싱할 때마다 새로 생성되므로 baseline↔현재 비교에 쓸 수 없다.
// 대신 type/props/content를 정규화해 문자열화한다. children은 제외한다 — 포함하면
// 자식이 바뀔 때 부모까지 변경으로 잡혀 마커가 이중으로 뜬다. 대신 depth를 섞어
// 서로 다른 레벨의 블록이 잘못 매칭되지 않게 한다.

export interface AnyBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: AnyBlock[];
}

export interface KeyedBlock {
  /** BlockNote block id — decoration 대상 식별용. baseline 쪽 값은 사용하지 않는다. */
  id: string;
  /** 내용 기반 비교 키 */
  key: string;
}

// 객체 키를 정렬하고 id/children/undefined를 제거해 안정적인 JSON을 만든다.
// 재귀적으로 적용되므로 테이블 셀 등 중첩 구조도 함께 정규화된다.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) {
    if (k === 'id' || k === 'children') continue;
    if (src[k] === undefined) continue;
    out[k] = normalize(src[k]);
  }
  return out;
}

export function blockKey(block: AnyBlock, depth: number): string {
  const shape = {
    type: block.type,
    props: block.props ?? {},
    content: block.content ?? null,
  };
  return `${depth} ${JSON.stringify(normalize(shape))}`;
}

/** 블록 트리를 깊이 우선(부모 → 자식)으로 평탄화한다. */
export function flattenBlocks(blocks: AnyBlock[], depth = 0, out: KeyedBlock[] = []): KeyedBlock[] {
  for (const b of blocks) {
    out.push({ id: b.id ?? '', key: blockKey(b, depth) });
    if (b.children && b.children.length > 0) flattenBlocks(b.children, depth + 1, out);
  }
  return out;
}
