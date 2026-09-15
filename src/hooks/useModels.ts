import { useState, useEffect, useCallback } from 'react';
import { Model } from '../types';
import { storageGet, storageSet } from '../utils/safeStorage';

const STORAGE_KEY = 'defaultModel';

export function useModels() {
  const [models, setModels] = useState<Model[]>([]);
  /**
   * 这份模型清单来自哪里 —— 界面据此说明"为什么和 WorkBuddy 里看到的一致/不一致"。
   * `workbuddy-config` = 与桌面端同源（正常情况），其余都是回落。
   */
  const [source, setSource] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    // 渲染期同步读 ⇒ 必须走 safeStorage
    return storageGet(STORAGE_KEY) ?? '';
  });

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      setModels(data.models || []);
      setSource(typeof data.source === 'string' ? data.source : '');
      if (data.models?.length > 0 && !selectedModel) {
        /**
         * 🔴 2026-09-16 修（精读 B-M1）：这两行原本又退回了**裸 `localStorage`**。
         *
         * 本文件第 3 行早就 import 了 `safeStorage`，初始化处（第 16 行）也用的是它，
         * 唯独这个分支漏了 —— 典型的"改一处漏一处"。
         * 裸访问在受限环境（opaque origin / 隐私模式 / 第三方存储被禁）会抛
         * `SecurityError`，而这里处在 async 回调里、抛错就是一次未捕获的 rejection。
         */
        const savedDefault = storageGet(STORAGE_KEY);
        const modelToUse = savedDefault && data.models.some((m: Model) => m.modelId === savedDefault)
          ? savedDefault
          : (data.defaultModel || data.models[0].modelId);
        setSelectedModel(modelToUse);
        storageSet(STORAGE_KEY, modelToUse);
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  }, [selectedModel]);

  // 初始加载
  useEffect(() => {
    fetchModels();
  }, []);

  return {
    models,
    source,
    selectedModel,
    setSelectedModel,
    fetchModels,
  };
}
