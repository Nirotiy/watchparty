"use client";

import React, { useState } from "react";
import { Users, Crown, ArrowRightLeft, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RoomMember } from "@/lib/contracts";

interface MembersModalProps {
  isOpen: boolean;
  onClose: () => void;
  members: RoomMember[];
  isOwner: boolean;
  onTransferOwnership: (targetClientId: string) => void;
}

export function MembersModal({
  isOpen,
  onClose,
  members,
  isOwner,
  onTransferOwnership,
}: MembersModalProps) {
  const [confirmTarget, setConfirmTarget] = useState<RoomMember | null>(null);

  if (!isOpen) return null;

  const handleTransfer = () => {
    if (confirmTarget) {
      onTransferOwnership(confirmTarget.clientId);
      setConfirmTarget(null);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-5 shadow-2xl shadow-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Users className="size-4 text-sky-400" />
            <span>在线成员与房主权限 ({members.length})</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭"
            className="text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* 成员列表 */}
        <div className="mt-4 max-h-64 overflow-y-auto space-y-1.5">
          {members.map((member) => (
            <div
              key={member.clientId}
              className="flex items-center justify-between rounded border border-neutral-800/80 bg-black p-2.5 text-xs"
            >
              <div className="flex items-center gap-2">
                {member.isOwner ? (
                  <Crown className="size-4 text-amber-400" />
                ) : (
                  <div className="size-2 rounded-full bg-emerald-400"></div>
                )}
                <span className="font-medium text-white">{member.name}</span>
                {member.isSelf && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">我</Badge>}
                {member.isOwner && (
                  <Badge className="border border-amber-800/50 bg-amber-950/40 px-1.5 py-0 text-[10px] font-medium text-amber-400">
                    房主
                  </Badge>
                )}
              </div>

              {isOwner && !member.isOwner && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmTarget(member)}
                  className="h-7 px-2 text-[11px] text-neutral-300 hover:border-amber-500 hover:text-amber-400"
                >
                  <ArrowRightLeft className="size-3" />
                  <span>移交房主</span>
                </Button>
              )}
            </div>
          ))}
        </div>

        {/* 移交房主二次确认 */}
        {confirmTarget && (
          <div className="mt-4 rounded border border-amber-900/60 bg-amber-950/30 p-3 text-xs space-y-2">
            <div className="flex items-center gap-1.5 font-medium text-amber-400">
              <ShieldCheck className="size-4" />
              <span>确认移交房主权限？</span>
            </div>
            <p className="text-neutral-300">
              您即将把房主权限转让给 <strong className="text-white">{confirmTarget.name}</strong>。移交后您将失去房主锁和播放控制优先权。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setConfirmTarget(null)}>取消</Button>
              <Button
                size="sm"
                onClick={handleTransfer}
                className="bg-amber-500 font-semibold text-black hover:bg-amber-400"
              >
                确认移交
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
