import { api, ApiError } from '../../shared/api/api';
import { Resource } from '../../shared/state/resource.svelte';
import { isCurrentSession, onSessionChange, readUserData, removeUserData, sessionVersion, writeUserData } from '../../shared/state/session';
import { app, handleAuthError } from '../auth/auth-state.svelte';
import { errorText } from '../../shared/api/net.svelte';
import { normalizeCalendar } from './calendar-data';
import { resolveSemesterDisplay } from './semester';
import { todos } from './todo-resource.svelte';
import type { CalendarData, CalendarItem, CalendarState, SemesterDisplay } from '../../shared/types';

const MIN = 60_000;
type Cached = { data: CalendarData; at: number };
type ItemPatch = Partial<Pick<CalendarItem, 'done' | 'doneOverride' | 'alert' | 'alertLeads' | 'status'>>;
let calendarSemesterDisplay: SemesterDisplay = 'current';
let storedDisplay: SemesterDisplay | null = null;
let stateRevision = 0;
let currentResponseRevision = 0;
let schoolReadRevision = 0;
let todosReadRevision = 0;
const schoolRefresh = new Set<SemesterDisplay>();
const stateChanges = new Map<string, { revision: number; patch: ItemPatch }>();
const pending = new Map<SemesterDisplay, { job: Promise<CalendarData>; controller: AbortController }>();
const memory = new Map<SemesterDisplay, Cached>();
const key = (display: SemesterDisplay) => `calendar-${display}`;
const cached = (display: SemesterDisplay) => {
  const data = memory.get(display) ?? (display === 'current' ? readUserData<Cached | null>(key(display), null) : null);
  if (data) memory.set(display, data);
  return data;
};
export const calendarArchive = $state({ loading: false, updating: false, ready: false, error: '', updatedAt: 0 });
let archiveJob: Promise<CalendarData> | null = null;

async function withCalendarTodos<T>(job: Promise<T>, force = false): Promise<T> {
  const version = sessionVersion();
  try { return await job; }
  finally {
    if (isCurrentSession(version)) {
      const changed = schoolReadRevision !== todosReadRevision;
      todosReadRevision = schoolReadRevision;
      await (changed ? todos.refresh() : todos.load(force));
    }
  }
}

function currentData(data: CalendarData): CalendarData | null {
  if (!data.currentTerm) return null;
  const courses = data.courses.filter((course) => course.term?.year === data.currentTerm!.year
    && course.term?.semester === data.currentTerm!.semester);
  const ids = new Set(courses.map((course) => course.id));
  return { ...data, semesterDisplay: 'current', courses, items: data.items.filter((item) => ids.has(item.courseId)),
    failedCourseIds: data.failedCourseIds?.filter((id) => ids.has(id)) };
}

function save(display: SemesterDisplay, value: Cached) {
  const previous = cached(display);
  if (previous?.at === value.at && JSON.stringify(previous.data) === JSON.stringify(value.data)) return;
  if (display === 'all' && calendarSemesterDisplay !== 'all') return;
  memory.set(display, value);
  if (display === 'current') writeUserData(key(display), value);
}

function store(data: CalendarData, at: number, preserveCurrent = false) {
  const previous = cached(data.semesterDisplay);
  if (!preserveCurrent && previous?.at === at && JSON.stringify(previous.data) === JSON.stringify(data)) return;
  const previousCurrent = cached('current');
  save(data.semesterDisplay, { data, at });
  if (data.semesterDisplay === 'all') {
    calendarArchive.updatedAt = data.archiveUpdatedAt ?? 0;
    const current = currentData(data);
    if (current) {
      if (previousCurrent && (preserveCurrent || previousCurrent.data.fetchedAt > data.fetchedAt)) {
        store(previousCurrent.data, previousCurrent.at, true);
      }
      else save('current', { data: current, at });
    }
  } else {
    const all = cached('all');
    if (!all) return;
    const ids = new Set(data.courses.map((course) => course.id));
    const previous = new Set(all.data.courses.filter((course) => data.currentTerm && course.term?.year === data.currentTerm.year
      && course.term?.semester === data.currentTerm.semester).map((course) => course.id));
    const merged = {
      ...all.data, currentTerm: data.currentTerm, fetchedAt: data.fetchedAt,
      failedCourseIds: [...(all.data.failedCourseIds ?? []).filter((id) => !previous.has(id) && !ids.has(id)), ...(data.failedCourseIds ?? [])],
      courses: [...all.data.courses.filter((course) => !previous.has(course.id) && !ids.has(course.id)), ...data.courses]
        .sort((a, b) => (b.term?.year ?? 0) - (a.term?.year ?? 0) || (b.term?.semester ?? 0) - (a.term?.semester ?? 0)
          || (a.code ?? '').localeCompare(b.code ?? '') || a.name.localeCompare(b.name)),
      items: [...all.data.items.filter((item) => !previous.has(item.courseId) && !ids.has(item.courseId)), ...data.items]
        .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity)),
    };
    save('all', { data: merged, at: all.at });
  }
}

function applyChanges(response: CalendarData, started: number) {
  const failed = new Set(response.failedCourseIds ?? []);
  if (failed.size) {
    const previous = cached(response.semesterDisplay)?.data ?? cached('all')?.data;
    const keys = new Set(response.items.map((item) => item.key));
    response = { ...response, items: [...response.items, ...(previous?.items ?? [])
      .filter((item) => failed.has(item.courseId) && !keys.has(item.key))] };
  }
  return normalizeCalendar({ ...response, items: response.items.map((item) => {
    const change = stateChanges.get(item.key);
    return change && change.revision > started ? { ...item, ...change.patch } : item;
  }) });
}

async function fetchMode(display: SemesterDisplay, refresh = false, storedOnly = false): Promise<CalendarData> {
  let existing = pending.get(display);
  if (storedOnly) existing?.controller.abort();
  if (existing?.controller.signal.aborted) existing = undefined;
  if (existing) return existing.job;
  const version = sessionVersion(), started = stateRevision, currentStarted = currentResponseRevision;
  const controller = new AbortController();
  const job = (async () => {
    const response = storedOnly
      ? await api.storedSchool<CalendarData>(display === 'all' ? 'archive' : 'calendar')
      : await api.calendar(refresh, display, controller.signal);
    let data = applyChanges(response, started);
    if (isCurrentSession(version) && !controller.signal.aborted && pending.get(display)?.controller === controller) {
      if (display === 'current') currentResponseRevision++;
      store(data, Date.now(), display === 'all' && currentResponseRevision !== currentStarted);
      data = cached(display)?.data ?? data;
      schoolReadRevision++;
    }
    return data;
  })().finally(() => { if (pending.get(display)?.job === job) pending.delete(display); });
  pending.set(display, { job, controller });
  return job;
}

async function fetchCalendar(): Promise<CalendarData> {
  const display = calendarSemesterDisplay;
  if (storedDisplay === display) {
    storedDisplay = null;
    try { return await fetchMode(display, false, true); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
  }
  if (display === 'all' && !calendarArchive.ready) return collectArchive(false);
  return fetchMode(display, schoolRefresh.delete(display));
}

class CalendarResource extends Resource<CalendarData> {
  override load(force = false): Promise<void> {
    return withCalendarTodos(super.load(force), force);
  }

  override get stale() {
    return calendarSemesterDisplay === 'all' ? this.data === null : super.stale;
  }

  async refreshSchool(): Promise<void> {
    if (calendarSemesterDisplay === 'all') {
      await refreshCurrentCalendar(true, true);
      return;
    }
    const active = pending.get('current');
    active?.controller.abort();
    pending.delete('current');
    schoolRefresh.add('current');
    return super.refresh();
  }

  override restore() {
    this.reset();
    const value = cached(calendarSemesterDisplay);
    if (value) {
      super.set(normalizeCalendar(value.data), value.at);
      this.error = this.warning(value.data);
    }
  }

  override set(data: CalendarData, at?: number) {
    const stored = cached(data.semesterDisplay);
    if (stored && JSON.stringify(stored.data) === JSON.stringify(data)) at ??= stored.at;
    if (this.data?.fetchedAt === data.fetchedAt) {
      const before = new Map(this.data.items.map((item) => [item.key, item]));
      for (const item of data.items) {
        const previous = before.get(item.key);
        if (!previous) continue;
        const patch: ItemPatch = {};
        if (item.done !== previous.done) patch.done = item.done;
        if (item.doneOverride !== previous.doneOverride) patch.doneOverride = item.doneOverride;
        if (item.alert !== previous.alert) patch.alert = item.alert;
        if (JSON.stringify(item.alertLeads) !== JSON.stringify(previous.alertLeads)) patch.alertLeads = item.alertLeads;
        if (item.status !== previous.status) patch.status = item.status;
        if (Object.keys(patch).length) {
          const current = stateChanges.get(item.key);
          stateChanges.set(item.key, { revision: ++stateRevision, patch: { ...current?.patch, ...patch } });
        }
      }
      at ??= this.at;
    }
    at ??= Date.now();
    super.set(data, at);
    this.error = this.warning(data);
  }

  protected override warning(data: CalendarData) {
    return data.failedCourseIds?.length ? '일부 과목의 정보를 불러오지 못했어요.' : null;
  }

  protected override persist(data: CalendarData, at: number) {
    store(data, at);
  }
}

export const calendar = new CalendarResource('calendar-current', fetchCalendar, 5 * MIN, normalizeCalendar);

function showStored() {
  const value = cached(calendarSemesterDisplay);
  if (value) calendar.set(value.data, value.at);
}

export async function refreshCurrentCalendar(force = false, refreshSchool = false): Promise<void> {
  if (calendarSemesterDisplay === 'current' && !refreshSchool) return calendar.load(force);
  const version = sessionVersion();
  const current = cached('current');
  if (!force && current && Date.now() - current.at < 5 * MIN) return todos.load();
  await withCalendarTodos(fetchMode('current', refreshSchool), force);
  if (isCurrentSession(version)) showStored();
}

async function collectArchive(refresh: boolean, readOnly = false): Promise<CalendarData> {
  if (archiveJob) {
    const data = await archiveJob;
    return data.semesterDisplay === calendarSemesterDisplay ? data : fetchMode(calendarSemesterDisplay);
  }
  const version = sessionVersion(), started = stateRevision, currentStarted = currentResponseRevision;
  calendarArchive.loading = true;
  calendarArchive.error = '';
  const job = (async () => {
    const display = calendarSemesterDisplay;
    const response = readOnly
      ? await api.storedSchool<CalendarData>(display === 'all' ? 'archive' : 'calendar')
      : await api.updateCalendarArchive(refresh, display);
    let data = applyChanges(response, started);
    if (isCurrentSession(version)) {
      store(data, Date.now(), currentResponseRevision !== currentStarted);
      data = cached(display)?.data ?? data;
      calendarArchive.ready = true;
      calendarArchive.error = data.failedCourseIds?.length ? '일부 과목의 정보를 불러오지 못했어요.' : '';
      showStored();
      schoolReadRevision++;
    }
    return data;
  })().catch((e) => {
    if (isCurrentSession(version)) calendarArchive.error = errorText(e, '전체 학기 데이터를 불러오지 못했어요.');
    throw e;
  }).finally(() => {
    if (archiveJob === job) archiveJob = null;
    if (isCurrentSession(version)) calendarArchive.loading = false;
  });
  archiveJob = job;
  return job;
}

export async function ensureCalendarArchive(): Promise<void> {
  try { await withCalendarTodos(collectArchive(false)); }
  catch (e) { handleAuthError(e); }
}

export function refreshCalendarArchiveData(): Promise<CalendarData> {
  return withCalendarTodos(collectArchive(true), true);
}

export function applyCalendarState(state: CalendarState): boolean {
  const off = new Set(state.alertsOff);
  let changed = false;
  for (const display of ['all', 'current'] as const) {
    const value = cached(display);
    if (!value) continue;
    let displayChanged = false;
    const items = value.data.items.map((item) => {
      const doneOverride = state.checks[item.key] ?? null;
      const done = doneOverride ?? (item.status === 'submitted' || item.status === 'done');
      const alert = !off.has(item.key);
      const alertLeads = state.alertLeads[item.key] ?? null;
      if (item.done === done && item.doneOverride === doneOverride && item.alert === alert
        && JSON.stringify(item.alertLeads) === JSON.stringify(alertLeads)) return item;
      displayChanged = true;
      return { ...item, done, doneOverride, alert, alertLeads };
    });
    if (displayChanged) {
      changed = true;
      save(display, { data: { ...value.data, items }, at: value.at });
    }
  }
  if (changed) showStored();
  return changed;
}

export async function refreshStoredCalendar(): Promise<boolean> {
  const version = sessionVersion(), started = stateRevision;
  const display = calendarSemesterDisplay;
  const data = await api.storedSchool<CalendarData>(display === 'all' ? 'archive' : 'calendar');
  if (!isCurrentSession(version) || display !== calendarSemesterDisplay) return false;
  store(applyChanges(data, started), Date.now());
  showStored();
  return true;
}

export function setCalendarSemesterDisplay(display: SemesterDisplay) {
  display = resolveSemesterDisplay(display);
  if (calendarSemesterDisplay === display) return;
  calendarSemesterDisplay = display;
  storedDisplay = display;
  if (display === 'current') {
    pending.get('all')?.controller.abort();
    pending.delete('all');
    memory.delete('all');
  }
  removeUserData('calendar-all');
  calendar.setKey(key(display));
  if (app.profile) void calendar.load(true);
}

onSessionChange(() => {
  for (const request of pending.values()) request.controller.abort();
  pending.clear();
  memory.clear();
  removeUserData('calendar-all');
  stateChanges.clear();
  stateRevision++;
  currentResponseRevision = 0;
  schoolReadRevision = 0;
  todosReadRevision = 0;
  schoolRefresh.clear();
  storedDisplay = null;
  archiveJob = null;
  calendarArchive.loading = false;
  calendarArchive.ready = false;
  calendarArchive.updating = false;
  calendarArchive.error = '';
  calendarArchive.updatedAt = 0;
});
