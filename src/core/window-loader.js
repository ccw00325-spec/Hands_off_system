import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Retry only interrupted/transient local-document loads. Missing or blocked files
// are genuine failures; never hide them or relax the renderer's security policy.
const recoverable = new Set(["ERR_FAILED", "ERR_ABORTED"]);
export async function loadLocalWindow(window, file, {
  isClosing = () => false,
  beforeAttempt = () => {},
  onRetry = () => {},
  onFailure = async () => {},
  retryDelays = [250, 750],
} = {}) {
  const closed = () => isClosing() || window.isDestroyed() || window.webContents.isDestroyed();
  if (closed()) return false;
  await access(file);
  const url = pathToFileURL(file).href;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (closed()) return false;
    beforeAttempt();
    try {
      await window.loadURL(url);
      return !closed();
    } catch (error) {
      if (closed()) return false;
      await onFailure(error, attempt + 1);
      if (!recoverable.has(error.code) || attempt === retryDelays.length) throw error;
      onRetry(attempt + 2);
      await delay(retryDelays[attempt]);
    }
  }
  return false;
}
