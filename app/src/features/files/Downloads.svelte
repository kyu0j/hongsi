<script lang="ts">
  import { onMount } from 'svelte';
  import { isApp } from '../../shared/api/api';
  import { downloads, fileErrorText, openDownload, refreshDownloads, revealDownload } from './download-state.svelte';
  import { isCurrentSession, sessionVersion } from '../../shared/state/session';
  import { toastOnce } from '../../shared/state/ui.svelte';
  import { ago } from '../../shared/utils/format';
  import { pressFeedback } from '../../shared/utils/press-feedback';
  import EmptyState from '../../shared/ui/EmptyState.svelte';
  import Icon from '../../shared/ui/Icon.svelte';
  import Sheet from '../../shared/ui/Sheet.svelte';
  const PAGE_SIZE = 10;
  let open = $state(false);
  let visibleCount = $state(PAGE_SIZE);
  let listElement: HTMLUListElement | undefined = $state();
  let moreVisible = $state(false);
  const loadingMore = $derived(open && moreVisible && visibleCount < downloads.list.length);

  function observeMore(node: HTMLElement) {
    const observer = new IntersectionObserver((entries) => {
      moreVisible = entries.some((entry) => entry.isIntersecting);
    }, { root: node.closest('.body'), rootMargin: '0px 0px 80px 0px' });
    observer.observe(node);
    return { destroy: () => { observer.disconnect(); moreVisible = false; } };
  }

  $effect(() => {
    if (!loadingMore) return;
    const nextCount = Math.min(visibleCount + PAGE_SIZE, downloads.list.length);
    const timer = window.setTimeout(() => { visibleCount = nextCount; }, 200);
    return () => window.clearTimeout(timer);
  });

  async function show() {
    const version = sessionVersion();
    listElement?.closest('.body')?.scrollTo({ top: 0 });
    visibleCount = PAGE_SIZE;
    open = true;
    try {
      await refreshDownloads();
    } catch (error) {
      if (open && isCurrentSession(version)) toastOnce(fileErrorText(error, '파일을 확인하지 못했어요.'), 'error');
    }
  }

  onMount(() => {
    if (!isApp) return;
    const refresh = () => {
      if (!document.hidden) void refreshDownloads().catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  });
</script>

<button class="icon-btn press-feedback" use:pressFeedback onclick={show} aria-label="받은 파일" title="받은 파일"><Icon name="inbox" size={23} /></button>
<Sheet bind:open title="받은 파일">
  {#if downloads.list.length}
    <ul class="files" bind:this={listElement}>
      {#each downloads.list.slice(0, visibleCount) as d, i (d.id + d.at)}
        <li class:added={i >= PAGE_SIZE}>
          <span class="ficon"><Icon name="file" size={18} /></span>
          <div class="finfo">
            <strong>{d.name}</strong>
            <span class="muted">{d.course} · {ago(d.at / 1000)}</span>
          </div>
          <div class="fbtns" class:one={!isApp}>
            <button class="btn btn-soft sm" onclick={() => openDownload(d)}>바로 열기</button>
            {#if isApp}
              <button class="btn btn-ghost sm" onclick={() => revealDownload(d)}>폴더에서 열기</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if visibleCount < downloads.list.length}
      <div class="load-more" use:observeMore>
        {#if loadingMore}<span class="spin" role="status" aria-label="파일 목록 불러오는 중"><Icon name="refresh" size={22} /></span>{/if}
      </div>
    {/if}
  {:else}
    <EmptyState message="아직 받은 파일이 없어요." detail="과제 상세에서 첨부 파일을 다운로드하면 여기에 모여요." />
  {/if}

</Sheet>
<style>
  .load-more {
    display: grid;
    place-items: center;
    height: 48px;
    color: var(--text-3);
    overflow-anchor: none;
  }

  .added { animation: appear 180ms ease-out; }

  @keyframes appear {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .added { animation: none; }
  }

  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    align-items: center;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--surface-2);
  }

  .ficon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--primary-weak);
    color: var(--primary-text);
  }

  .finfo {
    display: grid;
    min-width: 0;
  }

  .finfo strong {
    font-size: 14px;
    font-weight: 650;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .finfo span {
    font-size: 12px;
  }

  .fbtns {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .fbtns.one {
    grid-template-columns: 1fr;
  }

  .sm {
    min-height: 40px;
    font-size: 13.5px;
    border-radius: 10px;
  }

</style>
