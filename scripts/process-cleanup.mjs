import { createConnection } from "node:net";

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForChildExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolveExit(false);
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolveExit(true);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("close", onClose);
      child.off("exit", onClose);
    };
    child.once("close", onClose);
    child.once("exit", onClose);
  });
}

export async function terminateChild(child, label = "child process", timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  if (await waitForChildExit(child, timeoutMs)) return;

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  if (!(await waitForChildExit(child, timeoutMs))) {
    throw new Error(`${label} did not exit after SIGKILL (pid ${pid})`);
  }
}

export async function waitForPidExit(pid, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidExists(pid)) return true;
    await delay(100);
  }
  return !pidExists(pid);
}

export async function terminatePid(pid, label = "process", timeoutMs = 5000) {
  if (!Number.isInteger(pid) || pid <= 0 || !pidExists(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForPidExit(pid, timeoutMs)) return;

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  if (!(await waitForPidExit(pid, timeoutMs))) {
    throw new Error(`${label} did not exit after SIGKILL (pid ${pid})`);
  }
}

export function portIsListening(port) {
  return new Promise((resolveCheck) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolveCheck(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolveCheck(false);
    });
  });
}

export async function waitForPortClosed(port, timeoutMs = 5000) {
  if (!Number.isInteger(port) || port <= 0) return true;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await portIsListening(port))) return true;
    await delay(100);
  }
  return !(await portIsListening(port));
}

export async function assertPortClosed(port, label = `port ${port}`, timeoutMs = 5000) {
  if (!(await waitForPortClosed(port, timeoutMs))) {
    throw new Error(`${label} is still accepting connections after cleanup`);
  }
}
