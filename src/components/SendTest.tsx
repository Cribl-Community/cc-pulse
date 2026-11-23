import { useState, useSyncExternalStore } from 'react';
import { Button, Tag, Text } from '@capra/core';
import { sendTest, stopTest } from '../lib/channelsApi';

// Only one test can run at a time: a tiny shared flag, so the other Send test buttons are disabled.
let running = false;
const subs = new Set<() => void>();
const setRunning = (v: boolean) => { running = v; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

type Result = Awaited<ReturnType<typeof sendTest>> | { state: 'error'; message: string };

export function SendTest({ targetId }: { targetId: string }) {
  const busyAny = useSyncExternalStore(subscribe, () => running);
  const [mine, setMine] = useState(false);
  const [result, setResult] = useState<Result>();

  const go = async () => {
    if (running) return;
    setRunning(true); setMine(true); setResult(undefined);
    try {
      setResult(await sendTest(targetId));
    } catch (e) {
      setResult({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    try { await stopTest(); } catch { /* nothing to stop */ }
    setMine(false); setRunning(false);
  };

  return (
    <span data-testid={`send-test-${targetId}`}>
      <Button variant="secondary" size="sm" onClick={go} disabled={busyAny} aria-label={`Send test to ${targetId}`}>Send test</Button>
      {mine && <Text> Waiting up to 3 min…</Text>}
      {!mine && result?.state === 'sent' && <Tag size="sm" color="success">Sent: check the channel</Tag>}
      {!mine && result?.state === 'failed' && <Tag size="sm" color="danger">{`Failed (${result.errors} errors)`}</Tag>}
      {!mine && result?.state === 'no-answer' && <Tag size="sm" color="warning">No answer yet, check the channel</Tag>}
      {!mine && result?.state === 'error' && <Tag size="sm" color="danger">{`Failed: ${result.message}`}</Tag>}
    </span>
  );
}
