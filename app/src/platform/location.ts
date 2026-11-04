import { isAndroid, isIOS } from './env';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { LocationFix } from '../features/campus-map/location-filter';

type LocationEvent = { type: 'position'; position: LocationFix } | { type: 'error'; message: string };
let locationQueue: Promise<unknown> = Promise.resolve();
let locationEvents: Channel<LocationEvent> | undefined;
let locationReceive: ((event: LocationEvent) => void) | null = null;
let locationConnected = false;

export function watchLocation(receive: (position: LocationFix) => void, failed: () => void): () => void {
  let active = true;
  if (isIOS) {
    const receiveNative = (event: LocationEvent) => {
      if (!active) return;
      if (event.type === 'position') receive(event.position);
      else failed();
    };
    locationReceive = receiveNative;
    locationEvents ??= new Channel<LocationEvent>((event) => locationReceive?.(event));
    const events = locationEvents;
    const command = (action: string) => {
      const result = locationQueue.then(async () => {
        if (action === 'start' && !active) return;
        if (!locationConnected) { await invoke('location_channel', { events }); locationConnected = true; }
        return invoke('watch_location', { action, events });
      });
      locationQueue = result.catch(() => {});
      return result;
    };
    void command('start').catch(() => { if (active) failed(); });
    return () => {
      active = false;
      if (locationReceive === receiveNative) locationReceive = null;
      void command('stop').catch(() => {});
    };
  }
  if (!('geolocation' in navigator)) throw new Error('이 기기에서는 위치를 확인할 수 없어요.');
  const id = navigator.geolocation.watchPosition(
    ({ coords, timestamp }) => {
      if (active) receive({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, timestamp });
    },
    () => { if (active) failed(); },
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 10_000 },
  );
  return () => { active = false; navigator.geolocation.clearWatch(id); };
}

export type LocationPermission = 'unknown' | 'granted' | 'denied' | 'default' | 'unsupported';

export async function mapLocationAccess(request = false): Promise<{ permission: LocationPermission; precise: boolean | null }> {
  return invoke('location_permission', { action: request ? 'precise' : 'check' });
}

async function browserLocationPermission(): Promise<LocationPermission> {
  if (!window.isSecureContext || !('geolocation' in navigator)) return 'unsupported';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state === 'prompt' ? 'default' : status.state;
  } catch { return 'unknown'; }
}

export async function locationPermission(action: 'check' | 'request' | 'settings' = 'check'): Promise<LocationPermission> {
  if (isAndroid || isIOS) {
    const result = await invoke<{ permission: LocationPermission }>('location_permission', { action });
    return result.permission;
  }
  const status = await browserLocationPermission();
  if (action !== 'request' || status === 'granted' || status === 'unsupported' || status === 'denied') return status;
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    () => resolve('granted'),
    async (error) => {
      if (error.code === 1) { resolve('denied'); return; }
      const current = await browserLocationPermission();
      if (current === 'granted' || current === 'denied') resolve(current);
      else reject(new Error('위치 권한을 확인하지 못했어요. 다시 시도해 주세요.'));
    },
    { timeout: 10_000, maximumAge: 60_000 },
  ));
}

export async function currentLocation(options: { maximumAge?: number } = {}): Promise<{ latitude: number; longitude: number; accuracy: number }> {
  if (isIOS) {
    return invoke('current_location');
  }
  if (!('geolocation' in navigator)) throw new Error('이 기기에서는 위치를 확인할 수 없어요.');
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
    (error) => reject(new Error(error.code === 1 ? '위치 권한을 허용해 주세요.' : '위치를 찾지 못했어요.')),
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: options.maximumAge ?? 30_000 },
  ));
}
