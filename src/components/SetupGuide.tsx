import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Modal, Text } from '@capra/core';
import { usePulse } from '../state';
import { apiBase } from '../lib/host';
import { kvPut as kvSet } from '../lib/api';

const KEY = 'ui/onboarding';
import { GuideCtx, isPrimaryRoute } from '../lib/setupGuide';

type Read = 'pending' | 'dismissed' | 'open-ok';

async function readDismissal(): Promise<Read> {
  try {
    const res = await fetch(`${apiBase()}/kvstore/${KEY}`);
    if (res.status === 404) return 'open-ok';
    if (!res.ok) return 'dismissed';
    const text = await res.text();
    return text.includes('dismissedAt') ? 'dismissed' : 'open-ok';
  } catch { return 'dismissed'; }
}

export function SetupGuide({ children }: { children?: ReactNode }) {
  const { setup, settings } = usePulse();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [read, setRead] = useState<Read>('pending');
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const wrote = useRef(false);

  useEffect(() => { let live = true; void readDismissal().then((r) => { if (live) setRead(r); }); return () => { live = false; }; }, []);

  useEffect(() => {
    if (open || dismissed || read !== 'open-ok' || setup !== 'not-deployed' || !isPrimaryRoute(pathname)) return;
    if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return; // another modal is open
    const t = setTimeout(() => setOpen(true), 0); // after other modals have mounted
    return () => clearTimeout(t);
  }, [open, dismissed, read, setup, pathname]);

  const openGuide = useCallback(() => { wrote.current = false; setOpen(true); }, []);
  const dismiss = () => {
    setOpen(false); setDismissed(true);
    if (wrote.current) return;
    wrote.current = true;
    void kvSet(KEY, { dismissedAt: new Date().toISOString() }).catch(() => { /* best effort */ });
  };
  const onOpenSetup = () => { dismiss(); navigate('/settings/setup'); };
  const ctx = useMemo(() => ({ openGuide }), [openGuide]);

  return (
    <GuideCtx.Provider value={ctx}>
      {children}
      <Modal isOpen={open} size="md" title="Set up Pulse" confirmButtonText="Open Setup" cancelButtonText="Not now"
        onConfirm={onOpenSetup} onClose={dismiss}>
        <ol className="stack-sm">
          <li><Text><strong>Deploy Pulse</strong> (required). Settings → Setup is where you install it: tick the worker groups, pick the sources to watch, and click Deploy everything. One plan installs the pack, the Lake dataset, the destination, the route and the Cribl Search alerts.</Text></li>
          <li><Text><strong>Wait about 15 minutes.</strong> Heartbeats arrive every 5 minutes. An asset leaves learning after {settings.learning.LEARN_MIN} active minutes.</Text></li>
          <li><Text><strong>Optional.</strong> Choose an AI provider under Settings → General. Leave Cribl Search included on Setup so the alerts deploy with the groups.</Text></li>
        </ol>
      </Modal>
    </GuideCtx.Provider>
  );
}
