/** Redirect native Sound gain without resetting an unfinished ramp or creating asynchronous fade waits. */
export function transitionSoundGain(sound, volume, duration) {
  const gain = sound.gain;
  if (!gain) return;
  const now = sound.context.currentTime, current = gain.value;
  if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(now);
  else gain.cancelScheduledValues(now);
  // A completed ramp has no pending endpoint for cancelAndHoldAtTime to hold.
  // Anchor now explicitly, otherwise the next ramp starts at an old event time.
  gain.setValueAtTime(current, now);
  if (duration > 0) gain.linearRampToValueAtTime(volume, now + duration / 1000);
  else gain.setValueAtTime(volume, now);
}
