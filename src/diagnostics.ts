/**
 * Record handled failures during development without polluting Chromium's
 * extension-error database in production. Callers must still propagate real
 * failures through their normal state/message channel.
 */
export function debugHandledFailure(context: string, error: unknown): void {
  if (!import.meta.env.DEV) return;
  console.debug(`[TTSForX] ${context}`, error);
}
