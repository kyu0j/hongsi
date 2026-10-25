export type LocationFix = { latitude: number; longitude: number; accuracy: number; timestamp: number };

function distance(a: LocationFix, b: LocationFix) {
  const lat = (a.latitude + b.latitude) * Math.PI / 360;
  return Math.hypot((a.latitude - b.latitude) * 111320, (a.longitude - b.longitude) * 111320 * Math.cos(lat));
}

export function createLocationFilter() {
  let last: LocationFix | null = null, candidate: LocationFix | null = null;
  return (point: LocationFix, now = Date.now()): LocationFix | null => {
    if (![point.latitude, point.longitude, point.accuracy, point.timestamp].every(Number.isFinite)
      || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180 || point.accuracy < 0 || point.accuracy > 100
      || now - point.timestamp > 15_000 || point.timestamp > now + 5000 || (last && point.timestamp <= last.timestamp)) return null;
    if (last && now - last.timestamp < 15_000) {
      const elapsed = (point.timestamp - last.timestamp) / 1000, moved = distance(last, point);
      if (point.accuracy > Math.max(40, last.accuracy * 2) && elapsed < 10) return null;
      if (moved > Math.max(40, (last.accuracy + point.accuracy) * 2 + elapsed * 8)) {
        if (!candidate || point.timestamp <= candidate.timestamp || distance(candidate, point) > Math.max(20, point.accuracy + candidate.accuracy)) {
          candidate = point; return null;
        }
      }
    }
    candidate = null; last = point; return point;
  };
}
