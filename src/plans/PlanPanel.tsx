import { useEffect, useRef, useState } from 'react';
import type { PlanAssignment, PlanCompletionHistoryItem, PlanDefinition, PlanDefinitionVersion, PlanEnrollment, StreamEnrollment } from '../platform/plans';
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
type ChapterStreams = Extract<PlanDefinition['schedule'], { kind: 'chapterStreams' }>['streams'];

type PlanPanelApi = Pick<PlanDefinitionApi, 'listPlanEnrollments' | 'listLatestPlanDefinitionVersions' | 'getPlanDefinitionVersion' | 'activePlanAssignments' | 'planCompletionHistory' | 'registerFourStreamPlan' | 'registerMcheynePlan' | 'importPlanDefinitionJson' | 'createPlanDefinitionVersion' | 'exportPlanDefinitionJson' | 'enrollInChapterStreams' | 'completePlanStream' | 'undoPlanCompletion'>;

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

export function PlanPanel({ api }: { api?: PlanPanelApi }) {
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
  const [versionEditTarget, setVersionEditTarget] = useState<PlanDefinitionVersion | null>(null);
  const [versionEditJson, setVersionEditJson] = useState('');
  const [versionEditing, setVersionEditing] = useState(false);
  const [versionEditError, setVersionEditError] = useState('');
  const [versionEditResult, setVersionEditResult] = useState<PlanDefinitionVersion | null>(null);
  const detailEpoch = useRef(0);
  const historyEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const mcheyneEpoch = useRef(0);
  const completionEpoch = useRef(0);
  const undoEpoch = useRef(0);
  const importEpoch = useRef(0);
  const importedEnrollmentEpoch = useRef(0);
  const exportEpoch = useRef(0);
  const retainedExportEpoch = useRef(0);
  const retainedEnrollmentEpoch = useRef(0);
  const versionEditEpoch = useRef(0);
  const retainedChoiceDefinitionId = useRef('');
  const discoveryEpoch = useRef(0);
  const definitionDiscoveryEpoch = useRef(0);
  const confirmedEnrollment = useRef<PlanEnrollment | null>(null);
  const confirmedDefinitions = useRef(new Map<string, PlanDefinitionVersion>());
  const readyDefinitions = useRef<PlanDefinitionVersion[] | null>(null);
  const confirmedCompletions = useRef(new Map<string, string>());
  const confirmedUndos = useRef(new Map<string, string>());
  const readyDetails = useRef(new Map<string, ReadyPlanDetails>());
  const readyHistory = useRef(new Map<string, ReadyPlanHistory>());
  const selectedIdRef = useRef(selectedId);
  const selectedDefinitionIdRef = useRef(selectedDefinitionId);
  selectedIdRef.current = selectedId;
  selectedDefinitionIdRef.current = selectedDefinitionId;

  useEffect(() => () => {
    actionEpoch.current += 1;
    mcheyneEpoch.current += 1;
    completionEpoch.current += 1;
    undoEpoch.current += 1;
    importEpoch.current += 1;
    importedEnrollmentEpoch.current += 1;
    exportEpoch.current += 1;
    retainedExportEpoch.current += 1;
    retainedEnrollmentEpoch.current += 1;
    versionEditEpoch.current += 1;
    retainedChoiceDefinitionId.current = '';
    definitionDiscoveryEpoch.current += 1;
    confirmedEnrollment.current = null;
    confirmedDefinitions.current.clear();
    readyDefinitions.current = null;
    confirmedCompletions.current.clear();
    confirmedUndos.current.clear();
    readyDetails.current.clear();
    readyHistory.current.clear();
  }, [api]);

  useEffect(() => {
    setEnrollingRetained(false);
    setRetainedEnrollmentResult(null);
    setVersionEditTarget(null);
    setVersionEditJson('');
    setVersionEditing(false);
    setVersionEditError('');
    setVersionEditResult(null);
  }, [api]);

  useEffect(() => {
    retainedExportEpoch.current += 1;
    setRetainedExportingVersionId('');
    setRetainedExportError(null);
    setRetainedExportedJson(null);
  }, [api, selectedDefinitionId]);

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
      setSelectedDefinitionId(current => visible.some(item => item.id === current) ? current : (visible[0]?.id ?? ''));
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
    setSelectedDefinitionId(current => {
      const selectedPlanId = previousDefinitions?.find(item => item.id === current)?.planId;
      return !current || selectedPlanId === version.planId ? version.id : current;
    });
    const epoch = ++definitionDiscoveryEpoch.current;
    try {
      const items = await api.listLatestPlanDefinitionVersions();
      if (epoch !== definitionDiscoveryEpoch.current) return;
      const visible = mergeConfirmedDefinitions(items, confirmedDefinitions.current);
      readyDefinitions.current = visible;
      setRetainedDefinitions(visible);
      setSelectedDefinitionId(current => visible.some(item => item.id === current) ? current : (visible[0]?.id ?? ''));
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
    const epoch = ++retainedExportEpoch.current;
    setRetainedExportingVersionId(definition.id); setRetainedExportError(null);
    try {
      const json = await api.exportPlanDefinitionJson(definition.id);
      if (epoch !== retainedExportEpoch.current || selectedDefinitionIdRef.current !== definition.id) return;
      setRetainedExportedJson({ versionId: definition.id, json });
    } catch (error) {
      if (epoch === retainedExportEpoch.current && selectedDefinitionIdRef.current === definition.id) setRetainedExportError({ versionId: definition.id, message: `Could not export retained plan JSON: ${String(error)}` });
    } finally {
      if (epoch === retainedExportEpoch.current && selectedDefinitionIdRef.current === definition.id) setRetainedExportingVersionId('');
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
  const visibleRetainedEnrollmentChoices = selectedDefinition?.definition.schedule.kind === 'chapterStreams'
    ? updateStreamEnrollmentChoice(
      selectedDefinition.definition.schedule.streams,
      retainedChoiceDefinitionId.current === selectedDefinition.id ? retainedEnrollmentChoices : [],
      -1,
      {},
    )
    : [];
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
      {mcheyneResult?.version && <p role="status">Registered M’Cheyne definition version {mcheyneResult.version.version} for plan {mcheyneResult.version.planId}. Calendar enrollment is not available yet.</p>}
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
      {retainedDefinitions && retainedDefinitions.length > 0 && <><label>Retained plan definition<select value={selectedDefinitionId} onChange={event => setSelectedDefinitionId(event.target.value)}>{retainedDefinitions.map(definition => <option key={definition.id} value={definition.id}>{definition.definition.name} · plan {definition.planId}</option>)}</select></label>
        {selectedDefinition && <><dl><dt>Name</dt><dd>Retained name: {selectedDefinition.definition.name}</dd><dt>Plan identity</dt><dd>{selectedDefinition.planId}</dd><dt>Definition version</dt><dd>{selectedDefinition.version}</dd><dt>Schedule kind</dt><dd>{selectedDefinition.definition.schedule.kind === 'chapterStreams' ? 'Chapter streams' : 'Explicit schedule'}</dd></dl><section className="plan-export" aria-label="Export selected retained definition"><p>Export this selected retained immutable definition as portable JSON. This does not import, enroll, or modify a plan.</p><button disabled={!!retainedExportingVersionId} onClick={() => void exportSelectedRetainedDefinition(selectedDefinition)}>{retainedExportingVersionId === selectedDefinition.id ? 'Exporting retained definition JSON…' : retainedExportError?.versionId === selectedDefinition.id ? 'Retry retained definition JSON' : 'Export retained definition JSON'}</button>{retainedExportError?.versionId === selectedDefinition.id && <div role="alert" className="plan-error">{retainedExportError.message}</div>}{retainedExportedJson?.versionId === selectedDefinition.id && <label>Exported retained plan JSON<textarea readOnly value={retainedExportedJson.json} spellCheck={false} /></label>}</section><section className="plan-import" aria-label="Append retained plan version"><p>Editing appends a new immutable version. Existing enrollments remain pinned to their current version.</p><button disabled={versionEditing} onClick={() => beginVersionEdit(selectedDefinition)}>Edit selected as new version</button>{versionEditTarget && <><p>Editing plan {versionEditTarget.planId} from definition version {versionEditTarget.version}. Changing the retained selection does not retarget this edit.</p><label>Edited plan JSON<textarea value={versionEditJson} onChange={event => setVersionEditJson(event.target.value)} spellCheck={false} /></label><button disabled={versionEditing || !versionEditJson.trim()} onClick={() => void appendEditedVersion()}>{versionEditing ? 'Appending plan version…' : 'Append new plan version'}</button>{versionEditError && <div role="alert" className="plan-error">{versionEditError}</div>}{versionEditResult && <p role="status">Created immutable definition version {versionEditResult.version} for plan {versionEditResult.planId}. Existing enrollments were not changed.</p>}</>}</section>
          {selectedDefinition.definition.schedule.kind === 'explicitSchedule' && <p>This retained calendar plan cannot be enrolled as chapter streams.</p>}
          {selectedDefinition.definition.schedule.kind === 'chapterStreams' && !(retainedEnrollmentResult?.definitionId === selectedDefinition.id && retainedEnrollmentResult.enrollment) && <section aria-label="Enroll in selected retained plan"><p>Choose the starting occurrence and loop policy for an enrollment pinned to this selected immutable version.</p><div className="plan-streams">{selectedDefinition.definition.schedule.streams.map((stream, index) => <fieldset key={stream.id}><legend>{stream.name}</legend><label>Retained starting chapter<select value={visibleRetainedEnrollmentChoices[index].startingPosition} onChange={event => updateRetainedEnrollmentChoice(index, { startingPosition: Number(event.target.value) })}>{stream.chapters.map((chapter, position) => <option key={`${chapter.book}:${chapter.chapter}:${position}`} value={position}>Book {chapter.book} · Chapter {chapter.chapter}</option>)}</select></label><label className="plan-loop"><input type="checkbox" checked={visibleRetainedEnrollmentChoices[index].loopAfterEnd} onChange={event => updateRetainedEnrollmentChoice(index, { loopAfterEnd: event.target.checked })} /> Retained stream loops</label></fieldset>)}</div><button disabled={enrollingRetained || enrolling || enrollingImported} onClick={() => void enrollSelectedRetainedDefinition(selectedDefinition)}>{enrollingRetained ? 'Creating retained enrollment…' : 'Create retained enrollment'}</button></section>}
          {retainedEnrollmentResult?.definitionId === selectedDefinition.id && retainedEnrollmentResult.enrollment && <p>Retained-plan enrollment {retainedEnrollmentResult.enrollment.id} was created for definition version {retainedEnrollmentResult.enrollment.definitionVersionId}.</p>}
          {retainedEnrollmentResult?.definitionId === selectedDefinition.id && retainedEnrollmentResult.message && <div role="alert" className="plan-error">{retainedEnrollmentResult.message}</div>}
        </>}
      </>}
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
  </aside>;
}
