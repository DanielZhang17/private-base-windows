import { api } from "../services/api.js";

export interface ResolvedFileUrl {
  downloadUrl: string | null;
  expiresAt: number | null;
}

class FileUrlResolver {
  private pending = new Map<string, Promise<ResolvedFileUrl>>();
  private queue: { fileId: string; resolve: (result: ResolvedFileUrl) => void }[] = [];
  private flushTimer: any = null;

  resolve(fileId: string): Promise<ResolvedFileUrl> {
    if (this.pending.has(fileId)) return this.pending.get(fileId)!;
    
    const promise = new Promise<ResolvedFileUrl>((resolve) => {
      this.queue.push({ fileId, resolve });
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), 50); // 50ms debounce
      }
    });
    
    this.pending.set(fileId, promise);
    return promise;
  }

  private async flush() {
    this.flushTimer = null;
    const batch = this.queue.splice(0, 100);
    if (batch.length === 0) return;

    // If more items remain after this batch, schedule another pass immediately.
    if (this.queue.length > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 0);
    }

    try {
      const { urls } = await api.post<{ urls: Record<string, ResolvedFileUrl | null> }>("/api/files/batch-download-urls", {
        fileIds: batch.map(b => b.fileId)
      });
      
      batch.forEach(({ fileId, resolve }) => {
        resolve(urls[fileId] ?? { downloadUrl: null, expiresAt: null });
        this.pending.delete(fileId);
      });
    } catch (err) {
      console.error("Failed to batch resolve file URLs:", err);
      batch.forEach(({ fileId, resolve }) => {
        resolve({ downloadUrl: null, expiresAt: null });
        this.pending.delete(fileId);
      });
    }
  }
}

export const fileUrlResolver = new FileUrlResolver();
