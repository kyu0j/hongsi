<script lang="ts">
  import { untrack } from 'svelte';
  import { isApp } from '../../shared/api/api';
  import { hasStudentCard } from '../../platform/env';
  import { APP_COMMIT, APP_VERSION, versionLabel } from './about';
  import { appUpdater, canUpdateApp } from '../updates/app-update.svelte';
  import {
    accountPreferences,
    refreshAccountPreferences,
    setMealPlace,
    setTimetableDisplay,
    setSemesterDisplay,
    setShowUndatedAssignments,
    setMidnight,
    setTheme,
    settings,
    type MealPlace,
    type Midnight,
    type Theme,
  } from './settings.svelte';
  import NotificationSettings from '../notifications/NotificationSettings.svelte';
  import { app } from '../auth/auth-state.svelte';
  import { calendarArchive } from '../calendar/calendar-resources.svelte';
  import { updateCalendarArchive } from '../calendar/calendar-sync.svelte';
  import { pref } from '../../shared/state/preferences';
  import Avatar from '../../shared/ui/Avatar.svelte';
  import Icon from '../../shared/ui/Icon.svelte';
  import Sheet from '../../shared/ui/Sheet.svelte';
  import Switch from '../../shared/ui/Switch.svelte';
  import StudentCardSheet from '../student-card/StudentCardSheet.svelte';

  let { open = $bindable(false), onlogout, onlogoutall, ondeletedata }: { open: boolean; onlogout: () => Promise<void>; onlogoutall: () => Promise<void>; ondeletedata: () => Promise<void> } = $props();
  let confirmLogoutAll = $state(false);
  let confirmDeleteData = $state(false);
  let studentCardOpen = $state(false);

  $effect(() => { if (!open || app.loggingOut || !app.account) studentCardOpen = false; });

  $effect(() => { if (!open) { confirmLogoutAll = false; confirmDeleteData = false; } else untrack(() => { void refreshAccountPreferences(true); }); });

  const THEMES: { id: Theme; label: string }[] = [
    { id: 'system', label: '시스템' },
    { id: 'light', label: '라이트' },
    { id: 'dark', label: '다크' },
  ];
  const MIDNIGHT: { id: Midnight; label: string; hint: string }[] = [
    { id: 'prev', label: '전날 24:00', hint: '10/3 00:00 마감 → 10/2 24:00' },
    { id: 'same', label: '그날 00:00', hint: '클래스룸과 동일하게 10/3 00:00' },
  ];

  const PLACES: { id: MealPlace; label: string }[] = [
    { id: 'dorm', label: '제2기숙사' },
    { id: 'staff', label: '교직원식당' },
  ];

  const studentId = $derived(app.profile?.studentId || pref('last-id', ''));
  const version = $derived(versionLabel(isApp && appUpdater.currentVersion ? appUpdater.currentVersion : APP_VERSION));

</script>

<Sheet bind:open title="홍시 설정">
  <div class="me">
    <Avatar size={64} />
    <div class="me-info">
      <h3>{app.profile?.name || '내 정보'}</h3>
      <p class="muted">{[studentId, app.profile?.department].filter(Boolean).join(' · ')}</p>
      <span class="chip {app.remembered ? 'ok' : ''}">
        <Icon name={app.remembered ? 'tick' : 'clock'} size={13} stroke={2.4} />
        {#if isApp}{app.remembered ? '자동 로그인 켜짐' : '자동 로그인 꺼짐'}{:else}{app.remembered ? '로그인 상태 유지 중' : '로그인 상태 유지 꺼짐'}{/if}
      </span>
    </div>
    {#if hasStudentCard}
      <button class="qr-button" aria-label="학생증 QR 열기" onclick={() => studentCardOpen = true}><Icon name="qr" size={26} /></button>
    {/if}
  </div>

  <h4 class="section-title">설정</h4>
  {#if accountPreferences.error}
    <p class="set-hint muted">{accountPreferences.error} <button class="link" onclick={() => refreshAccountPreferences(true)}>다시 확인</button></p>
  {/if}
  <div class="settings card">
    <div class="set">
      <div class="set-label"><span>학교 정보 업데이트</span>
        <button class="archive-update" disabled={calendarArchive.loading || calendarArchive.updating || !accountPreferences.loaded} aria-busy={calendarArchive.loading || calendarArchive.updating} onclick={updateCalendarArchive}>
          <span class:spinning={calendarArchive.loading || calendarArchive.updating}><Icon name="refresh" size={15} /></span>업데이트
        </button>
      </div>
      <p class="set-hint muted">학교 정보(수업 과목 등)를 수동으로 업데이트해요.</p>
      {#if calendarArchive.error}<p class="set-hint muted">{calendarArchive.error}</p>{/if}
    </div>
    <div class="set">
      <span class="set-label">화면 테마</span>
      <div class="seg" role="radiogroup" aria-label="화면 테마">
        {#each THEMES as t (t.id)}
          <button role="radio" aria-checked={settings.theme === t.id} class:on={settings.theme === t.id} onclick={() => setTheme(t.id)}>{t.label}</button>
        {/each}
      </div>
    </div>
    <div class="set">
      <span class="set-label">00:00 마감 표시</span>
      <div class="seg" role="radiogroup" aria-label="00:00 마감 표시">
        {#each MIDNIGHT as m (m.id)}
          <button role="radio" aria-checked={settings.midnight === m.id} class:on={settings.midnight === m.id} disabled={!accountPreferences.loaded} onclick={() => setMidnight(m.id)}>{m.label}</button>
        {/each}
      </div>
      <p class="set-hint muted">{MIDNIGHT.find((m) => m.id === settings.midnight)?.hint}</p>
    </div>
    <div class="set">
      <span class="set-label">학식 기본 식당</span>
      <div class="seg" role="radiogroup" aria-label="학식 기본 식당">
        {#each PLACES as m (m.id)}
          <button role="radio" aria-checked={settings.mealPlace === m.id} class:on={settings.mealPlace === m.id} disabled={!accountPreferences.loaded} onclick={() => setMealPlace(m.id)}>{m.label}</button>
        {/each}
      </div>
    </div>
    <div class="set">
      <span class="set-label">주간 시간표</span>
      <div class="seg" role="radiogroup" aria-label="주간 시간표">
        <button role="radio" aria-checked={settings.timetableDisplay === 'fit'} class:on={settings.timetableDisplay === 'fit'} disabled={!accountPreferences.loaded} onclick={() => setTimetableDisplay('fit')}>최적화 표시</button>
        <button role="radio" aria-checked={settings.timetableDisplay === 'full'} class:on={settings.timetableDisplay === 'full'} disabled={!accountPreferences.loaded} onclick={() => setTimetableDisplay('full')}>전체 표시</button>
      </div>
      <p class="set-hint muted">{settings.timetableDisplay === 'full'
        ? '공강을 포함한 전체 시간표를 표시해요.'
        : '앞뒤 공강을 줄여 시간표를 표시해요.'}</p>
    </div>
    <div class="set">
      <span class="set-label">학기 표시</span>
      <div class="seg" role="group" aria-label="학기 표시">
        <button aria-pressed={settings.semesterDisplay === 'current'} class:on={settings.semesterDisplay === 'current'} disabled={!accountPreferences.loaded} onclick={() => setSemesterDisplay('current')}>현재 학기</button>
        <button aria-pressed={settings.semesterDisplay === 'all'} class:on={settings.semesterDisplay === 'all'} disabled={!accountPreferences.loaded} onclick={() => setSemesterDisplay('all')}>전체 학기</button>
      </div>
      <p class="set-hint muted">{settings.semesterDisplay === 'current'
        ? '현재 학기만 표시해요.'
        : '지난 학기까지 모두 표시해요.'}</p>
    </div>
    <div class="set">
      <span class="set-label">마감일 없는 과제 표시<Switch checked={settings.showUndatedAssignments} label="마감일 없는 과제 표시" disabled={!accountPreferences.loaded} onchange={setShowUndatedAssignments} /></span>
    </div>
  </div>

  <h4 class="section-title">알림</h4>
  <div class="settings card"><NotificationSettings /></div>

  {#if canUpdateApp || !isApp}
    <h4 class="section-title">{isApp ? '앱 업데이트' : '웹 버전'}</h4>
    <div class="settings card">
      <div class="set-label">
        <div class="version-info">
          <span>홍시 {version}</span>
          <span class="commit-hash muted" title={APP_COMMIT || undefined}>{APP_COMMIT ? APP_COMMIT.slice(0, 7) : '커밋 정보 없음'}</span>
        </div>
        {#if canUpdateApp}
          <button class="filter" disabled={appUpdater.checking || appUpdater.installing} onclick={() => appUpdater.check(true)}>{appUpdater.checking ? '확인 중…' : '업데이트 확인'}</button>
        {/if}
      </div>
    </div>
  {/if}


  <h4 class="section-title">계정</h4>
  <div class="settings card">
    <div class="set">
      <button class="btn btn-danger btn-block" disabled={app.loggingOut} onclick={() => confirmLogoutAll = true}><Icon name="logout" size={18} />모든 기기에서 로그아웃</button>
      <p class="set-hint muted">모든 기기에서 로그아웃하고 저장된 로그인 정보를 모두 삭제해요.</p>
    </div>
    <div class="set">
      <button class="btn btn-danger btn-block" disabled={app.loggingOut} onclick={() => confirmDeleteData = true}><Icon name="close" size={18} />모든 데이터 삭제 및 초기화</button>
      <p class="set-hint muted">홍시 서버에서 모든 데이터를 삭제하고 로그아웃해요.</p>
    </div>
  </div>

  {#snippet footer()}
    <button class="btn btn-danger btn-block" disabled={app.loggingOut} onclick={onlogout}><Icon name="logout" size={18} />{app.loggingOut ? '로그아웃하는 중…' : '로그아웃'}</button>
  {/snippet}
</Sheet>

{#if hasStudentCard}<StudentCardSheet bind:open={studentCardOpen} />{/if}

<Sheet bind:open={confirmLogoutAll} title="모든 기기에서 로그아웃할까요?" confirm>
  <div class="logout-confirm">
    <p>모든 기기에서 로그아웃하고 저장된 로그인 정보를 모두 삭제해요.</p>
    <p>서버에 저장된 모든 로그인 정보와 백그라운드 동기화·푸시 알림 등록 정보를 삭제합니다. 오프라인인 기기에 저장된 로그인 정보는 해당 기기가 다시 서버에 연결될 때 삭제합니다.</p>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost w1" disabled={app.loggingOut} onclick={() => confirmLogoutAll = false}>취소</button>
    <button class="btn btn-danger w2" disabled={app.loggingOut} onclick={onlogoutall}>{app.loggingOut ? '로그아웃하는 중…' : '모든 기기에서 로그아웃'}</button>
  {/snippet}
</Sheet>

<Sheet bind:open={confirmDeleteData} title="모든 데이터를 삭제할까요?" confirm>
  <div class="logout-confirm">
    <p>홍시 서버에서 해당 계정 및 생성된 모든 데이터(할 일, 일정, 마감 등)를 삭제해요.<br />모든 기기에서 로그아웃되며, 삭제한 데이터는 복구할 수 없어요.</p>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost w1" disabled={app.loggingOut} onclick={() => confirmDeleteData = false}>취소</button>
    <button class="btn btn-danger w2" disabled={app.loggingOut} onclick={ondeletedata}>{app.loggingOut ? '삭제하는 중…' : '삭제'}</button>
  {/snippet}
</Sheet>

<style>
  .me {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 20px 16px;
    background: var(--surface-2);
    border-radius: var(--radius);
  }

  .me-info {
    display: grid;
    flex: 1;
    min-width: 0;
    gap: 3px;
    justify-items: start;
  }

  .me-info h3, .me-info p { max-width: 100%; overflow-wrap: anywhere; }
  .me-info .chip { max-width: 100%; white-space: normal; }
  .qr-button { display: grid; place-items: center; flex: none; width: 48px; height: 48px; border-radius: 14px; color: var(--primary); background: var(--surface); }
  .qr-button:active { background: var(--surface-3); }

  h3 {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .me p {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .logout-confirm { display: grid; gap: 12px; }
  .logout-confirm p { font-size: 14px; line-height: 1.7; color: var(--text-2); }

  h4.section-title {
    margin-top: 22px;
  }

  .settings {
    display: grid;
    gap: 20px;
    padding: 18px 16px;
  }

  .set {
    display: grid;
    gap: 8px;
  }

  .set-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 14px;
    font-weight: 650;
    color: var(--text-2);
  }

  .archive-update { display: inline-flex; align-items: center; gap: 5px; min-height: 32px; color: var(--primary); font-size: 12px; font-weight: 650; }
  .archive-update > span { display: flex; }
  .spinning { animation: archive-spin .9s linear infinite; }
  @keyframes archive-spin { to { transform: rotate(360deg); } }
  .set-hint {
    font-size: 12px;
  }

  .version-info { display: grid; gap: 4px; min-width: 0; }
  .commit-hash { font-size: 12px; font-weight: 400; line-height: 1.5; user-select: text; }

  .seg {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: var(--surface-3);
  }

  .seg button {
    min-height: 40px;
    border-radius: 9px;
    font-size: 13.5px;
    font-weight: 650;
    color: var(--text-2);
  }

  .seg button.on {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }

  .me > div { min-width: 0; }
  .me p { overflow-wrap: anywhere; }
  .set + .set { padding-top: 18px; border-top: 1px solid var(--border); }
  .set-label { color: var(--text); }
  .set-hint { line-height: 1.65; }
  @media (max-width: 380px) { .me { gap: 12px; padding-inline: 12px; } .me p { font-size: 12px; } }

</style>
