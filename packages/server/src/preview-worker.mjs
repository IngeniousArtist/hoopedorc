// A small IPC supervisor survives parent death long enough to settle the
// repository process group. It never inherits the control-plane environment.
import { spawnManagedProcess } from "@orc/adapters";
const controller = new AbortController();
let started = false;
let logged = 0;
const stop = () => { controller.abort(); if (!started) process.exit(0); };
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const send = (message) => { if (process.connected) process.send(message, () => {}); };
const log = (data) => {
  if (logged >= 65536) return;
  const text = data.toString("utf8").slice(0, Math.min(8192, 65536 - logged));
  logged += text.length;
  send({ type: "log", text: text + (logged >= 65536 ? "\n[Preview log limit reached]\n" : "") });
};
process.on("message", async (message) => {
  if (message?.type === "stop") { stop(); return; }
  if (message?.type !== "start" || started) return;
  started = true;
  try {
    const managed = spawnManagedProcess(message.command, message.args, {
      cwd: message.cwd, env: message.env, signal: controller.signal, captureOutput: false,
    });
    managed.child.once("spawn", () => send({ type: "spawned", pid: managed.child.pid }));
    managed.child.once("exit", () => controller.abort());
    managed.child.stdout.on("data", log);
    managed.child.stderr.on("data", log);
    const result = await managed.settled;
    send({ type: "ended", code: result.code, aborted: result.aborted });
  } catch (error) { send({ type: "error", message: error instanceof Error ? error.message : "Preview process failed." }); }
  finally { if (process.connected) process.disconnect(); }
});
