"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/server/auth/auth-client";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    const { error } = await authClient.signUp.email({ name, email, password, callbackURL: "/login" });
    setPending(false);
    if (error) {
      setError(error.message ?? "注册失败，请重试");
      return;
    }
    setSent(true);
  };

  const resend = async () => {
    if (!email) return;
    await fetch("/api/auth/email-verification/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, callbackURL: "/login" }),
    });
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>注册 Indexly</h1>
        <p className="sub">注册后需要验证邮箱；加入工作区需要团队成员的邀请链接。</p>
        {error && <div className="auth-error">{error}</div>}
        {sent ? (
          <div className="auth-ok">
            验证邮件已发送到 {email}。开发环境下链接会打印在服务端控制台。
            <button type="button" className="auth-link" onClick={resend} style={{ background: "none", border: 0 }}>
              重新发送
            </button>
          </div>
        ) : (
          <>
            <label className="auth-label" htmlFor="name">
              姓名
            </label>
            <input
              id="name"
              className="auth-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={1}
            />
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
              密码（至少 8 位）
            </label>
            <input
              id="password"
              className="auth-input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
            <button className="auth-btn" type="submit" disabled={pending}>
              {pending ? "注册中…" : "注册"}
            </button>
          </>
        )}
        <Link className="auth-link" href="/login">
          已有账号？直接登录
        </Link>
      </form>
    </div>
  );
}
