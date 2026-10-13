<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '../../shared/ui/Icon.svelte';

  let { count, children, compact = false }: { count: number; children: Snippet; compact?: boolean } = $props();
</script>

<details class="completed-list" class:compact>
  <summary><span class="completed-arrow"><Icon name="right" size={compact ? 13 : 18} stroke={compact ? 2.2 : 2.6} /></span><span>완료된 항목</span><span class="completed-count">{count}</span></summary>
  {@render children()}
</details>

<style>
  .completed-list { margin-top: 12px; }
  summary { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 10px 0; cursor: pointer; list-style: none; font-size: 15px; font-weight: 700; color: var(--text); }
  summary::-webkit-details-marker { display: none; }
  summary::marker { content: ''; }
  .completed-arrow { display: flex; flex: none; transition: transform 150ms; }
  .completed-list[open] .completed-arrow { transform: rotate(90deg); }
  .compact summary { gap: 7px; padding-inline: 3px; font-size: 13px; font-weight: 600; color: var(--text-2); }
  .completed-count { padding: 0 5px; border-radius: 5px; background: var(--surface-3); color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
