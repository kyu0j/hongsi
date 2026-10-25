import { geoContains, geoMercator, geoPath, geoStream, line, polygonContains, select } from 'd3';
import type { Selection } from 'd3';
import { buildingById, buildingLabel, buildings, campus, floorLabel, guide, type Building, type Coordinate, type Entrance, type Facility, type MapLocation, type MapSelection } from './campus-data';
import { facilityLabels, facilitySymbol } from './facility-icons';
import type { MapLayers } from './map-layers';
import { applyView, invertView, mapView, viewMatrix, createMapCamera } from './map-camera';

type Layer = Selection<SVGGElement, unknown, null, undefined>;
type Bounds = { x: number; y: number; w: number; h: number };
type Footprint = Coordinate[][];
type Marker = { el: HTMLElement; anchor: Coordinate; point: Coordinate; footprint?: Footprint };
type Label = Marker & { b: Building; button: HTMLButtonElement; normal: Coordinate; selected: Coordinate };
type FacilityMarker = Marker & { f: Facility; enabled: boolean };
type EntranceMarker = Marker & { e: Entrance; enabled: boolean };

export function createCampusMap(stage: HTMLElement, onselect: (selection: MapSelection | null) => void, onscale: (meters: number, pixels: number) => void, initialLayers: MapLayers, onrotation: (angle: number) => void, oninteraction: () => void) {
  const svg = select(stage.querySelector<SVGSVGElement>('.map-canvas')!);
  const background = stage.querySelector<HTMLCanvasElement>('.map-background')!;
  const context = background.getContext('2d', { alpha: false })!;
  const labels = stage.querySelector<HTMLElement>('.label-layer')!;
  const facilities = stage.querySelector<HTMLElement>('.facility-layer')!;
  const entrances = stage.querySelector<HTMLElement>('.entrance-layer')!;
  const locationLayer = stage.querySelector<HTMLElement>('.current-location-layer')!;
  const locationDot = locationLayer.querySelector<HTMLElement>('.location-dot')!;
  const locationAccuracy = locationLayer.querySelector<HTMLElement>('.location-accuracy')!;
  const locationHeading = locationLayer.querySelector<HTMLElement>('.location-heading')!;
  const footprints = campus.geometry.features.filter((f) => f.properties.k === 'building');
  const areas = campus.geometry.features.filter((f) => !['building', 'highway'].includes(f.properties.k));
  const roads = campus.geometry.features.filter((f) => f.properties.k === 'highway');
  const connections = campus.connections.filter((c) => c.geometryStatus === 'mapped');
  const buildingFootprints = new Map(campus.buildings.map((b) => [b.id, footprints.find((f) => geoContains(f, b.coord))]));
  const facilityFootprints = campus.facilities.map((f) => footprints.find((p) => geoContains(p, f.coord)) ?? buildingFootprints.get(f.b));
  const limits = [Infinity, Infinity, -Infinity, -Infinity];
  geoStream(campus.geometry, {
    point(x, y) { limits[0] = Math.min(limits[0], x); limits[1] = Math.min(limits[1], y); limits[2] = Math.max(limits[2], x); limits[3] = Math.max(limits[3], y); },
    lineStart() {}, lineEnd() {}, polygonStart() {}, polygonEnd() {}, sphere() {},
  });
  const offsets: Coordinate[] = [];
  for (let x = -12; x <= 12; x++) for (let y = -12; y <= 12; y++) offsets.push([x * 4, y * 4]);
  offsets.sort((a, b) => a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2);
  const labelNodes: Label[] = buildings.map((b) => {
    const el = document.createElement('div'), button = document.createElement('button');
    el.className = 'node-anchor'; button.type = 'button'; button.className = 'building-button';
    button.textContent = buildingLabel(b.id); button.setAttribute('aria-label', `${b.name} 정보`);
    button.addEventListener('click', () => onselect({ kind: 'building', id: b.id }));
    el.append(button); labels.append(el);
    return { el, button, b, anchor: [0, 0], point: [0, 0], normal: [0, 0], selected: [0, 0] };
  });
  const facilityNodes: FacilityMarker[] = campus.facilities.map((f) => {
    const el = document.createElement('span');
    el.hidden = true; el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${buildingById[f.b].name} ${facilityLabels[f.kind]}${f.estimated ? ' · 추정 위치' : ''}`);
    el.dataset.kind = f.kind;
    const symbol = facilitySymbol(f.kind);
    const icon = select(el).append('svg').attr('width', 16).attr('height', 16).attr('viewBox', symbol.viewBox).attr('fill', symbol.solid ? 'currentColor' : 'none').attr('stroke', symbol.solid ? 'none' : 'currentColor').attr('stroke-width', 1.8).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round').attr('fill-rule', 'evenodd').attr('aria-hidden', 'true');
    icon.append('path').attr('d', symbol.path);
    facilities.append(el);
    return { el, f, anchor: [0, 0], point: [0, 0], enabled: false };
  });
  const entranceNodes: EntranceMarker[] = guide.entrances.map((e) => {
    const el = document.createElement('span');
    el.className = `entrance-marker${e.closed ? ' closed' : ''}`;
    el.textContent = e.closed ? '×' : e.floor; el.hidden = true; el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${buildingById[e.b].name} ${floorLabel(e.floor)} 출입구${e.closed ? ' · 안내도에서 통행 불가로 표시' : ''} · 추정 위치`);
    entrances.append(el);
    return { el, e, anchor: [0, 0], point: [0, 0], enabled: false };
  });
  const connectionNodes: { id: string; group: Layer }[] = [];
  const endpointNodes: SVGCircleElement[] = [];
  let width = 0, height = 0, frame = 0, paintedScale = NaN, paintedAngle = NaN, pixelsPerMeter = 1;
  let moving = false, needsLayout = true, needsMeasure = true, disposed = false;
  let projection = geoMercator(), transform = mapView();
  let viewport: Layer, endpointLayer: Layer;
  let selected: MapSelection | null = null, location: MapLocation | null = null;
  let layers = { ...initialLayers };
  let locationPoint: Coordinate = [0, 0], locationRadius = 0;
  let raster = mapView(), rasterDirty = true, colorsDirty = true;
  let tracking: 'free' | 'north' | 'heading' = 'free', heading: number | null = null;
  let focusNext = false;
  let areaPath = new Path2D(), buildingPath = new Path2D(), roadPath = new Path2D(), walkPath = new Path2D(), corridorPath = new Path2D();
  const colors: Record<string, string> = {};
  const project = (coord: Coordinate) => projection(coord)!;
  const invert = (point: Coordinate) => projection.invert!(point)!;
  const screen = (coord: Coordinate) => applyView(transform, coord);
  const unscreen = (coord: Coordinate) => invertView(transform, coord);
  const contains = (footprint: Footprint, point: Coordinate) => {
    const p = unscreen(point);
    return polygonContains(footprint[0], p) && !footprint.slice(1).some((ring) => polygonContains(ring, p));
  };
  const visible = (p: Coordinate, margin = 20) => p[0] >= -margin && p[0] <= width + margin && p[1] >= -margin && p[1] <= height + margin;
  const position = (node: Marker) => {
    const p = applyView({ ...transform, x: 0, y: 0 }, node.point);
    node.el.style.transform = `translate(${p[0]}px,${p[1]}px) translate(-50%,-50%)`;
  };
  const camera = createMapCamera(stage, (value, active) => { transform = value; moving = active; if (!active) needsLayout = true; onrotation(value.angle); schedule(); }, oninteraction);
  function clearSelection(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (event.defaultPrevented || event.button !== 0 || target?.closest('button, .connection-hit')) return;
    onselect(null);
  }
  stage.addEventListener('click', clearSelection);

  function measureLabels() {
    labelNodes.forEach((n) => { n.el.hidden = false; n.button.setAttribute('aria-pressed', 'false'); });
    labelNodes.forEach((n) => { n.normal = [n.button.offsetWidth, n.button.offsetHeight]; });
    labelNodes.forEach((n) => n.button.setAttribute('aria-pressed', 'true'));
    labelNodes.forEach((n) => { n.selected = [n.button.offsetWidth, n.button.offsetHeight]; });
    labelNodes.forEach((n) => n.button.setAttribute('aria-pressed', String(selected?.kind === 'building' && selected.id === n.b.id)));
    needsMeasure = false;
  }

  function layoutLabels() {
    const positioned: (Bounds & { node: Label; anchor: Coordinate })[] = [];
    labelNodes.forEach((n) => { n.point = n.anchor; });
    const ordered = labelNodes.filter((n) => visible(screen(n.anchor))).map((node) => {
      const [w, h] = selected?.kind === 'building' && selected.id === node.b.id ? node.selected : node.normal;
      return { node, w, h };
    }).sort((a, b) => b.w - a.w);
    ordered.forEach(({ node, w, h }) => {
      const anchor = screen(node.anchor);
      let p = anchor;
      if (node.footprint) for (const offset of offsets) {
        const candidate: Coordinate = [anchor[0] + offset[0], anchor[1] + offset[1]];
        if (candidate[0] - w / 2 < 0 || candidate[0] + w / 2 > width || candidate[1] - h / 2 < 0 || candidate[1] + h / 2 > height) continue;
        if (!contains(node.footprint, candidate)) continue;
        if (positioned.some((o) => Math.abs(candidate[0] - o.x) < (w + o.w) / 2 + 3 && Math.abs(candidate[1] - o.y) < (h + o.h) / 2 + 3)) continue;
        p = candidate; break;
      }
      positioned.push({ x: p[0], y: p[1], w, h, node, anchor });
    });
    const overlap = (p: Coordinate, a: Bounds, b: Bounds) => Math.max(0, (a.w + b.w) / 2 + 3 - Math.abs(p[0] - b.x)) * Math.max(0, (a.h + b.h) / 2 + 3 - Math.abs(p[1] - b.y));
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      positioned.forEach((item) => {
        if (!item.node.footprint || !positioned.some((other) => other !== item && overlap([item.x, item.y], item, other) > 0)) return;
        let best: Coordinate = [item.x, item.y];
        const score = (p: Coordinate) => positioned.reduce((sum, other) => sum + (other === item ? 0 : overlap(p, item, other) * 100), 0) + Math.hypot(p[0] - item.anchor[0], p[1] - item.anchor[1]);
        let cost = score(best);
        for (const offset of offsets) {
          const p: Coordinate = [item.anchor[0] + offset[0], item.anchor[1] + offset[1]];
          if (p[0] - item.w / 2 < 0 || p[0] + item.w / 2 > width || p[1] - item.h / 2 < 0 || p[1] + item.h / 2 > height) continue;
          if (!contains(item.node.footprint, p)) continue;
          const next = score(p);
          if (next < cost) { cost = next; best = p; }
        }
        if (best[0] !== item.x || best[1] !== item.y) changed = true;
        [item.x, item.y] = best;
      });
      if (!changed) break;
    }
    positioned.forEach((item) => { item.node.point = unscreen([item.x, item.y]); });
    return positioned;
  }

  function layoutFacilities(obstacles: Bounds[]) {
    const groups: { node: FacilityMarker; p: Coordinate; items: FacilityMarker[] }[] = [];
    facilityNodes.forEach((node) => {
      node.point = node.anchor; node.enabled = false;
      if (!layers[node.f.kind]) return;
      const p = screen(node.anchor);
      const group = groups.find((g) => g.node.f.kind === node.f.kind && g.node.f.b === node.f.b && Math.hypot(g.p[0] - p[0], g.p[1] - p[1]) < 16);
      if (group) group.items.push(node); else groups.push({ node, p, items: [node] });
    });
    const kinds = new Set<string>();
    const ordered = groups.map((group) => {
      const key = `${group.node.f.b}:${group.node.f.kind}`, priority = kinds.has(key) ? 1 : 0;
      kinds.add(key); return { ...group, priority };
    }).sort((a, b) => a.priority - b.priority);
    ordered.forEach(({ node, p: anchor, items }) => {
      node.el.className = `facility-marker${items.every((n) => n.f.estimated) ? ' estimated' : ''}${items.every((n) => n.f.status === 'construction') ? ' pending' : ''}`;
      if (!visible(anchor, 12)) return;
      let point: Coordinate | undefined;
      for (const offset of offsets) {
        const p: Coordinate = [anchor[0] + offset[0], anchor[1] + offset[1]];
        if (p[0] < 8 || p[0] > width - 8 || p[1] < 8 || p[1] > height - 8) continue;
        if (node.footprint && !contains(node.footprint, p)) continue;
        if (obstacles.some((o) => Math.abs(p[0] - o.x) < (16 + o.w) / 2 + 2 && Math.abs(p[1] - o.y) < (16 + o.h) / 2 + 2)) continue;
        point = p; break;
      }
      if (!point) return;
      node.enabled = true;
      node.point = unscreen(point);
      obstacles.push({ x: point[0], y: point[1], w: 16, h: 16 });
    });
  }

  function layoutEntrances(obstacles: Bounds[]) {
    const shown: EntranceMarker[] = [];
    [...entranceNodes].sort((a, b) => Number(b.e.closed) - Number(a.e.closed)).forEach((node) => {
      node.point = node.anchor;
      const anchor = screen(node.anchor);
      node.enabled = !shown.some((n) => n.e.b === node.e.b && n.e.floor === node.e.floor && n.e.closed === node.e.closed && Math.hypot(...screen(n.anchor).map((v, i) => v - anchor[i])) < 20);
      if (!node.enabled || !visible(anchor, 12)) return;
      let point: Coordinate | undefined;
      for (const offset of offsets) {
        const candidate: Coordinate = [anchor[0] + offset[0], anchor[1] + offset[1]];
        if (Math.hypot(...offset) > 24 || !visible(candidate, -10)) continue;
        if (obstacles.some((o) => Math.abs(candidate[0] - o.x) < (20 + o.w) / 2 + 2 && Math.abs(candidate[1] - o.y) < (20 + o.h) / 2 + 2)) continue;
        point = candidate; break;
      }
      if (!point) { node.enabled = false; return; }
      shown.push(node);
      node.point = unscreen(point);
      obstacles.push({ x: point[0], y: point[1], w: 20, h: 20 });
    });
  }

  function drawLocation() {
    if (!location || !width) { locationLayer.hidden = true; return; }
    const p = screen(locationPoint);
    locationLayer.hidden = !visible(p, 0);
    if (locationLayer.hidden) return;
    const translate = `translate(${p[0]}px,${p[1]}px) translate(-50%,-50%)`;
    locationDot.style.transform = locationAccuracy.style.transform = translate;
    locationAccuracy.style.width = locationAccuracy.style.height = `${locationRadius * transform.k * 2}px`;
    locationHeading.hidden = heading === null;
    if (heading !== null) locationHeading.style.transform = `${translate} rotate(${heading + transform.angle}deg)`;
  }

  function cacheLocation() {
    if (!location || !width) return;
    const { longitude, latitude, accuracy } = location;
    locationPoint = project([longitude, latitude]);
    const pixels = Math.abs(project([longitude + .0001, latitude])[0] - locationPoint[0]);
    locationRadius = accuracy * pixels / (111320 * Math.cos(latitude * Math.PI / 180) * .0001);
    locationLayer.setAttribute('aria-label', `현재 위치 · 위치 오차 약 ${Math.round(accuracy)}m`);
  }

  function follow() {
    if (tracking === 'free' || !width) return;
    const inside = location && location.longitude >= limits[0] && location.longitude <= limits[2] && location.latitude >= limits[1] && location.latitude <= limits[3];
    camera.move(inside ? locationPoint : camera.center(), inside && focusNext ? Math.max(camera.scale(), 2.5) : camera.scale(),
      tracking === 'north' ? 0 : heading === null ? transform.angle : -heading);
    if (inside) focusNext = false;
  }

  function drawBackground() {
    const ratio = transform.k / raster.k;
    const delta = (transform.angle - raster.angle) * Math.PI / 180;
    let a = Math.cos(delta) * ratio, b = Math.sin(delta) * ratio;
    let x = transform.x - a * (raster.x + width / 2) + b * (raster.y + height / 2);
    let y = transform.y - b * (raster.x + width / 2) - a * (raster.y + height / 2);
    const uncovered = [[0, 0], [width, 0], [0, height], [width, height]].some(([px, py]) => {
      const bx = (a * (px - x) + b * (py - y)) / (ratio * ratio), by = (-b * (px - x) + a * (py - y)) / (ratio * ratio);
      return bx < 8 || by < 8 || bx > width * 2 - 8 || by > height * 2 - 8;
    });
    if (rasterDirty || colorsDirty || uncovered || (!moving && (raster.k !== transform.k || raster.angle !== transform.angle))) {
      if (colorsDirty) {
        for (const name of ['bg', 'map-building', 'map-outline', 'map-road', 'text-3']) {
          background.style.color = `var(--${name})`;
          colors[name] = getComputedStyle(background).color;
        }
        colorsDirty = false;
      }
      raster = transform; rasterDirty = false;
      const density = Math.min(devicePixelRatio || 1, 2);
      context.setTransform(density, 0, 0, density, 0, 0);
      context.globalAlpha = 1; context.fillStyle = colors.bg;
      context.fillRect(0, 0, width * 2, height * 2);
      context.save(); context.translate(width / 2 + raster.x, height / 2 + raster.y); context.rotate(raster.angle * Math.PI / 180); context.scale(raster.k, raster.k);
      context.fillStyle = colors['map-building']; context.globalAlpha = .5; context.fill(areaPath);
      context.lineCap = 'round'; context.lineJoin = 'round'; context.strokeStyle = colors['map-road']; context.globalAlpha = .3;
      context.lineWidth = 4 / raster.k; context.stroke(roadPath);
      context.lineWidth = 1.3 / raster.k; context.stroke(walkPath);
      context.globalAlpha = .85; context.fillStyle = colors['map-building']; context.fill(buildingPath);
      context.globalAlpha = 1; context.strokeStyle = colors['map-outline']; context.lineWidth = 1 / raster.k; context.stroke(buildingPath);
      context.globalAlpha = .35; context.strokeStyle = colors['text-3']; context.lineWidth = 1.3 / raster.k; context.stroke(corridorPath);
      context.restore();
      context.globalAlpha = 1; context.fillStyle = colors['text-3']; context.textAlign = 'center';
      context.font = `11px ${getComputedStyle(stage).fontFamily}`;
      campus.landmarks.forEach((l) => { const p = applyView(raster, project(l.coord)); context.fillText(l.name, p[0] + width / 2, p[1] + height / 2); });
      a = 1; b = 0; x = -width / 2; y = -height / 2;
    }
    background.style.transform = `matrix(${a},${b},${-b},${a},${x},${y})`;
  }

  function paint() {
    if (!width || !viewport || disposed) return;
    if (needsLayout && !moving) {
      if (needsMeasure) measureLabels();
      const obstacles = layoutLabels();
      if (layers.entrances && transform.k >= 2.5) layoutEntrances(obstacles);
      if (transform.k >= 1.8) layoutFacilities(obstacles);
      needsLayout = false; paintedScale = NaN;
    }
    viewport.attr('transform', viewMatrix(transform));
    drawBackground();
    const translate = `translate3d(${transform.x}px,${transform.y}px,0)`;
    labels.style.transform = facilities.style.transform = entrances.style.transform = translate;
    if (paintedScale !== transform.k || paintedAngle !== transform.angle) {
      labelNodes.forEach(position);
      facilityNodes.forEach(position);
      entranceNodes.forEach(position);
      endpointNodes.forEach((n) => n.setAttribute('r', String(3.5 / transform.k)));
      const unit = [100, 50, 20, 10, 5, 2, 1].find((meters) => meters * pixelsPerMeter * transform.k < 100) ?? 1;
      onscale(unit, Math.round(unit * pixelsPerMeter * transform.k));
      paintedScale = transform.k; paintedAngle = transform.angle;
    }
    labelNodes.forEach((n) => {
      const hidden = !visible(screen(n.point), Math.max(...n.selected) / 2);
      if (n.el.hidden !== hidden) n.el.hidden = hidden;
    });
    facilityNodes.forEach((n) => {
      const hidden = !layers[n.f.kind] || !n.enabled || transform.k < 1.8 || !visible(screen(n.point), 12);
      if (n.el.hidden !== hidden) n.el.hidden = hidden;
    });
    entranceNodes.forEach((n) => {
      const hidden = !layers.entrances || !n.enabled || transform.k < 2.5 || !visible(screen(n.point), 12);
      if (n.el.hidden !== hidden) n.el.hidden = hidden;
    });
    drawLocation();
  }

  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; paint(); });
  }

  function updateSelection() {
    labelNodes.forEach((n) => n.button.setAttribute('aria-pressed', String(selected?.kind === 'building' && selected.id === n.b.id)));
    const route = selected?.kind === 'route' ? campus.routes.find((r) => r.id === selected?.id) : undefined;
    const active = new Set(route?.geometryStatus === 'mapped' ? route.legs.map((l) => l.connection) : []);
    connectionNodes.forEach(({ id, group }) => {
      const chosen = active.has(id);
      group.selectAll('.route-halo').attr('display', chosen ? null : 'none');
      group.selectAll('.connection-segment').attr('stroke-width', chosen ? 4 : 2).attr('stroke-opacity', chosen ? 1 : .3);
      if (chosen) group.raise();
    });
    endpointLayer.raise();
    endpointNodes.forEach((node, i) => {
      const coord = i === 0 ? route?.segments[0]?.coords[0] : route?.segments.at(-1)?.coords.at(-1);
      node.setAttribute('display', coord ? '' : 'none');
      if (coord) { const p = project(coord); node.setAttribute('cx', String(p[0])); node.setAttribute('cy', String(p[1])); }
    });
  }

  function resize() {
    const nextWidth = stage.clientWidth;
    if (!nextWidth || disposed) return;
    const nextHeight = nextWidth < 350 ? 420 : 450;
    if (nextWidth === width && nextHeight === height) return;
    const center = width ? invert(unscreen([width / 2, height / 2])) : null;
    width = nextWidth; height = nextHeight;
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
    projection = geoMercator().fitExtent([[20, 20], [width - 20, height - 22]], { type: 'FeatureCollection', features: buildings.map((b) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: b.coord } })) });
    const middle = invert([width / 2, height / 2]);
    pixelsPerMeter = (project([middle[0] + .001, middle[1]])[0] - project(middle)[0]) / (111320 * Math.cos(middle[1] * Math.PI / 180) * .001);
    const projected = new Map(footprints.map((f) => [f, f.geometry.type === 'Polygon' ? f.geometry.coordinates.map((ring) => ring.map((p) => project([p[0], p[1]]))) : undefined]));
    labelNodes.forEach((n) => { n.anchor = project(n.b.coord); n.footprint = projected.get(buildingFootprints.get(n.b.id)!); });
    facilityNodes.forEach((n, i) => { n.anchor = project(n.f.coord); n.footprint = projected.get(facilityFootprints[i]!); });
    entranceNodes.forEach((n) => { n.anchor = project(n.e.coord); });
    svg.selectAll('g').remove(); connectionNodes.length = 0; endpointNodes.length = 0;
    viewport = svg.append('g').attr('class', 'map-viewport');
    const routes = viewport.append('g'), path = geoPath(projection), segmentPath = line<Coordinate>();
    areaPath = new Path2D(); buildingPath = new Path2D(); roadPath = new Path2D(); walkPath = new Path2D(); corridorPath = new Path2D();
    areas.forEach((f) => areaPath.addPath(new Path2D(path(f) ?? '')));
    footprints.forEach((f) => buildingPath.addPath(new Path2D(path(f) ?? '')));
    roads.forEach((f) => (['footway', 'path', 'steps', 'corridor'].includes(f.properties.v) ? walkPath : roadPath).addPath(new Path2D(path(f) ?? '')));
    campus.corridors.forEach((c) => corridorPath.addPath(new Path2D(segmentPath(c.coords.map(project)) ?? '')));
    const density = Math.min(devicePixelRatio || 1, 2);
    background.width = Math.ceil(width * 2 * density); background.height = Math.ceil(height * 2 * density);
    background.style.width = `${width * 2}px`; background.style.height = `${height * 2}px`; rasterDirty = true;
    connections.forEach((connection) => {
      const group = routes.append('g').attr('data-connection', connection.id);
      const paths = (name: string, color: string, stroke: number) => group.selectAll(`path.${name}`).data(connection.segments).join('path').attr('class', name).attr('d', (s) => segmentPath(s.coords.map(project))).attr('fill', 'none').attr('stroke', color).attr('stroke-width', stroke).attr('vector-effect', 'non-scaling-stroke').attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
      paths('route-halo', 'var(--bg)', 7).attr('pointer-events', 'none');
      paths('connection-segment', 'var(--primary)', 2);
      paths('connection-hit', 'transparent', 16).on('click', (event: MouseEvent) => {
        if (event.defaultPrevented) return;
        event.stopPropagation();
        const route = campus.routes.find((r) => r.geometryStatus === 'mapped' && r.legs.length === 1 && r.legs[0].connection === connection.id);
        if (route) onselect({ kind: 'route', id: route.id });
      });
      connectionNodes.push({ id: connection.id, group });
    });
    endpointLayer = routes.append('g');
    for (let i = 0; i < 2; i++) endpointNodes.push(endpointLayer.append('circle').attr('fill', 'var(--primary)').attr('pointer-events', 'none').node()!);
    const p = center ? project(center) : null;
    updateSelection(); cacheLocation(); needsMeasure = true; needsLayout = true;
    camera.resize(width, height, p ?? undefined); paint();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(stage); resize();
  const fontsChanged = () => { if (!disposed) { needsMeasure = true; needsLayout = true; rasterDirty = true; schedule(); } };
  document.fonts.addEventListener('loadingdone', fontsChanged);
  void document.fonts.ready.then(fontsChanged);
  const themeChanged = () => { colorsDirty = true; schedule(); };
  const themeObserver = new MutationObserver(themeChanged);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  const colorScheme = matchMedia('(prefers-color-scheme: dark)');
  colorScheme.addEventListener('change', themeChanged);

  return {
    setLayers(value: MapLayers) {
      layers = { ...value }; needsLayout = true; schedule();
    },
    select(value: MapSelection | null) {
      if (selected?.kind === value?.kind && selected?.id === value?.id) return;
      selected = value; updateSelection(); needsLayout = true; schedule();
    },
    zoom(factor: number) { camera.zoom(factor); },
    north() { camera.north(); },
    track(value: typeof tracking) {
      if (value !== 'free' && tracking === 'free') focusNext = true;
      if (value === 'free') focusNext = false;
      tracking = value;
      follow();
    },
    heading(value: number | null) { heading = value; drawLocation(); if (tracking === 'heading') follow(); },
    locate(value: MapLocation | null) {
      location = value; cacheLocation();
      if (location && (location.longitude < limits[0] || location.longitude > limits[2] || location.latitude < limits[1] || location.latitude > limits[3])) { drawLocation(); return false; }
      follow();
      drawLocation(); return true;
    },
    destroy() {
      disposed = true; observer.disconnect(); cancelAnimationFrame(frame);
      stage.removeEventListener('click', clearSelection);
      document.fonts.removeEventListener('loadingdone', fontsChanged);
      themeObserver.disconnect(); colorScheme.removeEventListener('change', themeChanged);
      camera.destroy(); svg.selectAll('*').remove(); labels.replaceChildren(); facilities.replaceChildren(); entrances.replaceChildren();
      background.width = background.height = 0;
    },
  };
}
