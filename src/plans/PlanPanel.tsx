import { useEffect, useRef, useState } from 'react';
import type { PlanAssignment, PlanCompletionHistoryItem, PlanDefinitionVersion, PlanEnrollment, StreamEnrollment } from '../platform/plans';
import type { PlanDefinitionApi } from '../platform/plans';
import './plans.css';

type PlanDetails =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; definition: PlanDefinitionVersion; assignments: PlanAssignment[] };
type ReadyPlanDetails = Extract<PlanDetails, { kind: 'ready' }>;
type PlanHistory =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: PlanCompletionHistoryItem[] };
type ReadyPlanHistory = Extract<PlanHistory, { kind: 'ready' }>;

type PlanPanelApi = Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'getPlanDefinitionVersion' | 'activePlanAssignments' | 'planCompletionHistory' | 'registerFourStreamPlan' | 'importPlanDefinitionJson' | 'enrollInChapterStreams' | 'completePlanStream' | 'undoPlanCompletion'>;

export function PlanPanel({ api }: { api?: PlanPanelApi }) {
  const [enrollments, setEnrollments] = useState<PlanEnrollment[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [listError, setListError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [details, setDetails] = useState<PlanDetails | null>(null);
  const [history, setHistory] = useState<PlanHistory | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [offer, setOffer] = useState<PlanDefinitionVersion | null>(null);
  const [choices, setChoices] = useState<StreamEnrollment[]>([]);
  const [offerError, setOfferError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [completingId, setCompletingId] = useState('');
  const [completionMessage, setCompletionMessage] = useState('');
  const [undoingId, setUndoingId] = useState('');
  const [undoMessage, setUndoMessage] = useState('');
  const [undoRefreshFailed, setUndoRefreshFailed] = useState(false);
  const [customPlanJson, setCustomPlanJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [imported, setImported] = useState<PlanDefinitionVersion | null>(null);
  const detailEpoch = useRef(0);
  const historyEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const completionEpoch = useRef(0);
  const undoEpoch = useRef(0);
  const importEpoch = useRef(0);
  const discoveryEpoch = useRef(0);
  const confirmedEnrollment = useRef<PlanEnrollment | null>(null);
  const confirmedCompletions = useRef(new Map<string, string>());
  const confirmedUndos = useRef(new Map<string, string>());
  const readyDetails = useRef(new Map<string, ReadyPlanDetails>());
  const readyHistory = useRef(new Map<string, ReadyPlanHistory>());
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => () => {
    actionEpoch.current += 1;
    completionEpoch.current += 1;
    undoEpoch.current += 1;
    importEpoch.current += 1;
    confirmedEnrollment.current = null;
    confirmedCompletions.current.clear();
    confirmedUndos.current.clear();
    readyDetails.current.clear();
    readyHistory.current.clear();
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const epoch = ++discoveryEpoch.current;
    setListError('');
    api.listPlanEnrollments().then(items => {
      if (!active || epoch !== discoveryEpoch.current) return;
      const confirmed = confirmedEnrollment.current;
      const visible = confirmed && !items.some(item => item.id === confirmed.id) ? [...items, confirmed] : items;
      setEnrollments(visible);
      setSelectedId(current => confirmed?.id ?? (visible.some(item => item.id === current) ? current : (visible[0]?.id ?? '')));
      if (confirmed && items.some(item => item.id === confirmed.id)) confirmedEnrollment.current = null;
    }).catch(error => { if (active && epoch === discoveryEpoch.current) setListError(String(error)); });
    return () => { active = false; };
  }, [api, attempt]);

  useEffect(() => {
    const enrollment = enrollments?.find(item => item.id === selectedId);
    if (!api || !enrollment) return;
    let active = true;
    const epoch = ++detailEpoch.current;
    setDetails({ kind: 'loading' });
    setCompletionMessage('');
    Promise.all([
      api.getPlanDefinitionVersion(enrollment.definitionVersionId),
      api.activePlanAssignments(enrollment.id),
    ]).then(([definition, assignments]) => {
      if (!active || epoch !== detailEpoch.current) return;
      if (!definition) { setDetails({ kind: 'error', message: 'The retained plan definition is unavailable.' }); return; }
      const visible = assignments.filter(assignment => !confirmedCompletions.current.has(assignment.id));
      for (const [assignmentId, enrollmentId] of confirmedCompletions.current) {
        if (enrollmentId === enrollment.id && !assignments.some(assignment => assignment.id === assignmentId)) confirmedCompletions.current.delete(assignmentId);
      }
      const ready: ReadyPlanDetails = { kind: 'ready', definition, assignments: visible };
      readyDetails.current.set(enrollment.id, ready);
      setDetails(ready);
    }).catch(error => { if (active && epoch === detailEpoch.current) setDetails({ kind: 'error', message: String(error) }); });
    return () => { active = false; };
  }, [api, detailAttempt, enrollments, selectedId]);

  useEffect(() => {
    const enrollment = enrollments?.find(item => item.id === selectedId);
    if (!api || !enrollment) return;
    let active = true;
    const epoch = ++historyEpoch.current;
    const retained = readyHistory.current.get(enrollment.id);
    const hasConfirmedUndo = [...confirmedUndos.current.values()].includes(enrollment.id);
    setHistory(hasConfirmedUndo && retained ? retained : { kind: 'loading' });
    setUndoMessage('');
    setUndoRefreshFailed(false);
    api.planCompletionHistory(enrollment.id).then(items => {
      if (!active || epoch !== historyEpoch.current) return;
      const visible = items.map(item => confirmedUndos.current.has(item.id) ? { ...item, undone: true } : item);
      for (const [completionId, enrollmentId] of confirmedUndos.current) {
        if (enrollmentId === enrollment.id && items.some(item => item.id === completionId && item.undone)) confirmedUndos.current.delete(completionId);
      }
      const ready: ReadyPlanHistory = { kind: 'ready', items: visible };
      readyHistory.current.set(enrollment.id, ready);
      setHistory(ready);
    }).catch(error => {
      if (!active || epoch !== historyEpoch.current) return;
      const recovered = hasConfirmedUndo ? readyHistory.current.get(enrollment.id) : undefined;
      if (recovered) {
        setHistory(recovered);
        setUndoMessage(`Completion history could not be refreshed: ${String(error)}`);
        setUndoRefreshFailed(true);
      } else setHistory({ kind: 'error', message: String(error) });
    });
    return () => { active = false; };
  }, [api, enrollments, historyAttempt, selectedId]);

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
    setEnrolling(true); setOfferError('');
    try {
      const enrollment = await api.enrollInChapterStreams(offer.id, choices);
      if (epoch !== actionEpoch.current) return;
      confirmedEnrollment.current = enrollment;
      setEnrollments(current => current?.some(item => item.id === enrollment.id) ? current : [...(current ?? []), enrollment]);
      setSelectedId(enrollment.id);
      setOffer(null); setChoices([]);
      const refreshEpoch = ++discoveryEpoch.current;
      try {
        const refreshed = await api.listPlanEnrollments();
        if (epoch !== actionEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setListError('');
        setEnrollments(refreshed.some(item => item.id === enrollment.id) ? refreshed : [...refreshed, enrollment]);
        setSelectedId(enrollment.id);
        if (refreshed.some(item => item.id === enrollment.id)) confirmedEnrollment.current = null;
        else setOfferError('Enrollment was created, but discovery did not return it yet.');
      } catch (error) {
        if (epoch !== actionEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setOfferError(`Enrollment was created, but retained plans could not be refreshed: ${String(error)}`);
      }
    } catch (error) {
      if (epoch === actionEpoch.current) setOfferError(`Could not create enrollment: ${String(error)}`);
    } finally {
      if (epoch === actionEpoch.current) setEnrolling(false);
    }
  }

  async function importCustomPlan() {
    if (!api || importing || !customPlanJson.trim()) return;
    const epoch = ++importEpoch.current;
    const submitted = customPlanJson;
    setImporting(true); setImportError('');
    try {
      const version = await api.importPlanDefinitionJson(submitted);
      if (epoch !== importEpoch.current) return;
      setImported(version);
      setCustomPlanJson('');
    } catch (error) {
      if (epoch === importEpoch.current) setImportError(`Could not import custom plan: ${String(error)}`);
    } finally {
      if (epoch === importEpoch.current) setImporting(false);
    }
  }

  async function complete(assignment: PlanAssignment, definition: PlanDefinitionVersion) {
    if (!api || completingId || undoingId) return;
    const epoch = ++completionEpoch.current;
    setCompletingId(assignment.id); setCompletionMessage('');
    try {
      await api.completePlanStream({
        enrollmentId: assignment.enrollmentId,
        streamId: assignment.streamId,
        expectedAssignmentId: assignment.id,
        expectedProgressId: assignment.progressId,
      });
      if (epoch !== completionEpoch.current) return;
      confirmedCompletions.current.set(assignment.id, assignment.enrollmentId);
      if (selectedIdRef.current !== assignment.enrollmentId) return;
      setHistoryAttempt(current => current + 1);
      const refreshEpoch = ++detailEpoch.current;
      setDetails(current => {
        const retained = current?.kind === 'ready' ? current : readyDetails.current.get(assignment.enrollmentId);
        const recovered: ReadyPlanDetails = {
          kind: 'ready',
          definition: retained?.definition ?? definition,
          assignments: (retained?.assignments ?? []).filter(item => item.id !== assignment.id),
        };
        readyDetails.current.set(assignment.enrollmentId, recovered);
        return recovered;
      });
      try {
        const assignments = await api.activePlanAssignments(assignment.enrollmentId);
        if (epoch !== completionEpoch.current || refreshEpoch !== detailEpoch.current || selectedIdRef.current !== assignment.enrollmentId) return;
        const visible = assignments.filter(item => !confirmedCompletions.current.has(item.id));
        if (!assignments.some(item => item.id === assignment.id)) confirmedCompletions.current.delete(assignment.id);
        const ready: ReadyPlanDetails = { kind: 'ready', definition, assignments: visible };
        readyDetails.current.set(assignment.enrollmentId, ready);
        setDetails(ready);
      } catch (error) {
        if (epoch === completionEpoch.current && refreshEpoch === detailEpoch.current && selectedIdRef.current === assignment.enrollmentId) {
          setCompletionMessage(`Chapter was completed, but assignments could not be refreshed: ${String(error)}`);
        }
      }
    } catch (error) {
      if (epoch === completionEpoch.current && selectedIdRef.current === assignment.enrollmentId) setCompletionMessage(`Could not complete chapter: ${String(error)}`);
    } finally {
      if (epoch === completionEpoch.current) setCompletingId('');
    }
  }

  async function undo(item: PlanCompletionHistoryItem) {
    if (!api || completingId || undoingId || item.undone) return;
    const epoch = ++undoEpoch.current;
    setUndoingId(item.id); setUndoMessage(''); setUndoRefreshFailed(false);
    try {
      await api.undoPlanCompletion(item.id);
      if (epoch !== undoEpoch.current) return;
      confirmedUndos.current.set(item.id, item.enrollmentId);
      const retained = readyHistory.current.get(item.enrollmentId);
      const confirmedHistory: ReadyPlanHistory | undefined = retained && {
        kind: 'ready',
        items: retained.items.map(value => value.id === item.id ? { ...value, undone: true } : value),
      };
      if (confirmedHistory) readyHistory.current.set(item.enrollmentId, confirmedHistory);
      if (selectedIdRef.current !== item.enrollmentId) return;
      setHistory(current => {
        const visible = current?.kind === 'ready' ? current : confirmedHistory;
        if (!visible) return current;
        const ready: ReadyPlanHistory = { kind: 'ready', items: visible.items.map(value => value.id === item.id ? { ...value, undone: true } : value) };
        readyHistory.current.set(item.enrollmentId, ready);
        return ready;
      });
      setHistoryAttempt(value => value + 1);
      setDetailAttempt(value => value + 1);
    } catch (error) {
      if (epoch === undoEpoch.current && selectedIdRef.current === item.enrollmentId) {
        setUndoMessage(`Could not undo completion. Later active completions must be undone first. ${String(error)}`);
        setUndoRefreshFailed(false);
      }
    } finally {
      if (epoch === undoEpoch.current) setUndoingId('');
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
    <section className="plan-import" aria-label="Import custom plan">
      <h3>Import custom plan</h3>
      <p>Paste a plan-definition JSON document. Import creates a new plan identity and does not alter retained enrollments.</p>
      <label>Custom plan JSON<textarea value={customPlanJson} onChange={event => setCustomPlanJson(event.target.value)} placeholder='{"schemaVersion":1,...}' spellCheck={false} /></label>
      <button disabled={importing || !customPlanJson.trim()} onClick={() => void importCustomPlan()}>{importing ? 'Importing plan…' : 'Import custom plan'}</button>
      {importError && <div role="alert" className="plan-error">{importError}</div>}
      {imported && <div role="status" className="plan-imported">Imported custom plan <strong>{imported.definition.name}</strong> as a new plan identity. Retained enrollments were not changed.<small>Definition version {imported.id}</small></div>}
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
        {details.assignments.length === 0 ? <p>This enrollment is exhausted; it has no active assignments.</p> : <ul>{details.assignments.map(assignment => <li key={assignment.id}><strong>{assignment.streamId}</strong><span>Book {assignment.passage.book} · Chapter {assignment.passage.chapter}</span><button disabled={!!completingId || !!undoingId} onClick={() => void complete(assignment, details.definition)}>{completingId === assignment.id ? 'Completing…' : `Complete ${assignment.streamId}`}</button></li>)}</ul>}
        {completionMessage && <div role="alert" className="plan-error">{completionMessage}<button onClick={() => setDetailAttempt(value => value + 1)}>Retry assignments</button></div>}
      </section>}
      {history?.kind === 'loading' && <p role="status">Loading completion history…</p>}
      {history?.kind === 'error' && <div role="alert" className="plan-error">Could not load completion history: {history.message}<button onClick={() => setHistoryAttempt(value => value + 1)}>Retry completion history</button></div>}
      {history?.kind === 'ready' && <section className="plan-history" aria-label="Retained completion history">
        <h3>Completion history</h3>
        {history.items.length === 0 ? <p>No retained completions yet.</p> : <ol>{history.items.map(item => <li key={item.id}>
          <strong>{item.streamId}</strong><span>Book {item.passage.book} · Chapter {item.passage.chapter} · Cycle {item.cycle}</span><span>Completed {item.completedAt}</span><small>Completion {item.id} · Assignment {item.assignmentId}</small><em>{item.undone ? 'Undone' : 'Current completion'}</em>{!item.undone && <button disabled={!!undoingId || !!completingId} onClick={() => void undo(item)}>{undoingId === item.id ? 'Undoing…' : `Undo completion ${item.id}`}</button>}
        </li>)}</ol>}
        {undoMessage && <div role="alert" className="plan-error">{undoMessage}{undoRefreshFailed && <button onClick={() => setHistoryAttempt(value => value + 1)}>Retry completion history</button>}</div>}
      </section>}
    </>}
  </aside>;
}
