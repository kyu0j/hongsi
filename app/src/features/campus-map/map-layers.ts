import { pref, setPref } from '../../shared/state/preferences';
import type { FacilityKind } from './campus-data';

export const facilityKinds = ['stairs', 'elevator', 'toilet', 'cafe', 'food', 'store', 'study', 'printer', 'pc', 'lounge', 'smoking'] as const satisfies readonly FacilityKind[];
const layerKeys = ['entrances', ...facilityKinds] as const;
export type MapLayer = typeof layerKeys[number];
export type MapLayers = Record<MapLayer, boolean>;

export function loadMapLayers(): MapLayers {
  const saved = pref<Partial<MapLayers> | null>('campus-map-layers', null);
  return Object.fromEntries(layerKeys.map((key) => [key, typeof saved?.[key] === 'boolean' ? saved[key] : true])) as MapLayers;
}

export function saveMapLayers(layers: MapLayers) {
  try { setPref('campus-map-layers', layers); } catch {}
}
