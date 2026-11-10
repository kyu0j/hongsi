<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import { net, retry, trouble, TROUBLE_TEXT } from '../api/net.svelte';
  import Icon from './Icon.svelte';

  let { topbarHeight }: { topbarHeight: number } = $props();

  const t = $derived(trouble());
  const disconnected = $derived(t !== null);
  const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
  let visible = $state(false);
  const ICON = { offline: 'wifi-off', server: 'cloud-off', school: 'cloud-off' } as const;

  $effect(() => {
    if (!disconnected) {
      visible = false;
      return;
    }
    const timer = setTimeout(() => { visible = true; }, 2_000);
    return () => clearTimeout(timer);
  });

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

<div class="connection-layer" style:top={`${topbarHeight + 8}px`} use:portal>
  {#if visible && t}
    <div
      class="banner"
      role="status"
      in:fly={{ y: -8, duration: reducedMotion.current ? 0 : 280, easing: cubicOut }}
      out:fly={{ y: -8, duration: reducedMotion.current ? 0 : 180, easing: cubicOut }}
    >
      <span class="ico"><Icon name={ICON[t]} size={17} stroke={2} /></span>
      <p>
        <strong>{TROUBLE_TEXT[t].title}</strong>
      </p>
      <button class="again" onclick={() => retry()} disabled={net.checking} aria-label="연결 다시 확인">
        <span class:spin={net.checking}><Icon name="refresh" size={15} stroke={2.3} /></span>
        <span class="label">{net.checking ? '확인 중' : '다시 시도'}</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .connection-layer {
    position: fixed;
    left: max(12px, var(--safe-l));
    right: max(12px, var(--safe-r));
    max-width: 520px;
    margin-inline: auto;
    z-index: 900;
    pointer-events: none;
  }

  .banner {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    padding: 10px 10px 10px 14px;
    border-radius: 16px;
    background: var(--warn-weak);
    color: var(--warn);
    border: 1px solid color-mix(in srgb, var(--warn) 22%, transparent);
    box-shadow: var(--shadow-lg);
    will-change: transform, opacity;
  }

  .ico {
    display: grid;
    flex: none;
  }

  p {
    flex: 1;
    min-width: 0;
    margin: 0;
    text-align: left;
    font-size: 13px;
    line-height: 1.4;
  }

  strong {
    font-weight: 750;
  }

  .again {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    font-size: 12.5px;
    font-weight: 700;
    box-shadow: var(--shadow-sm);
  }

  .again:disabled {
    cursor: default;
    opacity: 0.8;
  }

  .again span {
    display: grid;
  }

  @media (max-width: 639px) {
    p {
      font-size: 12.5px;
    }
  }
</style>
