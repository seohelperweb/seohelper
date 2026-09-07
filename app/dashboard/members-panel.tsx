"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type InvitationItem, type InviteCreated, type MemberItem } from "./client";

const ROLE_LABELS: Record<string, string> = {
  OWNER: "所有者",
  ADMIN: "管理员",
  MEMBER: "成员",
  VIEWER: "只读",
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: "全部权限，含所有者管理",
  ADMIN: "项目管理、成员邀请与角色调整",
  MEMBER: "运行抓取与忽略问题",
  VIEWER: "只读查看",
};

const SELF_MANAGE_ROLES = new Set(["OWNER", "ADMIN"]);

export function MembersPanel({
  workspaceId,
  currentRole,
  onToast,
}: {
  workspaceId: string;
  currentRole: string;
  onToast: (message: string) => void;
}) {
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const canManage = SELF_MANAGE_ROLES.has(currentRole);

  const load = useCallback(async () => {
    const base = `/api/v1/workspaces/${workspaceId}`;
    const [membersData, invitationsData] = await Promise.all([
      api<{ items: MemberItem[] }>(`${base}/members`),
      canManage ? api<{ items: InvitationItem[] }>(`${base}/invitations`) : Promise.resolve({ items: [] }),
    ]);
    setMembers(membersData.items);
    setInvitations(invitationsData.items);
  }, [workspaceId, canManage]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const invite = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const created = await api<InviteCreated>(`/api/v1/workspaces/${workspaceId}/invitations`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const link = `${window.location.origin}/accept-invitation?token=${created.token}`;
      setInviteLink(link);
      setEmail("");
      setBusy(false);
      await load();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "邀请失败");
      setBusy(false);
    }
  };

  const changeRole = async (memberId: string, newRole: string) => {
    try {
      await api<unknown>(`/api/v1/workspaces/${workspaceId}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      await load();
      onToast("角色已更新");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "更新角色失败");
    }
  };

  const removeMember = async (memberId: string, name: string) => {
    if (!window.confirm(`确认移除成员 ${name}？`)) return;
    try {
      await api<unknown>(`/api/v1/workspaces/${workspaceId}/members/${memberId}`, { method: "DELETE" });
      await load();
      onToast("成员已移除");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "移除失败");
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    try {
      await api<unknown>(`/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`, { method: "DELETE" });
      await load();
      onToast("邀请已撤销");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "撤销失败");
    }
  };

  const copyLink = async () => {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink).catch(() => undefined);
    onToast("邀请链接已复制（只显示这一次，注意保存）");
  };

  return (
    <section className="members-panel">
      <div className="section-heading">
        <div>
          <h2>成员与邀请</h2>
          <p>
            当前工作区的成员。你的角色：<strong>{ROLE_LABELS[currentRole] ?? currentRole}</strong>。
          </p>
        </div>
      </div>

      <div className="history-card">
        <div className="table member-table">
          <div className="tr th">
            <span>成员</span>
            <span>邮箱</span>
            <span>角色</span>
            <span>操作</span>
          </div>
          {members.map((member) => (
            <div className="tr" key={member.id}>
              <span>{member.user.name}</span>
              <span className="mono">{member.user.email}</span>
              <span>
                {canManage ? (
                  <select
                    className="role-select"
                    value={member.role}
                    onChange={(e) => changeRole(member.id, e.target.value)}
                    disabled={member.role === "OWNER" && currentRole !== "OWNER"}
                    title={ROLE_DESCRIPTIONS[member.role] ?? member.role}
                  >
                    {Object.keys(ROLE_LABELS).map((key) => (
                      <option key={key} value={key}>
                        {ROLE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                ) : (
                  (ROLE_LABELS[member.role] ?? member.role)
                )}
              </span>
              <span>
                {canManage && (
                  <button
                    className="text-danger"
                    onClick={() => removeMember(member.id, member.user.name)}
                    disabled={member.role === "OWNER"}
                  >
                    移除
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {canManage && (
        <>
          <div className="invite-row">
            <input
              className="invite-input"
              placeholder="member@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select className="role-select" value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_LABELS)
                .filter(([key]) => key !== "OWNER" || currentRole === "OWNER")
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
            <button className="run" onClick={invite} disabled={busy || !email.trim()}>
              {busy ? "创建中…" : "发送邀请"}
            </button>
          </div>

          {inviteLink && (
            <div className="invite-link">
              <p>邀请链接（一次性，仅此刻显示）：</p>
              <code>{inviteLink}</code>
              <button className="text-btn" onClick={copyLink}>
                复制链接
              </button>
              <button className="text-danger" onClick={() => setInviteLink(null)}>
                关闭
              </button>
            </div>
          )}

          {invitations.length > 0 && (
            <div className="history-card">
              <div className="table member-table">
                <div className="tr th">
                  <span>待处理邀请</span>
                  <span>邮箱</span>
                  <span>角色</span>
                  <span>过期时间</span>
                  <span>操作</span>
                </div>
                {invitations
                  .filter((i) => !i.consumedAt && !i.revokedAt)
                  .map((invitation) => (
                    <div className="tr" key={invitation.id}>
                      <span />
                      <span className="mono">{invitation.email}</span>
                      <span>{ROLE_LABELS[invitation.role] ?? invitation.role}</span>
                      <span>{new Date(invitation.expiresAt).toLocaleString()}</span>
                      <span>
                        <button className="text-danger" onClick={() => revokeInvitation(invitation.id)}>
                          撤销
                        </button>
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
