<script lang="ts">
  type Loadable = {
    data: unknown;
    error: string | null;
  };

  let {
    resource,
    what,
  }: {
    resource: Loadable;
    what: string;
  } = $props();
</script>

{#if resource.error && resource.data === null}
  <div class="retry" role="alert">
    <strong>{what} 불러오지 못했어요.</strong>
  </div>
{/if}

<style>
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
