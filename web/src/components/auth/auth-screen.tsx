"use client";

import Image from "next/image";
import { signInWithEmailAndPassword } from "firebase/auth";
import { AlertCircle, ArrowRight, Download, LockKeyhole, Mail, UserRound } from "lucide-react";
import { useState } from "react";

import { registerViewerAccount } from "@/lib/api";
import { getClientAuth } from "@/lib/firebase";

type Mode = "login" | "register";

interface AuthScreenProps {
  onError: (message: string | null) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

export function AuthScreen({ onError }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsernameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    onError(null);

    try {
      const auth = getClientAuth();

      if (mode === "register") {
        await registerViewerAccount({
          email,
          password,
          username,
        });
        setNotice("Account created and saved. An admin must activate the subscription before live TV access is available.");
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="brand-band">
        <div className="brand-copy">
          <span className="eyebrow">Live TV. Anytime. Anywhere.</span>
          <h1>LiveZone</h1>
          <p>
            Secure live IPTV access with subscription controls, device locking, category browsing, and fast HLS
            playback.
          </p>
        </div>

        <div className="hero-preview">
          <div className="hero-panel">
            <Image src="/logo.png" alt="LiveZone" width={420} height={420} priority />
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-switch">
          <button
            className={mode === "login" ? "segment active" : "segment"}
            onClick={() => setMode("login")}
            type="button"
          >
            Sign In
          </button>
          <button
            className={mode === "register" ? "segment active" : "segment"}
            onClick={() => setMode("register")}
            type="button"
          >
            Register
          </button>
        </div>

        <a className="secondary-button mobile-download-link" download href="/livezone-mobile.apk">
          <Download size={16} />
          Get mobile app
        </a>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === "register" ? (
            <label className="field">
              <span>Username</span>
              <div className="input-shell">
                <UserRound size={18} />
                <input
                  autoComplete="nickname"
                  onChange={(event) => setUsernameInput(event.target.value)}
                  placeholder="Your display name"
                  required
                  value={username}
                />
              </div>
            </label>
          ) : null}

          <label className="field">
            <span>Email</span>
            <div className="input-shell">
              <Mail size={18} />
              <input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                type="email"
                value={email}
              />
            </div>
          </label>

          <label className="field">
            <span>Password</span>
            <div className="input-shell">
              <LockKeyhole size={18} />
              <input
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={6}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Minimum 6 characters"
                required
                type="password"
                value={password}
              />
            </div>
          </label>

          {notice ? <div className="inline-notice">{notice}</div> : null}

          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "Please wait..." : mode === "login" ? "Enter LiveZone" : "Create account"}
            <ArrowRight size={18} />
          </button>

          <div className="auth-footnote">
            <AlertCircle size={16} />
            <span>New accounts are created immediately, but live access depends on admin activation and expiry.</span>
          </div>
        </form>
      </section>
    </main>
  );
}
