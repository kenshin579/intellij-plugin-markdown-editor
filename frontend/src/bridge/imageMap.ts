// 이미지 경로 변환 (옵션 B: 비편집 영역 보존)
//
// 파일에 적힌 상대경로 이미지(예: `./_assets/foo.png`)를 그대로 BlockNote에 넘기면,
// <img>가 JCEF 페이지의 base URI(번들 dist 디렉터리) 기준으로 해석되어 디스크의 실제
// 파일이 아니라 엉뚱한 곳을 가리킨다 → 렌더링 실패. 그래서 로드 시 상대경로를 IDE가
// 디스크에서 직접 서빙하는 `api/local-image?path=<절대경로>` URL로 재작성한다.
// 동시에 (local-image URL → 원본 상대경로) 매핑을 만들어 두고, 저장 시 직렬화된 URL을
// 원본 상대경로로 되돌려 파일에는 localhost 절대 URL이 박히지 않게 한다.
//
// HTML <img> 태그는 추가로 다뤄야 한다: BlockNote의 markdown 파서는 raw HTML <img>를
// 통째로 버리므로(=렌더 안 됨), 로드 시 <img>를 markdown 이미지 `![alt](url)`로 변환해
// BlockNote가 image 블록으로 인식하게 한다. 변환과 동시에 (url → 원본 <img> 태그 전체)
// 매핑(htmlMap)을 만들어, 저장 시 markdown 이미지를 원본 <img> 태그로 되돌린다. 이렇게
// 하면 width 등 HTML 속성이 무손실로 보존된다.

// `![alt](target)` / `![alt](target "title")`를 head/target/tail 세 그룹으로 나눈다.
const IMAGE_REWRITE_RE = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
// 직렬화된 이미지/링크 `[alt](target "title")`를 그룹으로 나눈다(선행 `!` 포함).
const FULL_IMAGE_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;
// HTML <img ...> 태그 한 개.
const HTML_IMG_RE = /<img\b[^>]*>/gi;

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const DATA_URL_RE = /^data:/i;

// 마크다운 파일의 절대경로에서 상대경로 해석 기준이 되는 디렉터리를 뽑는다.
// bridge/markora.ts(loadFile/uploadImage)와 vcs/baselinePipeline.ts가 동일한 로직을
// 각자 복붙해 갖고 있었다 — baseline/현재 문서 변환이 byte-identical해야 한다는
// 이 기능의 전제상, 셋 중 하나만 고치고 나머지를 놓치면 오탐이 조용히 재발한다.
// 알려진 한계(기존 동작 그대로 보존): 파일시스템 루트의 `/doc.md`처럼 슬래시가 파일명
// 앞에 하나뿐이면 lastIndexOf가 그 슬래시 위치(0)를 찾아 substring(0,0) = ''가 된다
// (기대할 수 있는 '/'가 아니라 빈 문자열). 저장 경로 동작을 바꾸지 않기 위해
// 이 태스크에서는 고치지 않는다.
export function dirOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.substring(0, normalized.lastIndexOf('/'));
}

// `dir` 기준으로 상대경로 `rel`을 디스크 절대경로로 해석한다. `.`/`..` 세그먼트 처리.
function resolveAgainstDir(dir: string, rel: string): string {
  const parts = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

// <img> 태그에서 속성 값을 뽑는다(쌍/홑따옴표 지원). 없으면 null.
function getImgAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

// 상대경로 src를 local-image URL로, 절대/데이터 URL은 그대로 반환.
function toDisplayUrl(src: string, mdDir: string, serverUrl: string): string {
  if (ABSOLUTE_URL_RE.test(src) || DATA_URL_RE.test(src)) return src;
  const absPath = resolveAgainstDir(mdDir, src);
  return `${serverUrl}api/local-image?path=${encodeURIComponent(absPath)}`;
}

export function rewriteImagePathsForDisplay(
  md: string,
  mdDir: string,
  serverUrl: string,
): { body: string; map: Map<string, string>; htmlMap: Map<string, string> } {
  const map = new Map<string, string>();
  const htmlMap = new Map<string, string>();

  // 1) HTML <img>를 markdown 이미지로 변환(BlockNote가 raw <img>를 버리므로 필수).
  //    저장 시 원본 태그로 되돌리기 위해 (url → 원본 태그 전체)를 htmlMap에 등록.
  let body = md.replace(HTML_IMG_RE, (tag) => {
    const src = getImgAttr(tag, 'src');
    if (!src) return tag; // src 없으면 손대지 않음
    const url = toDisplayUrl(src, mdDir, serverUrl);
    const alt = (getImgAttr(tag, 'alt') ?? '').replace(/[\]\n]/g, ' ').trim();
    htmlMap.set(url, tag);
    return `![${alt}](${url})`;
  });

  // 2) markdown 이미지의 상대경로를 local-image URL로 재작성.
  //    (1)에서 만든 이미지는 이미 절대 URL이라 아래 분기에서 건너뛴다.
  body = body.replace(IMAGE_REWRITE_RE, (whole, head: string, target: string, tail: string) => {
    if (ABSOLUTE_URL_RE.test(target) || DATA_URL_RE.test(target)) return whole;
    const absPath = resolveAgainstDir(mdDir, target);
    const url = `${serverUrl}api/local-image?path=${encodeURIComponent(absPath)}`;
    map.set(url, target);
    return `${head}${url}${tail}`;
  });

  return { body, map, htmlMap };
}

export function restoreImagePaths(
  md: string,
  map: Map<string, string>,
  htmlMap?: Map<string, string>,
): string {
  if (map.size === 0 && (!htmlMap || htmlMap.size === 0)) return md;
  return md.replace(FULL_IMAGE_RE, (whole, bang: string, alt: string, target: string, title: string) => {
    // HTML 유래 이미지: markdown 이미지 전체를 원본 <img> 태그로 복원(width 등 무손실).
    const tag = bang === '!' ? htmlMap?.get(target) : undefined;
    if (tag !== undefined) return tag;
    // markdown 유래 이미지/업로드 이미지: 타깃 경로만 원본으로 복원.
    const original = map.get(target);
    if (original !== undefined) return `${bang}[${alt}](${original}${title})`;
    return whole;
  });
}
