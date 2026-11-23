import { useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Tag } from '@capra/core';
import type { FleetGroup } from '../lib/demo';
import { reachOf, reachText } from '../lib/sourceReach';

const fmtEvs = (n: number) => `${Math.round(n).toLocaleString('en-US')} ev/s`;

type Props = {
  group: FleetGroup;
  /** Source ids ticked when the drawer opens. */
  picked: string[];
  /** 031's STAYS and OWNER text, shown under a source that stays in its pack. */
  stays: string;
  owner: string;
  /** Other groups the ticked sources can be copied onto. */
  copyTargets: string[];
  copyTo: string[];
  onToggleCopy: (id: string) => void;
  /** Current drawer ticks (unlocked ids only). Setup's copySources drops ids the target does not list. */
  onCopy: (ids: string[]) => void;
  dropped: number | null;
  onApply: (ids: string[]) => void;
  onCancel: () => void;
};

/**
 * Sources on <group>: one Checkbox per source, own inputs first, then pack sources with their reach.
 * Ticks are local until Apply; Cancel (or closing) drops them. Copy uses the ticks on screen.
 * Mount it fresh for each open — the closed page does not contain the copy controls.
 */
export function SetupSourcesDrawer({ group, picked, stays, owner, copyTargets, copyTo, onToggleCopy, onCopy, dropped, onApply, onCancel }: Props) {
  const list = [...group.sources, ...group.packSources];
  // A locked source (live: one Pulse's route cannot reach, or Stream too old) is shown but never ticked.
  const open = list.filter((s) => !s.locked);
  const [ticked, setTicked] = useState<string[]>(() => picked.filter((id) => open.some((s) => s.id === id)));
  const flip = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const chosen = () => open.filter((s) => ticked.includes(s.id)).map((s) => s.id);
  const footer = (
    <div className="row">
      <span className="sp" />
      <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" onClick={() => onApply(chosen())}>Apply</Button>
    </div>
  );
  return (
    <Drawer isOpen title={`Sources on ${group.id}`} onClose={onCancel} footer={footer}>
      <div className="stack">
        {list.map((s) => {
          const reach = reachText(s);
          const label = [s.id, s.type, fmtEvs(s.evs), reach].filter(Boolean).join(' · ');
          return (
            <div key={`${s.pack ?? ''}/${s.id}`} className="stack-sm">
              <div className="row">
                <Checkbox checked={ticked.includes(s.id)} disabled={s.locked} onChange={() => flip(s.id)}>{label}</Checkbox>
                {s.isNew && <Tag size="sm">new</Tag>}
                {s.pack && s.reach === 'yes' && !s.versionBlock && <Tag size="sm">{`in pack ${s.pack} · reaches group routes`}</Tag>}
                {s.pack && reachOf(s) === 'no' && <Tag size="sm">stays in the pack</Tag>}
              </div>
              {s.versionBlock && <div>needs Stream 4.17+</div>}
              {s.reach === 'maybe' && !s.versionBlock && <Alert appearance="warning" layout="inline">{`only the events its route ${s.routeId ?? ''} sends on`}</Alert>}
              {reachOf(s) === 'no' && <>
                <div className="muted">{stays}</div>
                <div className="muted">What the pack owner can change</div>
                <div className="muted">{owner}</div>
              </>}
            </div>
          );
        })}
        <div className="row">
          <Button size="sm" variant="tertiary" onClick={() => setTicked(open.map((s) => s.id))}>Tick all</Button>
          <Button size="sm" variant="tertiary" onClick={() => setTicked([])}>Clear</Button>
        </div>
        {copyTargets.map((id) => (
          <Checkbox key={id} checked={copyTo.includes(id)} onChange={() => onToggleCopy(id)}>{`Copy to ${id}`}</Checkbox>
        ))}
        <Button size="sm" variant="secondary" onClick={() => onCopy(chosen())}>Copy these sources to…</Button>
        {dropped != null && <div className="muted">{`Dropped ${dropped}`}</div>}
      </div>
    </Drawer>
  );
}
