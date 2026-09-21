/**
 * WebSocket client for /ws/progress. The sidecar pushes ProgressMessage
 * frames for every long-running job (batch discovery, batch remap, stats
 * export); this module maintains a single shared socket and fans out
 * messages to subscribers keyed by job_id.
 */

import type { ProgressMessage } from "@/types/api";
import { getSidecarPort, getSidecarToken } from "@/api/client";

type ProgressCallback = (message: ProgressMessage) => void;

class ProgressSocket {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private subscribers = new Map<string, Set<ProgressCallback>>();
  private wildcardSubscribers = new Set<ProgressCallback>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const [port, token] = await Promise.all([getSidecarPort(), getSidecarToken()]);
      await new Promise<void>((resolve, reject) => {
        // WebSocket's constructor can't set custom headers, so the auth
        // token travels as a query param here instead — see server.py's
        // ws_progress handler, which checks it the same way.
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/api/v1/ws/progress?token=${encodeURIComponent(token)}`,
        );
        this.socket = ws;
        this.closedByUser = false;

        ws.onopen = () => {
          this.reconnectAttempts = 0;
          resolve();
        };

        ws.onmessage = (event) => {
          let parsed: ProgressMessage | null = null;
          try {
            parsed = JSON.parse(event.data as string) as ProgressMessage;
          } catch {
            return;
          }
          this.dispatch(parsed);
        };

        ws.onerror = () => {
          reject(new Error("Progress WebSocket connection failed"));
        };

        ws.onclose = () => {
          this.socket = null;
          if (!this.closedByUser) this.scheduleReconnect();
        };
      });
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size > 0 || this.wildcardSubscribers.size > 0) {
        this.ensureConnected().catch(() => {
          /* handled by next reconnect attempt */
        });
      }
    }, delay);
  }

  private dispatch(message: ProgressMessage): void {
    const jobSubs = this.subscribers.get(message.job_id);
    jobSubs?.forEach((cb) => cb(message));
    this.wildcardSubscribers.forEach((cb) => cb(message));
  }

  /** Subscribe to progress updates for a specific job id. Returns an unsubscribe fn. */
  subscribe(jobId: string, callback: ProgressCallback): () => void {
    if (!this.subscribers.has(jobId)) {
      this.subscribers.set(jobId, new Set());
    }
    this.subscribers.get(jobId)!.add(callback);
    this.ensureConnected().catch(() => {
      /* connection errors surface via reconnect attempts; subscriber just gets no events */
    });

    return () => {
      const set = this.subscribers.get(jobId);
      set?.delete(callback);
      if (set && set.size === 0) this.subscribers.delete(jobId);
      this.maybeDisconnect();
    };
  }

  /** Subscribe to every progress message regardless of job id. Returns an unsubscribe fn. */
  subscribeAll(callback: ProgressCallback): () => void {
    this.wildcardSubscribers.add(callback);
    this.ensureConnected().catch(() => {
      /* connection errors surface via reconnect attempts; subscriber just gets no events */
    });

    return () => {
      this.wildcardSubscribers.delete(callback);
      this.maybeDisconnect();
    };
  }

  private maybeDisconnect(): void {
    if (this.subscribers.size === 0 && this.wildcardSubscribers.size === 0) {
      this.closedByUser = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.socket?.close();
      this.socket = null;
    }
  }
}

export const progressSocket = new ProgressSocket();
