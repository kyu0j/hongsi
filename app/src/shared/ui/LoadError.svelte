<script lang="ts">
  import { ago } from '../utils/format';
  import type { Trouble } from '../api/net.svelte';
  import Icon from './Icon.svelte';

  type Loadable = {
    data: unknown;
    at: number;
    error: string | null;
    trouble: Trouble | 'other' | null;
  };

  let {
    resource,
    what,
    stale = true,
  }: {
    resource: Loadable;
    what: string;
    stale?: boolean;
  } = $props();

  const parseError = $derived(['학교 페이지의 정보를 읽지 못했어요', '학교 페이지 형식을 읽지 못했어요'].some((message) => resource.error?.includes(message)));
  const kind = $derived(resource.trouble);
  const conn = $derived(kind === 'offline' || kind === 'server' || kind === 'school' ? kind : null);
</script>

{#if resource.error}
  {#if resource.data !== null}
    {#if stale && resource.at}
      <p class="stale" class:failed={parseError}>
        <Icon name="clock" size={13} stroke={2} />
        {ago(resource.at / 1000)} 정보{conn ? '' : ` · ${parseError ? '불러오지 못했어요.' : resource.error}`}
      </p>
    {/if}
  {:else}
    <div class="retry" role="alert">
      <strong>{what} 불러오지 못했어요.</strong>
    </div>
  {/if}
{/if}

<style>
  .stale {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 4px 10px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-3);
  }

  .stale.failed { color: var(--danger); }

  .retry {
    min-height: 82px;
    border: 1.5px dashed var(--border-strong);
    border-radius: var(--radius);
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px 16px;
    text-align: center;
  }

  .retry strong {
    font-size: 14.5px;
    font-weight: 700;
    text-wrap: balance;
  }

</style>
