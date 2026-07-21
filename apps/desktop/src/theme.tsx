// 主题：light | dark | system（UI 显示“自动”），默认 system。
// 结合 Electron nativeTheme.themeSource（主进程同步），实时响应系统主题变化，
// 同步 <html> class 与 color-scheme；preload 已在首绘前设置初始 class，避免闪黑。
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ThemeMode } from '@ai-devflow/core';
import { api } from './lib.js';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (m: ThemeMode) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function resolve(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
}

function applyClass(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => {
    // 首绘前 preload 已设置 class；此处与之一致，避免闪烁。
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  });

  // 加载持久化主题
  useEffect(() => {
    api.settings.getTheme().then((m) => {
      setModeState(m);
      const r = resolve(m);
      setResolved(r);
      applyClass(r);
    }).catch(() => {});
  }, []);

  // 实时响应系统主题变化（system 模式下解析结果会变；nativeTheme.themeSource 驱动 prefers-color-scheme）
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (mode === 'system') {
        const r = resolve('system');
        setResolved(r);
        applyClass(r);
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  // 订阅主进程主题变化事件（用户在设置页切换或系统变化时主进程会转发）
  useEffect(() => {
    const unsub = api.events.subscribe((ev) => {
      if (ev.kind === 'theme-changed') {
        const d = ev.data as { mode: ThemeMode; resolved: 'light' | 'dark' };
        setModeState(d.mode);
        setResolved(d.resolved);
        applyClass(d.resolved);
      }
    });
    return unsub;
  }, []);

  const setMode = useCallback(async (m: ThemeMode) => {
    setModeState(m);
    const r = resolve(m);
    setResolved(r);
    applyClass(r);
    try { await api.settings.setTheme(m); } catch { /* 忽略持久化失败 */ }
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
