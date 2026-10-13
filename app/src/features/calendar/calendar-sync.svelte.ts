import { api } from '../../shared/api/api';
import { app, handleAuthError } from '../auth/auth-state.svelte';
import { calendar, calendarArchive, applyCalendarState, refreshCalendarArchiveData, refreshStoredCalendar } from './calendar-resources.svelte';
import { errorText } from '../../shared/api/net.svelte';
import { toast } from '../../shared/state/ui.svelte';
import { todos } from './todo-resource.svelte';
import { refreshAccountPreferences } from '../settings/settings.svelte';
import { timetable } from '../attendance/attendance-resources.svelte';
import { notices } from '../classroom/notice-resource.svelte';
import { seatSession } from '../seats/seat-resources.svelte';
import type { Timetable, ClassNotification } from '../../shared/types';
import { isCurrentSession, onSessionChange, sessionVersion } from '../../shared/state/session';

export const calendarSync = $state({ updatedAt: 0 });
let versions: Record<string, number> = {};
let revision = 0;
let writing = 0;
let lastRead = 0;
let reading: Promise<void> | null = null;

export function beginCalendarChange() {
  const version = sessionVersion();
  writing += 1;
  revision += 1;
  return () => {
    if (!isCurrentSession(version)) return;
    writing -= 1;
    revision += 1;
  };
}

async function refreshCalendarState() {
  if (reading) return reading;
  if (!app.profile || app.loggingOut || calendar.loading || writing || Date.now() - lastRead < 3_000) return;
  lastRead = Date.now();
  const version = sessionVersion(), started = revision, before = calendar.data;
  const job = (async () => {
    try {
      const next = await api.schoolRevisions();
      if (!isCurrentSession(version) || revision !== started || writing || calendar.loading || calendar.data !== before) return;
      const changed = (key: string) => versions[key] !== (next[key] ?? 0);
      const current = () => isCurrentSession(version) && revision === started && !writing;
      const sync = async (keys: string[], apply: () => Promise<boolean>) => {
        if (!current() || !keys.some(changed)) return;
        try {
          if (await apply() && current()) {
            for (const key of keys) versions[key] = next[key] ?? 0;
          }
        } catch (e) {
          if (current()) handleAuthError(e);
        }
      };
      await Promise.all([
        sync(['seat'], () => seatSession.refreshConfirmed()),
        (async () => {
          await sync(['preferences'], () => refreshAccountPreferences(true));
          await sync(['calendar', 'archive'], async () => {
            if (!next.calendar && !next.archive) return true;
            return refreshStoredCalendar();
          });
          await sync(['items'], async () => {
            if (!calendar.data) return false;
            const state = await api.calendarState();
            if (!current()) return false;
            if (applyCalendarState(state)) calendarSync.updatedAt = Date.now();
            return true;
          });
        })(),
        sync(['todos'], () => todos.refreshConfirmed()),
        sync(['timetable'], async () => {
          if (!next.timetable) return true;
          const data = await api.storedSchool<Timetable>('timetable');
          if (!current()) return false;
          timetable.set(data);
          return true;
        }),
        sync(['notices'], async () => {
          if (!next.notices) return true;
          const data = await api.storedSchool<ClassNotification[]>('notices');
          if (!current()) return false;
          notices.set(data);
          return true;
        }),
      ]);
    } catch (e) {
      if (isCurrentSession(version)) handleAuthError(e);
    }
  })().finally(() => { if (reading === job) reading = null; });
  reading = job;
  return job;
}

export function watchCalendarState() {
  const refresh = () => { if (document.visibilityState === 'visible') void refreshCalendarState(); };
  refresh();
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', refresh);
  const timer = setInterval(refresh, 30_000);
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('online', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}

export async function updateCalendarArchive(): Promise<void> {
  if (calendarArchive.loading || calendarArchive.updating) return;
  calendarArchive.updating = true;
  const version = sessionVersion();
  try {
    const results = await Promise.allSettled([refreshCalendarArchiveData(), api.timetable(true).then((data) => {
      if (isCurrentSession(version)) timetable.set(data);
    })]);
    if (!isCurrentSession(version)) return;
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const data = results[0].status === 'fulfilled' ? results[0].value : null;
    if (data?.failedCourseIds?.length) toast('일부 과목을 업데이트하지 못했어요.', 'error');
    else toast('학교 정보를 업데이트했어요.');
  } catch (e) {
    if (isCurrentSession(version) && !handleAuthError(e)) toast(errorText(e, '학교 정보를 업데이트하지 못했어요.'), 'error');
  } finally { if (isCurrentSession(version)) calendarArchive.updating = false; }
}

onSessionChange(() => {
  revision += 1;
  writing = 0;
  reading = null;
  lastRead = 0;
  calendarSync.updatedAt = 0;
  versions = {};
});
