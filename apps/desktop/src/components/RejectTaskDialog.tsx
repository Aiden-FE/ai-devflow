import React, { useState } from 'react';
import { useT } from '../i18n/index.js';
import { Button } from './ui/button.js';
import { Label } from './ui/label.js';
import { Textarea } from './ui/textarea.js';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from './ui/select.js';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from './ui/dialog.js';

export type RejectTaskTarget = 'ready' | 'in_progress';

export interface RejectTaskDialogProps {
  initialTarget?: RejectTaskTarget;
  lockedTarget?: RejectTaskTarget;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (reason: string, target: RejectTaskTarget) => void | Promise<void>;
}

export function RejectTaskDialog({
  busy,
  onClose,
  ...formProps
}: RejectTaskDialogProps): React.ReactElement {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('detail.reject.title')}</DialogTitle></DialogHeader>
        <RejectTaskForm {...formProps} busy={busy} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

export function RejectTaskForm({
  initialTarget = 'in_progress',
  lockedTarget,
  busy,
  error,
  onClose,
  onSubmit,
}: RejectTaskDialogProps): React.ReactElement {
  const t = useT();
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<RejectTaskTarget>(lockedTarget ?? initialTarget);
  const [touched, setTouched] = useState(false);
  const selectedTarget = lockedTarget ?? target;
  const reasonOk = reason.trim().length > 0;
  const targetLabel = t(`detail.reject.target.${selectedTarget}`);
  const targetHint = t(`detail.reject.target.${selectedTarget}.hint`);

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('detail.reject.reason')}</Label>
          <Textarea
            value={reason}
            onChange={(event) => { setReason(event.target.value); setTouched(true); }}
            rows={4}
            placeholder={t('detail.reject.reason.placeholder')}
            autoFocus
          />
          {touched && !reasonOk && <span className="text-xs text-destructive">{t('detail.reject.reasonRequired')}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('detail.reject.target')}</Label>
          {lockedTarget ? (
            <div data-testid="reject-target-locked" className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
              {targetLabel}
            </div>
          ) : (
            <Select value={target} onValueChange={(value) => setTarget(value as RejectTaskTarget)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="in_progress">{t('detail.reject.target.in_progress')}</SelectItem>
                <SelectItem value="ready">{t('detail.reject.target.ready')}</SelectItem>
              </SelectContent>
            </Select>
          )}
          <span className="text-[11px] text-muted-foreground">{targetHint}</span>
        </div>
        {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="destructive"
          disabled={busy || !reasonOk}
          onClick={() => void onSubmit(reason.trim(), selectedTarget)}
        >
          {t('detail.reject.submit')}
        </Button>
      </DialogFooter>
    </>
  );
}
