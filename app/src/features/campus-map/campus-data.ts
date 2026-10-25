import type { FeatureCollection, Geometry } from 'geojson';
import raw from './campus-data.json';
import guideRaw from './campus-guide.json';

export type Coordinate = [number, number];
export type MapSelection = { kind: 'building' | 'route'; id: string };
export type MapLocation = { latitude: number; longitude: number; accuracy: number };
export type Building = { id: string; name: string; coord: Coordinate };
export type FacilityKind = 'stairs' | 'elevator' | 'toilet' | 'cafe' | 'food' | 'store' | 'study' | 'printer' | 'pc' | 'lounge' | 'smoking';
export type Facility = {
  b: string;
  kind: FacilityKind;
  coord: Coordinate;
  estimated?: boolean;
  buildingRepresentative?: boolean;
  status?: string;
};
export type Entrance = { b: string; floor: string; coord: Coordinate; closed: boolean };
type GuideLink = { id: string; stops: string[]; floors: string[]; match: string[]; via?: string };
type BuildingGuide = { places: { floor: string; kind: FacilityKind; name: string }[] };
type Segment = {
  coords: Coordinate[];
  highway: string;
  indoor: boolean;
  bridge: boolean;
};
type CampusRoute = {
  id: string;
  stops: string[];
  legs: { connection: string }[];
  title?: string;
  geometryStatus: string;
  pathMeters?: number;
  segments: Segment[];
  guideLinks?: GuideLink[];
};
type CampusData = {
  geometry: FeatureCollection<Geometry, { k: string; v: string }>;
  buildings: Building[];
  routes: CampusRoute[];
  facilities: Facility[];
  landmarks: { coord: Coordinate; name: string }[];
  corridors: { coords: Coordinate[] }[];
  connections: { id: string; a: string; b: string; geometryStatus: string; segments: Segment[] }[];
};

export const guide = guideRaw as unknown as {
  buildings: Record<string, BuildingGuide>;
  markers: Facility[];
  entrances: Entrance[];
  links: GuideLink[];
};
const base = raw as unknown as CampusData;
const guideKinds = new Set(guide.markers.map((m) => `${m.b}:${m.kind}`));
const connections = base.connections.filter((c) => c.geometryStatus === 'mapped' || guide.links.some((l) => l.match.includes(c.id)));
const connectionIds = new Set(connections.map((c) => c.id));
const addedLinks = guide.links.filter((l) => !base.connections.some((c) => l.match.includes(c.id)));
export const campus: CampusData = {
  ...base,
  facilities: [
    ...base.facilities.filter((f) => !f.buildingRepresentative || !guideKinds.has(`${f.b}:${f.kind}`)),
    ...guide.markers.filter((m) => !base.facilities.some((f) => !f.estimated && f.b === m.b && f.kind === m.kind
      && Math.hypot((f.coord[0] - m.coord[0]) * 88200, (f.coord[1] - m.coord[1]) * 111320) < 12)),
  ],
  connections: [...connections, ...addedLinks.map((l) => ({ id: l.id, a: l.stops[0], b: l.stops.at(-1)!, geometryStatus: 'unmapped', segments: [] }))],
  routes: [
    ...base.routes.flatMap((r) => {
      const guideLinks = guide.links.filter((l) => r.legs.some((leg) => l.match.includes(leg.connection)));
      if ((r.geometryStatus !== 'mapped' && !guideLinks.length) || r.legs.some((leg) => !connectionIds.has(leg.connection))) return [];
      return [{ ...r, guideLinks }];
    }),
    ...addedLinks.map((l) => ({ id: l.id, stops: l.stops, legs: [], geometryStatus: 'unmapped', segments: [], guideLinks: [l] })),
  ],
};
export const buildings = campus.buildings.filter((b) => b.id !== 'D3');
export const buildingById = Object.fromEntries(campus.buildings.map((b) => [b.id, b]));
export const buildingLabel = (id: string) => id === 'ART' ? '아트밸리' : id === 'D2' ? '2기숙사' : `${id}동`;
export const floorLabel = (floor: string) => floor === 'R' ? '옥상' : floor.startsWith('B') ? `지하 ${floor.slice(1)}층` : `${floor}층`;
export const guideLinkLabel = (link: GuideLink) => `${link.stops.map((b, i) => `${buildingLabel(b)}${link.floors[i] ? ` ${floorLabel(link.floors[i])}` : ''}`).join(' ↔ ')}${link.via ? ` · ${link.via}` : ''}`;
export const routeLabel = (route: CampusRoute) => {
  const link = route.guideLinks?.length === 1 ? route.guideLinks[0] : undefined;
  if (link && route.stops.length === link.stops.length && route.stops.every((b) => link.stops.includes(b))) return guideLinkLabel(link);
  return route.geometryStatus === 'mapped' || !route.title ? route.stops.map(buildingLabel).join(' → ') : route.title;
};

export function buildingRoutes(id: string) {
  const seen = new Set<string>();
  return campus.routes.filter((route) => {
    if (!route.stops.includes(id)) return false;
    const key = JSON.stringify([route.stops, route.legs, route.title, route.guideLinks]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function highlightedLabel(label: string, id: string) {
  const expression = new RegExp(`(^|[^A-Za-z0-9])(${id === 'ART' ? '아트밸리' : id === 'D2' ? '2기숙사' : `${id}(?:동)?`})(?=$|[^A-Za-z0-9])`, 'g');
  const parts: { text: string; selected: boolean }[] = [];
  let cursor = 0;
  for (const match of label.matchAll(expression)) {
    const start = match.index + match[1].length;
    if (start > cursor) parts.push({ text: label.slice(cursor, start), selected: false });
    parts.push({ text: match[2], selected: true });
    cursor = start + match[2].length;
  }
  if (cursor < label.length) parts.push({ text: label.slice(cursor), selected: false });
  return parts;
}
