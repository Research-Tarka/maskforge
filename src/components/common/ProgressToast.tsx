/**
 * WebSocket-driven progress toast stack for long-running operations
 * (batch discovery, batch remap, stats export). Subscribes to every
 * progress message and shows one toast per active job_id, removing it
 * shortly after it reports progress >= 1.
 */

import { useEffect, useRef, useState } from "react";
import { progressSocket } from "@/api/progressSocket";
import type { ProgressMessage } from "@/types/api";

const AUTO_DISMISS_MS = 2500;

export default function ProgressToast() {
  const [jobs, setJobs] = useState<Record<string, ProgressMessage>>({});
  const dismissTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const timersAtMount = dismissTimers.current;

    const unsubscribe = progressSocket.subscribeAll((message) => {
      setJobs((prev) => ({ ...prev, [message.job_id]: message }));

      if (message.progress >= 1) {
        if (timersAtMount[message.job_id]) {
          clearTimeout(timersAtMount[message.job_id]);
        }
        timersAtMount[message.job_id] = setTimeout(() => {
          setJobs((prev) => {
            const next = { ...prev };
            delete next[message.job_id];
            return next;
          });
          delete timersAtMount[message.job_id];
        }, AUTO_DISMISS_MS);
      }
    });

    return () => {
      unsubscribe();
      Object.values(timersAtMount).forEach(clearTimeout);
    };
  }, []);

  const activeJobs = Object.values(jobs);
  if (activeJobs.length === 0) return null;

  return (
    <div className="progress-toast-stack">
      {activeJobs.map((job) => (
        <div className="progress-toast" key={job.job_id}>
          <div className="progress-toast__header">
            <span className="progress-toast__phase">{job.phase}</span>
            <span className="progress-toast__percent">
              {Math.round(job.progress * 100)}%
            </span>
          </div>
          <div className="progress-toast__bar-track">
            <div
              className="progress-toast__bar-fill"
              style={{ width: `${Math.min(100, Math.max(0, job.progress * 100))}%` }}
            />
          </div>
          <div className="progress-toast__message">{job.message}</div>
        </div>
      ))}
    </div>
  );
}
