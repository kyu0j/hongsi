import { api, uncertainWrite } from '../../shared/api/api';
import { beginCalendarChange } from './calendar-sync.svelte';
import { errorText, writeBlocked } from '../../shared/api/net.svelte';
import { schoolFinished } from './colors';
import { calendar, applyCalendarState } from './calendar-resources.svelte';
import { todos } from './todo-resource.svelte';
import { toastOnce } from '../../shared/state/ui.svelte';
import type { CalendarItem } from '../../shared/types';
import { handleAuthError } from '../auth/auth-state.svelte';
import { isCurrentSession, isStaleSession, onSessionChange, sessionVersion } from '../../shared/state/session';

const saving = new Set<string>();
const savingAlerts = new Set<string>();
export const doneConfirmation = $state({ pending: null as { key: string; done: boolean } | null });

export function cancelDoneConfirmation() {
  doneConfirmation.pending = null;
}

export async function confirmDone() {
  const pending = doneConfirmation.pending;
  cancelDoneConfirmation();
  if (!pending) return;
  const item = calendar.data?.items.find((i) => i.key === pending.key);
  if (item) await saveDone(item, pending.done);
}

function update(key: string, patch: Partial<CalendarItem>) {
  if (!calendar.data) return;
  calendar.set({ ...calendar.data, items: calendar.data.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
}

export async function toggleDone(item: CalendarItem) {
  if (writeBlocked() || saving.has(item.key) || doneConfirmation.pending) return;
  const current = calendar.data?.items.find((i) => i.key === item.key) ?? item;
  const done = !current.done;
  if (done !== schoolFinished(current)) {
    doneConfirmation.pending = { key: item.key, done };
    return;
  }
  await saveDone(current, done);
}

async function reconcile(error: unknown, version: number): Promise<boolean> {
  if (!uncertainWrite(error) || !isCurrentSession(version)) return false;
  try {
    const state = await api.calendarState();
    if (!isCurrentSession(version)) return false;
    applyCalendarState(state);
    await todos.refresh();
    return isCurrentSession(version);
  } catch (e) {
    if (isCurrentSession(version)) handleAuthError(e);
    return false;
  }
}

async function saveDone(item: CalendarItem, done: boolean) {
  if (writeBlocked() || saving.has(item.key)) return;
  const version = sessionVersion();
  const current = calendar.data?.items.find((i) => i.key === item.key) ?? item;
  if (done === current.done) return;
  const before = { done: current.done, doneOverride: current.doneOverride };
  const override = done === schoolFinished(current) ? null : done;
  const finishChange = beginCalendarChange();
  saving.add(item.key);
  update(item.key, { done, doneOverride: override });
  try {
    await api.setDone(item.key, override);
    if (isCurrentSession(version)) await todos.refresh();
  } catch (e) {
    if (!isCurrentSession(version) || isStaleSession(e)) return;
    const read = await reconcile(e, version);
    if (!isCurrentSession(version)) return;
    if (read && calendar.data?.items.find((i) => i.key === item.key)?.done === done) return;
    if (!read) update(item.key, before);
    if (!handleAuthError(e)) toastOnce(errorText(e, '저장하지 못했어요.'), 'error');
  } finally {
    if (isCurrentSession(version)) saving.delete(item.key);
    finishChange();
  }
}


async function saveItemAlert(item: CalendarItem, patch: Partial<CalendarItem>, save: () => Promise<unknown>) {
  if (writeBlocked() || savingAlerts.has(item.key)) return;
  const version = sessionVersion();
  const current = calendar.data?.items.find((i) => i.key === item.key) ?? item;
  const before = { alert: current.alert, alertLeads: current.alertLeads };
  const finishChange = beginCalendarChange();
  savingAlerts.add(item.key);
  update(item.key, patch);
  try {
    await save();
  } catch (e) {
    if (!isCurrentSession(version) || isStaleSession(e)) return;
    const read = await reconcile(e, version);
    if (!isCurrentSession(version)) return;
    const actual = calendar.data?.items.find((i) => i.key === item.key);
    if (read && actual && Object.entries(patch).every(([key, value]) => JSON.stringify(actual[key as keyof CalendarItem]) === JSON.stringify(value))) return;
    if (!read) update(item.key, before);
    if (!handleAuthError(e)) toastOnce(errorText(e, '저장하지 못했어요.'), 'error');
  } finally {
    if (isCurrentSession(version)) savingAlerts.delete(item.key);
    finishChange();
  }
}

export async function setItemAlert(item: CalendarItem, on: boolean) {
  await saveItemAlert(item, on ? { alert: true, alertLeads: null } : { alert: false }, () => api.setAlert(item.key, on));
}

export async function setItemAlertLeads(item: CalendarItem, leads: number[] | null) {
  await saveItemAlert(item, { alertLeads: leads }, () => api.setAlertLeads(item.key, leads));
}


onSessionChange(() => {
  saving.clear();
  savingAlerts.clear();
  cancelDoneConfirmation();
});
