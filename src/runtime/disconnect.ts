/** Acknowledge Chromium's transient port error while its disconnect callback runs. */
export function acknowledgeDisconnectError(): void {
  try {
    void browser.runtime.lastError;
  } catch {
    // The extension context can already be gone during an update.
  }
}
