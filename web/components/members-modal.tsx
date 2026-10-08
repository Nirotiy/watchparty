"use client";

import React, { useEffect, useRef, useState } from "react";
import { Crown, Tv, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { CommandAck, RoomMember } from "@/lib/contracts";
import { operationResult, type OperationResult } from "@/lib/media-operation-result";

interface MembersModalProps {
  isOpen: boolean;
  onClose: () => void;
  members: RoomMember[];
  isOwner: boolean;
  onTransferOwnership: (targetClientId: string) => CommandAck | void | Promise<CommandAck | void>;
  onTransferResult?: (result: OperationResult) => void;
}

export function MembersModal(props: MembersModalProps) {
  return props.isOpen ? <OpenMembersModal {...props} /> : null;
}

function OpenMembersModal({
  isOpen,
  onClose,
  members,
  isOwner,
  onTransferOwnership,
  onTransferResult,
}: MembersModalProps) {
  const [confirmTarget, setConfirmTarget] = useState<RoomMember | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferResult, setTransferResult] = useState<OperationResult | null>(null);
  const transferRef = useRef<{ targetId: string; session: number } | null>(null);
  const sessionRef = useRef(0);
  const latest = useRef({ members, isOpen, onClose, onTransferResult });
  useEffect(() => { latest.current = { members, isOpen, onClose, onTransferResult }; }, [members, isOpen, onClose, onTransferResult]);

  useEffect(() => {
    return () => { sessionRef.current += 1; transferRef.current = null; };
  }, []);

  const completeTransfer = () => {
    transferRef.current = null;
    setIsTransferring(false);
    setConfirmTarget(null);
    latest.current.onClose();
  };

  // Older parents return void. Only authoritative ownership can confirm those calls.
  useEffect(() => {
    const transfer = transferRef.current;
    if (isOpen && transfer && members.some((member) => member.clientId === transfer.targetId && member.isOwner)) {
      completeTransfer();
    }
  }, [members, isOpen]);

  if (!isOpen) return null;

  const handleTransfer = async () => {
    if (!confirmTarget || transferRef.current) return;
    const session = sessionRef.current;
    const targetId = confirmTarget.clientId;
    const transfer = { targetId, session };
    transferRef.current = transfer;
    setIsTransferring(true);
    setTransferResult(null);
    let result: OperationResult;
    try {
      const acknowledgement = await onTransferOwnership(targetId);
      result = acknowledgement ? operationResult(acknowledgement)
        : { status: "uncertain", error: { code: "INVALID_ACK", message: "Ownership transfer has no acknowledgement" } };
    } catch {
      result = { status: "uncertain", error: { code: "COMMAND_EXCEPTION", message: "Ownership transfer outcome is unknown" } };
    }
    if (session !== sessionRef.current || !latest.current.isOpen || transferRef.current !== transfer) return;
    setTransferResult(result);
    latest.current.onTransferResult?.(result);
    if (result.status === "succeeded" || latest.current.members.some((member) => member.clientId === targetId && member.isOwner)) {
      completeTransfer();
    } else {
      // Keep uncertain requests guarded until ownership is reconciled or the modal is closed.
      if (result.status === "failed") { transferRef.current = null; setIsTransferring(false); }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md gap-0 border-border bg-card p-0"
        aria-describedby={undefined}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <DialogTitle className="text-lg font-medium text-foreground">成员 · {members.length}</DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* 成员列表；移交确认就地展开在行内（不嵌第二层卡） */}
        <div className="max-h-72 space-y-0.5 overflow-y-auto p-2">
          {members.map((member) => {
            const confirming = confirmTarget?.clientId === member.clientId;
            return (
              <div key={member.clientId}>
                <div className="flex items-center justify-between gap-2 rounded-sm px-2 py-2 text-sm transition-colors hover:bg-accent">
                  <div className="flex min-w-0 items-center gap-2">
                    {member.isOwner ? (
                      <Crown className="size-3.5 shrink-0 text-warn" aria-hidden="true" />
                    ) : member.clientType === "mpv" ? (
                      <Tv className="size-3.5 shrink-0 text-info" aria-hidden="true" />
                    ) : (
                      <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden="true" />
                    )}
                    <span className="truncate font-medium text-foreground">{member.name}</span>
                    {member.clientType === "mpv" && (
                      <span
                        className="shrink-0 rounded-[4px] bg-info-soft px-1.5 text-xs text-info"
                        title="通过 watchparty.lua 加入的 MPV 渲染端，仅同步播放，不能获得房主权限"
                      >
                        MPV
                      </span>
                    )}
                    {member.isSelf && <span className="shrink-0 rounded-[4px] bg-elevated px-1.5 text-xs text-foreground/70">我</span>}
                    {member.isOwner && <span className="shrink-0 rounded-[4px] bg-warn-soft px-1.5 text-xs text-warn">房主</span>}
                  </div>

                  {/* MPV 是永久普通成员（spec 9.4），不参与房主转让 */}
                  {isOwner && !member.isOwner && member.clientType !== "mpv" && (
                    confirming ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Button size="sm" className="h-7 px-2 text-xs" disabled={isTransferring} onClick={() => void handleTransfer()}>
                          {isTransferring ? "移交中…" : "确认移交"}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={isTransferring}
                          onClick={() => { transferRef.current = null; setConfirmTarget(null); }}
                        >
                          取消
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setConfirmTarget(member); setTransferResult(null); }}
                        disabled={isTransferring}
                        className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        移交房主
                      </Button>
                    )
                  )}
                </div>

                {confirming && transferResult && transferResult.status !== "succeeded" && (
                  <p role="alert" className="flex items-start gap-2 px-2 pb-1.5 text-xs text-destructive">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
                    <span className="break-words">
                      {transferResult.status === "uncertain"
                        ? "移交结果未知，正在等待房主状态确认，请勿重复提交"
                        : transferResult.error.message.replace(/https?:\/\/\S+/g, "链接已隐藏")}
                    </span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
