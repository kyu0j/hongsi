<script lang="ts">
  import type { Component } from 'svelte';
  import { isAndroid, isIOS } from '../../platform/env';
  import Icon from '../../shared/ui/Icon.svelte';
  import Sheet from '../../shared/ui/Sheet.svelte';
  import { pressFeedback } from '../../shared/utils/press-feedback';
  import { toast } from '../../shared/state/ui.svelte';

  let open = $state(false);
  let loading = $state(false);
  let settingsOpen = $state(false);
  let outsideMap = $state(false);
  let settingsAnchor = $state<HTMLButtonElement | null>(null);
  let Content = $state<Component<{ settingsAnchor: HTMLButtonElement | null; settingsOpen?: boolean; outsideMap?: boolean }> | null>(null);

  async function show() {
    if (loading) return;
    loading = true;
    try {
      Content ??= (await import('./MapContent.svelte')).default;
      settingsOpen = false;
      outsideMap = false;
      open = true;
    } catch {
      toast('지도를 열지 못했어요. 다시 시도해 주세요.', 'error');
    } finally { loading = false; }
  }
</script>

{#if isAndroid || isIOS}
<button class="icon-btn press-feedback" use:pressFeedback onclick={show} aria-label="학교 지도" title="학교 지도" aria-busy={loading}>
  <Icon name="campus-map" size={18} />
</button>
<Sheet bind:open title="학교 지도" onclose={() => { settingsOpen = false; outsideMap = false; }}>
  {#snippet titleActions()}
    <button class="map-settings-button" bind:this={settingsAnchor} onclick={() => { settingsOpen = !settingsOpen; }} aria-label="지도 표시 설정" title="지도 표시 설정" aria-expanded={settingsOpen} aria-haspopup="dialog">
      <Icon name="gear" size={17} />
    </button>
    {#if outsideMap}<p class="map-location-note" role="status">현재 위치가 학교 지도 범위 밖에 있어요.</p>{/if}
  {/snippet}
  {#if Content}<Content {settingsAnchor} bind:settingsOpen bind:outsideMap />{/if}
</Sheet>
{/if}

<style>
  :global(.sheet > header:has(.map-location-note)) { position: relative; }
  .map-location-note { position: absolute; left: 20px; bottom: -2px; max-width: calc(100% - 40px); margin: 0; font-size: 10px; line-height: 12px; color: var(--text-3); white-space: nowrap; pointer-events: none; }
  .map-settings-button { display: grid; place-items: center; flex: none; width: 32px; height: 36px; border-radius: 9px; color: var(--text-3); }
  .map-settings-button[aria-expanded='true'] { color: var(--primary-text); background: var(--primary-weak); }
  @media (hover: hover) { .map-settings-button:hover { color: var(--text); background: var(--surface-2); } }
</style>
