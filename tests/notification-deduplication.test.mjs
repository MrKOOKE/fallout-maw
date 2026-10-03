import test from "node:test";
import assert from "node:assert/strict";
import { registerNotificationDeduplication } from "../src/utils/notification-deduplication.mjs";

function fixture() {
  const pending = new Map(), logged = [];
  let id = 0;
  const notifications = {
    notify(message, type = "info", options = {}) {
      const notification = { id: ++id, message: String(message), type, options, active: pending.size < 5,
        remove() { pending.delete(this.id); } };
      pending.set(notification.id, notification); logged.push(notification);
      return notification;
    },
    has(notification) { return pending.has(notification.id ?? notification); },
    remove(notification) { pending.delete(notification.id ?? notification); },
    clear() { pending.clear(); },
    warn(message, options) { return this.notify(message, "warning", options); },
    error(message, options) { return this.notify(message, "error", options); }
  };
  registerNotificationDeduplication(notifications);
  return { notifications, pending, logged };
}

test("repeated warning retains one native handle and one console entry until it is removed", () => {
  const { notifications, pending, logged } = fixture();
  const first = notifications.warn("Нет права управления.");
  for (let i = 0; i < 200; i++) assert.equal(notifications.warn("Нет права управления."), first);
  assert.equal(pending.size, 1); assert.equal(logged.length, 1);
  first.remove();
  assert.notEqual(notifications.warn("Нет права управления."), first);
  assert.equal(logged.length, 2);
  notifications.clear();
  notifications.warn("Нет права управления.");
  assert.equal(pending.size, 1); assert.equal(logged.length, 3);
  const changed = notifications.warn("Статус");
  changed.message = "Другой статус";
  assert.notEqual(notifications.warn("Статус"), changed, "a native message update does not suppress the old, now absent text");
});

test("queued duplicates collapse too, while distinct messages, severity and progress tasks retain their own handles", () => {
  const { notifications, pending, logged } = fixture();
  for (let i = 0; i < 5; i++) notifications.warn(`Предупреждение ${i}`);
  const queued = notifications.warn("Двигатель выключен.");
  assert.equal(queued.active, false);
  for (let i = 0; i < 100; i++) assert.equal(notifications.warn("Двигатель выключен."), queued);
  assert.equal(pending.size, 6); assert.equal(logged.length, 6);
  assert.notEqual(notifications.error("Двигатель выключен."), queued);
  const one = notifications.notify("Загрузка", "info", { progress: true });
  const two = notifications.notify("Загрузка", "info", { progress: true });
  assert.notEqual(one, two);
  assert.equal(notifications.warn("Угол {angle}", { format: { angle: 30, unit: "°" } }),
    notifications.warn("Угол {angle}", { format: { unit: "°", angle: 30 } }));
  assert.notEqual(notifications.warn("Угол {angle}", { format: { angle: 45 } }),
    notifications.warn("Угол {angle}", { format: { angle: 30 } }));
  const patched = notifications.notify;
  registerNotificationDeduplication(notifications);
  assert.equal(notifications.notify, patched);
});
