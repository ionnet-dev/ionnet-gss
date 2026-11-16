import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/Api/BaseApi.ts";
import { ModApi } from "@/Api/ModApi.ts";

export type UploadState = "queued" | "uploading" | "done" | "failed" | "cancelled" | "skipped";

export interface UploadItem {
  id: number;
  name: string;
  sent: number;
  total: number;
  state: UploadState;
  error: string | null;
}

export interface OverwriteQuestion {
  name: string;
  message: string;
}

interface QueuedUpload {
  id: number;
  file: File;
  controller: AbortController;
}

export interface ModUploads {
  uploads: UploadItem[];
  /**
   * The mod that already exists, waiting for the user's answer (replace or skip).
   */
  question: OverwriteQuestion | null;
  enqueue: (files: File[]) => void;
  cancel: (item: UploadItem) => void;
  clear: () => void;
  reply: (overwrite: boolean) => void;
}

/**
 * The upload queue of one mod folder: files go up one at a time with progress; a 409 (exists) asks once for that file
 * whether to replace it and retries with `overwrite`. `onUploaded` runs after each file that landed.
 */
export function useModUploads(serverId: string, folder: string, onUploaded: () => void | Promise<void>): ModUploads {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [question, setQuestion] = useState<OverwriteQuestion | null>(null);
  const queue = useRef<QueuedUpload[]>([]);
  const controllers = useRef(new Map<number, AbortController>());
  const running = useRef(false);
  const nextId = useRef(1);
  const answer = useRef<((overwrite: boolean) => void) | null>(null);
  const uploadedRef = useRef(onUploaded);
  uploadedRef.current = onUploaded;

  const patch = useCallback((id: number, change: Partial<UploadItem>) => {
    setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const ask = (name: string, message: string) =>
    new Promise<boolean>((resolve) => {
      answer.current = resolve;
      setQuestion({ name, message });
    });

  const reply = (overwrite: boolean) => {
    answer.current?.(overwrite);
    answer.current = null;
    setQuestion(null);
  };

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        const { id, file, controller } = next;
        if (controller.signal.aborted) continue;
        patch(id, { state: "uploading" });
        let overwrite = false;
        for (;;) {
          try {
            await ModApi.upload(serverId, folder, file, { overwrite, onProgress: (sent, total) => patch(id, { sent, total }), signal: controller.signal });
            patch(id, { state: "done", sent: file.size, total: file.size });
            await uploadedRef.current();
            break;
          } catch (error) {
            if (controller.signal.aborted) {
              patch(id, { state: "cancelled" });
              break;
            }
            // Only "exists" can be answered by replacing; other 409s (host offline…) just fail.
            if (!overwrite && error instanceof ApiError && error.status === 409 && /exist/i.test(error.message)) {
              if (await ask(file.name, error.message)) {
                overwrite = true;
                continue;
              }
              patch(id, { state: "skipped" });
              break;
            }
            patch(id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
            break;
          }
        }
        controllers.current.delete(id);
      }
    } finally {
      running.current = false;
    }
  }, [serverId, folder, patch]);

  const enqueue = (files: File[]) => {
    if (files.length === 0) return;
    const items: UploadItem[] = [];
    for (const file of files) {
      const id = nextId.current++;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      queue.current.push({ id, file, controller });
      items.push({ id, name: file.name, sent: 0, total: file.size, state: "queued", error: null });
    }
    setUploads((current) => [...current, ...items]);
    drain();
  };

  const cancel = (item: UploadItem) => {
    controllers.current.get(item.id)?.abort();
    if (item.state === "queued") patch(item.id, { state: "cancelled" });
  };

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      answer.current?.(false);
    };
  }, []);

  return { uploads, question, enqueue, cancel, clear: () => setUploads([]), reply };
}
