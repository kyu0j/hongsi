<script lang="ts">
  import dependencies from 'virtual:dependency-info';
  import Icon from '../../shared/ui/Icon.svelte';
  import Sheet from '../../shared/ui/Sheet.svelte';

  let { open = $bindable(false) }: { open: boolean } = $props();

  const sources = [
    { name: '학교 지도 정보', url: 'https://everytime.kr/370446/v/396085680' },
    { name: '지도 데이터', url: 'https://www.openstreetmap.org/copyright' },
  ];
</script>

<Sheet bind:open title="오픈소스 라이선스">
  <section>
    <h4 class="section-title">지도 출처</h4>
    <div class="card links">
      {#each sources as source (source.url)}
        <a href={source.url} target="_blank" rel="noopener noreferrer">
          <span class="entry">{source.name}</span>
          <Icon name="external" size={17} />
        </a>
      {/each}
    </div>
  </section>
  <section>
    <h4 class="section-title">의존성</h4>
    <div class="groups">
      {#each dependencies as group (group.id)}
        <details class="card" open={group.id === 'web'}>
          <summary>{group.title}<span class="count muted">{group.items.length}</span><span class="chevron"><Icon name="down" size={17} /></span></summary>
          <div class="links">
            {#each group.items as item (item.name)}
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <span class="entry">{item.name}</span>
                <Icon name="external" size={17} />
              </a>
            {/each}
          </div>
        </details>
      {/each}
    </div>
  </section>
</Sheet>

<style>
  section + section { margin-top: 24px; }
  section:first-child > .section-title { margin-top: 2px; }
  .links a { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 14px 16px; color: var(--text); text-decoration: none; text-align: left; }
  .links a + a { border-top: 1px solid var(--border); }
  .links a:active { background: var(--surface-2); }
  .entry { flex: 1; min-width: 0; font-size: 14px; overflow-wrap: anywhere; }
  .links a :global(svg) { flex: none; color: var(--text-3); }
  .groups { display: grid; gap: 10px; }
  summary { display: flex; align-items: center; gap: 8px; padding: 16px; cursor: pointer; list-style: none; font-size: 14px; font-weight: 650; text-align: left; }
  summary::-webkit-details-marker { display: none; }
  .count { margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; }
  .chevron { display: flex; flex: none; }
  details[open] .chevron { transform: rotate(180deg); }
  details[open] > .links { border-top: 1px solid var(--border); }
</style>
