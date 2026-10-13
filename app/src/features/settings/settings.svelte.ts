import { api, uncertainWrite } from '../../shared/api/api';
import { app, handleAuthError, onBeforeLogout } from '../auth/auth-state.svelte';
import { pref, setPref } from '../../shared/state/preferences';
import { setCalendarSemesterDisplay } from '../calendar/calendar-resources.svelte';
import { resolveSemesterDisplay } from '../calendar/semester';
import { isCurrentSession, onSessionChange, readUserData, sessionUser, sessionVersion, writeUserData } from '../../shared/state/session';
import { toastOnce } from '../../shared/state/ui.svelte';
import type { AccountPreferences, AccountPreferenceChanges, SemesterDisplay } from '../../shared/types';

export type Theme = 'system' | 'light' | 'dark';
export type Midnight = 'prev' | 'same';
export type MealPlace = 'dorm' | 'staff';
export type TimetableDisplay = 'full' | 'fit';

export const ALERT_LEADS: { min: number; label: string }[] = [
  { min: 1440, label: '1일 전' },
  { min: 180, label: '3시간 전' },
  { min: 60, label: '1시간 전' },
  { min: 10, label: '10분 전' },
  { min: 0, label: '마감' },
];

export const settings = $state({
  theme: pref<Theme>('theme', 'system'),
  midnight: 'prev' as Midnight,
  showUndatedAssignments: false,
  mealPlace: 'dorm' as MealPlace,
  timetableDisplay: 'fit' as TimetableDisplay,
  semesterDisplay: 'current' as SemesterDisplay,
  alertLeads: [60],
});

export function toggleAlertLead(min: number) {
  const next = settings.alertLeads.includes(min)
    ? settings.alertLeads.filter((m) => m !== min)
    : [...settings.alertLeads, min];
  changeAccountPreferences({ alertLeads: next.sort((a, b) => b - a) });
}

export function setTimetableDisplay(value: TimetableDisplay) {
  changeAccountPreferences({ timetableDisplay: value });
}

export function setSemesterDisplay(value: SemesterDisplay) {
  changeAccountPreferences({ semesterDisplay: resolveSemesterDisplay(value) });
}

export function setMealPlace(value: MealPlace) {
  changeAccountPreferences({ mealPlace: value });
}

export function isPreferredPlace(name: string, place: MealPlace = settings.mealPlace): boolean {
  return place === 'dorm' ? name.includes('기숙사') : name.includes('교직원');
}

export function applyTheme(theme: Theme = settings.theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  settings.theme = theme;
  setPref('theme', theme);
  applyTheme(theme);
}

export function setMidnight(value: Midnight) {
  changeAccountPreferences({ midnight: value });
}

export function setShowUndatedAssignments(value: boolean) {
  changeAccountPreferences({ showUndatedAssignments: value });
}

const defaults = (): AccountPreferences => ({
  mealPlace: 'dorm', timetableDisplay: 'fit', semesterDisplay: 'current', alertLeads: [60],
  midnight: 'prev', showUndatedAssignments: false, updatedAt: 0,
});
export const accountPreferences = $state({ loaded: false, saving: false, error: '', updatedAt: 0 });
let confirmed = defaults();
let pending: AccountPreferenceChanges = {};
let saving: Promise<void> | null = null;
let reading: Promise<boolean> | null = null;
let revision = 0;
let lastRead = 0;

function apply(value: AccountPreferences, changes: AccountPreferenceChanges = {}) {
  const next = { ...value, ...changes };
  settings.midnight = next.midnight;
  settings.showUndatedAssignments = next.showUndatedAssignments;
  settings.mealPlace = next.mealPlace;
  settings.timetableDisplay = next.timetableDisplay;
  settings.semesterDisplay = resolveSemesterDisplay(next.semesterDisplay);
  setCalendarSemesterDisplay(settings.semesterDisplay);
  settings.alertLeads = [...next.alertLeads];
  accountPreferences.updatedAt = value.updatedAt;
}

function accept(value: AccountPreferences) {
  confirmed = { ...defaults(), ...value };
  accountPreferences.loaded = true;
  accountPreferences.error = '';
  writeUserData('account-preferences', confirmed);
  apply(confirmed, pending);
}

function changeAccountPreferences(changes: AccountPreferenceChanges) {
  if (!sessionUser() || app.loggingOut || !accountPreferences.loaded) return;
  revision++;
  pending = { ...pending, ...changes };
  Object.assign(settings, changes);
  if (changes.semesterDisplay) setCalendarSemesterDisplay(changes.semesterDisplay);
  if (saving) return;
  const version = sessionVersion();
  accountPreferences.saving = true;
  const job = (async () => {
    while (isCurrentSession(version) && Object.keys(pending).length) {
      const changes = pending;
      pending = {};
      try {
        const result = await api.updatePreferences(changes);
        if (!isCurrentSession(version)) return;
        accept(result);
      } catch (e) {
        if (!isCurrentSession(version)) return;
        if (handleAuthError(e)) return;
        if (uncertainWrite(e)) {
          try {
            const actual = await api.preferences();
            if (!isCurrentSession(version)) return;
            accept(actual);
            if (Object.entries(changes).every(([key, value]) => JSON.stringify(actual[key as keyof AccountPreferences]) === JSON.stringify(value))) continue;
          } catch (readError) {
            if (!isCurrentSession(version) || handleAuthError(readError)) return;
          }
        }
        apply(confirmed, pending);
        accountPreferences.error = '설정을 저장하지 못했어요.';
        toastOnce(accountPreferences.error, 'error');
      }
    }
  })().finally(() => {
    if (saving !== job) return;
    saving = null;
    accountPreferences.saving = false;
  });
  saving = job;
}

export function refreshAccountPreferences(force = false): Promise<boolean> {
  if (!sessionUser() || app.loggingOut) return Promise.resolve(false);
  if (saving) return saving.then(() => false);
  if (reading) {
    const version = sessionVersion();
    return force ? reading.then(() => isCurrentSession(version) ? refreshAccountPreferences(true) : false) : reading;
  }
  if (!force && Date.now() - lastRead < 5000) return Promise.resolve(false);
  lastRead = Date.now();
  const version = sessionVersion(), started = revision;
  const job = (async () => {
    try {
      const result = await api.preferences();
      if (!isCurrentSession(version) || revision !== started) return false;
      accept(result);
      return true;
    } catch (e) {
      if (isCurrentSession(version) && revision === started && !handleAuthError(e)) {
        accountPreferences.error = '계정 설정을 불러오지 못했어요.';
      }
      return false;
    }
  })().finally(() => { if (reading === job) reading = null; });
  reading = job;
  return job;
}

onBeforeLogout(() => saving ?? Promise.resolve());

onSessionChange(() => {
  revision++;
  reading = null;
  saving = null;
  pending = {};
  lastRead = 0;
  const cached = readUserData<AccountPreferences | null>('account-preferences', null);
  confirmed = { ...defaults(), ...cached };
  accountPreferences.loaded = cached !== null;
  accountPreferences.saving = false;
  accountPreferences.error = '';
  apply(confirmed);
});
