<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../auth/auth-state.svelte';
  import { configureLocationPermission, locationAccess, locationPermissionText, watchLocationPermission } from './location-permission.svelte';

  onMount(watchLocationPermission);
</script>

<div class="location-settings">
  <div class="setting-head">
    <div><strong>위치 권한</strong><p class="hint">{locationPermissionText[locationAccess.permission]}</p></div>
    {#if locationAccess.permission !== 'granted' && locationAccess.permission !== 'unsupported'}
      <button class="filter" disabled={app.loggingOut || locationAccess.busy} onclick={configureLocationPermission}>{locationAccess.busy ? '확인 중…' : '권한 설정'}</button>
    {/if}
  </div>
  {#if locationAccess.error}<p class="error" role="alert">{locationAccess.error}</p>{/if}
</div>

<style>
  .location-settings { display: grid; gap: 12px; }
  .setting-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .setting-head > div { min-width: 0; }
  .setting-head > button { flex: none; }
  strong { font-size: 14px; }
  .hint { margin-top: 4px; font-size: 13px; color: var(--text-2); line-height: 1.6; }
  .error { font-size: 13px; color: var(--danger); line-height: 1.6; }
</style>
