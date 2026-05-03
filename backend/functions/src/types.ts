export interface UserProfileRecord {
  uid: string;
  email: string;
  username: string;
  active: boolean;
  device_id: string | null;
  role: "viewer" | "admin";
  subscription_expiry: FirebaseFirestore.Timestamp | null;
  created_at: FirebaseFirestore.Timestamp;
  updated_at: FirebaseFirestore.Timestamp;
}

export interface ViewerProfileDto {
  uid: string;
  email: string;
  username: string;
  active: boolean;
  deviceId: string | null;
  role: string;
  subscriptionExpiryMs: number | null;
}

export type ViewerAccessReason =
  | "ok"
  | "inactive"
  | "expired"
  | "device_mismatch"
  | "profile_missing";

export interface ViewerSessionDto {
  allowed: boolean;
  reason: ViewerAccessReason;
  isAdmin: boolean;
  serverTimeMs: number;
  profile: ViewerProfileDto | null;
}

export interface LiveCategoryDto {
  id: string;
  name: string;
  parentId: number;
}

export interface LiveChannelDto {
  id: string;
  name: string;
  categoryId: string;
  logo: string | null;
  streamUrl: string;
  epgChannelId: string | null;
}

export interface LiveCatalogDto {
  generatedAtMs: number;
  categories: LiveCategoryDto[];
  channels: LiveChannelDto[];
}

export interface FavoriteChannelRecord extends LiveChannelDto {
  added_at: FirebaseFirestore.Timestamp;
}

export interface DashboardSummaryDto {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  expiredUsers: number;
  boundDevices: number;
}

export interface AdminUserDto {
  uid: string;
  email: string;
  username: string;
  active: boolean;
  deviceId: string | null;
  role: string;
  subscriptionExpiryMs: number | null;
  createdAtMs: number | null;
}

