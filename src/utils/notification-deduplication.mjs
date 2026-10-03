const PATCH = Symbol.for("fallout-maw.notificationDeduplication");

/** Keep the native notification, including its lifetime and removal API. */
export function registerNotificationDeduplication(notifications = globalThis.ui?.notifications) {
  if (!notifications?.notify || !notifications.has || notifications.notify[PATCH]) return;
  const original = notifications.notify, pending = new Map();
  function notify(message, type = "info", options = {}) {
    // Concurrent progress tasks need their own handles even when their labels match.
    if (options.progress) return original.call(this, message, type, options);
    for (const [key, entry] of pending) if (!this.has(entry.notification)
      || entry.notification.message !== entry.message) pending.delete(key);
    const format = options.format ? Object.entries(options.format).sort(([a], [b]) => a.localeCompare(b)) : null;
    const key = JSON.stringify([type, String(message), format, options.escape !== false, options.clean !== false]);
    const existing = pending.get(key);
    if (existing) return existing.notification;
    const notification = original.call(this, message, type, options);
    pending.set(key, { notification, message: notification.message });
    return notification;
  }
  Object.defineProperty(notify, PATCH, { value: true });
  notifications.notify = notify;
}
