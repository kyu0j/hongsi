import { isAndroid, isIOS } from './env';
import { invoke } from '@tauri-apps/api/core';

export type LocationPermission = 'unknown' | 'granted' | 'denied' | 'default' | 'unsupported';

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

export async function currentLocation(): Promise<{ latitude: number; longitude: number; accuracy: number }> {
  if (isIOS) {
    return invoke('current_location');
  }
  if (!('geolocation' in navigator)) throw new Error('이 기기에서는 위치를 확인할 수 없어요.');
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
    (error) => reject(new Error(error.code === 1 ? '위치 권한을 허용해 주세요.' : '위치를 찾지 못했어요.')),
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
  ));
}
