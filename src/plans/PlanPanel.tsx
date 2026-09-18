import { useEffect, useRef, useState } from 'react';
import type { PlanAssignment, PlanDefinitionVersion, PlanEnrollment, StreamEnrollment } from '../platform/plans';
import type { PlanDefinitionApi } from '../platform/plans';
import './plans.css';

type PlanDetails =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; definition: PlanDefinitionVersion; assignments: PlanAssignment[] };

type PlanPanelApi = Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'getPlanDefinitionVersion' | 'activePlanAssignments' | 'registerFourStreamPlan' | 'enrollInChapterStreams'>;

export function PlanPanel({ api }: { api?: PlanPanelApi }) {
  const [enrollments, setEnrollments] = useState<PlanEnrollment[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [listError, setListError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [details, setDetails] = useState<PlanDetails | null>(null);
  const [offer, setOffer] = useState<PlanDefinitionVersion | null>(null);
  const [choices, setChoices] = useState<StreamEnrollment[]>([]);
  const [offerError, setOfferError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const detailEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const discoveryEpoch = useRef(0);

  useEffect(() => () => { actionEpoch.current += 1; }, [api]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const epoch = ++discoveryEpoch.current;
    setEnrollments(null); setListError(''); setDetails(null);
    api.listPlanEnrollments().then(items => {
      if (!active || epoch !== discoveryEpoch.current) return;
      setEnrollments(items);
      setSelectedId(current => items.some(item => item.id === current) ? current : (items[0]?.id ?? ''));
    }).catch(error => { if (active && epoch === discoveryEpoch.current) setListError(String(error)); });
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

  async function prepareEnrollment() {
    if (!api || preparing || enrolling) return;
    const epoch = ++actionEpoch.current;
    setPreparing(true); setOfferError('');
    try {
      const version = await api.registerFourStreamPlan();
      if (epoch !== actionEpoch.current) return;
      if (version.definition.schedule.kind !== 'chapterStreams' || version.definition.schedule.streams.length !== 4) {
        throw new Error('The native four-stream definition is unavailable.');
      }
      setOffer(version);
      setChoices(version.definition.schedule.streams.map(stream => ({ streamId: stream.id, startingPosition: 0, loopAfterEnd: true })));
    } catch (error) {
      if (epoch === actionEpoch.current) setOfferError(`Could not prepare four-stream enrollment: ${String(error)}`);
    } finally {
      if (epoch === actionEpoch.current) setPreparing(false);
    }
  }

  async function enroll() {
    if (!api || !offer || enrolling || preparing) return;
    const epoch = ++actionEpoch.current;
    const knownEnrollments = enrollments ?? [];
    setEnrolling(true); setOfferError('');
    try {
      const enrollment = await api.enrollInChapterStreams(offer.id, choices);
      if (epoch !== actionEpoch.current) return;
      const refreshEpoch = ++discoveryEpoch.current;
      try {
        const refreshed = await api.listPlanEnrollments();
        if (epoch !== actionEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setListError('');
        setEnrollments(refreshed.some(item => item.id === enrollment.id) ? refreshed : [...refreshed, enrollment]);
        setSelectedId(enrollment.id);
        if (!refreshed.some(item => item.id === enrollment.id)) setOfferError('Enrollment was created, but discovery did not return it yet.');
      } catch (error) {
        if (epoch !== actionEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setEnrollments(current => {
          const retained = current ?? knownEnrollments;
          return retained.some(item => item.id === enrollment.id) ? retained : [...retained, enrollment];
        });
        setSelectedId(enrollment.id);
        setOfferError(`Enrollment was created, but retained plans could not be refreshed: ${String(error)}`);
      }
      setOffer(null); setChoices([]);
    } catch (error) {
      if (epoch === actionEpoch.current) setOfferError(`Could not create enrollment: ${String(error)}`);
    } finally {
      if (epoch === actionEpoch.current) setEnrolling(false);
    }
  }

  if (!api) return <aside className="plan-panel" aria-label="Reading plans"><h2>Reading plans</h2><p>Plans are available in the native desktop app.</p></aside>;
  return <aside className="plan-panel" aria-label="Reading plans">
    <header><div><span>READING PLANS</span><h2>Retained plans</h2></div></header>
    {enrollments === null && !listError && <p role="status">Loading retained plans…</p>}
    {listError && <div role="alert" className="plan-error">Could not load retained plans: {listError}<button onClick={() => setAttempt(value => value + 1)}>Retry plans</button></div>}
    <section className="plan-enrollment" aria-label="Start four-stream plan">
      {!offer && <><p>Read one chapter in each of four independent streams. Each stream advances only when you complete it.</p><button disabled={preparing || enrolling} onClick={() => void prepareEnrollment()}>{preparing ? 'Preparing…' : 'Set up four-stream plan'}</button></>}
      {offer && offer.definition.schedule.kind === 'chapterStreams' && <>
        <h3>{offer.definition.name}</h3>
        <p>Choose a starting chapter and whether each stream loops or stops after its final chapter. Defaults start at the first chapter and loop.</p>
        <div className="plan-streams">{offer.definition.schedule.streams.map((stream, index) => <fieldset key={stream.id} disabled={enrolling}>
          <legend>{stream.name}</legend>
          <label>Starting chapter<select value={choices[index]?.startingPosition ?? 0} onChange={event => setChoices(current => current.map((choice, choiceIndex) => choiceIndex === index ? { ...choice, startingPosition: Number(event.target.value) } : choice))}>
            {stream.chapters.map((chapter, position) => <option key={`${chapter.book}:${chapter.chapter}:${position}`} value={position}>Book {chapter.book} · Chapter {chapter.chapter}</option>)}
          </select></label>
          <label className="plan-loop"><input type="checkbox" checked={choices[index]?.loopAfterEnd ?? true} onChange={event => setChoices(current => current.map((choice, choiceIndex) => choiceIndex === index ? { ...choice, loopAfterEnd: event.target.checked } : choice))} /> Loop after the final chapter</label>
        </fieldset>)}</div>
        <button disabled={enrolling || choices.length !== 4} onClick={() => void enroll()}>{enrolling ? 'Creating enrollment…' : 'Create enrollment'}</button>
      </>}
      {offerError && <div role="alert" className="plan-error">{offerError}</div>}
    </section>
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
