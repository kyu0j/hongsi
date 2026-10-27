<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, api } from '../../shared/api/api';
  import { attendanceFailureMessage } from '../../shared/api/api-error';
  import { currentLocation } from '../../platform/location';
  import { POLL_MS, afterSubmit, checkNow, classWatch, isAttended, lectureMark, lectureSession, classScheduleLabel, markFor, markTitle, nextClass, todaySessions, useClassWatch } from './classwatch.svelte';
  import { sentenceLines } from '../../shared/utils/format';
  import { errorText, writeBlocked } from '../../shared/api/net.svelte';
  import { attendance, attendanceReceipts, lectures, timetable } from './attendance-resources.svelte';
  import { handleAuthError } from '../auth/auth-state.svelte';
  import { toast } from '../../shared/state/ui.svelte';
  import { refreshState, refreshTab } from '../../shared/state/refresh.svelte';
  import type { ActiveLecture } from '../../shared/types';
  import Icon from '../../shared/ui/Icon.svelte';
  import Ring from '../../shared/ui/Ring.svelte';
  import Sheet from '../../shared/ui/Sheet.svelte';

  let { showLabel = true }: { showLabel?: boolean } = $props();

  onMount(() => {
    timetable.load();
    return useClassWatch();
  });

  let target = $state<ActiveLecture | null>(null);
  let open = $state(false);
  let code = $state('');
  let geo = $state<{ state: 'idle' | 'finding' | 'ok' | 'error'; lat?: number; lon?: number; acc?: number; msg?: string }>({
    state: 'idle',
  });
  let busy = $state(false);
  let result = $state('');
  let geoRequest = 0;
  const submittedMark = $derived(target ? lectureMark(target) : null);
  const submitted = $derived(isAttended(submittedMark));

  const openList = $derived(lectures.at > classWatch.now - 10 * 60_000 ? (lectures.data?.items ?? []) : []);
  const lecture = $derived(openList.find((l) => !isAttended(lectureMark(l))) ?? openList[0] ?? null);
  const current = $derived(classWatch.current);
  const next = $derived(nextClass(classWatch.now));
  const currentMark = $derived(current ? markFor(current) : null);
  const mark = $derived(lecture ? lectureMark(lecture) : currentMark);
  const watching = $derived(current && !currentMark ? current : null);
  const loading = $derived(!lectures.data && !lectures.error);
  const available = $derived(!!lecture && !isAttended(mark));
  const failed = $derived(!!lectures.error && !available && !mark);
  const nextOnly = $derived(!loading && !failed && !lecture && !current && !!next);
  const waiting = $derived(!loading && !failed && !available && !mark && !!watching);
  const accent = $derived(available || waiting);
  const slot = $derived(lecture ? lectureSession(lecture) : current ?? (nextOnly ? next : null));
  const schedule = $derived(classScheduleLabel(slot, lecture?.time));
  const title = $derived(loading ? '' : failed ? '출석 정보를 불러오지 못했어요.' : lecture?.name ?? current?.name ?? (nextOnly ? next?.name : '') ?? '');
  const badgeTone = $derived(mark?.kind === 'absent' ? 'danger' : mark?.kind === 'late' ? 'warn' : mark && isAttended(mark) ? 'ok' : '');
  const refreshing = $derived(loading || lectures.loading || classWatch.polling || refreshState.attendance.busy);
  const sessions = $derived(todaySessions(timetable.data?.slots ?? [], classWatch.now));
  const emptyMessage = $derived(loading || (!timetable.data && !timetable.error)
    ? '출석 정보를 확인하고 있어요.'
    : !timetable.data ? '출석 정보를 불러오지 못했어요.'
    : !sessions.length ? '오늘은 수업이 없어요.'
    : sessions.every((s) => classWatch.now >= s.at + 3_600_000) ? '오늘 수업이 모두 끝났어요.'
    : '출석할 수업이 없어요.');
  const emptyLayout = $derived(failed || !title);
  const left = $derived(Math.max(0, Math.min(1, (classWatch.nextAt - classWatch.now) / POLL_MS)));

  function startAttend(l: ActiveLecture) {
    if (busy) return;
    target = l;
    code = '';
    result = '';
    open = true;
    locate();
  }

  async function locate() {
    const request = ++geoRequest;
    geo = { state: 'finding' };
    try {
      const p = await currentLocation();
      if (request === geoRequest) geo = { state: 'ok', lat: p.latitude, lon: p.longitude, acc: Math.round(p.accuracy) };
    } catch (e) {
      if (request === geoRequest) geo = { state: 'error', msg: e instanceof Error ? e.message : typeof e === 'string' ? e : '위치를 찾지 못했어요.' };
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!target || busy || submitted || geo.state !== 'ok' || !code.trim()) return;
    if (writeBlocked('school', '출결할')) return;
    result = '';
    busy = true;
    try {
      const res = await api.submitAttendance(target.key, code.trim(), geo.lat!, geo.lon!);
      const confirmed = afterSubmit(res);
      if (confirmed) {
        open = false;
        code = '';
        toast('출석 확인이 완료되었습니다.', 'success', 5000);
      } else {
        result = attendanceFailureMessage(res.message);
      }
      void lectures.refresh();
      void attendance.refresh();
    } catch (err) {
      if (!handleAuthError(err)) result = err instanceof ApiError && (err.status === 0 || err.status >= 500)
        ? '출석 결과를 확인하지 못했어요.'
        : errorText(err, '출석 결과를 확인하지 못했어요.');
    } finally {
      busy = false;
    }
  }
</script>

<section class="now card" class:empty-layout={emptyLayout} class:watching={accent} class:failed aria-label="빠른 출결 상태">
  <div class="now-head">
    <div>
      {#if showLabel}<span class="eyebrow">빠른 출결</span>{/if}
      {#if title && !failed}<h2>{title}</h2>{/if}
    </div>
    <button class="icon-btn refresh-button" class:ring-btn={accent && !!watching} onclick={() => watching ? checkNow() : refreshTab('attendance')} aria-label="출결 다시 확인" aria-busy={refreshing} disabled={refreshing}>
      {#if accent && watching}
        <Ring value={left} size={40} stroke={3}>
          <span class="refresh-icon" class:spin={refreshing}><Icon name="refresh" size={18} stroke={2.2} /></span>
        </Ring>
      {:else}
        <span class="refresh-icon" class:spin={refreshing}><Icon name="refresh" size={18} /></span>
      {/if}
    </button>
  </div>
  <div class="status-body">
  {#if available || waiting}
    <div class="card-bottom">
      <div class="class-info">
        <span class="available-message"><i></i>{available ? '출석할 수 있어요.' : '확인중'}</span>
        {#if schedule}<span class="schedule">{schedule}</span>{/if}
      </div>
      <button class="btn btn-primary attend-button" onclick={() => lecture && startAttend(lecture)} disabled={!available || busy}>{#if available}<Icon name="tick" size={17} />출석하기{:else}확인중{/if}</button>
    </div>
  {:else if !failed && mark}
    <div class="card-bottom">
      {#if schedule}<span class="schedule">{schedule}</span>{/if}
      <span class="state-badge {badgeTone}">{#if isAttended(mark)}<Icon name={mark.kind === 'late' ? 'clock' : 'tick'} size={14} />{:else if mark.kind === 'absent'}<Icon name="alert" size={14} />{/if}{markTitle(mark)}</span>
    </div>
  {:else if nextOnly}
    <div class="card-bottom">
      <span class="schedule">{schedule}</span>
      <span class="state-badge">다음 수업</span>
    </div>
  {:else if failed}
    <div class="empty-state" role="status">
      <h2>{title}</h2>
      {#if schedule}<span class="schedule">{schedule}</span>{/if}
    </div>
  {:else}
    <div class="empty-state" role="status">
      <span>{emptyMessage}</span>
    </div>
  {/if}
  {#if lectures.error && !failed}<p class="error-message small sentence-message" role="status">{sentenceLines(lectures.error)}</p>{/if}
  {#if attendanceReceipts.error}<p class="muted small" role="status">출석 기록을 불러오지 못했어요.</p>{/if}
  </div>
</section>

<Sheet bind:open title={target?.name ?? '출결하기'} titleMeta={target?.time}>
  <form id="attend" onsubmit={submit} class="attend">
    <label class="code">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={code}
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="12"
        aria-label="출결번호"
        placeholder="출결번호"
        autofocus
      />
    </label>
    <div class="geo {geo.state}">
      <Icon name="pin" size={18} />
      <span class="geo-text">
        {#if geo.state === 'finding'}현재 위치를 확인하는 중…
        {:else if geo.state === 'ok'}현재 위치 확인됨 (오차 약 {geo.acc}m)
        {:else if geo.state === 'error'}{geo.msg}
        {:else}위치 확인 전{/if}
      </span>
      {#if geo.state === 'error'}<button type="button" class="link" onclick={locate}>다시 시도</button>{/if}
    </div>
    {#if result}<p class="result sentence-message" role="status">{sentenceLines(result)}</p>{/if}
  </form>
  {#snippet footer()}
    <button class="btn btn-ghost w1" onclick={() => (open = false)}>닫기</button>
    <button class="btn btn-primary w2" form="attend" disabled={busy || submitted || geo.state !== 'ok' || !code.trim()}>
      {submitted && submittedMark ? markTitle(submittedMark) : busy ? '보내는 중…' : '출결하기'}
    </button>
  {/snippet}
</Sheet>

<style>
  .now { border: 0; height: 160px; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: var(--surface); position: relative; overflow: hidden; }
  .now-head { flex-shrink: 0; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .now-head > div { min-width: 0; }
  .now.watching { box-shadow: none; background: var(--primary-weak); }
  .eyebrow { display: block; font-size: 12px; font-weight: 700; color: var(--text-2); }
  .now.watching .eyebrow, .available-message { color: var(--primary-text); }
  .now h2 { margin-top: 4px; font-size: 19px; font-weight: 720; line-height: 1.35; letter-spacing: -0.02em; overflow-wrap: anywhere; }
  .refresh-button { width: 40px; height: 40px; flex: none; }
  .ring-btn { color: var(--primary-text); }
  .refresh-icon { display: grid; place-items: center; }
  .card-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
  .class-info { display: grid; gap: 5px; min-width: 0; }
  .available-message { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; }
  .available-message i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }
  .schedule { font-size: 12px; color: var(--text-2); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .attend-button { min-width: 108px; min-height: 44px; padding: 0 14px; font-size: 15px; border-radius: 12px; gap: 6px; flex: none; margin-left: auto; }
  .state-badge { display: inline-flex; align-items: center; gap: 5px; padding: 7px 9px; border-radius: 9px; background: color-mix(in srgb, #94a3b8 10%, transparent); color: var(--text-2); font-size: 12px; font-weight: 650; white-space: nowrap; margin-left: auto; }
  .state-badge.ok { background: var(--ok-weak); color: var(--ok); }
  .state-badge.warn { background: var(--primary-weak); color: var(--primary-text); }
  .state-badge.danger { background: var(--danger-weak); color: var(--danger); }
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; min-height: 83px; padding: 20px 10px; border: 1px dashed var(--border); border-radius: 12px; text-align: center; font-size: 13px; color: var(--text-2); }
  .status-body { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; overflow-y: auto; }
  .now.empty-layout .now-head { position: absolute; top: 14px; left: 14px; right: 14px; }
  .now.empty-layout .status-body { padding-inline: 36px; overflow: hidden; }
  .now.empty-layout .empty-state { min-height: 0; border: 0; border-radius: 0; padding: 0; font-size: 15px; font-weight: 500; }
  .now.failed .status-body { padding-inline: 0; }
  .now.failed h2 { margin-top: 0; }
  .now h2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .small { font-size: 12.5px; font-weight: 500; }
  .error-message { color: var(--danger); }

  .attend {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }

  .code {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    font-size: 13px;
    font-weight: 650;
    color: var(--text-2);
  }

  .code input {
    width: 100%;
    min-width: 0;
    height: 60px;
    padding: 0 14px;
    border-radius: 14px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    text-align: center;
    font-size: 26px;
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: 0.25em;
    text-indent: 0.25em;
  }

  .code input:placeholder-shown {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0;
    text-indent: 0;
  }

  .code input::placeholder {
    color: var(--text-3);
  }

  .code input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 18%, transparent);
  }

  .geo {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-2);
  }

  .geo.ok {
    background: var(--ok-weak);
    color: var(--ok);
  }

  .geo.error {
    background: var(--danger-weak);
    color: var(--danger);
  }

  .geo-text {
    flex: 1;
    min-width: 0;
  }

  .geo .link {
    flex: none;
  }

  .link {
    color: inherit;
    text-decoration: underline;
    font-weight: 700;
  }

  .result {
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--danger-weak);
    color: var(--danger);
    font-weight: 650;
    white-space: pre-line;
  }

  @media (max-width: 359px) {
    .now { padding: 14px; }
    .attend-button { padding: 0 10px; }
  }
</style>
