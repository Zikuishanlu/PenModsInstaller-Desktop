import { useCallback, useRef } from 'react';
import { AdbManager } from '../../../lib/adb';
import { joinPath, parentPath } from '../utils';
import type { FileEntry } from '../types';
import type { FileManagerAction } from '../state';

export function useNavigation(
  dispatch: React.Dispatch<FileManagerAction>,
  adb: AdbManager | null,
) {
  // 快速连续切目录时，先发出的请求可能后返回；用序号丢弃过期结果，
  // 否则界面会显示上一个目录的文件列表。
  const reqId = useRef(0);

  const loadDir = useCallback(async (dir: string) => {
    if (!adb) return;
    const id = ++reqId.current;
    dispatch({ type: 'NAVIGATE_START', path: dir });
    try {
      const raw = await adb.readDir(dir);
      if (id !== reqId.current) return;
      const entries: FileEntry[] = raw.map(e => ({
        name: e.name,
        isDir: e.isDir,
        isSymlink: e.isSymlink,
        sizeBytes: e.sizeBytes,
        mtime: e.mtime,
      }));
      dispatch({ type: 'NAVIGATE_SUCCESS', entries, path: dir });
    } catch (e) {
      if (id !== reqId.current) return;
      dispatch({ type: 'NAVIGATE_ERROR', error: `读取失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [adb, dispatch]);

  const enterDir = useCallback((name: string, currentPath: string) => {
    loadDir(joinPath(currentPath, name));
  }, [loadDir]);

  const goBack = useCallback((currentPath: string) => {
    if (currentPath !== '/') loadDir(parentPath(currentPath));
  }, [loadDir]);

  const goHome = useCallback(() => {
    loadDir('/');
  }, [loadDir]);

  const navigateTo = useCallback((p: string) => {
    loadDir(p || '/');
  }, [loadDir]);

  return { loadDir, enterDir, goBack, goHome, navigateTo };
}
