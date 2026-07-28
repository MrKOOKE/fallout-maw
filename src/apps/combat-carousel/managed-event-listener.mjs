/**
 * Register an event listener and return an idempotent cleanup callback.
 *
 * Keeping the exact listener reference inside the cleanup closure is important:
 * EventTarget.removeEventListener cannot remove a newly-bound copy of a method.
 *
 * @param {EventTarget} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} listener
 * @param {boolean | AddEventListenerOptions} [options]
 * @returns {() => boolean} Whether this call removed the listener.
 */
export function addManagedEventListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    let active = true;

    return () => {
        if (!active) return false;
        active = false;
        target.removeEventListener(type, listener, options);
        return true;
    };
}
