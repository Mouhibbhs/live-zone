"use client";

import { Power, RefreshCw, ShieldCheck, UserPlus, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  adminCreateUser,
  getAdminIptvSettings,
  adminListUsers,
  adminResetDevice,
  adminUpdateUser,
  updateAdminIptvSettings,
} from "@/lib/api";

import type { AdminUser, DashboardSummary, IptvSettings } from "@/lib/types";

interface EditableUser extends AdminUser {
  subscriptionExpiryInput: string;
}

function toDateTimeLocal(timestampMs: number | null): string {
  if (!timestampMs) {
    return "";
  }

  const date = new Date(timestampMs);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestampMs - offset).toISOString().slice(0, 16);
}

function toEpoch(value: string): number | null {
  return value ? new Date(value).getTime() : null;
}

function formatDate(timestampMs: number | null): string {
  return timestampMs ? new Date(timestampMs).toLocaleString() : "No expiry";
}

function mapUser(user: AdminUser): EditableUser {
  return {
    ...user,
    subscriptionExpiryInput: toDateTimeLocal(user.subscriptionExpiryMs),
  };
}

export function AdminDashboard() {
  const [users, setUsers] = useState<EditableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [iptvNotice, setIptvNotice] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    email: "",
    password: "",
    username: "",
    active: true,
    subscriptionExpiryInput: "",
  });
  const [iptvForm, setIptvForm] = useState<IptvSettings>({
    baseUrl: "",
    username: "",
    password: "",
    updatedAtMs: null,
  });

  async function loadAdminData() {
    setLoading(true);
    setError(null);
    setIptvNotice(null);

    try {
      const [usersResponse, iptvSettings] = await Promise.all([adminListUsers(), getAdminIptvSettings()]);
      setUsers(usersResponse.users.map(mapUser));
      setIptvForm(iptvSettings);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load admin data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAdminData();
  }, []);

  const summary: DashboardSummary = useMemo(() => {
    const now = Date.now();

    return {
      totalUsers: users.length,
      activeUsers: users.filter((user) => user.active).length,
      inactiveUsers: users.filter((user) => !user.active).length,
      expiredUsers: users.filter(
        (user) => user.subscriptionExpiryMs !== null && user.subscriptionExpiryMs <= now,
      ).length,
      boundDevices: users.filter((user) => Boolean(user.deviceId)).length,
    };
  }, [users]);

  async function handleCreateUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking("create");
    setError(null);

    try {
      await adminCreateUser({
        email: createForm.email,
        password: createForm.password,
        username: createForm.username,
        active: createForm.active,
        subscriptionExpiryMs: toEpoch(createForm.subscriptionExpiryInput),
      });

      setCreateForm({
        email: "",
        password: "",
        username: "",
        active: true,
        subscriptionExpiryInput: "",
      });
      await loadAdminData();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create the user.");
    } finally {
      setWorking(null);
    }
  }

  async function handleSaveUser(user: EditableUser) {
    setWorking(user.uid);
    setError(null);

    try {
      await adminUpdateUser({
        uid: user.uid,
        username: user.username,
        active: user.active,
        subscriptionExpiryMs: toEpoch(user.subscriptionExpiryInput),
      });
      await loadAdminData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to update the user.");
    } finally {
      setWorking(null);
    }
  }

  async function handleResetDevice(uid: string) {
    setWorking(uid);
    setError(null);

    try {
      await adminResetDevice(uid);
      await loadAdminData();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Unable to reset the device lock.");
    } finally {
      setWorking(null);
    }
  }

  async function handleSaveIptvSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking("iptv-settings");
    setError(null);
    setIptvNotice(null);

    try {
      const savedSettings = await updateAdminIptvSettings({
        baseUrl: iptvForm.baseUrl,
        username: iptvForm.username,
        password: iptvForm.password,
      });

      setIptvForm(savedSettings);
      setIptvNotice("IPTV settings saved. Run `npm run sync:catalog` in `backend/functions` to update `.env` and `web/public/channels.json`.");

    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save IPTV settings.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <section className="admin-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h2>LiveZone control room</h2>
        </div>

        <button className="secondary-button" onClick={() => void loadAdminData()} type="button">
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="admin-summary-grid">
        <div className="stat-card">
          <ShieldCheck size={18} />
          <div>
            <span>Total users</span>
            <strong>{summary.totalUsers}</strong>
          </div>
        </div>

        <div className="stat-card">
          <Power size={18} />
          <div>
            <span>Active</span>
            <strong>{summary.activeUsers}</strong>
          </div>
        </div>

        <div className="stat-card">
          <XCircle size={18} />
          <div>
            <span>Expired</span>
            <strong>{summary.expiredUsers}</strong>
          </div>
        </div>

        <div className="stat-card">
          <UserPlus size={18} />
          <div>
            <span>Bound devices</span>
            <strong>{summary.boundDevices}</strong>
          </div>
        </div>
      </div>

      <p className="muted-copy">
        Spark-friendly admin mode manages Firestore profiles, subscription dates, and device locks. Authentication
        account deletion still needs a separate admin backend.
      </p>

      <form className="admin-create-form" onSubmit={handleSaveIptvSettings}>
        <div className="field compact">
          <span>IPTV URL</span>
          <input
            onChange={(event) => setIptvForm((current) => ({ ...current, baseUrl: event.target.value }))}
            placeholder="http://xlion.net:8080"
            required
            value={iptvForm.baseUrl}
          />
        </div>

        <div className="field compact">
          <span>IPTV User</span>
          <input
            onChange={(event) => setIptvForm((current) => ({ ...current, username: event.target.value }))}
            required
            value={iptvForm.username}
          />
        </div>

        <div className="field compact">
          <span>IPTV Pass</span>
          <input
            onChange={(event) => setIptvForm((current) => ({ ...current, password: event.target.value }))}
            required
            type="password"
            value={iptvForm.password}
          />
        </div>

        <div className="field compact">
          <span>Last update</span>
          <input
            disabled
            value={iptvForm.updatedAtMs ? new Date(iptvForm.updatedAtMs).toLocaleString() : "Not saved yet"}
          />
        </div>

        <button className="primary-button" disabled={working === "iptv-settings"} type="submit">
          {working === "iptv-settings" ? "Saving..." : "Save IPTV settings"}
        </button>
      </form>

      {iptvNotice ? <div className="inline-notice">{iptvNotice}</div> : null}

      <form className="admin-create-form" onSubmit={handleCreateUser}>
        <div className="field compact">
          <span>Email</span>
          <input
            onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
            required
            type="email"
            value={createForm.email}
          />
        </div>

        <div className="field compact">
          <span>Password</span>
          <input
            minLength={6}
            onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
            required
            type="password"
            value={createForm.password}
          />
        </div>

        <div className="field compact">
          <span>Username</span>
          <input
            onChange={(event) => setCreateForm((current) => ({ ...current, username: event.target.value }))}
            required
            value={createForm.username}
          />
        </div>

        <div className="field compact">
          <span>Expiry</span>
          <input
            onChange={(event) =>
              setCreateForm((current) => ({ ...current, subscriptionExpiryInput: event.target.value }))
            }
            type="datetime-local"
            value={createForm.subscriptionExpiryInput}
          />
        </div>

        <label className="toggle-row">
          <input
            checked={createForm.active}
            onChange={(event) => setCreateForm((current) => ({ ...current, active: event.target.checked }))}
            type="checkbox"
          />
          <span>Active</span>
        </label>

        <button className="primary-button" disabled={working === "create"} type="submit">
          {working === "create" ? "Creating..." : "Create user"}
        </button>
      </form>

      <div className="users-table">
        <div className="table-head">
          <span>User</span>
          <span>Subscription</span>
          <span>Device</span>
          <span>Actions</span>
        </div>

        {loading ? <p className="muted-copy">Loading users...</p> : null}

        {users.map((user) => (
          <div className="table-row" key={user.uid}>
            <div className="row-user">
              <input
                className="table-input"
                onChange={(event) =>
                  setUsers((current) =>
                    current.map((item) => (item.uid === user.uid ? { ...item, username: event.target.value } : item)),
                  )
                }
                value={user.username}
              />
              <input className="table-input" disabled value={user.email} />
            </div>

            <div className="row-subscription">
              <input
                className="table-input"
                onChange={(event) =>
                  setUsers((current) =>
                    current.map((item) =>
                      item.uid === user.uid ? { ...item, subscriptionExpiryInput: event.target.value } : item,
                    ),
                  )
                }
                type="datetime-local"
                value={user.subscriptionExpiryInput}
              />
              <label className="toggle-row">
                <input
                  checked={user.active}
                  onChange={(event) =>
                    setUsers((current) =>
                      current.map((item) => (item.uid === user.uid ? { ...item, active: event.target.checked } : item)),
                    )
                  }
                  type="checkbox"
                />
                <span>{user.active ? "Active" : "Inactive"}</span>
              </label>
              <span className="muted-copy">{formatDate(user.subscriptionExpiryMs)}</span>
            </div>

            <div className="row-device">
              <span className="device-badge">{user.deviceId || "Not locked"}</span>
              <span className="muted-copy">{user.role}</span>
            </div>

            <div className="row-actions">
              <button className="secondary-button" onClick={() => void handleSaveUser(user)} type="button">
                {working === user.uid ? "Saving..." : "Save"}
              </button>
              <button className="secondary-button" onClick={() => void handleResetDevice(user.uid)} type="button">
                Reset device
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
