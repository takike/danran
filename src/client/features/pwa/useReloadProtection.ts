import {
  refreshPwaGuardState,
  registerPwaManualReloadGuard,
  registerPwaReloadGuard,
} from '@client/features/pwa/updateManager';
import { useLayoutEffect, useRef } from 'react';

export function useReloadProtection(isProtected: boolean, manualReloadBlocked = false): void {
  const protectedRef = useRef(isProtected);
  const manualBlockedRef = useRef(manualReloadBlocked);

  useLayoutEffect(() => {
    protectedRef.current = isProtected;
    manualBlockedRef.current = manualReloadBlocked;
    refreshPwaGuardState();
  }, [isProtected, manualReloadBlocked]);

  useLayoutEffect(() => {
    const unregisterReload = registerPwaReloadGuard(() => protectedRef.current);
    const unregisterManualReload = registerPwaManualReloadGuard(() => manualBlockedRef.current);
    return () => {
      unregisterReload();
      unregisterManualReload();
      refreshPwaGuardState();
    };
  }, []);
}
