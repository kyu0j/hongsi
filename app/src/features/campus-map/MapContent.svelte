<script lang="ts">
  import { onMount } from 'svelte';
  import { mapLocationAccess } from '../../platform/location';
  import { createMapTracking } from '../../platform/map-tracking';
  import { createLocationFilter, type LocationFix } from './location-filter';
  import { angleDifference } from './map-camera';
  import { toastOnce } from '../../shared/state/ui.svelte';
  import Icon from '../../shared/ui/Icon.svelte';
  import Popover from '../../shared/ui/Popover.svelte';
  import Switch from '../../shared/ui/Switch.svelte';
  import { buildingById, buildingLabel, buildingRoutes, campus, floorLabel, guide, guideLinkLabel, highlightedLabel, routeLabel, type MapSelection } from './campus-data';
  import { facilityLabels } from './facility-icons';
  import FacilityIcon from './FacilityIcon.svelte';
  import { createCampusMap } from './map-renderer';
  import { facilityKinds, loadMapLayers, saveMapLayers, type MapLayer } from './map-layers';

  let { settingsAnchor, settingsOpen = $bindable(false), outsideMap = $bindable(false) }: { settingsAnchor: HTMLButtonElement | null; settingsOpen?: boolean; outsideMap?: boolean } = $props();

  let stage: HTMLDivElement;
  let layers = $state(loadMapLayers());
  let map = $state.raw<ReturnType<typeof createCampusMap> | null>(null);
  let selection = $state<MapSelection | null>(null);
  let scaleMeters = $state(50), scalePixels = $state(70);
  let locating = $state(false);
  let mode = $state<'free' | 'north' | 'heading'>('free');
  let rotation = $state(0);
  let locate = $state<() => void>(() => {});
  let pointNorth = $state<() => void>(() => {});
  const locateLabel = $derived(mode === 'free' ? '현재 위치 추적' : mode === 'north' ? '방향에 따라 지도 회전' : '위치 추적 해제');
  const building = $derived(selection?.kind === 'building' ? buildingById[selection.id] : undefined);
  const route = $derived(selection?.kind === 'route' ? campus.routes.find((r) => r.id === selection?.id) : undefined);
  const routes = $derived(building ? buildingRoutes(building.id) : []);
  const info = $derived(building ? guide.buildings[building.id] : undefined);
  const entranceFloors = $derived.by(() => {
    const seen = new Set<string>();
    return building ? guide.entrances.filter((e) => {
      if (e.b !== building.id || seen.has(`${e.floor}:${e.closed}`)) return false;
      seen.add(`${e.floor}:${e.closed}`); return true;
    }) : [];
  });
  const placeFloors = $derived(info ? [...new Set(info.places.map((p) => p.floor))] : []);
  const neighbors = $derived(building ? [...new Set(campus.connections.filter((c) => c.a !== c.b && (c.a === building.id || c.b === building.id)).map((c) => c.a === building.id ? c.b : c.a))] : []);
  const availableFacilities = facilityKinds.filter((kind) => campus.facilities.some((f) => f.kind === kind));
  const legend = $derived(availableFacilities.filter((kind) => layers[kind]));
  const routeTags = $derived(route ? [
    ...(route.segments.length && route.segments.every((s) => s.indoor) ? ['실내 복도'] : []),
    ...(route.segments.some((s) => s.bridge) ? ['보행교'] : []),
    ...(route.segments.some((s) => s.highway === 'steps') ? ['계단 포함'] : []),
    ...(route.segments.some((s) => !s.indoor) ? ['실외 포함'] : []),
  ] : []);

  $effect(() => { map?.select(selection); });
  $effect(() => { map?.setLayers(layers); });
  $effect(() => { map?.track(mode); });

  function changeLayer(kind: MapLayer, enabled: boolean) {
    layers = { ...layers, [kind]: enabled };
    saveMapLayers(layers);
  }

  onMount(() => {
    const renderer = createCampusMap(stage, (value) => { selection = value; }, (meters, pixels) => { scaleMeters = meters; scalePixels = pixels; }, layers,
      (angle) => { rotation = angle; }, () => { setMode('free'); });
    map = renderer;
    let disposed = false, paused = false, started = false, revision = 0, precise: boolean | null = null, startedAt = 0;
    let last: LocationFix | null = null, heading: number | null = null;
    let headingTimer: ReturnType<typeof setTimeout> | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined;
    const filter = createLocationFilter();
    const notices = new Set<string>();
    function notifyLocation(message: string) {
      if (notices.has(message)) return;
      notices.add(message);
      toastOnce(message);
    }
    const sensors = createMapTracking((event) => {
      if (disposed || paused || document.hidden) return;
      if (event.type === 'error') {
        locating = false; outsideMap = false; notifyLocation(event.message); sensors.stop(); started = false;
        clearTimeout(retryTimer); retryTimer = setTimeout(() => { void start(false); }, 3000); return;
      }
      if (event.type === 'heading') {
        if (mode !== 'heading' || !Number.isFinite(event.heading) || event.accuracy < 0 || event.accuracy > 60) return;
        clearTimeout(headingTimer);
        if (heading !== null && Math.abs(angleDifference(heading, event.heading)) < 1.5) return;
        heading = heading === null ? event.heading : (heading + angleDifference(heading, event.heading) * .35 + 360) % 360;
        renderer.heading(heading); return;
      }
      const point = filter(event.position);
      if (!point) return;
      last = point; locating = false;
      outsideMap = !renderer.locate(point);
    });

    function setMode(next: typeof mode) {
      if (mode === next) return;
      if (next !== 'heading') {
        clearTimeout(headingTimer); heading = null; renderer.heading(null);
        if (mode === 'heading') void sensors.heading(false).catch(() => {});
      }
      mode = next;
    }

    pointNorth = () => { if (mode === 'heading') setMode('north'); renderer.north(); };

    function waitForHeading() {
      clearTimeout(headingTimer);
      headingTimer = setTimeout(() => {
        if (mode === 'heading' && heading === null) { setMode('north'); notifyLocation('이 기기에서는 방향을 확인할 수 없어요.'); }
      }, 5000);
    }

    async function start(request: boolean) {
      if (disposed || paused || document.hidden) return;
      clearTimeout(retryTimer);
      const current = revision;
      try {
        const access = await mapLocationAccess(request);
        if (disposed || paused || current !== revision || document.hidden) return;
        precise = access.precise;
        if (access.permission !== 'granted' && access.permission !== 'unknown') {
          outsideMap = false;
          if (request) throw new Error(access.permission === 'unsupported' ? '이 기기에서는 위치를 확인할 수 없어요.' : '위치 권한을 허용해 주세요.');
          return;
        }
        locating = !last; startedAt = Date.now();
        if (precise === false) notifyLocation('정확한 위치 권한을 허용해 주세요.');
        await sensors.start();
        if (disposed || paused || current !== revision || document.hidden) return;
        started = true;
        if (mode === 'heading') {
          heading = null; renderer.heading(null);
          if (!await sensors.heading(true)) setMode('north'); else waitForHeading();
        }
      } catch (error) {
        if (!disposed && current === revision) {
          locating = false; outsideMap = false; setMode('free');
          notifyLocation(error instanceof Error ? error.message : '현재 위치를 확인하지 못했어요. 다시 시도해 주세요.');
        }
      }
    }

    locate = () => {
      if (mode === 'heading') { setMode('free'); return; }
      notices.clear();
      if (mode === 'free' || !started) { setMode('north'); void start(true); return; }
      void sensors.heading(true).then((available) => {
        if (disposed || document.hidden || mode !== 'north' || !started) { void sensors.heading(false); return; }
        if (!available) { void sensors.heading(false); notifyLocation('이 기기에서는 방향을 확인할 수 없어요.'); return; }
        setMode('heading');
        waitForHeading();
      }).catch(() => { if (!disposed) notifyLocation('방향 센서 권한을 허용해 주세요.'); });
    };
    const visibility = () => {
      revision++;
      if (document.hidden) { sensors.stop(); started = false; clearTimeout(headingTimer); clearTimeout(retryTimer); }
      else void start(false);
    };
    const pause = () => { paused = true; revision++; sensors.stop(); started = false; clearTimeout(headingTimer); clearTimeout(retryTimer); };
    const resume = () => { paused = false; revision++; void start(false); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('hongsi-pause', pause);
    window.addEventListener('hongsi-resume', resume);
    const timer = setInterval(() => {
      if (disposed || document.hidden) return;
      if (last && Date.now() - last.timestamp > 20_000) { last = null; outsideMap = false; renderer.locate(null); }
      if (started && !last && Date.now() - startedAt > 15_000) {
        locating = false; notifyLocation(precise === false ? '정확한 위치 권한을 허용해 주세요.' : '현재 위치를 확인하지 못했어요. 다시 시도해 주세요.');
      }
    }, 1000);
    void start(false);
    return () => {
      disposed = true; revision++; clearInterval(timer); clearTimeout(headingTimer); clearTimeout(retryTimer); sensors.stop();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('hongsi-pause', pause);
      window.removeEventListener('hongsi-resume', resume);
      renderer.destroy(); map = null;
    };
  });
</script>

<Popover anchor={settingsAnchor} bind:open={settingsOpen} placement="bottom" label="지도 표시 설정">
  <div class="map-layer-settings">
    <div class="layer-setting"><span><Icon name="enter" size={17} />출입구</span><Switch label="출입구 표시" checked={layers.entrances} onchange={(value) => changeLayer('entrances', value)} /></div>
    {#each availableFacilities as kind}
      <div class="layer-setting"><span><FacilityIcon {kind} size={17} />{facilityLabels[kind]}</span><Switch label="{facilityLabels[kind]} 표시" checked={layers[kind]} onchange={(value) => changeLayer(kind, value)} /></div>
    {/each}
  </div>
</Popover>
<div class="campus-map-stage" bind:this={stage} data-sheet-no-drag tabindex="-1" role="group" aria-label="학교 지도 조작">
  <canvas class="map-background" aria-hidden="true"></canvas>
  <svg class="map-canvas" role="img" aria-label="홍익대학교 지도">
    <title>홍익대학교 지도</title>
    <desc>동이나 연결선을 선택하면 아래에 상세 정보가 표시됩니다. 확대하면 출입구 층수와 건물 내부 시설이 표시됩니다.</desc>
  </svg>
  <div class="label-layer"></div>
  <div class="facility-layer"></div>
  <div class="entrance-layer"></div>
  <div class="current-location-layer" role="img" aria-label="현재 위치" hidden><span class="location-accuracy"></span><span class="location-heading" hidden><svg viewBox="-36 -36 72 72" aria-hidden="true"><path d="M0 0-24-32a40 40 0 0 1 48 0Z" fill="currentColor" opacity=".2" /></svg></span><span class="location-dot"></span></div>
  <div class="map-controls">
    <button onclick={() => map?.zoom(1.4)} aria-label="지도 확대"><Icon name="plus" size={18} /></button>
    <button onclick={() => map?.zoom(1 / 1.4)} aria-label="지도 축소"><Icon name="minus" size={18} /></button>
  </div>
  <button class="north" onclick={pointNorth} aria-label="북쪽을 위로" title="북쪽을 위로"><span style:transform="rotate({rotation}deg)"><Icon name="north" size={16} /></span>N</button>
  <button class="locate-user" data-mode={mode} onclick={locate} aria-label={locateLabel} title={locateLabel} aria-busy={locating} aria-pressed={mode !== 'free'}>
    <Icon name={mode === 'heading' ? 'navigation' : 'locate'} size={20} />
  </button>
  <div class="map-scale" aria-hidden="true"><div class="scale-rule" style:width="{scalePixels}px"></div>{scaleMeters} m</div>
</div>
<div class="map-legend" aria-label="지도 범례" hidden={!layers.entrances && !legend.length}>
  {#if layers.entrances}
  <span><span class="entrance-key">1</span>출입구 층</span>
  <span><span class="entrance-key">R</span>옥상</span>
  <span><span class="entrance-key closed">×</span>통행 불가 표기</span>
  {/if}
  {#each legend as kind}<span><FacilityIcon {kind} size={14} />{facilityLabels[kind]}</span>{/each}
</div>
<div class="detail" role="region" aria-label="선택한 지도 정보" aria-live="polite">
  {#if building}
    <div class="detail-top"><span class="detail-kicker">{buildingLabel(building.id)}</span><strong class="detail-title">{building.name.replace(/\([^)]*\)/g, '')}</strong></div>
    {#if entranceFloors.length}
      <div class="building-section">
        <div class="section-heading">출입구</div>
        <div class="entrance-floors">{#each entranceFloors as entrance}<span class:closed={entrance.closed}>{floorLabel(entrance.floor)}{entrance.closed ? ' · 통행 불가 표기' : ''}</span>{/each}</div>
      </div>
    {/if}
    {#if info?.places.length}
      <div class="building-section">
        <div class="section-heading">시설</div>
        <div class="place-list">
          {#each placeFloors as floor}
            <div class="place-floor"><strong>{floorLabel(floor)}</strong><div class="floor-places">{#each info.places.filter((p) => p.floor === floor) as place}<span class="place"><FacilityIcon kind={place.kind} size={15} /><span>{place.name}</span></span>{/each}</div></div>
          {/each}
        </div>
      </div>
    {/if}
    {#if neighbors.length}<div class="connected-row"><span>연결 동</span>{#each neighbors as id}<button class="building-chip" onclick={() => { selection = { kind: 'building', id }; }}>{buildingLabel(id)}</button>{/each}</div>{/if}
    {#if routes.length}
      <div class="building-routes">
        <div class="routes-heading">경로</div>
        <div class="building-route-list">
          {#each routes as item (item.id)}
            {@const label = routeLabel(item)}
            <button class="building-route" onclick={() => { selection = { kind: 'route', id: item.id }; }} aria-label="{label} 경로 보기">
              <span class="building-route-title">{#each highlightedLabel(label, building.id) as part}{#if part.selected}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</span>
              <span class="building-route-meta"><span>{item.stops[0] === building.id ? '출발' : item.stops.at(-1) === building.id ? '도착' : '경유'}</span><Icon name="right" size={13} /></span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  {:else if route}
    <div class="detail-top"><span class="detail-kicker">{route.geometryStatus === 'mapped' ? `표시 구간 약 ${route.pathMeters} m` : '출입구·연결층 안내'}</span><strong class="detail-title">{routeLabel(route)}</strong></div>
    {#if routeTags.length}<div class="route-tags">{#each routeTags as tag}<span>{tag}</span>{/each}</div>{/if}
    {#if route.guideLinks?.length}
      <div class="guide-links">
        <div class="section-heading">연결층</div>
        {#each route.guideLinks as link}<div class="guide-link"><strong>{guideLinkLabel(link)}</strong></div>{/each}
      </div>
    {/if}
  {:else}
    <div class="empty-detail">지도에서 동이나 경로를 선택해 주세요.</div>
  {/if}
</div>

<style>
  .map-layer-settings { width: 240px; max-width: calc(100vw - 46px); max-height: min(440px, 60dvh); overflow-y: auto; overscroll-behavior: contain; }
  .layer-setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 42px; }
  .layer-setting > span { display: inline-flex; align-items: center; gap: 9px; font-size: 13px; color: var(--text-2); }
  .layer-setting > span :global(svg) { flex: none; color: var(--primary); }
  .campus-map-stage {
    --map-building: color-mix(in srgb, var(--border) 80%, var(--surface));
    --map-outline: color-mix(in srgb, var(--text-3) 45%, var(--border));
    --map-road: var(--text-3);
    position: relative;
    overflow: clip;
    touch-action: none;
    contain: layout paint;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 18px;
  }
  .map-background { position: absolute; left: 0; top: 0; z-index: 0; transform-origin: 0 0; pointer-events: none; will-change: transform; }
  .map-canvas { position: relative; z-index: 1; display: block; width: 100%; }
  .label-layer, .facility-layer, .entrance-layer { position: absolute; inset: 0; pointer-events: none; will-change: transform; }
  .label-layer { z-index: 3; }
  .facility-layer { z-index: 1; }
  .entrance-layer { z-index: 2; }
  .campus-map-stage :global(.node-anchor) { position: absolute; left: 0; top: 0; display: flex; align-items: center; justify-content: center; white-space: nowrap; pointer-events: auto; }
  .campus-map-stage :global(.node-anchor[hidden]) { display: none; }
  .campus-map-stage :global(.building-button) { display: inline-flex; align-items: center; justify-content: center; padding: 1px 4px; font-size: 11px; line-height: 16px; border: 1px solid color-mix(in srgb, var(--primary) 72%, var(--border)); border-radius: 5px; background: var(--bg); color: var(--text); font-weight: 500; }
  .campus-map-stage :global(.building-button[aria-pressed='true']) { background: var(--primary-weak); border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); color: var(--primary-text); font-weight: 750; }
  .campus-map-stage :global(.facility-marker) { position: absolute; left: 0; top: 0; display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; pointer-events: none; color: var(--primary); }
  .campus-map-stage :global(.facility-marker[hidden]) { display: none; }
  .campus-map-stage :global(.facility-marker.estimated) { opacity: .65; }
  .campus-map-stage :global(.facility-marker.pending) { opacity: .3; }
  .campus-map-stage :global(.entrance-marker), .entrance-key { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 3px; border-radius: 50%; font-size: 10px; line-height: 1; font-weight: 700; background: var(--info); color: var(--surface); }
  .campus-map-stage :global(.entrance-marker) { position: absolute; left: 0; top: 0; pointer-events: none; box-shadow: 0 0 0 1px var(--surface); }
  .campus-map-stage :global(.entrance-marker[hidden]) { display: none; }
  .campus-map-stage :global(.entrance-marker.closed), .entrance-key.closed { background: var(--text-3); }
  .map-legend { display: flex; flex-wrap: wrap; gap: 8px 12px; padding-top: 12px; font-size: 10px; line-height: 1.4; color: var(--text-3); }
  .map-legend[hidden] { display: none; }
  .map-legend > span { display: inline-flex; align-items: center; gap: 4px; }
  .map-legend :global(svg) { color: var(--primary); }
  .map-legend .entrance-key { min-width: 14px; height: 14px; font-size: 8px; padding: 0 2px; }
  .map-controls { position: absolute; z-index: 3; top: 12px; left: 12px; display: flex; flex-direction: column; gap: 5px; }
  .map-controls button, .locate-user { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface); color: var(--text-2); }
  .locate-user { position: absolute; bottom: 36px; right: 12px; z-index: 5; color: var(--primary); }
  .locate-user[data-mode='north'] { border-color: var(--primary); background: var(--primary-weak); }
  .locate-user[data-mode='heading'] { border-color: var(--primary); background: var(--primary); color: var(--on-primary, #fff); }
  .current-location-layer { position: absolute; inset: 0; z-index: 4; pointer-events: none; color: var(--info); }
  .location-accuracy { position: absolute; left: 0; top: 0; border-radius: 50%; background: color-mix(in srgb, currentColor 15%, transparent); border: 1px solid color-mix(in srgb, currentColor 35%, transparent); }
  .location-dot { position: absolute; left: 0; top: 0; width: 15px; height: 15px; border-radius: 50%; background: currentColor; border: 3px solid var(--surface); box-shadow: 0 1px 5px rgb(0 0 0 / 25%); }
  .location-heading { position: absolute; left: 0; top: 0; width: 72px; height: 72px; }
  .location-heading :global(svg) { width: 100%; height: 100%; }
  .north { position: absolute; z-index: 5; top: 12px; right: 12px; display: flex; width: 36px; height: 42px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); flex-direction: column; align-items: center; justify-content: center; color: var(--text-3); font-size: 10px; }
  .map-controls, .north { transform: translateZ(0); }
  .north > span { display: flex; }
  .map-scale { position: absolute; bottom: 10px; right: 12px; text-align: center; font-size: 10px; color: var(--text-2); }
  .scale-rule { height: 5px; border: 1px solid var(--text-2); border-top: 0; }
  .detail { padding: 18px 0 0; min-height: 130px; }
  .detail-top { margin-bottom: 13px; }
  .detail-title { display: block; font-size: 17px; line-height: 1.4; font-weight: 750; letter-spacing: -.02em; }
  .detail-kicker { display: block; font-size: 11px; color: var(--primary-text); font-weight: 650; margin-bottom: 3px; }
  .building-section { margin-bottom: 17px; }
  .section-heading { font-size: 12px; color: var(--text-3); margin-bottom: 8px; }
  .entrance-floors { display: flex; flex-wrap: wrap; gap: 6px; }
  .entrance-floors > span { padding: 3px 7px; border-radius: 6px; background: var(--info-weak); color: var(--info); font-size: 11px; }
  .entrance-floors > span.closed { background: var(--surface-3); color: var(--text-3); }
  .place-list { display: grid; gap: 1px; border-radius: 10px; overflow: hidden; }
  .place-floor { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 10px; padding: 10px; background: var(--surface-2); font-size: 12px; line-height: 1.6; }
  .place-floor > strong { color: var(--text-2); font-weight: 650; }
  .floor-places { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 14px; }
  .place { display: inline-flex; align-items: flex-start; gap: 6px; min-width: 0; }
  .place :global(svg) { margin-top: 2px; color: var(--primary); }
  .place > span { min-width: 0; overflow-wrap: anywhere; }
  .guide-links { margin-top: 16px; }
  .guide-link { padding: 10px; border-radius: 8px; background: var(--surface-2); margin-bottom: 6px; font-size: 12px; line-height: 1.6; }
  .guide-link strong { color: var(--primary-text); font-weight: 650; }
  .building-routes { margin-bottom: 17px; }
  .routes-heading { font-size: 12px; color: var(--text-3); margin-bottom: 8px; }
  .building-route-list { display: flex; flex-direction: column; gap: 6px; }
  .building-route { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 12px; text-align: left; padding: 9px 10px; border-radius: 8px; background: var(--surface-2); }
  .building-route-title { font-size: 12px; line-height: 1.6; color: var(--text-2); overflow-wrap: anywhere; min-width: 0; }
  .building-route-title strong { font-weight: 800; color: var(--text); }
  .building-route-meta { display: grid; grid-template-columns: auto 13px; align-items: center; gap: 1px 5px; flex: none; text-align: right; color: var(--primary-text); font-size: 11px; line-height: 1.6; }
  .building-route-meta > span { grid-column: 1; }
  .building-route-meta :global(svg) { grid-column: 2; grid-row: 1 / span 2; color: var(--text-3); }
  .connected-row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 12px; color: var(--text-3); margin-bottom: 12px; }
  .building-chip { padding: 3px 9px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-2); font-size: 12px; }
  .route-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .route-tags span { border-radius: 6px; background: var(--surface-2); padding: 3px 8px; font-size: 11px; color: var(--text-2); }
  .empty-detail { display: grid; place-items: center; min-height: 112px; color: var(--text-3); font-size: 13px; text-align: center; }
  @media (pointer: coarse) { .map-controls button, .locate-user { width: 42px; height: 42px; } }
</style>
