"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/server/auth/auth-client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { error } = await authClient.signIn.email({ email, password });
      if (error) {
        setError(error.message ?? "登录失败，请重试");
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next");
      const target = new URL(next ?? "/", window.location.origin);
      window.location.href = target.origin === window.location.origin ? target.href : "/";
    } catch (error) {
      setError(error instanceof Error ? error.message : "登录失败，请重试");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>登录 Indexly</h1>
        <p className="sub">监控网站技术 SEO 变化的团队工作台。</p>
        {error && <div className="auth-error">{error}</div>}
        <label className="auth-label" htmlFor="email">
          邮箱
        </label>
        <input
          id="email"
          className="auth-input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label className="auth-label" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          className="auth-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="auth-btn" type="submit" disabled={pending}>
          {pending ? "登录中…" : "登录"}
        </button>
        <Link className="auth-link" href="/register">
          没有账号？注册一个（需邀请才能加入工作区）
        </Link>
      </form>
    </div>
  );
}
