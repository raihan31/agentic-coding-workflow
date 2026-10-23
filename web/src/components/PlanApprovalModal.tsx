import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, CheckCircle2, HelpCircle, FileText, Loader2 } from 'lucide-react';
import { api, type Backlog, type OpenQuestion } from '../api';
import { Button, ErrorNote } from '../components';

export interface PlanApprovalModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  planContent?: string;
  backlog?: Backlog | null;
  onApproved?: () => void;
}

export function PlanApprovalModal({
  open,
  onOpenChange,
  projectId,
  planContent = '',
  backlog,
  onApproved,
}: PlanApprovalModalProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const blockingQuestions: OpenQuestion[] = backlog?.openQuestions?.filter(q => q.blocking) ?? [];

  const handleAnswerChange = (questionId: string, value: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: value }));
  };

  const handleApprove = async () => {
    try {
      setSubmitting(true);
      setError(null);
      await api.approve(projectId, answers);
      onOpenChange(false);
      onApproved?.();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setSubmitting(false);
    }
  };

  const allBlockingAnswered = blockingQuestions.every(
    q => (answers[q.id]?.trim() || q.answer?.trim())
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs transition-opacity animate-in fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[95vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-surface shadow-2xl transition-all">
          
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-6 py-4">
            <div className="flex items-center gap-2.5">
              <div className="rounded-md bg-accent/10 p-1.5 text-accent">
                <FileText size={18} />
              </div>
              <div>
                <Dialog.Title className="text-base font-semibold text-ink">
                  Review & Approve Execution Plan
                </Dialog.Title>
                <Dialog.Description className="text-xs text-ink-2">
                  Project {projectId} · Review tasks, architecture plan, and answer blocking questions.
                </Dialog.Description>
              </div>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink transition"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            
            {/* Blocking Questions Section */}
            {blockingQuestions.length > 0 && (
              <div className="rounded-lg border border-warn/30 bg-warn/5 p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-warn">
                  <HelpCircle size={16} />
                  <span>Blocking Questions ({blockingQuestions.length})</span>
                </div>
                <p className="text-xs text-ink-2">
                  The Analyst requires answers to these questions before execution can proceed safely.
                </p>

                <div className="space-y-4 pt-1">
                  {blockingQuestions.map(q => (
                    <div key={q.id} className="rounded-md border border-line bg-surface p-3 space-y-2">
                      <div className="text-xs font-semibold text-ink">{q.question}</div>
                      {q.context && <div className="text-xs text-muted leading-relaxed">{q.context}</div>}
                      <textarea
                        rows={2}
                        defaultValue={answers[q.id] || q.answer || ''}
                        onChange={e => handleAnswerChange(q.id, e.target.value)}
                        placeholder="Provide your answer or clarification..."
                        className="w-full rounded border border-line bg-page px-3 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Plan Markdown Content */}
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                Architectural Plan (plan.md)
              </div>
              <div className="rounded-lg border border-line bg-raised/50 p-4 prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed overflow-x-auto">
                {planContent ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {planContent}
                  </ReactMarkdown>
                ) : (
                  <div className="py-8 text-center text-muted italic">
                    No plan.md artifact loaded yet.
                  </div>
                )}
              </div>
            </div>

            {error && <ErrorNote error={error} />}
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between border-t border-line bg-raised/30 px-6 py-3.5">
            <div className="text-xs text-muted">
              {blockingQuestions.length > 0 && !allBlockingAnswered ? (
                <span className="text-warn font-medium">Please answer all blocking questions above.</span>
              ) : (
                <span>Ready to execute backlog tasks.</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Dialog.Close asChild>
                <Button kind="secondary">Cancel</Button>
              </Dialog.Close>
              <Button
                kind="primary"
                onClick={handleApprove}
                disabled={submitting || (blockingQuestions.length > 0 && !allBlockingAnswered)}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Approving...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={14} />
                    <span>Approve & Start Project</span>
                  </>
                )}
              </Button>
            </div>
          </div>

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
