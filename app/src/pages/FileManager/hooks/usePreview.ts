import { useCallback } from 'react';
import { joinPath } from '../utils';
import type { FileManagerAction } from '../state';

/** 预览只需要「按路径读一个文件」，USB(adb) 和 SSH(sftp) 各给一个来源即可 */
export interface PreviewReader {
  readFile(path: string): Promise<Uint8Array>;
}

/** 文本预览只读前 256KB：整文件读进内存再 decode，遇到大日志会直接卡死页面 */
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
/** 图片预览上限；超过就不预览，避免几 MB 的原图把渲染进程顶爆 */
const MAX_IMAGE_PREVIEW_BYTES = 12 * 1024 * 1024;

export function usePreview(
  dispatch: React.Dispatch<FileManagerAction>,
  reader: PreviewReader | null,
) {
  const previewFile = useCallback(async (currentPath: string, name: string) => {
    // 没有可用后端时也要给反馈，否则点了预览毫无反应
    if (!reader) {
      dispatch({ type: 'SET_PREVIEW', preview: { name, dataUrl: '', type: 'other' } });
      return;
    }
    const remotePath = joinPath(currentPath, name);
    const ext = name.split('.').pop()?.toLowerCase() || '';

    // 图片预览
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) {
      try {
        const data = await reader.readFile(remotePath);
        if (data.length > MAX_IMAGE_PREVIEW_BYTES) {
          dispatch({ type: 'SET_PREVIEW', preview: { name, dataUrl: '', type: 'other' } });
          return;
        }
        const blob = new Blob([data as BlobPart]);
        const url = URL.createObjectURL(blob);
        dispatch({ type: 'SET_PREVIEW', preview: { name, dataUrl: url, type: 'image' } });
      } catch {
        dispatch({ type: 'SET_PREVIEW', preview: { name, dataUrl: '', type: 'other' } });
      }
      return;
    }

    // 文本预览
    if (['txt', 'md', 'log', 'cfg', 'ini', 'conf', 'env', 'json', 'xml', 'yaml', 'yml', 'toml',
         'js', 'ts', 'css', 'html', 'sh', 'bash', 'py', 'java', 'c', 'cpp', 'h'].includes(ext)) {
      try {
        const data = await reader.readFile(remotePath);
        const truncated = data.length > MAX_TEXT_PREVIEW_BYTES;
        const slice = truncated ? data.subarray(0, MAX_TEXT_PREVIEW_BYTES) : data;
        let text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
        if (truncated) text += `\n\n…（文件共 ${(data.length / 1024).toFixed(0)}KB，仅显示前 256KB）`;
        dispatch({ type: 'SET_PREVIEW', preview: { name, dataUrl: text, type: 'text' } });
      } catch {
        dispatch({ type: 'SET_PREVIEW', preview: { name, dataUrl: '', type: 'other' } });
      }
      return;
    }

    // 其他类型
    dispatch({ type: 'SET_PREVIEW', preview: { name, dataUrl: '', type: 'other' } });
  }, [reader, dispatch]);

  const closePreview = useCallback((currentPreview?: { dataUrl: string; type: string } | null) => {
    if (currentPreview?.type === 'image' && currentPreview.dataUrl.startsWith('blob:')) {
      URL.revokeObjectURL(currentPreview.dataUrl);
    }
    dispatch({ type: 'SET_PREVIEW', preview: null });
  }, [dispatch]);

  return { previewFile, closePreview };
}
