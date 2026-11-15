import { describe, it, expect } from 'vitest';
import {
  dirname,
  basename,
  decodeZipName,
  pickMetadata,
  resolveName,
  sanitizePluginName,
  safeJoin,
  PLUGINS_DIR,
} from '../plugin-install';

// 直接 import 真实实现。
// 以前这里把 dirname/basename/decodeZipName/pickMetadata/resolveName 的代码
// 复制进测试文件，断言的是副本 —— 真实实现改坏了测试照样「通过」
// （resolveName 里有 bug 的正则也是这么一起抄进来的）。

describe('plugin-install helpers', () => {
  describe('dirname', () => {
    it('extracts dirname from path', () => {
      expect(dirname('a/b/c.json')).toBe('a/b');
    });
    it('returns empty for root file', () => {
      expect(dirname('metadata.json')).toBe('');
    });
    it('handles nested paths', () => {
      expect(dirname('plugins/my-plugin/qml/main.qml')).toBe('plugins/my-plugin/qml');
    });
  });

  describe('basename', () => {
    it('extracts basename from path', () => {
      expect(basename('a/b/file.txt')).toBe('file.txt');
    });
    it('handles root path', () => {
      expect(basename('/')).toBe('');
    });
    it('handles single segment', () => {
      expect(basename('file.txt')).toBe('file.txt');
    });
  });

  describe('decodeZipName', () => {
    it('decodes UTF-8 names', () => {
      const bytes = new TextEncoder().encode('metadata.json');
      expect(decodeZipName(bytes)).toBe('metadata.json');
    });

    it('decodes Chinese UTF-8 names', () => {
      const bytes = new TextEncoder().encode('配置.json');
      expect(decodeZipName(bytes)).toBe('配置.json');
    });

    it('falls back to GBK for non-UTF-8 bytes', () => {
      // GBK encoded "测试" (0xB2 E2 0xCA D4)
      const bytes = new Uint8Array([0xB2, 0xE2, 0xCA, 0xD4]);
      const result = decodeZipName(bytes);
      // Should decode to something (GBK fallback), not throw
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('pickMetadata', () => {
    it('finds root metadata.json', () => {
      expect(pickMetadata(['metadata.json', 'main.qml'])).toBe('metadata.json');
    });

    it('finds nested metadata.json', () => {
      expect(pickMetadata(['plugin/main.qml', 'plugin/metadata.json'])).toBe('plugin/metadata.json');
    });

    it('prefers non-source metadata over source', () => {
      const paths = ['src/metadata.json', 'plugin/metadata.json'];
      expect(pickMetadata(paths)).toBe('plugin/metadata.json');
    });

    it('returns null when no metadata.json', () => {
      expect(pickMetadata(['main.qml', 'icon.png'])).toBeNull();
    });

    it('picks the shallowest non-source metadata', () => {
      const paths = ['a/metadata.json', 'a/b/metadata.json', 'src/metadata.json'];
      expect(pickMetadata(paths)).toBe('a/metadata.json');
    });

    it('ignores case for metadata.json', () => {
      expect(pickMetadata(['Metadata.json'])).toBe('Metadata.json');
    });
  });

  describe('resolveName', () => {
    it('resolves from icon path', () => {
      expect(resolveName({ icon: 'plugins/my-plugin/icon.png' }, '')).toBe('my-plugin');
    });

    it('falls back to root dir basename', () => {
      expect(resolveName({}, 'plugins/some-plugin')).toBe('some-plugin');
    });

    it('falls back to id', () => {
      expect(resolveName({ id: 'fallback-id' }, '')).toBe('fallback-id');
    });

    it('falls back to name (space sanitized)', () => {
      expect(resolveName({ name: 'My Plugin' }, '')).toBe('My_Plugin');
    });

    it('sanitizes name with special chars (underscore)', () => {
      expect(resolveName({ name: 'bad/name:test' }, '')).toBe('bad_name_test');
    });

    it('icon path takes priority over root dir', () => {
      expect(resolveName({ icon: 'plugins/icon-version/icon.png' }, 'plugins/outdated-name')).toBe('icon-version');
    });
  });

  describe('sanitizePluginName', () => {
    it('keeps ordinary names untouched', () => {
      expect(sanitizePluginName('my-plugin_1.0')).toBe('my-plugin_1.0');
    });

    it('keeps CJK names', () => {
      expect(sanitizePluginName('输入法增强')).toBe('输入法增强');
    });

    it('strips shell metacharacters from a command-injection payload', () => {
      // metadata.icon 里的 name 会拼进设备上的 mkdir/unzip 命令
      expect(sanitizePluginName('a";reboot;#')).toBe('a_reboot_');
    });

    it('rejects traversal names', () => {
      expect(sanitizePluginName('..')).toBe('');
      expect(sanitizePluginName('../..')).toBe('');
      expect(sanitizePluginName('')).toBe('');
    });
  });

  describe('safeJoin', () => {
    it('joins normal relative paths', () => {
      expect(safeJoin(PLUGINS_DIR, 'qml/main.qml')).toBe(PLUGINS_DIR + '/qml/main.qml');
    });

    it('rejects path traversal', () => {
      expect(() => safeJoin(PLUGINS_DIR, '../../system/bin/x')).toThrow();
    });

    it('rejects absolute paths', () => {
      expect(() => safeJoin(PLUGINS_DIR, '/etc/passwd')).toThrow();
    });
  });
});
