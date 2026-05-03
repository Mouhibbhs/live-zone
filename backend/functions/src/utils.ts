import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import type { AdminUserDto, UserProfileRecord, ViewerAccessReason, ViewerProfileDto } from "./types.js";

export function sanitizeUsername(input: unknown): string {
  const value = typeof input === "string" ? input.trim() : "";

  if (value.length < 3 || value.length > 32) {
    throw new HttpsError("invalid-argument", "Username must be between 3 and 32 characters.");
  }

  return value.replace(/\s+/g, " ");
}

export function sanitizeDeviceId(input: unknown): string {
  const value = typeof input === "string" ? input.trim() : "";

  if (!value || value.length > 160) {
    throw new HttpsError("invalid-argument", "A valid device identifier is required.");
  }

  return value;
}

export function timestampFromMillis(input: unknown): Timestamp | null {
  if (input === null || input === undefined || input === "") {
    return null;
  }

  const numeric = Number(input);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new HttpsError("invalid-argument", "Invalid subscription expiry timestamp.");
  }

  return Timestamp.fromMillis(numeric);
}

export function toMillis(timestamp: FirebaseFirestore.Timestamp | null | undefined): number | null {
  return timestamp ? timestamp.toMillis() : null;
}

export function buildViewerReason(profile: UserProfileRecord | null, deviceId: string): ViewerAccessReason {
  if (!profile) {
    return "profile_missing";
  }

  if (!profile.active) {
    return "inactive";
  }

  const expiryMs = toMillis(profile.subscription_expiry);

  if (!expiryMs || expiryMs <= Date.now()) {
    return "expired";
  }

  if (profile.device_id && profile.device_id !== deviceId) {
    return "device_mismatch";
  }

  return "ok";
}

export function profileToDto(profile: UserProfileRecord): ViewerProfileDto {
  return {
    uid: profile.uid,
    email: profile.email,
    username: profile.username,
    active: profile.active,
    deviceId: profile.device_id,
    role: profile.role,
    subscriptionExpiryMs: toMillis(profile.subscription_expiry),
  };
}

export function adminUserToDto(profile: UserProfileRecord): AdminUserDto {
  return {
    uid: profile.uid,
    email: profile.email,
    username: profile.username,
    active: profile.active,
    deviceId: profile.device_id,
    role: profile.role,
    subscriptionExpiryMs: toMillis(profile.subscription_expiry),
    createdAtMs: toMillis(profile.created_at),
  };
}
