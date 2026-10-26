<script lang="ts">
  import { onMount } from 'svelte';
  import { downloadFile, downloads, fileId, openDownload, refreshDownloads, savedFile } from './download-state.svelte';
  import type { Attachment, FileSource } from '../../shared/types';
  import DownloadIcon from './DownloadIcon.svelte';

  let {
    files,
    source,
    course,
  }: {
    files: Attachment[];
    source: (index: number) => FileSource;
    course: string;
  } = $props();

  onMount(() => { void refreshDownloads().catch(() => {}); });

  const size = (n: number | null) =>
    n === null ? '' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

  function press(index: number) {
    const got = savedFile(source(index));
    if (got) void openDownload(got);
    else void downloadFile(source(index), files[index].name, course);
  }
</script>

<ul class="files">
  {#each files as f, i (i)}
    {@const got = savedFile(source(i))}
    {@const busy = downloads.busy === fileId(source(i))}
    <li class:got>
      <button class="fmain" onclick={() => press(i)} disabled={busy} aria-busy={busy} title={got ? '눌러서 바로 열기' : '눌러서 받기'}>
        <span class="fsize">{size(f.size)}</span>
        <span class="fname">{got?.name ?? f.name}</span>
        <span class="ficon" role={busy ? 'status' : undefined} aria-label={busy ? '다운로드 중' : undefined}>{#if got && !busy}열기{:else}<DownloadIcon active={busy} />{/if}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }

  li {
    display: grid;
    padding: 4px;
    border-radius: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }

  .fmain {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 9px;
    text-align: left;
  }

  .ficon {
    display: inline-flex;
    flex: none;
    font-size: 12px;
    font-weight: 700;
    color: var(--primary-text);
  }

  .got .ficon {
    color: var(--ok);
  }

  .fname {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .fsize {
    flex: none;
    font-size: 12px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

</style>
