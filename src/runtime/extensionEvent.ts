export interface InvalidationContext {
  readonly isInvalid: boolean;
  onInvalidated(callback: () => void): unknown;
}

export interface ExtensionEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/**
 * Register an extension event across the narrow race where Chrome removes the
 * runtime object before WXT's invalidation signal reaches the content script.
 */
export function registerExtensionEvent<Listener>(
  context: InvalidationContext,
  resolveEvent: () => ExtensionEvent<Listener> | null | undefined,
  listener: Listener,
): boolean {
  if (context.isInvalid) return false;

  let event: ExtensionEvent<Listener>;
  try {
    const resolved = resolveEvent();
    if (!resolved) return false;
    event = resolved;
    event.addListener(listener);
  } catch {
    return false;
  }

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    try {
      event.removeListener(listener);
    } catch {
      // Chrome already destroyed the extension context.
    }
  };

  try {
    context.onInvalidated(remove);
  } catch {
    remove();
    return false;
  }

  // Covers invalidation between addListener() and onInvalidated().
  if (context.isInvalid) {
    remove();
    return false;
  }
  return true;
}
