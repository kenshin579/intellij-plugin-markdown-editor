import type { BridgeContext, MarkoraBridge, Theme, UploadResult, VcsBaseline } from '../types';
import { splitFrontmatter, joinFrontmatter } from './transform';
import { rewriteImagePathsForDisplay, restoreImagePaths, dirOf } from './imageMap';

export function parseQueryContext(href: string): BridgeContext {
  const url = new URL(href);
  const filePath = url.searchParams.get('filePath') ?? '';
  const serverUrl = url.searchParams.get('serverUrl') ?? `${url.origin}/`;
  const dark = url.searchParams.get('dark') === 'true';
  return { filePath, serverUrl, initialTheme: dark ? 'dark' : 'light' };
}

export function createBridge(ctx: BridgeContext): MarkoraBridge {
  const themeListeners = new Set<(t: Theme) => void>();
  const reloadListeners = new Set<() => void>();
  const vcsListeners = new Set<() => void>();
  // (BlockNote가 재작성한 절대 이미지 URL → 원본 경로) 매핑. 저장 시 역변환에 사용.
  const imageMap = new Map<string, string>();
  // (local-image URL → 원본 HTML <img> 태그 전체) 매핑. 저장 시 markdown 이미지를
  // 원본 <img>로 되돌려 width 등 속성을 무손실 보존한다.
  const htmlImageMap = new Map<string, string>();

  // Window-level callback Kotlin이 호출
  if (typeof window !== 'undefined') {
    window.markora = {
      applyTheme: (t: Theme) => {
        themeListeners.forEach(cb => cb(t));
      },
      reloadFromDisk: () => {
        reloadListeners.forEach(cb => cb());
      },
      vcsChanged: () => {
        vcsListeners.forEach(cb => cb());
      },
    };
  }

  return {
    getContext: () => ctx,

    async loadFile() {
      const res = await fetch(
        `${ctx.serverUrl}api/file/read?path=${encodeURIComponent(ctx.filePath)}`
      );
      if (!res.ok) throw new Error(`loadFile failed: ${res.status}`);
      const data = await res.json();
      const { frontmatter, body } = splitFrontmatter(data.content ?? '');
      // 본문의 상대경로 이미지를 디스크에서 서빙되는 local-image URL로 재작성한다.
      // (그래야 BlockNote <img>가 실제 파일을 가리켜 렌더링됨) 동시에 저장 시 원본
      // 상대경로로 되돌리기 위한 매핑을 등록한다.
      const mdDir = dirOf(ctx.filePath);
      const { body: rewritten, map, htmlMap } = rewriteImagePathsForDisplay(body, mdDir, ctx.serverUrl);
      for (const [url, original] of map) {
        imageMap.set(url, original);
      }
      for (const [url, tag] of htmlMap) {
        htmlImageMap.set(url, tag);
      }
      return { body: rewritten, frontmatter };
    },

    // loadFile과 달리 imageMap을 건드리지 않고 디스크 본문만 반환.
    // 저장 직전 외부 편집 여부를 확인하는 용도라 부작용이 있으면 안 된다.
    async peekFile() {
      const res = await fetch(
        `${ctx.serverUrl}api/file/read?path=${encodeURIComponent(ctx.filePath)}`
      );
      if (!res.ok) throw new Error(`peekFile failed: ${res.status}`);
      const data = await res.json();
      const { body } = splitFrontmatter(data.content ?? '');
      return body;
    },

    async saveFile(body: string, frontmatter: string) {
      const restored = restoreImagePaths(body, imageMap, htmlImageMap);
      const content = joinFrontmatter(frontmatter, restored);
      const res = await fetch(`${ctx.serverUrl}api/file/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ctx.filePath, content }),
      });
      if (!res.ok) throw new Error(`saveFile failed: ${res.status}`);
    },

    async uploadImage(file: File): Promise<UploadResult> {
      const fd = new FormData();
      fd.append('file[]', file);
      const res = await fetch(
        `${ctx.serverUrl}api/upload?filePath=${encodeURIComponent(ctx.filePath)}`,
        { method: 'POST', body: fd }
      );
      if (!res.ok) throw new Error(`uploadImage failed: ${res.status}`);
      const json = await res.json();
      const succMap = json?.data?.succMap ?? {};
      const firstKey = Object.keys(succMap)[0];
      if (!firstKey) {
        throw new Error(`uploadImage: server returned no succMap entries (code=${json?.code})`);
      }
      const relativePath = succMap[firstKey] as string;
      const dir = dirOf(ctx.filePath);
      const absolutePath = `${dir}/${relativePath}`;
      const url = `${ctx.serverUrl}api/local-image?path=${encodeURIComponent(absolutePath)}`;
      // 저장 시 이 절대 URL을 파일에는 상대경로로 기록하도록 매핑 등록
      imageMap.set(url, relativePath);
      return { url };
    },

    onThemeChange(cb) {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },

    onReloadRequest(cb) {
      reloadListeners.add(cb);
      return () => reloadListeners.delete(cb);
    },

    async fetchVcsBaseline(): Promise<VcsBaseline> {
      const res = await fetch(
        `${ctx.serverUrl}api/vcs/baseline?path=${encodeURIComponent(ctx.filePath)}`
      );
      if (!res.ok) throw new Error(`fetchVcsBaseline failed: ${res.status}`);
      const data = await res.json();
      return { status: data.status, content: data.content ?? null };
    },

    onVcsChange(cb) {
      vcsListeners.add(cb);
      return () => vcsListeners.delete(cb);
    },
  };
}

// 개발 환경(`vite`)에서 단독 실행 시 사용하는 mock
export function createMockBridge(): MarkoraBridge {
  let storedMd = '# Markora dev mock\n\n*편집 가능합니다.*\n';
  const themeListeners = new Set<(t: Theme) => void>();
  const reloadListeners = new Set<() => void>();
  const vcsListeners = new Set<() => void>();
  if (typeof window !== 'undefined') {
    window.markora = {
      applyTheme: (t: Theme) => themeListeners.forEach(cb => cb(t)),
      reloadFromDisk: () => reloadListeners.forEach(cb => cb()),
      vcsChanged: () => vcsListeners.forEach(cb => cb()),
    };
  }
  return {
    getContext: () => ({ filePath: '/dev/mock.md', serverUrl: 'http://localhost:5173/', initialTheme: 'light' }),
    async loadFile() {
      const { body, frontmatter } = splitFrontmatter(storedMd);
      return { body, frontmatter };
    },
    async peekFile() {
      const { body } = splitFrontmatter(storedMd);
      return body;
    },
    async saveFile(body: string, frontmatter: string) {
      storedMd = joinFrontmatter(frontmatter, body);
      console.log('[mock] saved', storedMd.length, 'bytes');
    },
    async uploadImage(file: File) { return { url: URL.createObjectURL(file) }; },
    onThemeChange(cb) { themeListeners.add(cb); return () => themeListeners.delete(cb); },
    onReloadRequest(cb) { reloadListeners.add(cb); return () => reloadListeners.delete(cb); },
    async fetchVcsBaseline(): Promise<VcsBaseline> {
      return { status: 'unavailable', content: null };
    },
    onVcsChange(cb) { vcsListeners.add(cb); return () => vcsListeners.delete(cb); },
  };
}
