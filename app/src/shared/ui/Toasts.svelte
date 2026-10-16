<script lang="ts">
  import { flip } from 'svelte/animate';
  import { fly } from 'svelte/transition';
  import { dismiss, toasts } from '../state/ui.svelte';
  import { sentenceLines } from '../utils/format';
  import Icon from './Icon.svelte';

  const ICON = { info: 'bell', success: 'tick', error: 'alert', alarm: 'clock' } as const;
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

<div class="toasts" aria-live="polite" use:portal>
  {#each toasts as t (t.id)}
    <button
      class="toast {t.tone}"
      animate:flip={{ duration: 200 }}
      transition:fly={{ y: -16, duration: 220 }}
      onclick={() => { t.action?.(); dismiss(t.id); }}
    >
      <Icon name={ICON[t.tone]} size={18} />
      <span class="toast-copy">
        <span class="toast-title">{t.tone === 'alarm' ? t.text : sentenceLines(t.text)}</span>
        {#if t.detail}<span class="toast-detail">{t.detail}</span>{/if}
      </span>
    </button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 28px);
    left: 16px;
    right: 16px;
    margin-inline: auto;
    z-index: 1000;
    display: grid;
    gap: 8px;
    width: min(480px, calc(100% - 32px));
    max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 56px);
    overflow-y: auto;
    padding: 4px;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 14px;
    background: var(--primary);
    color: var(--on-primary);
    font-size: 14px;
    font-weight: 600;
    text-align: left;
  }

  .toast-copy { min-width: 0; flex: 1; display: grid; gap: 3px; }
  .toast-title { min-width: 0; white-space: pre-line; overflow-wrap: anywhere; }
  .toast.alarm .toast-title, .toast-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toast-detail { font-size: 13px; font-weight: 500; }
  .toast :global(svg) { flex-shrink: 0; }

  .toast.error {
    background: var(--danger);
    color: #fff;
  }

  .toast.success {
    background: var(--ok);
    color: #fff;
  }

  .toast.alarm {
    background: var(--primary);
    color: var(--on-primary);
  }
</style>
