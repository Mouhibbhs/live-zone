const DEVICE_STORAGE_KEY = "livezone_device_id";

export function getBrowserDeviceId(): string {
  if (typeof window === "undefined") {
    return "server-unavailable";
  }

  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);

  if (existing) {
    return existing;
  }

  const generated = window.crypto.randomUUID();
  window.localStorage.setItem(DEVICE_STORAGE_KEY, generated);
  return generated;
}

