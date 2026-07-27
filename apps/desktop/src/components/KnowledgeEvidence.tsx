import React from 'react';
import type { TaskKnowledgeEvidence } from '@ai-devflow/core';
import { useT } from '../i18n/index.js';

/** 任务知识证据展示：检索层级、候选/读取路径、预算、评估与沉淀状态。 */
export function KnowledgeEvidence({ evidence }: { evidence: TaskKnowledgeEvidence }): React.ReactElement {
  const t = useT();
  const latest = evidence.retrievals[0];
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
      <div className="font-medium text-muted-foreground">{t('knowledge.evidenceTitle')}</div>
      {latest && (
        <div className="flex flex-wrap gap-3">
          <span>L{latest.level}</span>
          <span>{t('knowledge.budget')}: {latest.used.files}/{latest.budget.maxFiles} {latest.used.chars}/{latest.budget.maxChars}</span>
        </div>
      )}
      {latest?.candidates.map((c) => (
        <div key={c.id}>{c.id} <span className="text-muted-foreground">{c.path}</span></div>
      ))}
      {evidence.assessment && (
        <div>
          {evidence.assessment.verdict === 'none'
            ? <span>{t('knowledge.verdict.none')}: {evidence.assessment.reason}</span>
            : <span>{t('knowledge.verdict.valuable')}（{evidence.assessment.candidates.length}）</span>}
        </div>
      )}
      {evidence.deposition && (
        <div>{t('knowledge.depositionState')}: {evidence.deposition.state} {evidence.deposition.gatePassed ? '✓' : '✗'}</div>
      )}
    </section>
  );
}
