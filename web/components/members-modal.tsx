"use client";

import React, { useState } from "react";
import { Users, Crown, ArrowRightLeft, ShieldCheck, X, Tv } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md gap-0 border-border bg-card p-5"
        aria-describedby={undefined}
      >
        <div className="flex items-center justify-between border-b border-border pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Users className="size-4 text-sky-400" />
            <span>在线成员与房主权限 ({members.length})</span>
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭"
            className="text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* 成员列表 */}
        <div className="mt-4 max-h-64 overflow-y-auto space-y-1.5">
          {members.map((member) => (
            <div
              key={member.clientId}
              className="flex items-center justify-between rounded border border-border bg-black p-2.5 text-xs"
            >
              <div className="flex items-center gap-2">
                {member.isOwner ? (
                  <Crown className="size-4 text-amber-400" />
                ) : member.clientType === "mpv" ? (
                  <Tv className="size-4 text-sky-400" />
                ) : (
                  <div className="size-2 rounded-full bg-emerald-400"></div>
                )}
                <span className="font-medium text-white">{member.name}</span>
                {member.clientType === "mpv" && (
                  <Badge
                    className="border border-sky-800/50 bg-sky-950/40 px-1.5 py-0 text-[10px] font-medium text-sky-400"
                    title="通过 watchparty.lua 加入的 MPV 渲染端，仅同步播放，不能获得房主权限"
                  >
                    MPV
                  </Badge>
                )}
                {member.isSelf && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">我</Badge>}
                {member.isOwner && (
                  <Badge className="border border-amber-800/50 bg-amber-950/40 px-1.5 py-0 text-[10px] font-medium text-amber-400">
                    房主
                  </Badge>
                )}
              </div>

              {/* MPV 是永久普通成员（spec 9.4），不参与房主转让 */}
              {isOwner && !member.isOwner && member.clientType !== "mpv" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmTarget(member)}
                  className="h-7 px-2 text-[11px] text-foreground/85 hover:border-amber-500 hover:text-amber-400"
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
            <p className="text-foreground/85">
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
      </DialogContent>
    </Dialog>
  );
}
