import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Notification } from "@orc/types";
import { initDb } from "./db/index.js";
import {
  commitTelegramActionEffect,
  SqliteTelegramUpdateStore,
} from "./telegram-inbox.js";
import {
  classifyTelegramUpdate,
  TELEGRAM_COMMANDS,
  TELEGRAM_MESSAGE_LIMIT,
  TelegramBot,
  splitTelegramMessage,
  type TgUpdate,
  type TelegramUpdateStore,
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

test("O15: every Telegram domain mutation is classified before handling", () => {
  const cases: Array<[TgUpdate, string | undefined]> = [
    [update({ message: { ...privateMessage, text: "/start p1" } }), "command_start"],
    [update({ message: { ...privateMessage, text: "/pause p1" } }), "command_pause"],
    [update({ message: { ...privateMessage, text: "/retry task" } }), "command_retry"],
    [update({ message: { ...privateMessage, text: "/autonomous on" } }), "settings_autonomous"],
    [update({ message: { ...privateMessage, text: "/digest all" } }), "settings_digest"],
    [update({ callback_query: { id: "1", data: "appr:n1:approve" } }), "approval"],
    [update({ callback_query: { id: "2", data: "stopall:yes" } }), "stop_all"],
    [update({ callback_query: { id: "3", data: "proj:start:p1" } }), "project_start"],
    [update({ callback_query: { id: "4", data: "proj:pause:p1" } }), "project_pause"],
    [update({ message: { ...privateMessage, text: "/status" } }), undefined],
    [update({ message: { ...privateMessage, text: "/pending" } }), undefined],
    [update({ message: { ...privateMessage, text: "/stopall" } }), undefined],
    [update({ callback_query: { id: "5", data: "proj:status:p1" } }), undefined],
  ];
  for (const [telegramUpdate, kind] of cases) {
    assert.equal(
      classifyTelegramUpdate(telegramUpdate).action?.kind,
      kind,
      JSON.stringify(telegramUpdate),
    );
  }
});

test("O15: a failure before claim has no receipt and Telegram redelivery remains processable", async () => {
  const db = initDb(":memory:");
  const durable = new SqliteTelegramUpdateStore(db);
  let failClaim = true;
  const store: TelegramUpdateStore = {
    claim: (...args) => {
      if (failClaim) {
        failClaim = false;
        throw new Error("injected crash before claim");
      }
      return durable.claim(...args);
    },
    tryStart: (updateId) => durable.tryStart(updateId),
    recover: () => durable.recover(),
    release: (updateId) => durable.release(updateId),
    complete: (updateId) => durable.complete(updateId),
    nextOffset: () => durable.nextOffset(),
    prune: (days) => durable.prune(days),
  };
  let handled = 0;
  const bot = new TelegramBot(
    "token",
    "42",
    {
      onApproval: () => true,
      onCommand: (_cmd, _args, context) => {
        handled++;
        const key = context?.idempotencyKey;
        assert.ok(key);
        commitTelegramActionEffect(db, key, () => ({ ok: true }));
        return "Started";
      },
    },
    () => {},
    {
      fetchImpl: () => Promise.resolve(response({ ok: true, result: true })),
      maxRetries: 0,
      updateStore: store,
    },
  );
  const command = update({ message: { ...privateMessage, text: "/start p1" } });

  await assert.rejects(bot.processUpdate(command), /before claim/);
  assert.equal(durable.getUpdate(1), null);
  assert.equal(durable.nextOffset(), 0);
  await bot.processUpdate(command);
  assert.equal(handled, 1);
  assert.equal(durable.getUpdate(1)?.state, "processed");
  db.close();
});

test("O15: handler crash after an effect retries the same key without duplicating it", async () => {
  const db = initDb(":memory:");
  const store = new SqliteTelegramUpdateStore(db);
  let attempts = 0;
  let effects = 0;
  const fetchImpl = (() =>
    Promise.resolve(response({ ok: true, result: true }))) as typeof fetch;
  const bot = new TelegramBot(
    "token",
    "42",
    {
      onApproval: () => true,
      onCommand: (_cmd, _args, context) => {
        attempts++;
        const key = context?.idempotencyKey;
        assert.equal(key, "telegram:1");
        commitTelegramActionEffect(db, key, () => ({
          effects: ++effects,
        }));
        if (attempts === 1) throw new Error("injected crash after effect");
        return "Recovered";
      },
    },
    () => {},
    { fetchImpl, maxRetries: 0, updateStore: store },
  );
  const command = update({ message: { ...privateMessage, text: "/start p1" } });

  await assert.rejects(bot.processUpdate(command), /injected crash/);
  assert.equal(store.getUpdate(1)?.state, "claimed");
  assert.equal(store.getAction(1)?.state, "effect_committed");
  await bot.processUpdate(command);
  await bot.processUpdate(command);

  assert.equal(attempts, 2, "processed duplicate is skipped");
  assert.equal(effects, 1);
  assert.equal(store.getUpdate(1)?.state, "processed");
  assert.equal(store.nextOffset(), 2);
  db.close();
});

test("O15: startup drains durable claims before requesting newer updates", async () => {
  const db = initDb(":memory:");
  const store = new SqliteTelegramUpdateStore(db);
  const claimed = {
    update_id: 41,
    message: { ...privateMessage, text: "/start p1" },
  } satisfies TgUpdate;
  const classified = classifyTelegramUpdate(claimed);
  store.claim(claimed, classified.identity, classified.action);
  const calls: string[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const rawUrl = typeof url === "string"
      ? url
      : url instanceof URL
        ? url.href
        : url.url;
    const method = rawUrl.split("/").pop()!;
    calls.push(method);
    if (method !== "getUpdates") {
      return Promise.resolve(response({ ok: true, result: true }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;
  const handled: number[] = [];
  const bot = new TelegramBot(
    "token",
    "42",
    {
      onApproval: () => true,
      onCommand: (_cmd, _args, context) => {
        const key = context?.idempotencyKey;
        assert.ok(key);
        handled.push(context.updateId);
        commitTelegramActionEffect(db, key, () => ({ ok: true }));
        return "Recovered";
      },
    },
    () => {},
    { fetchImpl, maxRetries: 0, updateStore: store },
  );

  bot.start();
  await waitImmediate();
  await waitImmediate();
  bot.stop();
  await waitImmediate();

  assert.deepEqual(handled, [41]);
  assert.equal(store.getUpdate(41)?.state, "processed");
  assert.ok(calls.indexOf("sendMessage") < calls.indexOf("getUpdates"));
  db.close();
});

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
