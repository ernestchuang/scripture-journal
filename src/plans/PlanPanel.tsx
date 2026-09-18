import { useEffect, useRef, useState } from 'react';
import type { PlanAssignment, PlanDefinitionVersion, PlanEnrollment } from '../platform/plans';
import type { PlanDefinitionApi } from '../platform/plans';
import './plans.css';

type PlanDetails =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; definition: PlanDefinitionVersion; assignments: PlanAssignment[] };

export function PlanPanel({ api }: { api?: Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'getPlanDefinitionVersion' | 'activePlanAssignments'> }) {
  const [enrollments, setEnrollments] = useState<PlanEnrollment[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [listError, setListError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [details, setDetails] = useState<PlanDetails | null>(null);
  const detailEpoch = useRef(0);

  useEffect(() => {
    if (!api) return;
    let active = true;
    setEnrollments(null); setListError(''); setDetails(null);
    api.listPlanEnrollments().then(items => {
      if (!active) return;
      setEnrollments(items);
      setSelectedId(current => items.some(item => item.id === current) ? current : (items[0]?.id ?? ''));
    }).catch(error => { if (active) setListError(String(error)); });
    return () => { active = false; detailEpoch.current += 1; };
  }, [api, attempt]);

  useEffect(() => {
    const enrollment = enrollments?.find(item => item.id === selectedId);
    if (!api || !enrollment) return;
    let active = true;
    const epoch = ++detailEpoch.current;
    setDetails({ kind: 'loading' });
    Promise.all([
      api.getPlanDefinitionVersion(enrollment.definitionVersionId),
      api.activePlanAssignments(enrollment.id),
    ]).then(([definition, assignments]) => {
      if (!active || epoch !== detailEpoch.current) return;
      if (!definition) { setDetails({ kind: 'error', message: 'The retained plan definition is unavailable.' }); return; }
      setDetails({ kind: 'ready', definition, assignments });
    }).catch(error => { if (active && epoch === detailEpoch.current) setDetails({ kind: 'error', message: String(error) }); });
    return () => { active = false; };
  }, [api, detailAttempt, enrollments, selectedId]);

  if (!api) return <aside className="plan-panel" aria-label="Reading plans"><h2>Reading plans</h2><p>Plans are available in the native desktop app.</p></aside>;
  return <aside className="plan-panel" aria-label="Reading plans">
    <header><div><span>READING PLANS</span><h2>Retained plans</h2></div></header>
    {enrollments === null && !listError && <p role="status">Loading retained plans…</p>}
    {listError && <div role="alert" className="plan-error">Could not load retained plans: {listError}<button onClick={() => setAttempt(value => value + 1)}>Retry plans</button></div>}
    {enrollments?.length === 0 && <p>No retained plan enrollments yet.</p>}
    {enrollments && enrollments.length > 0 && <>
      <label>Retained enrollment<select value={selectedId} onChange={event => setSelectedId(event.target.value)}>
        {enrollments.map(enrollment => <option key={enrollment.id} value={enrollment.id}>{enrollment.id}</option>)}
      </select></label>
      {details?.kind === 'loading' && <p role="status">Loading current assignments…</p>}
      {details?.kind === 'error' && <div role="alert" className="plan-error">Could not load this retained plan: {details.message}<button onClick={() => setDetailAttempt(value => value + 1)}>Retry selection</button></div>}
      {details?.kind === 'ready' && <section className="plan-details" aria-label="Current plan assignments">
        <h3>{details.definition.definition.name}</h3>
        {details.assignments.length === 0 ? <p>This enrollment is exhausted; it has no active assignments.</p> : <ul>{details.assignments.map(assignment => <li key={assignment.id}><strong>{assignment.streamId}</strong><span>Book {assignment.passage.book} · Chapter {assignment.passage.chapter}</span></li>)}</ul>}
      </section>}
    </>}
  </aside>;
}
