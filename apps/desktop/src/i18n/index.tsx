// 轻量 i18n：LocaleProvider 加载/持久化语言，useT 返回 t(key, vars?)。
// 默认中文；缺失键回退到中文，再回退到键本身。
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Locale } from '@ai-devflow/core';
import { zh } from './zh.js';
import { en } from './en.js';
import { api } from '../lib.js';

type Dict = Record<string, string>;
const DICTS: Record<Locale, Dict> = { zh, en };

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[locale][key] ?? zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

export function LocaleProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [locale, setLocaleState] = useState<Locale>('zh');

  useEffect(() => {
    api.settings.getLocale().then((l) => setLocaleState(l)).catch(() => {});
  }, []);

  const setLocale = useCallback(async (l: Locale) => {
    setLocaleState(l);
    try { await api.settings.setLocale(l); } catch { /* 忽略持久化失败 */ }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  return useLocale().t;
}
