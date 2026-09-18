import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarAssignmentCompletion, CalendarEnrollmentRequest, CalendarPlanEnrollment, CalendarScheduleMode, DatedPlanAssignment, PlanAdoptionEvent, PlanAssignment, PlanCompletionHistoryItem, PlanDefinition, PlanDefinitionVersion, PlanEnrollment, StreamEnrollment } from '../platform/plans';
import type { PlanDefinitionApi } from '../platform/plans';
import { formatPassage } from '../scripture/books';
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
type CalendarRead<T> = { kind: 'loading' } | { kind: 'error'; message: string; items?: T[] } | { kind: 'ready'; items: T[] };

function CalendarAssignments({ items, selectedId, assignments, history, completingId, completionError, undoingId, undoError, onSelect, onRetry, onRetryHistory, onComplete, onUndo }: {
  items: CalendarPlanEnrollment[];
  selectedId: string;
  assignments: CalendarRead<DatedPlanAssignment> | null;
  history: CalendarRead<CalendarAssignmentCompletion> | null;
  completingId: string;
  completionError: string;
  undoingId: string;
  undoError: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onRetryHistory: () => void;
  onComplete: (assignment: DatedPlanAssignment) => void;
  onUndo: (completion: CalendarAssignmentCompletion) => void;
}) {
  const selected = items.find(item => item.id === selectedId);
  const historyItems = history?.kind === 'ready' ? history.items : history?.kind === 'error' ? history.items : undefined;
  return <section className="plan-history" aria-label="Retained calendar assignments">
    <h3>Retained calendar enrollments</h3>
    <label>Retained calendar enrollment<select value={selectedId} onChange={event => onSelect(event.target.value)}>{items.map(enrollment => <option key={enrollment.id} value={enrollment.id}>{enrollment.id} · {enrollment.scheduleMode} · {enrollment.startDate}</option>)}</select></label>
    {selected && <p>Calendar policy {selected.scheduleMode}, starting {selected.startDate}; definition version {selected.definitionVersionId}.</p>}
    {assignments?.kind === 'loading' && <p role="status">Loading dated calendar assignments…</p>}
    {assignments?.kind === 'error' && <div role="alert" className="plan-error">Could not load dated calendar assignments: {assignments.message}<button onClick={onRetry}>Retry calendar assignments</button></div>}
    {history?.kind === 'loading' && <p role="status">Loading calendar completion history…</p>}
    {history?.kind === 'error' && <div role="alert" className="plan-error">Could not load calendar completion history: {history.message}<button onClick={onRetryHistory}>Retry calendar completion history</button></div>}
    {completionError && <div role="alert" className="plan-error">Could not complete calendar assignment: {completionError}</div>}
    {undoError && <div role="alert" className="plan-error">Could not undo calendar completion: {undoError}</div>}
    {assignments?.kind === 'ready' && (assignments.items.length === 0 ? <p>No retained calendar assignments.</p> : <ol>{assignments.items.map(assignment => { const completion = historyItems?.find(item => item.assignmentId === assignment.id && !item.undone); return <li key={assignment.id}><strong>{assignment.localDate}</strong><span>Definition day {assignment.definitionDay}</span><span>{assignment.passages.map(formatPassage).join('; ')}</span><small>Assignment {assignment.id} · Definition version {assignment.definitionVersionId}</small>{historyItems ? (completion ? <><span>Completed {completion.completedAt} · Completion {completion.id}</span><button disabled={!!completingId || !!undoingId} onClick={() => onUndo(completion)}>{undoingId === completion.id ? 'Undoing calendar completion…' : `Undo calendar completion ${completion.id}`}</button></> : history?.kind === 'error' ? <span>Completion status is unavailable.</span> : <button disabled={!!completingId || !!undoingId} onClick={() => onComplete(assignment)}>{completingId === assignment.id ? 'Completing calendar assignment…' : 'Complete calendar assignment'}</button>) : <span>{history?.kind === 'loading' ? 'Completion status is loading.' : 'Completion status is unavailable.'}</span>}</li>; })}</ol>)}
    {historyItems && historyItems.length > 0 && <div><h4>Calendar completion history</h4><ol>{historyItems.map(item => <li key={item.id}><span>Retained record {item.id} · Assignment {item.assignmentId} · Enrollment {item.enrollmentId}</span><span>Completed {item.completedAt}</span><em>{item.undone ? 'Undone' : 'Current completion'}</em></li>)}</ol></div>}
  </section>;
}

function supportsCalendarAlignment(definition: PlanDefinitionVersion) {
  return definition.definition.schedule.kind === 'explicitSchedule'
    && definition.definition.schedule.days.length === 365;
}

function defaultCalendarScheduleMode(definition: PlanDefinitionVersion): CalendarScheduleMode {
  return supportsCalendarAlignment(definition) ? 'calendarAligned' : 'dayOne';
}
type ChapterStreams = Extract<PlanDefinition['schedule'], { kind: 'chapterStreams' }>['streams'];

type PlanPanelApi = Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'listLatestPlanDefinitionVersions' | 'getPlanDefinitionVersion' | 'activePlanAssignments' | 'planCompletionHistory' | 'registerFourStreamPlan' | 'registerMcheynePlan' | 'importPlanDefinitionJson' | 'createPlanDefinitionVersion' | 'exportPlanDefinitionJson' | 'enrollInChapterStreams' | 'enrollInCalendar' | 'getCalendarPlanEnrollment' | 'calendarPlanAssignments' | 'completeCalendarAssignment' | 'undoCalendarCompletion' | 'calendarCompletionHistory' | 'completePlanStream' | 'undoPlanCompletion'> & Partial<Pick<PlanDefinitionApi, 'adoptChapterStreamPlan' | 'adoptCalendarPlan' | 'planAdoptionHistory'>>;

function localToday() {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mergeConfirmedDefinitions(items: PlanDefinitionVersion[], confirmed: Map<string, PlanDefinitionVersion>, acknowledge = true) {
  const visible = items.map(item => {
    const pending = confirmed.get(item.planId);
    return pending && pending.version > item.version ? pending : item;
  });
  for (const version of confirmed.values()) {
    if (!visible.some(item => item.planId === version.planId)) visible.push(version);
    if (acknowledge && items.some(item => item.planId === version.planId && item.version >= version.version)) confirmed.delete(version.planId);
  }
  return visible;
}

export function updateStreamEnrollmentChoice(
  streams: ChapterStreams,
  current: StreamEnrollment[],
  index: number,
  update: Partial<Pick<StreamEnrollment, 'startingPosition' | 'loopAfterEnd'>>,
) {
  return streams.map((stream, choiceIndex) => ({
    ...(current.find(choice => choice.streamId === stream.id) ?? {
      streamId: stream.id,
      startingPosition: 0,
      loopAfterEnd: true,
    }),
    ...(choiceIndex === index ? update : {}),
  }));
}

export type RetainedExportLifecycle = { epoch: number; selectedDefinitionId: string };

export function selectRetainedExportDefinition(lifecycle: RetainedExportLifecycle, id: string) {
  if (lifecycle.selectedDefinitionId === id) return false;
  lifecycle.epoch += 1;
  lifecycle.selectedDefinitionId = id;
  return true;
}

export function startRetainedExport(lifecycle: RetainedExportLifecycle) {
  lifecycle.epoch += 1;
  return lifecycle.epoch;
}

export function ownsRetainedExport(lifecycle: RetainedExportLifecycle, epoch: number, definitionId: string) {
  return lifecycle.epoch === epoch && lifecycle.selectedDefinitionId === definitionId;
}

export function PlanPanel({ api }: { api?: PlanPanelApi }) {
  const currentApi = useRef(api);
  currentApi.current = api;
  const [enrollments, setEnrollments] = useState<PlanEnrollment[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [retainedDefinitions, setRetainedDefinitions] = useState<PlanDefinitionVersion[] | null>(null);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState('');
  const [definitionListError, setDefinitionListError] = useState('');
  const [definitionListAttempt, setDefinitionListAttempt] = useState(0);
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
  const [registeringMcheyne, setRegisteringMcheyne] = useState(false);
  const [mcheyneResult, setMcheyneResult] = useState<{ version?: PlanDefinitionVersion; message?: string } | null>(null);
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
  const [importedChoices, setImportedChoices] = useState<StreamEnrollment[]>([]);
  const [enrollingImported, setEnrollingImported] = useState(false);
  const [importedEnrollment, setImportedEnrollment] = useState<PlanEnrollment | null>(null);
  const [importedEnrollError, setImportedEnrollError] = useState('');
  const [exportingVersionId, setExportingVersionId] = useState('');
  const [exportError, setExportError] = useState<{ versionId: string; message: string } | null>(null);
  const [exportedJson, setExportedJson] = useState<{ versionId: string; json: string } | null>(null);
  const [retainedExportingVersionId, setRetainedExportingVersionId] = useState('');
  const [retainedExportError, setRetainedExportError] = useState<{ versionId: string; message: string } | null>(null);
  const [retainedExportedJson, setRetainedExportedJson] = useState<{ versionId: string; json: string } | null>(null);
  const [retainedEnrollmentChoices, setRetainedEnrollmentChoices] = useState<StreamEnrollment[]>([]);
  const [enrollingRetained, setEnrollingRetained] = useState(false);
  const [retainedEnrollmentResult, setRetainedEnrollmentResult] = useState<{ definitionId: string; enrollment?: PlanEnrollment; message?: string } | null>(null);
  const [calendarChoiceDefinitionId, setCalendarChoiceDefinitionId] = useState('');
  const [calendarStartDate, setCalendarStartDate] = useState(localToday);
  const [calendarScheduleMode, setCalendarScheduleMode] = useState<CalendarScheduleMode>('calendarAligned');
  const [enrollingCalendar, setEnrollingCalendar] = useState(false);
  const [calendarEnrollmentResult, setCalendarEnrollmentResult] = useState<{ definitionId: string; enrollment?: CalendarPlanEnrollment; message?: string } | null>(null);
  const [calendarEnrollments, setCalendarEnrollments] = useState<CalendarRead<CalendarPlanEnrollment> | null>(null);
  const [selectedCalendarEnrollmentId, setSelectedCalendarEnrollmentId] = useState('');
  const [calendarEnrollmentAttempt, setCalendarEnrollmentAttempt] = useState(0);
  const [calendarAssignments, setCalendarAssignments] = useState<CalendarRead<DatedPlanAssignment> | null>(null);
  const [calendarAssignmentAttempt, setCalendarAssignmentAttempt] = useState(0);
  const [calendarHistory, setCalendarHistory] = useState<CalendarRead<CalendarAssignmentCompletion> | null>(null);
  const [calendarHistoryAttempt, setCalendarHistoryAttempt] = useState(0);
  const [completingCalendarId, setCompletingCalendarId] = useState('');
  const [calendarCompletionError, setCalendarCompletionError] = useState('');
  const [undoingCalendarId, setUndoingCalendarId] = useState('');
  const [calendarUndoError, setCalendarUndoError] = useState('');
  const [versionEditTarget, setVersionEditTarget] = useState<PlanDefinitionVersion | null>(null);
  const [versionEditJson, setVersionEditJson] = useState('');
  const [versionEditing, setVersionEditing] = useState(false);
  const [versionEditError, setVersionEditError] = useState('');
  const [versionEditResult, setVersionEditResult] = useState<PlanDefinitionVersion | null>(null);
  const [adoptionHistory, setAdoptionHistory] = useState<Record<string, PlanAdoptionEvent[]>>({});
  const [adoptingEnrollmentId, setAdoptingEnrollmentId] = useState('');
  const [adoptionMessage, setAdoptionMessage] = useState('');
  const [calendarCutoverDate, setCalendarCutoverDate] = useState('');
  const detailEpoch = useRef(0);
  const historyEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const mcheyneEpoch = useRef(0);
  const completionEpoch = useRef(0);
  const undoEpoch = useRef(0);
  const importEpoch = useRef(0);
  const importedEnrollmentEpoch = useRef(0);
  const exportEpoch = useRef(0);
  const retainedExportLifecycle = useRef<RetainedExportLifecycle>({ epoch: 0, selectedDefinitionId });
  const retainedEnrollmentEpoch = useRef(0);
  const calendarEnrollmentEpoch = useRef(0);
  const calendarDiscoveryEpoch = useRef(0);
  const calendarAssignmentEpoch = useRef(0);
  const calendarHistoryEpoch = useRef(0);
  const calendarCompletionEpoch = useRef(0);
  const calendarUndoEpoch = useRef(0);
  const calendarPendingEpoch = useRef(0);
  const versionEditEpoch = useRef(0);
  const adoptionEpoch = useRef(0);
  const retainedChoiceDefinitionId = useRef('');
  const discoveryEpoch = useRef(0);
  const definitionDiscoveryEpoch = useRef(0);
  const confirmedEnrollment = useRef<PlanEnrollment | null>(null);
  const confirmedDefinitions = useRef(new Map<string, PlanDefinitionVersion>());
  const readyDefinitions = useRef<PlanDefinitionVersion[] | null>(null);
  const confirmedCompletions = useRef(new Map<string, string>());
  const confirmedUndos = useRef(new Map<string, string>());
  const confirmedCalendarUndos = useRef(new Map<string, string>());
  const readyCalendarHistory = useRef(new Map<string, CalendarAssignmentCompletion[]>());
  const readyDetails = useRef(new Map<string, ReadyPlanDetails>());
  const readyHistory = useRef(new Map<string, ReadyPlanHistory>());
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedCalendarEnrollmentIdRef = useRef(selectedCalendarEnrollmentId);
  selectedCalendarEnrollmentIdRef.current = selectedCalendarEnrollmentId;
  const streamEnrollments = useMemo(() => enrollments !== null && calendarEnrollments?.kind === 'ready'
    ? enrollments.filter(enrollment => !calendarEnrollments.items.some(calendar => calendar.id === enrollment.id))
    : null, [calendarEnrollments, enrollments]);

  useEffect(() => {
    if (!api?.planAdoptionHistory || !enrollments) return;
    let active = true;
    Promise.all(enrollments.map(async enrollment => [enrollment.id, await api.planAdoptionHistory!(enrollment.id)] as const))
      .then(rows => { if (active) setAdoptionHistory(Object.fromEntries(rows)); })
      .catch(error => { if (active) setAdoptionMessage(`Could not load adoption history: ${String(error)}`); });
    return () => { active = false; };
  }, [api, enrollments, detailAttempt, calendarAssignmentAttempt]);

  useEffect(() => () => {
    if (currentApi.current === api) currentApi.current = undefined;
    actionEpoch.current += 1;
    mcheyneEpoch.current += 1;
    completionEpoch.current += 1;
    undoEpoch.current += 1;
    importEpoch.current += 1;
    importedEnrollmentEpoch.current += 1;
    exportEpoch.current += 1;
    retainedExportLifecycle.current.epoch += 1;
    retainedEnrollmentEpoch.current += 1;
    calendarEnrollmentEpoch.current += 1;
    calendarDiscoveryEpoch.current += 1;
    calendarAssignmentEpoch.current += 1;
    calendarHistoryEpoch.current += 1;
    calendarCompletionEpoch.current += 1;
    calendarUndoEpoch.current += 1;
    calendarPendingEpoch.current = 0;
    versionEditEpoch.current += 1;
    adoptionEpoch.current += 1;
    retainedChoiceDefinitionId.current = '';
    definitionDiscoveryEpoch.current += 1;
    confirmedEnrollment.current = null;
    confirmedDefinitions.current.clear();
    readyDefinitions.current = null;
    confirmedCompletions.current.clear();
    confirmedUndos.current.clear();
    confirmedCalendarUndos.current.clear();
    readyCalendarHistory.current.clear();
    readyDetails.current.clear();
    readyHistory.current.clear();
  }, [api]);

  useEffect(() => {
    setEnrollingRetained(false);
    setRetainedEnrollmentResult(null);
    setEnrollingCalendar(false);
    setCalendarEnrollmentResult(null);
    setCalendarEnrollments(null);
    setSelectedCalendarEnrollmentId('');
    setCalendarAssignments(null);
    setCalendarHistory(null);
    setCompletingCalendarId('');
    setCalendarCompletionError('');
    setUndoingCalendarId('');
    setCalendarUndoError('');
    setVersionEditTarget(null);
    setVersionEditJson('');
    setVersionEditing(false);
    setVersionEditError('');
    setVersionEditResult(null);
  }, [api]);

  useEffect(() => {
    if (!api || enrollments === null) return;
    let active = true;
    const epoch = ++calendarDiscoveryEpoch.current;
    setCalendarEnrollments({ kind: 'loading' });
    Promise.all(enrollments.map(enrollment => api.getCalendarPlanEnrollment(enrollment.id))).then(values => {
      if (!active || epoch !== calendarDiscoveryEpoch.current) return;
      const items = values.filter((value): value is CalendarPlanEnrollment => value !== null);
      setCalendarEnrollments({ kind: 'ready', items });
      setSelectedCalendarEnrollmentId(current => items.some(item => item.id === current) ? current : (items[0]?.id ?? ''));
    }).catch(error => {
      if (active && epoch === calendarDiscoveryEpoch.current) setCalendarEnrollments({ kind: 'error', message: String(error) });
    });
    return () => { active = false; };
  }, [api, enrollments, calendarEnrollmentAttempt]);

  useEffect(() => {
    if (streamEnrollments === null) return;
    setSelectedId(current => streamEnrollments.some(enrollment => enrollment.id === current)
      ? current
      : (streamEnrollments[0]?.id ?? ''));
  }, [streamEnrollments]);

  useEffect(() => {
    if (!api || !selectedCalendarEnrollmentId) { setCalendarAssignments(null); return; }
    let active = true;
    const enrollmentId = selectedCalendarEnrollmentId;
    const epoch = ++calendarAssignmentEpoch.current;
    setCalendarAssignments({ kind: 'loading' });
    api.calendarPlanAssignments(enrollmentId).then(items => {
      if (active && epoch === calendarAssignmentEpoch.current && selectedCalendarEnrollmentId === enrollmentId) setCalendarAssignments({ kind: 'ready', items });
    }).catch(error => {
      if (active && epoch === calendarAssignmentEpoch.current && selectedCalendarEnrollmentId === enrollmentId) setCalendarAssignments({ kind: 'error', message: String(error) });
    });
    return () => { active = false; };
  }, [api, selectedCalendarEnrollmentId, calendarAssignmentAttempt]);

  useEffect(() => {
    if (!api || !selectedCalendarEnrollmentId) { setCalendarHistory(null); return; }
    let active = true;
    const enrollmentId = selectedCalendarEnrollmentId;
    const epoch = ++calendarHistoryEpoch.current;
    setCalendarHistory({ kind: 'loading' });
    api.calendarCompletionHistory(enrollmentId).then(items => {
      if (!active || epoch !== calendarHistoryEpoch.current || selectedCalendarEnrollmentId !== enrollmentId) return;
      const visible = items.map(item => confirmedCalendarUndos.current.get(item.id) === enrollmentId ? { ...item, undone: true } : item);
      for (const item of items) if (item.undone && confirmedCalendarUndos.current.get(item.id) === enrollmentId) confirmedCalendarUndos.current.delete(item.id);
      readyCalendarHistory.current.set(enrollmentId, visible);
      setCalendarHistory({ kind: 'ready', items: visible });
    }).catch(error => {
      if (active && epoch === calendarHistoryEpoch.current && selectedCalendarEnrollmentId === enrollmentId) setCalendarHistory({ kind: 'error', message: String(error), items: readyCalendarHistory.current.get(enrollmentId) });
    });
    return () => { active = false; };
  }, [api, selectedCalendarEnrollmentId, calendarHistoryAttempt]);

  async function completeCalendar(assignment: DatedPlanAssignment) {
    if (!api || completingCalendarId || undoingCalendarId) return;
    const enrollmentId = selectedCalendarEnrollmentId;
    const epoch = ++calendarCompletionEpoch.current;
    setCompletingCalendarId(assignment.id);
    setCalendarCompletionError('');
    try {
      await api.completeCalendarAssignment({ enrollmentId, assignmentId: assignment.id });
      if (epoch !== calendarCompletionEpoch.current || selectedCalendarEnrollmentId !== enrollmentId) return;
      setCompletingCalendarId('');
      setCalendarHistoryAttempt(value => value + 1);
    } catch (error) {
      if (epoch === calendarCompletionEpoch.current && selectedCalendarEnrollmentId === enrollmentId) {
        setCompletingCalendarId('');
        setCalendarCompletionError(String(error));
      }
    }
  }

  async function undoCalendar(completion: CalendarAssignmentCompletion) {
    if (!api || completingCalendarId || undoingCalendarId || completion.undone) return;
    const enrollmentId = selectedCalendarEnrollmentId;
    const epoch = ++calendarUndoEpoch.current;
    setUndoingCalendarId(completion.id);
    setCalendarUndoError('');
    try {
      await api.undoCalendarCompletion({ enrollmentId, assignmentId: completion.assignmentId, completionId: completion.id });
      if (currentApi.current !== api) return;
      confirmedCalendarUndos.current.set(completion.id, enrollmentId);
      const reconcile = (items: CalendarAssignmentCompletion[]) => items.map(item => item.id === completion.id ? { ...item, undone: true } : item);
      readyCalendarHistory.current.set(enrollmentId, reconcile(readyCalendarHistory.current.get(enrollmentId) ?? []));
      if (selectedCalendarEnrollmentIdRef.current === enrollmentId) {
        setCalendarHistory(current => {
          if (current?.kind === 'ready') return { kind: 'ready', items: reconcile(current.items) };
          if (current?.kind === 'error' && current.items) return { ...current, items: reconcile(current.items) };
          return current;
        });
      }
      if (epoch !== calendarUndoEpoch.current || selectedCalendarEnrollmentId !== enrollmentId) return;
      setUndoingCalendarId('');
      setCalendarHistoryAttempt(value => value + 1);
    } catch (error) {
      if (epoch === calendarUndoEpoch.current && selectedCalendarEnrollmentId === enrollmentId) {
        setUndoingCalendarId('');
        setCalendarUndoError(confirmedCalendarUndos.current.get(completion.id) === enrollmentId ? '' : String(error));
      }
    }
  }

  function selectRetainedDefinition(id: string) {
    if (!selectRetainedExportDefinition(retainedExportLifecycle.current, id)) return;
    calendarEnrollmentEpoch.current += 1;
    setCalendarEnrollmentResult(null);
    setRetainedExportingVersionId('');
    setRetainedExportError(null);
    setRetainedExportedJson(null);
    setSelectedDefinitionId(id);
  }

  useEffect(() => {
    retainedExportLifecycle.current.epoch += 1;
    setRetainedExportingVersionId('');
    setRetainedExportError(null);
    setRetainedExportedJson(null);
  }, [api]);

  useEffect(() => {
    exportEpoch.current += 1;
    setExportingVersionId('');
    setExportError(null);
    setExportedJson(null);
  }, [selectedId]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const epoch = ++definitionDiscoveryEpoch.current;
    setRetainedDefinitions(readyDefinitions.current); setDefinitionListError('');
    api.listLatestPlanDefinitionVersions().then(items => {
      if (!active || epoch !== definitionDiscoveryEpoch.current) return;
      const visible = mergeConfirmedDefinitions(items, confirmedDefinitions.current);
      readyDefinitions.current = visible;
      setRetainedDefinitions(visible);
      selectRetainedDefinition(visible.some(item => item.id === retainedExportLifecycle.current.selectedDefinitionId)
        ? retainedExportLifecycle.current.selectedDefinitionId
        : (visible[0]?.id ?? ''));
    }).catch(error => {
      if (!active || epoch !== definitionDiscoveryEpoch.current) return;
      setRetainedDefinitions(readyDefinitions.current ?? []);
      setDefinitionListError(String(error));
    });
    return () => { active = false; };
  }, [api, definitionListAttempt]);

  async function refreshDefinitionsAfterWrite(version: PlanDefinitionVersion) {
    if (!api) return;
    const previousDefinitions = readyDefinitions.current;
    confirmedDefinitions.current.set(version.planId, version);
    setDefinitionListError('');
    setRetainedDefinitions(current => {
      const visible = mergeConfirmedDefinitions(current ?? readyDefinitions.current ?? [], confirmedDefinitions.current, false);
      readyDefinitions.current = visible;
      return visible;
    });
    const selectedPlanId = previousDefinitions?.find(item => item.id === retainedExportLifecycle.current.selectedDefinitionId)?.planId;
    selectRetainedDefinition(!retainedExportLifecycle.current.selectedDefinitionId || selectedPlanId === version.planId
      ? version.id
      : retainedExportLifecycle.current.selectedDefinitionId);
    const epoch = ++definitionDiscoveryEpoch.current;
    try {
      const items = await api.listLatestPlanDefinitionVersions();
      if (epoch !== definitionDiscoveryEpoch.current) return;
      const visible = mergeConfirmedDefinitions(items, confirmedDefinitions.current);
      readyDefinitions.current = visible;
      setRetainedDefinitions(visible);
      selectRetainedDefinition(visible.some(item => item.id === retainedExportLifecycle.current.selectedDefinitionId)
        ? retainedExportLifecycle.current.selectedDefinitionId
        : (visible[0]?.id ?? ''));
    } catch (error) {
      if (epoch !== definitionDiscoveryEpoch.current) return;
      setDefinitionListError(`Retained definitions could not be refreshed after the confirmed write: ${String(error)}`);
    }
  }

  function beginVersionEdit(version: PlanDefinitionVersion) {
    if (versionEditing) return;
    versionEditEpoch.current += 1;
    setVersionEditTarget(version);
    setVersionEditJson(JSON.stringify(version.definition, null, 2));
    setVersionEditError('');
    setVersionEditResult(null);
  }

  async function appendEditedVersion() {
    if (!api || !versionEditTarget || versionEditing || !versionEditJson.trim()) return;
    const target = versionEditTarget;
    const submitted = versionEditJson;
    let definition: PlanDefinition;
    try {
      definition = JSON.parse(submitted) as PlanDefinition;
    } catch (error) {
      setVersionEditError(`Could not parse edited plan JSON: ${String(error)}`);
      return;
    }
    const epoch = ++versionEditEpoch.current;
    setVersionEditing(true);
    setVersionEditError('');
    try {
      const version = await api.createPlanDefinitionVersion(target.planId, definition);
      if (epoch !== versionEditEpoch.current) return;
      setVersionEditResult(version);
      void refreshDefinitionsAfterWrite(version);
    } catch (error) {
      if (epoch === versionEditEpoch.current) setVersionEditError(`Could not append plan version: ${String(error)}`);
    } finally {
      if (epoch === versionEditEpoch.current) setVersionEditing(false);
    }
  }

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
    const enrollment = streamEnrollments?.find(item => item.id === selectedId);
    if (!api || !enrollment) { setDetails(null); return; }
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
  }, [api, detailAttempt, selectedId, streamEnrollments]);

  useEffect(() => {
    const enrollment = streamEnrollments?.find(item => item.id === selectedId);
    if (!api || !enrollment) { setHistory(null); return; }
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
  }, [api, historyAttempt, selectedId, streamEnrollments]);

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
      void refreshDefinitionsAfterWrite(version);
    } catch (error) {
      if (epoch === actionEpoch.current) setOfferError(`Could not prepare four-stream enrollment: ${String(error)}`);
    } finally {
      if (epoch === actionEpoch.current) setPreparing(false);
    }
  }

  async function registerMcheyne() {
    if (!api || registeringMcheyne) return;
    const epoch = ++mcheyneEpoch.current;
    setRegisteringMcheyne(true);
    setMcheyneResult(null);
    try {
      const version = await api.registerMcheynePlan();
      if (epoch !== mcheyneEpoch.current) return;
      if (version.definition.schedule.kind !== 'explicitSchedule') {
        throw new Error('The native M’Cheyne definition is unavailable.');
      }
      setMcheyneResult({ version });
      void refreshDefinitionsAfterWrite(version);
    } catch (error) {
      if (epoch === mcheyneEpoch.current) setMcheyneResult({ message: `Could not register M’Cheyne plan: ${String(error)}` });
    } finally {
      if (epoch === mcheyneEpoch.current) setRegisteringMcheyne(false);
    }
  }

  async function enroll() {
    if (!api || !offer || enrolling || preparing || enrollingImported || enrollingRetained) return;
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
    if (!api || importing || enrollingImported || enrollingRetained || !customPlanJson.trim()) return;
    const epoch = ++importEpoch.current;
    const submitted = customPlanJson;
    setImporting(true); setImportError('');
    try {
      const version = await api.importPlanDefinitionJson(submitted);
      if (epoch !== importEpoch.current) return;
      setImported(version);
      setImportedEnrollment(null); setImportedEnrollError('');
      setImportedChoices(version.definition.schedule.kind === 'chapterStreams'
        ? version.definition.schedule.streams.map(stream => ({ streamId: stream.id, startingPosition: 0, loopAfterEnd: true }))
        : []);
      setCustomPlanJson(current => current === submitted ? '' : current);
      void refreshDefinitionsAfterWrite(version);
    } catch (error) {
      if (epoch === importEpoch.current) setImportError(`Could not import custom plan: ${String(error)}`);
    } finally {
      if (epoch === importEpoch.current) setImporting(false);
    }
  }

  async function enrollImportedPlan() {
    if (!api || !imported || importing || enrolling || enrollingImported || enrollingRetained) return;
    const schedule = imported.definition.schedule;
    if (schedule.kind !== 'chapterStreams') return;
    const version = imported;
    const submitted = importedChoices.map(choice => ({ ...choice }));
    if (submitted.length !== schedule.streams.length) return;
    const epoch = ++importedEnrollmentEpoch.current;
    setEnrollingImported(true); setImportedEnrollError('');
    try {
      const enrollment = await api.enrollInChapterStreams(version.id, submitted);
      if (epoch !== importedEnrollmentEpoch.current) return;
      confirmedEnrollment.current = enrollment;
      setImportedEnrollment(enrollment);
      setEnrollments(current => current?.some(item => item.id === enrollment.id) ? current : [...(current ?? []), enrollment]);
      setSelectedId(enrollment.id);
      const refreshEpoch = ++discoveryEpoch.current;
      try {
        const refreshed = await api.listPlanEnrollments();
        if (epoch !== importedEnrollmentEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setListError('');
        setEnrollments(refreshed.some(item => item.id === enrollment.id) ? refreshed : [...refreshed, enrollment]);
        setSelectedId(enrollment.id);
        if (refreshed.some(item => item.id === enrollment.id)) confirmedEnrollment.current = null;
        else setImportedEnrollError('Custom-plan enrollment was created, but discovery did not return it yet.');
      } catch (error) {
        if (epoch !== importedEnrollmentEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setImportedEnrollError(`Custom-plan enrollment was created, but retained plans could not be refreshed: ${String(error)}`);
      }
    } catch (error) {
      if (epoch === importedEnrollmentEpoch.current) setImportedEnrollError(`Could not create custom-plan enrollment: ${String(error)}`);
    } finally {
      if (epoch === importedEnrollmentEpoch.current) setEnrollingImported(false);
    }
  }

  async function enrollSelectedRetainedDefinition(definition: PlanDefinitionVersion) {
    if (!api || definition.definition.schedule.kind !== 'chapterStreams' || enrolling || enrollingImported || enrollingRetained) return;
    const submitted = updateStreamEnrollmentChoice(
      definition.definition.schedule.streams,
      retainedChoiceDefinitionId.current === definition.id ? retainedEnrollmentChoices : [],
      -1,
      {},
    );
    if (submitted.length !== definition.definition.schedule.streams.length) return;
    const epoch = ++retainedEnrollmentEpoch.current;
    setEnrollingRetained(true);
    setRetainedEnrollmentResult(current => current?.definitionId === definition.id ? null : current);
    try {
      const enrollment = await api.enrollInChapterStreams(definition.id, submitted);
      if (epoch !== retainedEnrollmentEpoch.current) return;
      confirmedEnrollment.current = enrollment;
      setRetainedEnrollmentResult({ definitionId: definition.id, enrollment });
      setEnrollments(current => current?.some(item => item.id === enrollment.id) ? current : [...(current ?? []), enrollment]);
      setSelectedId(enrollment.id);
      const refreshEpoch = ++discoveryEpoch.current;
      try {
        const refreshed = await api.listPlanEnrollments();
        if (epoch !== retainedEnrollmentEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setListError('');
        setEnrollments(refreshed.some(item => item.id === enrollment.id) ? refreshed : [...refreshed, enrollment]);
        setSelectedId(enrollment.id);
        if (refreshed.some(item => item.id === enrollment.id)) confirmedEnrollment.current = null;
        else setRetainedEnrollmentResult({ definitionId: definition.id, enrollment, message: 'Retained-plan enrollment was created, but discovery did not return it yet.' });
      } catch (error) {
        if (epoch !== retainedEnrollmentEpoch.current || refreshEpoch !== discoveryEpoch.current) return;
        setRetainedEnrollmentResult({ definitionId: definition.id, enrollment, message: `Retained-plan enrollment was created, but retained plans could not be refreshed: ${String(error)}` });
      }
    } catch (error) {
      if (epoch === retainedEnrollmentEpoch.current) setRetainedEnrollmentResult({ definitionId: definition.id, message: `Could not create retained-plan enrollment: ${String(error)}` });
    } finally {
      if (epoch === retainedEnrollmentEpoch.current) setEnrollingRetained(false);
    }
  }

  async function enrollSelectedCalendarDefinition(definition: PlanDefinitionVersion) {
    if (!api || definition.definition.schedule.kind !== 'explicitSchedule' || enrollingCalendar || enrolling || enrollingImported || enrollingRetained) return;
    const request: CalendarEnrollmentRequest = {
      definitionVersionId: definition.id,
      startDate: calendarChoiceDefinitionId === definition.id ? calendarStartDate : localToday(),
      scheduleMode: calendarChoiceDefinitionId === definition.id && supportsCalendarAlignment(definition)
        ? calendarScheduleMode
        : defaultCalendarScheduleMode(definition),
    };
    if (!request.startDate) return;
    const epoch = ++calendarEnrollmentEpoch.current;
    calendarPendingEpoch.current = epoch;
    setEnrollingCalendar(true);
    setCalendarEnrollmentResult(null);
    try {
      const enrollment = await api.enrollInCalendar(request);
      if (epoch !== calendarEnrollmentEpoch.current || retainedExportLifecycle.current.selectedDefinitionId !== definition.id) return;
      confirmedEnrollment.current = enrollment;
      setEnrollments(current => current?.some(item => item.id === enrollment.id) ? current : [...(current ?? []), enrollment]);
      setSelectedCalendarEnrollmentId(enrollment.id);
      setAttempt(value => value + 1);
      setCalendarEnrollmentResult({ definitionId: definition.id, enrollment });
    } catch (error) {
      if (epoch === calendarEnrollmentEpoch.current && retainedExportLifecycle.current.selectedDefinitionId === definition.id) {
        setCalendarEnrollmentResult({ definitionId: definition.id, message: `Could not create calendar enrollment: ${String(error)}` });
      }
    } finally {
      if (calendarPendingEpoch.current === epoch) {
        calendarPendingEpoch.current = 0;
        setEnrollingCalendar(false);
      }
    }
  }

  async function exportDefinition(definition: PlanDefinitionVersion, enrollmentId?: string) {
    if (!api || exportingVersionId) return;
    const epoch = ++exportEpoch.current;
    setExportingVersionId(definition.id); setExportError(null);
    try {
      const json = await api.exportPlanDefinitionJson(definition.id);
      if (epoch !== exportEpoch.current || (enrollmentId && selectedIdRef.current !== enrollmentId)) return;
      setExportedJson({ versionId: definition.id, json });
    } catch (error) {
      if (epoch === exportEpoch.current && (!enrollmentId || selectedIdRef.current === enrollmentId)) setExportError({ versionId: definition.id, message: `Could not export selected plan JSON: ${String(error)}` });
    } finally {
      if (epoch === exportEpoch.current && (!enrollmentId || selectedIdRef.current === enrollmentId)) setExportingVersionId('');
    }
  }

  async function exportSelectedRetainedDefinition(definition: PlanDefinitionVersion) {
    if (!api || retainedExportingVersionId) return;
    const epoch = startRetainedExport(retainedExportLifecycle.current);
    setRetainedExportingVersionId(definition.id); setRetainedExportError(null);
    try {
      const json = await api.exportPlanDefinitionJson(definition.id);
      if (!ownsRetainedExport(retainedExportLifecycle.current, epoch, definition.id)) return;
      setRetainedExportedJson({ versionId: definition.id, json });
    } catch (error) {
      if (ownsRetainedExport(retainedExportLifecycle.current, epoch, definition.id)) setRetainedExportError({ versionId: definition.id, message: `Could not export retained plan JSON: ${String(error)}` });
    } finally {
      if (ownsRetainedExport(retainedExportLifecycle.current, epoch, definition.id)) setRetainedExportingVersionId('');
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
  const selectedDefinition = retainedDefinitions?.find(item => item.id === selectedDefinitionId);
  const visibleCalendarStartDate = selectedDefinition && calendarChoiceDefinitionId === selectedDefinition.id ? calendarStartDate : localToday();
  const visibleCalendarScheduleMode = selectedDefinition && calendarChoiceDefinitionId === selectedDefinition.id && supportsCalendarAlignment(selectedDefinition)
    ? calendarScheduleMode
    : selectedDefinition && selectedDefinition.definition.schedule.kind === 'explicitSchedule'
      ? defaultCalendarScheduleMode(selectedDefinition)
      : 'dayOne';
  function updateCalendarChoice(definition: PlanDefinitionVersion, update: { startDate?: string; scheduleMode?: CalendarScheduleMode }) {
    const definitionId = definition.id;
    if (calendarChoiceDefinitionId !== definitionId) setCalendarChoiceDefinitionId(definitionId);
    if (update.startDate !== undefined) setCalendarStartDate(update.startDate);
    else if (calendarChoiceDefinitionId !== definitionId) setCalendarStartDate(localToday());
    if (update.scheduleMode !== undefined) setCalendarScheduleMode(supportsCalendarAlignment(definition) ? update.scheduleMode : 'dayOne');
    else if (calendarChoiceDefinitionId !== definitionId) setCalendarScheduleMode(defaultCalendarScheduleMode(definition));
  }
  const visibleRetainedEnrollmentChoices = selectedDefinition?.definition.schedule.kind === 'chapterStreams'
    ? updateStreamEnrollmentChoice(
      selectedDefinition.definition.schedule.streams,
      retainedChoiceDefinitionId.current === selectedDefinition.id ? retainedEnrollmentChoices : [],
      -1,
      {},
    )
      : [];
  const activeStreamEnrollment = streamEnrollments?.find(item => item.id === selectedId);
  const streamAdoptionTarget = activeStreamEnrollment && details?.kind === 'ready'
    ? retainedDefinitions?.find(item => item.planId === details.definition.planId && item.id !== effectiveVersionId(activeStreamEnrollment) && item.version > details.definition.version && item.definition.schedule.kind === 'chapterStreams')
    : undefined;
  function updateRetainedEnrollmentChoice(index: number, update: Partial<Pick<StreamEnrollment, 'startingPosition' | 'loopAfterEnd'>>) {
    if (!selectedDefinition || selectedDefinition.definition.schedule.kind !== 'chapterStreams') return;
    const streams = selectedDefinition.definition.schedule.streams;
    const sameDefinition = retainedChoiceDefinitionId.current === selectedDefinition.id;
    retainedChoiceDefinitionId.current = selectedDefinition.id;
    setRetainedEnrollmentChoices(current => updateStreamEnrollmentChoice(
      streams,
      sameDefinition ? current : [],
      index,
      update,
    ));
  }

  function effectiveVersionId(enrollment: PlanEnrollment) {
    const events = adoptionHistory[enrollment.id] ?? [];
    return events.at(-1)?.targetDefinitionVersionId ?? enrollment.definitionVersionId;
  }

  async function adoptSelectedStreamEnrollment(enrollment: PlanEnrollment, current: ReadyPlanDetails, target: PlanDefinitionVersion) {
    if (!api?.adoptChapterStreamPlan || adoptingEnrollmentId) return;
    const epoch = ++adoptionEpoch.current;
    setAdoptingEnrollmentId(enrollment.id); setAdoptionMessage('');
    try {
      const event = await api.adoptChapterStreamPlan({
        enrollmentId: enrollment.id,
        expectedDefinitionVersionId: effectiveVersionId(enrollment),
        targetDefinitionVersionId: target.id,
        streams: current.assignments.map(item => ({ streamId: item.streamId, assignmentId: item.id, progressId: item.progressId })),
      });
      if (epoch !== adoptionEpoch.current || selectedIdRef.current !== enrollment.id) return;
      setAdoptionHistory(value => ({ ...value, [enrollment.id]: [...(value[enrollment.id] ?? []), event] }));
      setAdoptionMessage(`Adopted definition version ${event.targetDefinitionVersionId} for future stream assignments.`);
      setDetailAttempt(value => value + 1);
    } catch (error) { if (epoch === adoptionEpoch.current && selectedIdRef.current === enrollment.id) setAdoptionMessage(`Could not adopt plan version: ${String(error)}`); }
    finally { if (epoch === adoptionEpoch.current) setAdoptingEnrollmentId(''); }
  }

  async function adoptSelectedCalendarEnrollment() {
    if (!api?.adoptCalendarPlan || adoptingEnrollmentId || !selectedDefinition || selectedDefinition.definition.schedule.kind !== 'explicitSchedule') return;
    const enrollment = calendarEnrollments?.kind === 'ready' ? calendarEnrollments.items.find(item => item.id === selectedCalendarEnrollmentId) : undefined;
    const assignment = calendarAssignments?.kind === 'ready' ? calendarAssignments.items.find(item => item.localDate === calendarCutoverDate) : undefined;
    if (!enrollment || !assignment) { setAdoptionMessage('Choose an active dated assignment as the adoption cutover.'); return; }
    const epoch = ++adoptionEpoch.current;
    setAdoptingEnrollmentId(enrollment.id); setAdoptionMessage('');
    try {
      const event = await api.adoptCalendarPlan({ enrollmentId: enrollment.id, expectedDefinitionVersionId: effectiveVersionId(enrollment), targetDefinitionVersionId: selectedDefinition.id, effectiveFromLocalDate: assignment.localDate, expectedAssignmentId: assignment.id });
      if (epoch !== adoptionEpoch.current || selectedCalendarEnrollmentIdRef.current !== enrollment.id) return;
      setAdoptionHistory(value => ({ ...value, [enrollment.id]: [...(value[enrollment.id] ?? []), event] }));
      setAdoptionMessage(`Adopted definition version ${event.targetDefinitionVersionId} from ${assignment.localDate}.`);
      setCalendarAssignmentAttempt(value => value + 1);
    } catch (error) { if (epoch === adoptionEpoch.current && selectedCalendarEnrollmentIdRef.current === enrollment.id) setAdoptionMessage(`Could not adopt calendar version: ${String(error)}`); }
    finally { if (epoch === adoptionEpoch.current) setAdoptingEnrollmentId(''); }
  }
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
        <button disabled={enrolling || enrollingRetained || choices.length !== 4} onClick={() => void enroll()}>{enrolling ? 'Creating enrollment…' : 'Create enrollment'}</button>
      </>}
      {offerError && <div role="alert" className="plan-error">{offerError}</div>}
    </section>
    <section className="plan-enrollment" aria-label="Register M’Cheyne plan">
      <h3>M’Cheyne’s Daily Bible Readings</h3>
      <p>Register the retained 365-day calendar definition. Registration does not enroll you or schedule readings.</p>
      <button disabled={registeringMcheyne} onClick={() => void registerMcheyne()}>{registeringMcheyne ? 'Registering M’Cheyne plan…' : mcheyneResult?.message ? 'Retry M’Cheyne registration' : 'Register M’Cheyne plan'}</button>
      {mcheyneResult?.version && <p role="status">Registered M’Cheyne definition version {mcheyneResult.version.version} for plan {mcheyneResult.version.planId}. Select the retained definition below, then explicitly create a calendar enrollment when ready. Registration does not enroll you or schedule readings.</p>}
      {mcheyneResult?.message && <div role="alert" className="plan-error">{mcheyneResult.message}</div>}
    </section>
    <section className="plan-import" aria-label="Import custom plan">
      <h3>Import custom plan</h3>
      <p>Paste a plan-definition JSON document. Import creates a new plan identity and does not alter retained enrollments.</p>
      <label>Custom plan JSON<textarea value={customPlanJson} onChange={event => setCustomPlanJson(event.target.value)} placeholder='{"schemaVersion":1,...}' spellCheck={false} /></label>
      <button disabled={importing || enrollingImported || enrollingRetained || !customPlanJson.trim()} onClick={() => void importCustomPlan()}>{importing ? 'Importing plan…' : 'Import custom plan'}</button>
      {importError && <div role="alert" className="plan-error">{importError}</div>}
      {imported && <div role="status" className="plan-imported">Imported custom plan <strong>{imported.definition.name}</strong> as a new plan identity. Retained enrollments were not changed.<small>Definition version {imported.id}</small><button disabled={!!exportingVersionId} onClick={() => void exportDefinition(imported)}>{exportingVersionId === imported.id ? 'Exporting imported version JSON…' : exportError?.versionId === imported.id ? 'Retry imported version JSON' : 'Export imported version JSON'}</button>{exportError?.versionId === imported.id && <div role="alert" className="plan-error">{exportError.message}</div>}{exportedJson?.versionId === imported.id && <label>Exported imported plan JSON<textarea readOnly value={exportedJson.json} spellCheck={false} /></label>}
        {imported.definition.schedule.kind === 'explicitSchedule' && <p>This imported calendar plan cannot be enrolled as chapter streams.</p>}
        {imported.definition.schedule.kind === 'chapterStreams' && !importedEnrollment && <section aria-label="Enroll in imported custom plan"><p>Choose the starting occurrence and whether each stream loops, then create an enrollment pinned to this definition version.</p><div className="plan-streams">{imported.definition.schedule.streams.map((stream, index) => <fieldset key={stream.id}>
          <legend>{stream.name}</legend>
          <label>Custom starting chapter<select value={importedChoices[index]?.startingPosition ?? 0} onChange={event => setImportedChoices(current => current.map((choice, choiceIndex) => choiceIndex === index ? { ...choice, startingPosition: Number(event.target.value) } : choice))}>{stream.chapters.map((chapter, position) => <option key={`${chapter.book}:${chapter.chapter}:${position}`} value={position}>Book {chapter.book} · Chapter {chapter.chapter}</option>)}</select></label>
          <label className="plan-loop"><input type="checkbox" checked={importedChoices[index]?.loopAfterEnd ?? true} onChange={event => setImportedChoices(current => current.map((choice, choiceIndex) => choiceIndex === index ? { ...choice, loopAfterEnd: event.target.checked } : choice))} /> Custom stream loops</label>
        </fieldset>)}</div><button disabled={enrollingImported || enrollingRetained || importing || enrolling || importedChoices.length !== imported.definition.schedule.streams.length} onClick={() => void enrollImportedPlan()}>{enrollingImported ? 'Creating custom enrollment…' : 'Create custom enrollment'}</button></section>}
        {importedEnrollment && <p>Custom-plan enrollment {importedEnrollment.id} was created for definition version {importedEnrollment.definitionVersionId}.</p>}
        {importedEnrollError && <div role="alert" className="plan-error">{importedEnrollError}</div>}
      </div>}
    </section>
    <section className="plan-definitions" aria-label="Retained plan definitions">
      <h3>Retained plan definitions</h3>
      <p>Browse the latest immutable version of every retained plan identity. This selection does not change an active enrollment.</p>
      {retainedDefinitions === null && <p role="status">Loading retained plan definitions…</p>}
      {definitionListError && <div role="alert" className="plan-error">Could not load retained plan definitions: {definitionListError}<button onClick={() => setDefinitionListAttempt(value => value + 1)}>Retry retained definitions</button></div>}
      {retainedDefinitions?.length === 0 && !definitionListError && <p>No retained plan definitions yet.</p>}
      {retainedDefinitions && retainedDefinitions.length > 0 && <><label>Retained plan definition<select value={selectedDefinitionId} onChange={event => selectRetainedDefinition(event.target.value)}>{retainedDefinitions.map(definition => <option key={definition.id} value={definition.id}>{definition.definition.name} · plan {definition.planId}</option>)}</select></label>
        {selectedDefinition && <><dl><dt>Name</dt><dd>Retained name: {selectedDefinition.definition.name}</dd><dt>Plan identity</dt><dd>{selectedDefinition.planId}</dd><dt>Definition version</dt><dd>{selectedDefinition.version}</dd><dt>Schedule kind</dt><dd>{selectedDefinition.definition.schedule.kind === 'chapterStreams' ? 'Chapter streams' : 'Explicit schedule'}</dd></dl><section className="plan-export" aria-label="Export selected retained definition"><p>Export this selected retained immutable definition as portable JSON. This does not import, enroll, or modify a plan.</p><button disabled={!!retainedExportingVersionId} onClick={() => void exportSelectedRetainedDefinition(selectedDefinition)}>{retainedExportingVersionId === selectedDefinition.id ? 'Exporting retained definition JSON…' : retainedExportError?.versionId === selectedDefinition.id ? 'Retry retained definition JSON' : 'Export retained definition JSON'}</button>{retainedExportError?.versionId === selectedDefinition.id && <div role="alert" className="plan-error">{retainedExportError.message}</div>}{retainedExportedJson?.versionId === selectedDefinition.id && <label>Exported retained plan JSON<textarea readOnly value={retainedExportedJson.json} spellCheck={false} /></label>}</section><section className="plan-import" aria-label="Append retained plan version"><p>Editing appends a new immutable version. Existing enrollments remain pinned to their current version.</p><button disabled={versionEditing} onClick={() => beginVersionEdit(selectedDefinition)}>Edit selected as new version</button>{versionEditTarget && <><p>Editing plan {versionEditTarget.planId} from definition version {versionEditTarget.version}. Changing the retained selection does not retarget this edit.</p><label>Edited plan JSON<textarea value={versionEditJson} onChange={event => setVersionEditJson(event.target.value)} spellCheck={false} /></label><button disabled={versionEditing || !versionEditJson.trim()} onClick={() => void appendEditedVersion()}>{versionEditing ? 'Appending plan version…' : 'Append new plan version'}</button>{versionEditError && <div role="alert" className="plan-error">{versionEditError}</div>}{versionEditResult && <p role="status">Created immutable definition version {versionEditResult.version} for plan {versionEditResult.planId}. Existing enrollments were not changed.</p>}</>}</section>
          {selectedDefinition.definition.schedule.kind === 'explicitSchedule' && !(calendarEnrollmentResult?.definitionId === selectedDefinition.id && calendarEnrollmentResult.enrollment) && <section aria-label="Enroll in selected retained calendar plan"><p>{supportsCalendarAlignment(selectedDefinition) ? 'Calendar alignment starts at the selected month and day and ends December 31, without earlier backlog. On February 29, it schedules no set so the day is available for catch-up or rest. Start from day one schedules all 365 sets successively from the selected local date and treats February 29 as an ordinary scheduled day.' : `This ${selectedDefinition.definition.schedule.days.length}-set calendar starts from day one on the selected local date. Calendar alignment is available only for an exact 365-day schedule; February 29 is an ordinary scheduled day when this schedule reaches it.`}</p><label>Calendar start date<input type="date" value={visibleCalendarStartDate} onChange={event => updateCalendarChoice(selectedDefinition, { startDate: event.target.value })} /></label><label>Calendar schedule policy<select value={visibleCalendarScheduleMode} onChange={event => updateCalendarChoice(selectedDefinition, { scheduleMode: event.target.value as CalendarScheduleMode })}>{supportsCalendarAlignment(selectedDefinition) && <option value="calendarAligned">Align to the calendar</option>}<option value="dayOne">Start from day one</option></select></label><button disabled={enrollingCalendar || enrolling || enrollingImported || enrollingRetained || !visibleCalendarStartDate} onClick={() => void enrollSelectedCalendarDefinition(selectedDefinition)}>{enrollingCalendar ? 'Creating calendar enrollment…' : calendarEnrollmentResult?.definitionId === selectedDefinition.id && calendarEnrollmentResult.message ? 'Retry calendar enrollment' : 'Create calendar enrollment'}</button>{calendarEnrollmentResult?.definitionId === selectedDefinition.id && calendarEnrollmentResult.message && <div role="alert" className="plan-error">{calendarEnrollmentResult.message}</div>}</section>}
          {calendarEnrollmentResult?.definitionId === selectedDefinition.id && calendarEnrollmentResult.enrollment && <p role="status">Calendar enrollment {calendarEnrollmentResult.enrollment.id} was created for definition version {calendarEnrollmentResult.enrollment.definitionVersionId}, starting {calendarEnrollmentResult.enrollment.startDate} with policy {calendarEnrollmentResult.enrollment.scheduleMode}.</p>}
          {selectedDefinition.definition.schedule.kind === 'chapterStreams' && !(retainedEnrollmentResult?.definitionId === selectedDefinition.id && retainedEnrollmentResult.enrollment) && <section aria-label="Enroll in selected retained plan"><p>Choose the starting occurrence and loop policy for an enrollment pinned to this selected immutable version.</p><div className="plan-streams">{selectedDefinition.definition.schedule.streams.map((stream, index) => <fieldset key={stream.id}><legend>{stream.name}</legend><label>Retained starting chapter<select value={visibleRetainedEnrollmentChoices[index].startingPosition} onChange={event => updateRetainedEnrollmentChoice(index, { startingPosition: Number(event.target.value) })}>{stream.chapters.map((chapter, position) => <option key={`${chapter.book}:${chapter.chapter}:${position}`} value={position}>Book {chapter.book} · Chapter {chapter.chapter}</option>)}</select></label><label className="plan-loop"><input type="checkbox" checked={visibleRetainedEnrollmentChoices[index].loopAfterEnd} onChange={event => updateRetainedEnrollmentChoice(index, { loopAfterEnd: event.target.checked })} /> Retained stream loops</label></fieldset>)}</div><button disabled={enrollingRetained || enrolling || enrollingImported} onClick={() => void enrollSelectedRetainedDefinition(selectedDefinition)}>{enrollingRetained ? 'Creating retained enrollment…' : 'Create retained enrollment'}</button></section>}
          {retainedEnrollmentResult?.definitionId === selectedDefinition.id && retainedEnrollmentResult.enrollment && <p>Retained-plan enrollment {retainedEnrollmentResult.enrollment.id} was created for definition version {retainedEnrollmentResult.enrollment.definitionVersionId}.</p>}
          {retainedEnrollmentResult?.definitionId === selectedDefinition.id && retainedEnrollmentResult.message && <div role="alert" className="plan-error">{retainedEnrollmentResult.message}</div>}
        </>}
      </>}
    </section>
    {enrollments?.length === 0 && <p>No retained plan enrollments yet.</p>}
    {calendarEnrollments?.kind === 'loading' && <p role="status">Loading retained calendar enrollments…</p>}
    {calendarEnrollments?.kind === 'error' && <div role="alert" className="plan-error">Could not load retained calendar enrollments: {calendarEnrollments.message}<button onClick={() => setCalendarEnrollmentAttempt(value => value + 1)}>Retry calendar enrollments</button></div>}
    {calendarEnrollments?.kind === 'ready' && calendarEnrollments.items.length > 0 && <CalendarAssignments items={calendarEnrollments.items} selectedId={selectedCalendarEnrollmentId} assignments={calendarAssignments} history={calendarHistory} completingId={completingCalendarId} completionError={calendarCompletionError} undoingId={undoingCalendarId} undoError={calendarUndoError} onSelect={id => { calendarCompletionEpoch.current += 1; calendarUndoEpoch.current += 1; adoptionEpoch.current += 1; setAdoptingEnrollmentId(''); setAdoptionMessage(''); setCompletingCalendarId(''); setCalendarCompletionError(''); setUndoingCalendarId(''); setCalendarUndoError(''); setSelectedCalendarEnrollmentId(id); }} onRetry={() => setCalendarAssignmentAttempt(value => value + 1)} onRetryHistory={() => setCalendarHistoryAttempt(value => value + 1)} onComplete={assignment => void completeCalendar(assignment)} onUndo={completion => void undoCalendar(completion)} />}
    {api?.adoptCalendarPlan && selectedCalendarEnrollmentId && selectedDefinition?.definition.schedule.kind === 'explicitSchedule' && calendarAssignments?.kind === 'ready' && <section className="plan-enrollment" aria-label="Adopt calendar plan version"><h3>Adopt selected version for future dates</h3><p>Choose the first date to replace. Completed or previously completed dates cannot be replaced; earlier assignments and all history stay retained.</p><label>Calendar adoption cutover<select value={calendarCutoverDate} onChange={event => setCalendarCutoverDate(event.target.value)}><option value="">Choose a date</option>{calendarAssignments.items.map(item => <option key={item.id} value={item.localDate}>{item.localDate} · day {item.definitionDay}</option>)}</select></label><button disabled={!calendarCutoverDate || !!adoptingEnrollmentId} onClick={() => void adoptSelectedCalendarEnrollment()}>{adoptingEnrollmentId === selectedCalendarEnrollmentId ? 'Adopting calendar version…' : 'Adopt selected version from this date'}</button></section>}
    {streamEnrollments && streamEnrollments.length > 0 && <>
      <label>Retained enrollment<select value={selectedId} onChange={event => { adoptionEpoch.current += 1; setAdoptingEnrollmentId(''); setAdoptionMessage(''); setSelectedId(event.target.value); }}>
        {streamEnrollments.map(enrollment => <option key={enrollment.id} value={enrollment.id}>{enrollment.id}</option>)}
      </select></label>
      {details?.kind === 'loading' && <p role="status">Loading current assignments…</p>}
      {details?.kind === 'error' && <div role="alert" className="plan-error">Could not load this retained plan: {details.message}<button onClick={() => setDetailAttempt(value => value + 1)}>Retry selection</button></div>}
      {details?.kind === 'ready' && <section className="plan-details" aria-label="Current plan assignments">
        <h3>{details.definition.definition.name}</h3>
        {activeStreamEnrollment && streamAdoptionTarget && api?.adoptChapterStreamPlan && <section className="plan-enrollment" aria-label="Adopt chapter-stream plan version"><p>Version {streamAdoptionTarget.version} is available. Adoption keeps the displayed assignments and retained history, then uses the newer definition only for assignments first created after this frontier.</p><button disabled={!!adoptingEnrollmentId || details.assignments.length === 0} onClick={() => void adoptSelectedStreamEnrollment(activeStreamEnrollment, details, streamAdoptionTarget)}>{adoptingEnrollmentId === activeStreamEnrollment.id ? 'Adopting plan version…' : `Adopt version ${streamAdoptionTarget.version} for future assignments`}</button></section>}
        <section className="plan-export" aria-label="Export selected plan JSON">
          <p>Export this selected immutable definition version as portable JSON. This does not change plans or enrollments.</p>
          <button disabled={!!exportingVersionId} onClick={() => void exportDefinition(details.definition, selectedId)}>{exportingVersionId === details.definition.id ? 'Exporting selected version JSON…' : exportError?.versionId === details.definition.id ? 'Retry selected version JSON' : 'Export selected version JSON'}</button>
          {exportError?.versionId === details.definition.id && <div role="alert" className="plan-error">{exportError.message}</div>}
          {exportedJson?.versionId === details.definition.id && <label>Exported plan JSON<textarea readOnly value={exportedJson.json} spellCheck={false} /></label>}
        </section>
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
    {adoptionMessage && <div role="alert" className="plan-error">{adoptionMessage}</div>}
  </aside>;
}
