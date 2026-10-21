import { Capacitor } from '@capacitor/core';
import { requestNativePaymentWakeNotifications } from '#lib/native/capacitor.ts';
import type { PushWakeDeviceToken } from './pushWakeTypes';
import { normalizeDeviceToken, normalizePlatform } from './pushWakeBoundary';
import { requestWebPushToken } from './pushWakeWeb';
type PushWakeDesktopBridge = {
  getPushWakeToken?: () => Promise<{ value?: unknown; token?: unknown; platform?: unknown } | string>;
};
const DEFAULT_PUSH_TOKEN_TIMEOUT_MS = 15_000;
const getDesktopBridge = (): PushWakeDesktopBridge | null => {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & { xlnDesktop?: PushWakeDesktopBridge }).xlnDesktop;
  return candidate && typeof candidate.getPushWakeToken === 'function' ? candidate : null;
};

export const canRequestPushWakeDeviceToken = (webPublicKey: string): boolean =>
  getDesktopBridge() !== null || Capacitor.isNativePlatform() || webPublicKey.trim().length > 0;

const normalizeBridgeToken = (
  value: { value?: unknown; token?: unknown; platform?: unknown } | string,
  source: PushWakeDeviceToken['source'],
): PushWakeDeviceToken => {
  if (typeof value === 'string') {
    return { token: normalizeDeviceToken(value), platform: source === 'desktop-bridge' ? 'desktop' : 'web', source };
  }
  return {
    token: normalizeDeviceToken(value.value || value.token),
    platform: normalizePlatform(value.platform, source === 'desktop-bridge' ? 'desktop' : 'web'),
    source,
  };
};

const waitForNativePushToken = (timeoutMs: number): Promise<PushWakeDeviceToken> =>
  new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('PUSH_NATIVE_WINDOW_UNAVAILABLE'));
      return;
    }
    const timer = window.setTimeout(
      () => {
        window.removeEventListener('xln-native-push-token', onToken as EventListener);
        reject(new Error('PUSH_NATIVE_TOKEN_TIMEOUT'));
      },
      Math.max(1_000, timeoutMs),
    );

    const onToken = (event: Event): void => {
      window.clearTimeout(timer);
      window.removeEventListener('xln-native-push-token', onToken as EventListener);
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      try {
        resolve({
          token: normalizeDeviceToken(detail['value'] || detail['token']),
          platform: normalizePlatform(detail['platform'], 'ios'),
          source: 'native',
        });
      } catch (error) {
        reject(error);
      }
    };

    window.addEventListener('xln-native-push-token', onToken as EventListener, { once: true });
    void requestNativePaymentWakeNotifications().catch(error => {
      window.clearTimeout(timer);
      window.removeEventListener('xln-native-push-token', onToken as EventListener);
      reject(error);
    });
  });

export const requestPushWakeDeviceToken = async (
  options: {
    timeoutMs?: number;
    web?: { publicKey: string; workerUrl: string };
  } = {},
): Promise<PushWakeDeviceToken> => {
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    const token = await desktopBridge.getPushWakeToken!();
    return normalizeBridgeToken(token, 'desktop-bridge');
  }

  if (Capacitor.isNativePlatform()) {
    return waitForNativePushToken(options.timeoutMs ?? DEFAULT_PUSH_TOKEN_TIMEOUT_MS);
  }

  const web = options.web ?? {
    publicKey: String(import.meta.env?.['VITE_XLN_WEB_PUSH_PUBLIC_KEY'] || '').trim(),
    workerUrl: '/push-wake-sw.js',
  };
  const webToken = await requestWebPushToken(web.publicKey, web.workerUrl);
  if (webToken) return webToken;

  throw new Error('PUSH_TOKEN_PROVIDER_UNAVAILABLE');
};
