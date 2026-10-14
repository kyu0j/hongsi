import { isAndroid, isIOS } from '../../platform/env';
import { locationPermission, type LocationPermission } from '../../platform/location';

export const locationAccess = $state({ permission: 'unknown' as LocationPermission, busy: false, error: '' });

export const locationPermissionText: Record<LocationPermission, string> = {
  unknown: '권한 상태를 확인해 주세요.',
  granted: '위치가 허용되어 있어요.',
  denied: isAndroid || isIOS ? '기기 설정에서 위치를 허용해 주세요.' : '브라우저 설정에서 위치를 허용해 주세요.',
  default: '출결 시 위치 권한이 필요해요.',
  unsupported: '위치를 지원하지 않는 환경이에요.',
};

export async function refreshLocationPermission() {
  if (locationAccess.busy) return;
  try {
    const permission = await locationPermission();
    if (!locationAccess.busy) { locationAccess.permission = permission; locationAccess.error = ''; }
  } catch {
    if (!locationAccess.busy) { locationAccess.permission = 'unknown'; locationAccess.error = '위치 권한을 확인하지 못했어요.'; }
  }
}

export async function configureLocationPermission() {
  if (locationAccess.busy) return;
  locationAccess.busy = true;
  locationAccess.error = '';
  try {
    locationAccess.permission = await locationPermission(locationAccess.permission === 'denied' && (isAndroid || isIOS) ? 'settings' : 'request');
  } catch {
    locationAccess.error = '위치 권한을 설정하지 못했어요. 다시 시도해 주세요.';
  } finally { locationAccess.busy = false; }
}

export function watchLocationPermission() {
  const refresh = () => { if (document.visibilityState === 'visible') void refreshLocationPermission(); };
  refresh();
  window.addEventListener('focus', refresh);
  window.addEventListener('hongsi-resume', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
    window.removeEventListener('focus', refresh);
    window.removeEventListener('hongsi-resume', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}
