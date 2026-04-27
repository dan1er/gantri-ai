import { useEffect, useRef, useState } from 'react';

interface Props {
  open: boolean;
  reportTitle: string;
  /** Called when the modal is dismissed (cancel / outside click / Escape). */
  onClose: () => void;
  /** Called with the form values when the user submits. Should resolve when
   *  the network request completes; throws to surface an error message. */
  onSubmit: (input: { reason: string; reporterHandle: string }) => Promise<void>;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

const HANDLE_KEY = 'gantri-reports-handle';

export function FeedbackModal({ open, reportTitle, onClose, onSubmit }: Props) {
  const [reason, setReason] = useState('');
  const [reporterHandle, setReporterHandle] = useState(() => localStorage.getItem(HANDLE_KEY) ?? '');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Reset transient state every time the modal is opened.
  useEffect(() => {
    if (open) {
      setReason('');
      setStatus('idle');
      setErrorMsg(null);
      // Focus the reason textarea on next tick so it lands after the dialog mounts.
      setTimeout(() => reasonRef.current?.focus(), 30);
    }
  }, [open]);

  // Escape closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit() {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setErrorMsg('Please describe what looks wrong (at least 3 characters).');
      return;
    }
    setStatus('submitting');
    setErrorMsg(null);
    try {
      const handle = reporterHandle.trim();
      if (handle) localStorage.setItem(HANDLE_KEY, handle);
      else localStorage.removeItem(HANDLE_KEY);
      await onSubmit({ reason: trimmed, reporterHandle: handle });
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to submit. Try again.');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-modal-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-gray-900/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 id="feedback-modal-title" className="text-base font-semibold text-gantri-ink">Report a wrong number</h2>
            <p className="mt-1 text-xs text-gray-500">in <span className="text-gray-700">{reportTitle}</span></p>
          </div>
          <button onClick={onClose} aria-label="Close" className="-mr-1 -mt-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </header>

        {status === 'success' ? (
          <div className="px-5 py-8 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-green-600">✓</div>
            <p className="text-sm text-gray-700">Thanks — sent to Danny. You'll hear back when it's looked at.</p>
            <button
              onClick={onClose}
              className="mt-5 inline-flex items-center rounded-md bg-gantri-ink px-4 py-2 text-sm font-medium text-white hover:bg-black"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-4 px-5 py-4">
              <label className="block">
                <span className="block text-xs font-medium text-gray-700">What looks wrong?</span>
                <span className="mt-0.5 block text-xs text-gray-500">Be specific — which number, what you'd expect, any context.</span>
                <textarea
                  ref={reasonRef}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={5}
                  maxLength={4000}
                  placeholder="e.g. The 'Total Revenue' KPI shows $12k for last week, but Northbeam dashboard shows $18k for the same period."
                  className="mt-2 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gantri-ink placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60"
                  disabled={status === 'submitting'}
                />
                <span className="mt-1 block text-right text-[10px] text-gray-400">{reason.length}/4000</span>
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-gray-700">Your Slack handle <span className="font-normal text-gray-500">(optional — so I can DM you when fixed)</span></span>
                <input
                  type="text"
                  value={reporterHandle}
                  onChange={(e) => setReporterHandle(e.target.value)}
                  placeholder="@danny"
                  maxLength={80}
                  className="mt-2 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gantri-ink placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60"
                  disabled={status === 'submitting'}
                />
              </label>
              {errorMsg && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{errorMsg}</p>
              )}
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
              <button
                onClick={onClose}
                disabled={status === 'submitting'}
                className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={status === 'submitting' || reason.trim().length < 3}
                className="inline-flex items-center rounded-md bg-gantri-ink px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-black disabled:opacity-60"
              >
                {status === 'submitting' ? 'Sending…' : 'Send to Danny'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
