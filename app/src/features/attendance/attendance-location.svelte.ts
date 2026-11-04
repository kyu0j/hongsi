import { untrack } from 'svelte';
import { locationPermission, watchLocation } from '../../platform/location';
import { clock } from '../../shared/state/clock.svelte';
import type { ActiveLecture } from '../../shared/types';
import { createLocationFilter, type LocationFix } from '../campus-map/location-filter';
import { inWindow, isAttended, lectureMark, lectureSession, markFor, POLL_MS, todaySessions } from './classwatch.svelte';
import { timetable } from './attendance-resources.svelte';

const MAX_AGE = 15_000;
export const attendanceLocation = $state({ position: null as LocationFix | null });

function needed(now = Date.now()) {
  return todaySessions(timetable.data?.slots ?? [], now).some((session) => inWindow(session, now) && !isAttended(markFor(session)));
}

export function preparedAttendanceLocation(lecture: ActiveLecture): LocationFix | null {
  const now = Date.now(), session = lectureSession(lecture, now), position = attendanceLocation.position;
  if (document.hidden || !session || !inWindow(session, now) || isAttended(lectureMark(lecture))
    || !position || now - position.timestamp > MAX_AGE || position.timestamp > now + 5000) return null;
  return position;
}

export function watchAttendanceLocation(): () => void {
  let disposed = false, paused = false, enabled = false, checking = false, generation = 0, lastAttempt = 0;
  let cancel: (() => void) | null = null;
  let filter = createLocationFilter();
  const visible = () => !disposed && !paused && document.visibilityState === 'visible';
  function stop() {
    generation++;
    const current = cancel;
    cancel = null;
    attendanceLocation.position = null;
    filter = createLocationFilter();
    current?.();
  }
  async function sync() {
    if (!enabled || !visible()) { stop(); lastAttempt = 0; return; }
    if (cancel || checking || Date.now() - lastAttempt < POLL_MS) return;
    const current = ++generation;
    lastAttempt = Date.now();
    checking = true;
    try {
      const permission = await locationPermission();
      if (permission !== 'granted' || current !== generation || !enabled || !visible()) return;
      const cancelWatch = watchLocation((position) => {
        if (current !== generation || !enabled || !visible()) return;
        const accepted = filter(position);
        if (accepted) attendanceLocation.position = accepted;
      }, () => { if (current === generation) stop(); });
      if (current === generation) cancel = cancelWatch;
      else cancelWatch();
    } catch { if (current === generation) stop(); }
    finally { checking = false; }
  }
  $effect(() => {
    enabled = needed(clock.now);
    untrack(() => { void sync(); });
  });
  const changed = () => { enabled = untrack(() => needed()); void sync(); };
  const pause = () => { paused = true; stop(); };
  const resume = () => { paused = false; changed(); };
  document.addEventListener('visibilitychange', changed);
  window.addEventListener('hongsi-pause', pause);
  window.addEventListener('hongsi-resume', resume);
  return () => {
    disposed = true;
    stop();
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener('hongsi-pause', pause);
    window.removeEventListener('hongsi-resume', resume);
  };
}
