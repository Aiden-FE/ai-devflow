import React from 'react';
import { ChevronDown } from 'lucide-react';
import { useT } from '../i18n/index.js';

/** 悬浮「↓ N 条新消息」按钮：仅 count>0 时渲染。 */
export function NewMessagesButton({ count, onResume }: { count: number; onResume: () => void }): React.ReactElement | null {
  const t = useT();
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onResume}
      className="absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs shadow hover:bg-secondary"
    >
      <ChevronDown className="h-3.5 w-3.5" /> {t('chat.newMessages', { n: count })}
    </button>
  );
}
