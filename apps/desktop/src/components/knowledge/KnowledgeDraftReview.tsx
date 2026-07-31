import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { parseUnifiedDiff, type DiffFile, type DiffLine } from '../../lib/unified-diff.js';

export interface KnowledgeDraftReviewProps {
  diff?: string;
  changedPaths: string[];
  draftBranch?: string;
}

function lineClass(kind: DiffLine['kind']): string {
  if (kind === 'addition') return 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
  if (kind === 'deletion') return 'bg-red-500/10 text-red-800 dark:text-red-300';
  if (kind === 'meta') return 'text-muted-foreground italic';
  return 'text-foreground/90';
}

function lineMarker(kind: DiffLine['kind']): string {
  if (kind === 'addition') return '+';
  if (kind === 'deletion') return '-';
  return ' ';
}

function fallbackFile(path: string): DiffFile {
  return { oldPath: path, newPath: path, path, status: 'modified', additions: 0, deletions: 0, hunks: [] };
}

export function KnowledgeDraftReview({ diff, changedPaths, draftBranch }: KnowledgeDraftReviewProps): React.ReactElement {
  const t = useT();
  const files = useMemo(() => {
    const parsed = parseUnifiedDiff(diff);
    const parsedPaths = new Set(parsed.map((file) => file.path));
    return [...parsed, ...changedPaths.filter((path) => !parsedPaths.has(path)).map(fallbackFile)];
  }, [changedPaths, diff]);
  const fileIdentity = files.map((file) => file.path).join('\0');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(files[0] ? [files[0].path] : []));

  useEffect(() => {
    setExpanded(new Set(files[0] ? [files[0].path] : []));
  }, [fileIdentity]);

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  return (
    <section data-testid="knowledge-draft-review" aria-labelledby="knowledge-draft-title">
      <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-3">
        <div className="min-w-0">
          <h2 id="knowledge-draft-title" className="text-sm font-semibold">{t('knowledge.draft')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('knowledge.draft.summary', { files: files.length, additions, deletions })}
          </p>
        </div>
        {draftBranch && (
          <span className="max-w-full truncate rounded-sm bg-secondary px-2 py-1 font-mono text-[11px] text-muted-foreground" title={draftBranch}>
            {t('knowledge.draft.branch')}: {draftBranch}
          </span>
        )}
      </div>

      <div className="border-y border-border" role="list">
        {files.map((file, index) => {
          const open = expanded.has(file.path);
          const panelId = `knowledge-diff-file-${index}`;
          return (
            <div key={`${file.path}-${index}`} className="border-b border-border last:border-b-0" data-testid="knowledge-draft-file" role="listitem">
              <button
                type="button"
                className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(file.path)}
              >
                {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>{file.path}</span>
                <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {t(`knowledge.draft.status.${file.status}`)}
                </span>
                <span className="w-8 shrink-0 text-right font-mono text-xs text-emerald-700 dark:text-emerald-400">+{file.additions}</span>
                <span className="w-8 shrink-0 text-right font-mono text-xs text-red-700 dark:text-red-400">-{file.deletions}</span>
              </button>

              {open && (
                <div id={panelId} className="max-h-80 overflow-auto border-t border-border bg-background/60">
                  {file.hunks.length > 0 ? file.hunks.map((hunk, hunkIndex) => (
                    <div key={`${hunk.header}-${hunkIndex}`} className="min-w-max font-mono text-[11px] leading-5">
                      <div className="sticky left-0 border-b border-border bg-secondary/70 px-3 py-1 text-muted-foreground">{hunk.header}</div>
                      {hunk.lines.map((line, lineIndex) => (
                        <div
                          key={lineIndex}
                          className={`grid min-h-5 grid-cols-[1.25rem_3rem_3rem_minmax(max-content,1fr)] ${lineClass(line.kind)}`}
                          data-testid="knowledge-diff-line"
                          data-line-kind={line.kind}
                        >
                          <span className="select-none text-center">{lineMarker(line.kind)}</span>
                          <span className="select-none border-l border-border/60 pr-2 text-right text-muted-foreground/70">{line.oldLine}</span>
                          <span className="select-none border-x border-border/60 pr-2 text-right text-muted-foreground/70">{line.newLine}</span>
                          <span className="whitespace-pre px-2">{line.text || ' '}</span>
                        </div>
                      ))}
                    </div>
                  )) : (
                    <div className="px-3 py-3 text-xs text-muted-foreground">{t('knowledge.draft.diffUnavailable')}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {files.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">{t('knowledge.draft.noChanges')}</div>
        )}
      </div>

    </section>
  );
}
