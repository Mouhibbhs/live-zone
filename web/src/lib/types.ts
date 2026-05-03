export interface ViewerProfile {
  uid: string;
  email: string;
  username: string;
  active: boolean;
  role: string;
  deviceId: string | null;
  subscriptionExpiryMs: number | null;
}

export type ViewerAccessReason =
  | "ok"
  | "inactive"
  | "expired"
  | "device_mismatch"
  | "profile_missing";

export interface ViewerSession {
  allowed: boolean;
  reason: ViewerAccessReason;
  isAdmin: boolean;
  serverTimeMs: number;
  profile: ViewerProfile | null;
}

export interface LiveCategory {
  id: string;
  name: string;
  parentId: number;
}

export interface LiveChannel {
  id: string;
  name: string;
  categoryId: string;
  logo: string | null;
  streamUrl: string;
  epgChannelId: string | null;
}

export interface LiveCatalog {
  generatedAtMs: number;
  categories: LiveCategory[];
  channels: LiveChannel[];
}

export interface FavoritesResponse {
  favorites: LiveChannel[];
}

export interface DashboardSummary {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  expiredUsers: number;
  boundDevices: number;
}

export interface AdminUser {
  uid: string;
  email: string;
  username: string;
  active: boolean;
  deviceId: string | null;
  role: string;
  subscriptionExpiryMs: number | null;
  createdAtMs: number | null;
}

export interface IptvSettings {
  baseUrl: string;
  username: string;
  password: string;
  updatedAtMs: number | null;
}
