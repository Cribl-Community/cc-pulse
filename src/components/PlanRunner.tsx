import { useState } from 'react';
import { Alert, Button, Card, Modal, Tag, Text } from '@capra/core';
import type { Step } from '../lib/deploy';
import { restart, retryFrom, runSteps, skipFrom, type PlanState } from '../lib/plan';

type Confirm = null | 'apply' | 'restart';

/** Shows a plan as numbered steps; nothing runs until "Apply plan" is confirmed. When a step fails the plan stops
 *  there, and the user can retry the step, skip it and carry on, or restart the whole plan (spec 016). */
export function PlanRunner({ title, steps, onDone }: { title: string; steps: Step[]; onDone?: () => void }) {
  const [status, setStatus] = useState<PlanState>({});
  const [confirm, setConfirm] = useState<Confirm>(null);
  const running = Object.values(status).some((x) => x.s === 'running');
  const started = Object.keys(status).length > 0;
  const failedAt = steps.findIndex((st) => status[st.id]?.s === 'failed');
  const finished = steps.length > 0 && steps.every((st) => status[st.id]?.s === 'done' || status[st.id]?.s === 'skipped');
  const skipped = steps.filter((st) => status[st.id]?.s === 'skipped');

  const report = async (p: Promise<{ failedAt: number }>) => {
    const r = await p;
    if (r.failedAt >= 0) console.error('[Pulse] plan step failed', steps[r.failedAt].id); else onDone?.();
  };
  const retry = () => void report(retryFrom(steps, status, failedAt, setStatus));
  const skip = () => void report(skipFrom(steps, status, failedAt, setStatus));
  function onConfirm() { const again = confirm === 'restart'; setConfirm(null); setStatus({}); void report(again ? restart(steps, setStatus) : runSteps(steps, 0, {}, setStatus)); }

  const failed = failedAt >= 0 ? steps[failedAt] : undefined;
  const dependants = failed ? steps.filter((st) => st.needs?.includes(failed.id)).map((st) => st.title) : [];

  return (
    <Card>
      <Card.Header><Card.Title>{title}</Card.Title>
        <Card.Action>
          {started && !running && !finished
            ? <Button variant="secondary" onClick={() => setConfirm('restart')}>Restart plan</Button>
            : <Button variant="primary" pending={running} disabled={!steps.length || finished} onClick={() => setConfirm('apply')}>{finished ? 'Applied' : 'Apply plan'}</Button>}
        </Card.Action>
      </Card.Header>
      <Card.Content>
        <ol className="plan">
          {steps.map((st, i) => { const x = status[st.id];
            return (<li key={st.id} className="plan-step">
              <span className="plan-num">{i + 1}</span>
              <div className="plan-body">
                <Text variant="body-sm-semibold">{st.title}</Text>
                <Text variant="body-xs-normal" color="subtle">{st.detail}</Text>
                {x?.msg && <Text variant="body-xs-normal" color={x.s === 'failed' ? 'attention' : 'subtle'}>{x.msg}</Text>}
                {x?.log && (<details className="plan-log" open={x.s === 'failed'}>
                  <summary>Error details</summary>
                  <pre>{x.log}</pre>
                  <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(x.log!)}>Copy</Button>
                </details>)}
              </div>
              <Tag size="sm" color={x?.s === 'done' ? 'success' : x?.s === 'failed' ? 'danger' : x?.s === 'running' ? 'info' : x?.s === 'skipped' ? 'warning' : 'default'}>{x?.s ?? (st.volatile ? 'changes config' : 'pending')}</Tag>
            </li>); })}
        </ol>
        {failed && !running && (<Alert appearance="danger" title={`Step ${failedAt + 1} failed: ${failed.title}`}>
          <div className="stack-sm">
            <Text variant="body-sm-normal">{`Retry it, skip it and carry on with the next step${dependants.length ? ` (this also skips ${dependants.join(', ')}, which need it)` : ''}, or restart the whole plan from step 1.`}</Text>
            <div className="row wrap">
              <Button size="sm" variant="primary" onClick={retry}>Retry step</Button>
              <Button size="sm" variant="secondary" onClick={skip}>Skip and continue</Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirm('restart')}>Restart plan</Button>
            </div>
          </div>
        </Alert>)}
        {finished && (skipped.length
          ? <Alert appearance="warning" title={`Plan applied, ${skipped.length} step(s) skipped`}>{`Skipped: ${skipped.map((st) => st.title).join(' · ')}. Restart the plan once the cause is fixed.`}</Alert>
          : <Alert appearance="success" title="Plan applied">All steps completed.</Alert>)}
        {finished && skipped.length > 0 && <div className="row"><Button size="sm" variant="secondary" onClick={() => setConfirm('restart')}>Restart plan</Button></div>}
      </Card.Content>
      <Modal isOpen={confirm !== null} title={confirm === 'restart' ? 'Restart this plan?' : 'Apply this plan?'} confirmButtonText={confirm === 'restart' ? 'Restart' : 'Apply'}
        onConfirm={onConfirm} onClose={() => setConfirm(null)}>
        <Text>{`${confirm === 'restart' ? 'All steps run again from step 1. Steps that already succeeded are re-applied (they are safe to repeat). ' : ''}${steps.length} step(s) will change Cribl configuration: ${steps.map((s) => s.title).join(' · ')}. Route and saved-search changes overwrite the existing Pulse objects.`}</Text>
      </Modal>
    </Card>
  );
}
