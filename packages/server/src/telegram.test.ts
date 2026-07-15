import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Notification } from "@orc/types";
import {
  TELEGRAM_COMMANDS,
  TELEGRAM_MESSAGE_LIMIT,
  TelegramBot,
  splitTelegramMessage,
  type TgUpdate,
} from "./telegram.js";

function response(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function update(data: Partial<TgUpdate>): TgUpdate {
  return { update_id: 1, ...data };
}

const privateMessage = {
  chat: { id: 42, type: "private" },
  from: { id: 42 },
};

test("F49: start registers BotFather commands before long polling", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (method === "setMyCommands") return response({ ok: true, result: true });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    { onApproval: () => true, onCommand: () => "" },
    () => {},
    { fetchImpl, maxRetries: 0 },
  );
  bot.start();
  await waitImmediate();
  bot.stop();
  await waitImmediate();

  assert.equal(calls[0]?.method, "setMyCommands");
  assert.deepEqual(calls[0]?.body.commands, TELEGRAM_COMMANDS);
  assert.equal(calls[1]?.method, "getUpdates");
});

test("F49: callbacks require both the configured private chat and callback user", async () => {
  let approvals = 0;
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response({ ok: true, result: true });
  }) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    { onApproval: () => { approvals++; return true; }, onCommand: () => "" },
    () => {},
    { fetchImpl, maxRetries: 0 },
  );

  await bot.processUpdate(update({
    callback_query: {
      id: "callback",
      data: "appr:n1:approve",
      from: { id: 7 },
      message: { chat: { id: 42, type: "private" }, message_id: 9 },
    },
  }));

  assert.equal(approvals, 0);
  assert.equal(bodies[0]?.text, "Unauthorized");
  assert.equal(bodies[0]?.show_alert, true);
});

test("F49: authorized inline project actions call the shared handler", async () => {
  const actions: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response({ ok: true, result: true });
  }) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    {
      onApproval: () => true,
      onCommand: () => "",
      onProjectAction: (action, projectId) => {
        actions.push(`${action}:${projectId}`);
        return "Started Project";
      },
    },
    () => {},
    { fetchImpl, maxRetries: 0 },
  );

  await bot.processUpdate(update({
    callback_query: {
      id: "callback",
      data: "proj:start:p1",
      from: { id: 42 },
      message: { chat: { id: 42, type: "private" }, message_id: 9 },
    },
  }));

  assert.deepEqual(actions, ["start:p1"]);
  assert.equal(sent.some((body) => body.text === "Started Project"), true);
});

test("F49: command failures are returned to the authorized user", async () => {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response({ ok: true, result: true });
  }) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    {
      onApproval: () => true,
      onCommand: () => { throw new Error("engine unavailable"); },
    },
    () => {},
    { fetchImpl, maxRetries: 0 },
  );

  await bot.processUpdate(update({
    message: { ...privateMessage, text: "/start p1" },
  }));
  assert.equal(sent[0]?.text, "Command failed: engine unavailable");
});

test("F49: Telegram 429 honors retry_after before bounded retry", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? response({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 2 },
        }, 429)
      : response({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    { onApproval: () => true, onCommand: () => "" },
    () => {},
    {
      fetchImpl,
      maxRetries: 1,
      sleep: async (ms) => { delays.push(ms); },
    },
  );
  assert.equal(await bot.send("hello"), true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
});

test("F49: request deadline degrades delivery instead of hanging", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    { onApproval: () => true, onCommand: () => "" },
    () => {},
    { fetchImpl, maxRetries: 0, requestTimeoutMs: 5 },
  );
  assert.equal(await bot.send("hello"), false);
  assert.equal(bot.health.state, "degraded");
  assert.match(bot.health.lastError ?? "", /timed out/);
});

test("F49: delivery health and logs redact the bot token from fetch errors", async () => {
  const logs: string[] = [];
  const fetchImpl = (async () => {
    throw new Error("failed https://api.telegram.org/bottop-secret/sendMessage");
  }) as typeof fetch;
  const bot = new TelegramBot(
    "top-secret",
    "42",
    { onApproval: () => true, onCommand: () => "" },
    (message) => logs.push(message),
    { fetchImpl, maxRetries: 0 },
  );
  assert.equal(await bot.send("hello"), false);
  assert.doesNotMatch(JSON.stringify(bot.health), /top-secret/);
  assert.doesNotMatch(logs.join("\n"), /top-secret/);
  assert.match(bot.health.lastError ?? "", /\[redacted\]/);
});

test("F49: long messages are chunked below the Bot API limit", async () => {
  const texts: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    texts.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return response({ ok: true, result: true });
  }) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    { onApproval: () => true, onCommand: () => "" },
    () => {},
    { fetchImpl, maxRetries: 0 },
  );
  const message = "x".repeat(TELEGRAM_MESSAGE_LIMIT * 2 + 17);
  assert.equal(await bot.send(message), true);
  assert.equal(texts.length, 3);
  assert.equal(texts.every((text) => text.length <= TELEGRAM_MESSAGE_LIMIT), true);
  assert.equal(texts.join(""), message);
  assert.deepEqual(splitTelegramMessage("short"), ["short"]);
});

test("F49: permanent approval delivery failure is surfaced after retries", async () => {
  let calls = 0;
  let resolveFailure!: (value: { id: string; error: string }) => void;
  const failure = new Promise<{ id: string; error: string }>((resolve) => {
    resolveFailure = resolve;
  });
  const fetchImpl = (async () => {
    calls++;
    return response({ ok: false, description: "upstream unavailable" }, 503);
  }) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    {
      onApproval: () => true,
      onCommand: () => "",
      onApprovalDeliveryFailure: (id, error) => resolveFailure({ id, error }),
    },
    () => {},
    { fetchImpl, maxRetries: 1, sleep: async () => {} },
  );
  const notification: Notification = {
    id: "n1",
    projectId: "p1",
    severity: "action_required",
    title: "Approve",
    message: "Please approve",
    requiresApproval: true,
    createdAt: new Date().toISOString(),
  };
  bot.approvalRequested(notification);
  assert.deepEqual(await failure, { id: "n1", error: "upstream unavailable" });
  assert.equal(calls, 4, "Markdown and plain sends each use one bounded retry");
});
