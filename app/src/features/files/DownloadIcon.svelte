<script lang="ts">
  let { active = false, size = 17 }: { active?: boolean; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class:active>
  <path class="arrow" d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
  <path d="M5 19.5h14" />
</svg>

<style>
  svg { flex: none; }
  .active .arrow { animation: download-arrow 1.1s ease-in-out infinite; }
  @keyframes download-arrow {
    0% { transform: translateY(-3px); opacity: 0; }
    25%, 55% { opacity: 1; }
    80%, 100% { transform: translateY(3px); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .active .arrow { animation: none; }
  }
</style>
