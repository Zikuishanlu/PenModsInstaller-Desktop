import { useState, useCallback } from 'react';
import { AdbManager } from '../../../lib/adb';
import { joinPath } from '../utils';
import { showToast } from '../components/Toast';
import type { FileManagerAction } from '../state';

/** USB 上传上限：一次读进内存，超过这个尺寸必然 OOM */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export function useUpload(
  dispatch: React.Dispatch<FileManagerAction>,
  adb: AdbManager | null,
  onLog: (msg: string) => void,
  loadDir: (dir: string) => void,
) {
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  // ── 推送单个文件 ──
  const pushFile = useCallback(async (file: File, remotePath: string) => {
    if (!adb) return;
    // 整文件一次性读进内存（pushFile 收 Uint8Array），浏览器标签页几千 MB 会直接崩，
    // 给个明确上限和提示，比静默卡死强。
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`文件过大（${(file.size / 1048576).toFixed(0)}MB），当前上限 ${MAX_UPLOAD_BYTES / 1048576}MB`);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    await adb.pushFile(data, remotePath, (pct) => setUploadProgress(pct));
  }, [adb]);

  // ── 直接上传（拖拽用） ──
  const uploadFromDrop = useCallback(async (fileList: FileList, currentPath: string) => {
    if (!adb) return;
    const count = fileList.length;
    onLog(`拖拽上传 ${count} 个文件`);
    dispatch({ type: 'SET_PROCESSING', message: `上传 ${count} 个文件...` });
    let successCount = 0;
    for (let i = 0; i < count; i++) {
      const file = fileList[i];
      try {
        await pushFile(file, joinPath(currentPath, file.name));
        successCount++;
      } catch (e) {
        onLog(`✗ 上传 ${file.name} 失败: ${e instanceof Error ? e.message : String(e)}`);
        showToast(`上传 ${file.name} 失败`, 'error');
      }
    }
    dispatch({ type: 'SET_PROCESSING', message: null });
    onLog(`✓ 上传完成 ${successCount}/${count}`);
    if (successCount > 0) loadDir(currentPath);
  }, [adb, dispatch, onLog, loadDir, pushFile]);

  // ── 选择文件后弹确认栏 ──
  const selectFile = useCallback((file: File) => {
    setUploadFile(file);
    setUploadProgress(null);
  }, []);

  // ── 确认上传 ──
  const handleUploadConfirm = useCallback(async (currentPath: string) => {
    if (!uploadFile || !adb) return;
    onLog('上传 ' + uploadFile.name);
    dispatch({ type: 'SET_PROCESSING', message: '上传 ' + uploadFile.name + '...' });
    try {
      await pushFile(uploadFile, joinPath(currentPath, uploadFile.name));
      onLog('✓ 上传完成');
      loadDir(currentPath);
    } catch (e) {
      const msg = '✗ 上传失败: ' + (e instanceof Error ? e.message : String(e));
      onLog(msg);
      showToast(msg, 'error');
    } finally {
      dispatch({ type: 'SET_PROCESSING', message: null });
      setUploadFile(null);
      setUploadProgress(null);
    }
  }, [uploadFile, adb, dispatch, onLog, loadDir, pushFile]);

  // ── 取消上传 ──
  const cancelUpload = useCallback(() => {
    setUploadFile(null);
    setUploadProgress(null);
  }, []);

  return {
    uploadFile,
    uploadProgress,
    selectFile,
    uploadFromDrop,
    handleUploadConfirm,
    cancelUpload,
  };
}
