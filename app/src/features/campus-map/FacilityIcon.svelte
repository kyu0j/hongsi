<script lang="ts">
  import type { FacilityKind } from './campus-data';
  import { facilitySymbol } from './facility-icons';
  let { kind, size = 16 }: { kind: FacilityKind; size?: number } = $props();
  const icon = $derived(facilitySymbol(kind));
</script>

<svg width={size} height={size} viewBox={icon.viewBox} fill={icon.solid ? 'currentColor' : 'none'} stroke={icon.solid ? 'none' : 'currentColor'} stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill-rule="evenodd" aria-hidden="true"><path d={icon.path} /></svg>

<style>
  svg { flex: none; display: block; }
</style>
