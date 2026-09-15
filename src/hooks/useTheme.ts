import { useState, useEffect, useCallback } from 'react';
import { Theme } from '../types';
import { storageGet, storageSet } from '../utils/safeStorage';

const STORAGE_KEY = 'theme';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    /**
     * ⚠️ 必须走 safeStorage：这一行在**渲染期**同步执行。
     *    裸 `localStorage.getItem` 在 opaque origin（about:blank / sandbox iframe）
     *    或用户禁用站点数据时会**抛 SecurityError**，而不是返回 null
     *    ⇒ 整棵树被 ErrorBoundary 兜成「界面渲染出错」，**整页白屏**（2026-09-16 实测复现）。
     */
    const saved = storageGet(STORAGE_KEY);
    return (saved as Theme) || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });

  // 应用主题到 DOM
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    // 存储不可用时静默降级：本次会话内主题照常生效，只是不持久化（不能因此白屏）
    storageSet(STORAGE_KEY, theme);
  }, [theme]);

  // 监听系统主题变化
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      if (!storageGet(STORAGE_KEY)) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  }, []);

  return {
    theme,
    setTheme,
    toggleTheme,
  };
}
