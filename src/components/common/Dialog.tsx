/**
 * Generic modal dialog primitive used by confirmations (remap confirm,
 * destructive delete confirmations, etc.) and lightweight forms.
 */

import { useEffect, type ReactNode } from "react";

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export default function Dialog({ open, title, onClose, children, footer, width = 420 }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__header">
          <h2 className="dialog__title">{title}</h2>
          <button type="button" className="dialog__close" onClick={onClose} aria-label="Close dialog">
            &times;
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}
