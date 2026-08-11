import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBridge, createMockBridge, parseQueryContext } from '../markora';

describe('parseQueryContext', () => {
  it('reads filePath, serverUrl, dark from URL query', () => {
    const ctx = parseQueryContext(
      'http://localhost:63342/resources/blocknote/dist/index.html?filePath=%2Ftmp%2Ffoo.md&serverUrl=http%3A%2F%2Flocalhost%3A63342%2F&dark=true'
    );
    expect(ctx).toEqual({
      filePath: '/tmp/foo.md',
      serverUrl: 'http://localhost:63342/',
      initialTheme: 'dark',
    });
  });

  it('defaults to light theme when dark missing', () => {
    const ctx = parseQueryContext(
      'http://localhost/?filePath=%2Ftmp%2Fa.md&serverUrl=http%3A%2F%2Flocalhost%2F'
    );
    expect(ctx.initialTheme).toBe('light');
  });
});

describe('createBridge (real fetch)', () => {
  const ctx: import('../../types').BridgeContext = {
    filePath: '/tmp/x.md',
    serverUrl: 'http://localhost:9000/',
    initialTheme: 'light',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loadFile calls /api/file/read with filePath', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ content: '# hello' }),
    });
    const b = createBridge(ctx);
    const { body, frontmatter } = await b.loadFile();
    expect(body).toBe('# hello');
    expect(frontmatter).toBe('');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:9000/api/file/read?path=%2Ftmp%2Fx.md'
    );
  });

  it('saveFile POSTs JSON', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({}) });
    const b = createBridge(ctx);
    await b.saveFile('# updated', '');
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe('http://localhost:9000/api/file/save');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ path: '/tmp/x.md', content: '# updated' });
  });

  it('frontmatter를 본문에서 떼어 반환하고 저장 시 다시 붙인다', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ content: '---\ntitle: Post\n---\n\n# Body\n' }),
    });
    const b = createBridge(ctx);
    const { body, frontmatter } = await b.loadFile();
    expect(body).toBe('\n# Body\n');
    expect(frontmatter).toBe('title: Post');
    await b.saveFile('\n# Body edited\n', 'title: Post');
    const saveCall = (globalThis.fetch as any).mock.calls.find(
      (c: any[]) => c[0] === 'http://localhost:9000/api/file/save'
    );
    expect(JSON.parse(saveCall[1].body).content).toBe('---\ntitle: Post\n---\n\n# Body edited\n');
  });

  it('로드 시 상대경로 이미지를 local-image URL로 재작성한다', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ content: '![alt](images/foo.png)\n' }),
    });
    const b = createBridge(ctx);
    const { body } = await b.loadFile();
    const url =
      'http://localhost:9000/api/local-image?path=' +
      encodeURIComponent('/tmp/images/foo.png');
    expect(body).toBe(`![alt](${url})\n`);
  });

  it('로드한 상대경로 이미지는 저장 시 local-image URL이 아닌 원본 상대경로로 기록된다', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ content: '![alt](images/foo.png)\n' }),
    });
    const b = createBridge(ctx);
    // 로드가 반환한 본문(= BlockNote가 그대로 직렬화할 내용)을 그대로 저장한다.
    const { body } = await b.loadFile();
    await b.saveFile(body, '');
    const saveCall = (globalThis.fetch as any).mock.calls.find(
      (c: any[]) => c[0] === 'http://localhost:9000/api/file/save'
    );
    expect(JSON.parse(saveCall[1].body).content).toBe('![alt](images/foo.png)\n');
  });

  it('peekFile은 read 엔드포인트에서 본문(frontmatter 제거)을 반환한다', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ content: '---\ntitle: Post\n---\n\n# Body\n' }),
    });
    const b = createBridge(ctx);
    const body = await b.peekFile();
    expect(body).toBe('\n# Body\n');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:9000/api/file/read?path=%2Ftmp%2Fx.md'
    );
  });

  it('frontmatter는 saveFile 호출자가 넘긴 값으로 기록되고 peekFile은 이에 영향 없음', async () => {
    const b = createBridge(ctx);
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: '---\ntitle: F1\n---\n\n# Body\n' }),
    });
    const { frontmatter } = await b.loadFile();
    expect(frontmatter).toBe('title: F1');
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: '---\ntitle: F2\n---\n\n# Body changed externally\n' }),
    });
    await b.peekFile();
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await b.saveFile('\n# Body\n', frontmatter);
    const saveCall = (globalThis.fetch as any).mock.calls.find(
      (c: any[]) => c[0] === 'http://localhost:9000/api/file/save'
    );
    expect(JSON.parse(saveCall[1].body).content).toBe('---\ntitle: F1\n---\n\n# Body\n');
  });

  it('uploadImage POSTs multipart', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { succMap: { 'a.png': 'images/a.png' } } }),
    });
    const b = createBridge(ctx);
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const result = await b.uploadImage(file);
    expect(result.url).toContain('/api/local-image?path=');
    expect(result.url).toContain('images%2Fa.png');
  });
});

describe('uploadImage edge cases', () => {
  it('throws when server returns empty succMap', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ code: 1, data: { succMap: {} } }),
    });
    const b = createBridge({
      filePath: '/tmp/x.md',
      serverUrl: 'http://localhost:9000/',
      initialTheme: 'light',
    });
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await expect(b.uploadImage(file)).rejects.toThrow(/no succMap entries/);
  });

  it('normalizes Windows backslash paths', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { succMap: { 'a.png': 'images/a.png' } } }),
    });
    const b = createBridge({
      filePath: 'C:\\Users\\foo\\bar.md',
      serverUrl: 'http://localhost:9000/',
      initialTheme: 'light',
    });
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const result = await b.uploadImage(file);
    // Path should not contain undefined and should use forward slashes
    expect(result.url).not.toContain('undefined');
    expect(result.url).toContain('C%3A%2FUsers%2Ffoo%2Fimages%2Fa.png');
  });
});

describe('onReloadRequest', () => {
  it('window.markora.reloadFromDisk() 호출 시 등록된 콜백이 실행된다', () => {
    const b = createBridge({
      filePath: '/tmp/x.md',
      serverUrl: 'http://localhost:9000/',
      initialTheme: 'light',
    });
    const cb = vi.fn();
    const unsub = b.onReloadRequest(cb);
    window.markora.reloadFromDisk();
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    unsub();
    window.markora.reloadFromDisk();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('onThemeChange', () => {
  it('subscribes and unsubscribes via returned function', () => {
    const b = createBridge({
      filePath: '/tmp/x.md',
      serverUrl: 'http://localhost:9000/',
      initialTheme: 'light',
    });
    const cb = vi.fn();
    const unsub = b.onThemeChange(cb);
    window.markora.applyTheme('dark');
    expect(cb).toHaveBeenCalledWith('dark');
    cb.mockClear();
    unsub();
    window.markora.applyTheme('light');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('createMockBridge', () => {
  it('loadFile은 mock 본문에서 frontmatter와 body를 분리한다', async () => {
    const b = createMockBridge();
    await b.saveFile('# Hello\n', 'title: T');
    const { body, frontmatter } = await b.loadFile();
    expect(frontmatter).toBe('title: T');
    expect(body).toBe('# Hello\n');
  });

  it('saveFile은 frontmatter를 펜스로 감싸 저장하고 peekFile은 body만 반환한다', async () => {
    const b = createMockBridge();
    await b.saveFile('# Body\n', 'title: T');
    const peeked = await b.peekFile();
    expect(peeked).toBe('# Body\n');
    const { frontmatter } = await b.loadFile();
    expect(frontmatter).toBe('title: T');
  });

  it('frontmatter가 비면 저장 시 frontmatter가 삭제된다', async () => {
    const b = createMockBridge();
    await b.saveFile('# Body\n', '');
    const { body, frontmatter } = await b.loadFile();
    expect(frontmatter).toBe('');
    expect(body).toBe('# Body\n');
  });
});

describe('fetchVcsBaseline', () => {
  it('엔드포인트 응답을 그대로 돌려준다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'changed', content: '# old\n' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bridge = createBridge({ filePath: '/p/a.md', serverUrl: 'http://x/', initialTheme: 'light' });
    await expect(bridge.fetchVcsBaseline()).resolves.toEqual({ status: 'changed', content: '# old\n' });
    expect(fetchMock).toHaveBeenCalledWith('http://x/api/vcs/baseline?path=%2Fp%2Fa.md');

    vi.unstubAllGlobals();
  });

  it('content가 없으면 null로 채운다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'untracked' }),
    }));
    const bridge = createBridge({ filePath: '/p/a.md', serverUrl: 'http://x/', initialTheme: 'light' });
    await expect(bridge.fetchVcsBaseline()).resolves.toEqual({ status: 'untracked', content: null });
    vi.unstubAllGlobals();
  });

  it('window.markora.vcsChanged가 리스너를 호출한다', () => {
    const bridge = createBridge({ filePath: '/p/a.md', serverUrl: 'http://x/', initialTheme: 'light' });
    const cb = vi.fn();
    const unsub = bridge.onVcsChange(cb);
    window.markora.vcsChanged();
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    window.markora.vcsChanged();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
