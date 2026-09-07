"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function AcceptForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [pending, setPending] = useState(false);

  const accept = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json()) as {
        data?: { workspaceName: string; role: string };
        error?: { message: string; code: string };
      };
      if (response.ok && body.data) {
        setResult(`已加入工作区「${body.data.workspaceName}」，角色：${body.data.role}`);
      } else if (response.status === 401) {
        setNeedLogin(true);
      } else {
        setError(body.error?.message ?? "接受邀请失败");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "接受邀请失败，请重试");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>接受工作区邀请</h1>
        <p className="sub">需要使用与邀请邮箱一致且已验证的账号登录。</p>
        {result && <div className="auth-ok">{result}</div>}
        {error && <div className="auth-error">{error}</div>}
        {needLogin && (
          <div className="auth-error">
            请先登录或注册。登录后回到此链接继续。
            <br />
            <Link className="auth-link" href={`/login?next=${encodeURIComponent(`/accept-invitation?token=${token}`)}`}>
              前往登录
            </Link>
          </div>
        )}
        {!token && <div className="auth-error">链接缺少邀请令牌。</div>}
        <button className="auth-btn" type="button" onClick={accept} disabled={pending || !token || result !== null}>
          {pending ? "处理中…" : "接受邀请"}
        </button>
        {result && (
          <Link className="auth-link" href="/">
            进入首页
          </Link>
        )}
      </div>
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <AcceptForm />
    </Suspense>
  );
}
