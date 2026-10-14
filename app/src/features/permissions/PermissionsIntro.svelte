<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isApp } from '../../platform/env';
  import { app } from '../auth/auth-state.svelte';
  import { isCurrentSession, sessionVersion } from '../../shared/state/session';
  import { notificationState, notificationsAllowed } from '../notifications/notify';
  import { refreshBackground } from '../notifications/background.svelte';
  import { configureLocationPermission, locationAccess, locationPermissionText, refreshLocationPermission, watchLocationPermission } from './location-permission.svelte';
  import Icon from '../../shared/ui/Icon.svelte';
  import Sheet from '../../shared/ui/Sheet.svelte';

  const INTRO_KEY = 'hc:pref:permissions-intro';
  let open = $state(false);
  let notificationBusy = $state(false);
  const busy = $derived(notificationBusy || locationAccess.busy);

  onMount(() => {
    try { if (localStorage.getItem(INTRO_KEY) === '1') return; } catch { }
    let disposed = false;
    void Promise.all([notificationsAllowed(), refreshLocationPermission()]).then(() => {
      if (disposed || !app.profile || app.loggingOut) return;
      const settled = (permission: string) => permission === 'granted' || permission === 'unsupported';
      open = !settled(notificationState.permission) || !settled(locationAccess.permission);
      try { localStorage.setItem(INTRO_KEY, '1'); } catch { }
    });
    return () => { disposed = true; };
  });

  $effect(() => { if (app.loggingOut) open = false; });
  $effect(() => { if (open) return untrack(watchLocationPermission); });

  async function allowNotifications() {
    if (notificationBusy || app.loggingOut) return;
    const version = sessionVersion();
    notificationBusy = true;
    try {
      await notificationsAllowed(true);
      if (isCurrentSession(version) && !app.loggingOut) await refreshBackground(true);
    } finally { notificationBusy = false; }
  }
</script>

<Sheet bind:open title="권한 안내" confirm closeDisabled={busy} onbeforeclose={() => !busy}>
  <div class="permission-info">
    <div class="permission-card">
      <div class="permission-head">
        <span class="permission-name"><span class="permission-icon"><Icon name="bell" size={21} /></span><strong>알림</strong><span class="optional">선택</span></span>
        {#if notificationState.permission === 'granted'}
          <span class="allowed"><Icon name="tick" size={14} />허용됨</span>
        {:else if notificationState.permission !== 'unsupported'}
          <button class="filter" disabled={busy || app.loggingOut} onclick={allowNotifications}>{notificationBusy ? '확인 중…' : notificationState.permission === 'denied' ? '다시 확인' : '허용하기'}</button>
        {/if}
      </div>
      <p>새 알림과 마감 시간을 알려드려요.</p>
      {#if notificationState.permission === 'denied'}<p class="hint">{isApp ? '기기 설정에서 알림을 허용해 주세요.' : '브라우저 설정에서 알림을 허용해 주세요.'}</p>{/if}
      {#if notificationState.permission === 'unsupported'}<p class="hint">알림을 지원하지 않는 환경이에요.</p>{/if}
      {#if notificationState.error}<p class="error" role="alert">{notificationState.error}</p>{/if}
    </div>
    <div class="permission-card">
      <div class="permission-head">
        <span class="permission-name"><span class="permission-icon"><Icon name="pin" size={21} /></span><strong>위치</strong><span class="optional">선택</span></span>
        {#if locationAccess.permission === 'granted'}
          <span class="allowed"><Icon name="tick" size={14} />허용됨</span>
        {:else if locationAccess.permission !== 'unsupported'}
          <button class="filter" disabled={busy || app.loggingOut} onclick={configureLocationPermission}>{locationAccess.busy ? '확인 중…' : locationAccess.permission === 'denied' ? '권한 설정' : '허용하기'}</button>
        {/if}
      </div>
      <p>출결할 때 현재 위치를 확인해요.</p>
      {#if locationAccess.permission === 'denied' || locationAccess.permission === 'unsupported'}<p class="hint">{locationPermissionText[locationAccess.permission]}</p>{/if}
      {#if locationAccess.error}<p class="error" role="alert">{locationAccess.error}</p>{/if}
    </div>
  </div>
  {#snippet footer()}
    <button class="btn btn-primary btn-block" disabled={busy} onclick={() => open = false}>확인</button>
  {/snippet}
</Sheet>

<style>
  .permission-info { display: grid; gap: 12px; }
  .permission-card { padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
  .permission-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .permission-name { display: flex; align-items: center; gap: 7px; }
  .permission-icon { display: grid; place-items: center; color: var(--primary); }
  strong { font-size: 15px; color: var(--text); }
  .optional { font-size: 11px; color: var(--text-3); }
  .permission-head button { flex: none; }
  .allowed { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--ok); }
  .permission-card p { font-size: 13px; color: var(--text); line-height: 1.6; }
  .permission-card .hint { margin-top: 6px; }
  .hint { font-size: 12px; color: var(--text-2); line-height: 1.6; }
  .permission-card .hint { color: var(--text-2); font-size: 12px; }
  .permission-card .error { margin-top: 6px; color: var(--danger); }
</style>
