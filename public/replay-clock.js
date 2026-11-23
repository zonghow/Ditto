// A cached tab's last server timestamp is not "now" when selected later. Use
// elapsed local monotonic time since receipt, without assuming synchronized
// Mac/devbox wall clocks or changing the recorded event timestamps.
export function replayBaseline(recording, bufferMs = 80, now = performance.now()) {
  const elapsed = Number.isFinite(recording.receivedAt) ? Math.max(0, now - recording.receivedAt) : 0;
  return recording.serverTime + elapsed - bufferMs;
}
