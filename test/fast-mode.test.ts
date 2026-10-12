// Import helpers first: every app, credential, and conversation lives in a temporary install.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import {
    type FauxResponseStep,
    normalizeContext,
    type Provider,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ChatDoc, SubagentsDoc } from "../src/server/docs.ts";
import { agentInfo, supportsFastMode } from "../src/server/models.ts";

const requests: { text: string; tier: SimpleStreamOptions["serviceTier"]; provider: string }[] = [];
let pauseNext = false;

const route: FauxResponseStep = async (request, options, _state, model) => {
    const { role, text } = lastText(request as never);

    requests.push({ text, tier: options?.serviceTier, provider: model.provider });

    if (pauseNext) {
        pauseNext = false;
        await new Promise<void>((_resolve, reject) => {
            options!.signal!.addEventListener("abort", () => reject(new Error("interrupted")), {
                once: true,
            });
        });
    }

    if (
        role === "user" &&
        (text.endsWith("spawn fast helper") || text.endsWith("spawn unsupported helper"))
    ) {
        const unsupported = text.endsWith("spawn unsupported helper");

        return fauxAssistantMessage(
            fauxToolCall("subagent", {
                action: "spawn",
                name: "helper",
                message: unsupported ? "unsupported child hello" : "child hello",
                ...(unsupported ? { model: "faux/faux-1" } : {}),
            }),
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage("scripted answer");
};

// Real OpenAI capability metadata, but only scripted streams and keyless faux auth.
const supported = fauxProvider({
    provider: "openai",
    api: "openai-responses",
    tokensPerSecond: 10000,
    models: [
        { id: "fast-test", reasoning: true },
        { id: "fast-test-2", reasoning: true },
    ],
});

supported.setResponses(Array.from({ length: 200 }, () => route));
const unsupported = scriptedModel(route);
let app: App;

async function open() {
    const opened = await openApp(supported);

    opened.models.registerNativeProvider(unsupported.provider);

    return opened;
}

before(async () => {
    app = await open();
    await app.setSubagentModels(owner(app), ["faux/faux-1"]);
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function session(fastMode = false) {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "openai", modelId: "fast-test" },
        thinkingLevel: "high",
        fastMode,
    });

    return id;
}

async function info(id: ConversationId) {
    return agentInfo(app.models, (await app.agentState(id))!, work);
}

async function activities(id: ConversationId) {
    return (await app.harness.snapshot(ChatDoc, id, context))!.messages.map((item) => item.text);
}

function requestFor(text: string) {
    const found = requests.findLast((request) => request.text.endsWith(text));

    assert.ok(found, `a scripted request for ${text}`);

    return found;
}

test("capability detection requires an OpenAI provider and a Responses API", () => {
    const model = supported.getModel();

    assert.equal(supportsFastMode(model), true);
    assert.equal(
        supportsFastMode({ ...model, provider: "openai-codex", api: "openai-codex-responses" }),
        true,
    );
    assert.equal(supportsFastMode({ ...model, provider: "proxy" }), false);
    assert.equal(supportsFastMode({ ...model, api: "openai-completions" }), false);
    assert.equal(supportsFastMode(undefined), false);
});

test("on/off changes only the tier, publishes the agent view, and records activity once", async () => {
    const id = await session();
    const original = (await app.agentState(id))!;
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);

    try {
        assert.equal((await info(id)).supportsFastMode, true);
        assert.equal((await info(id)).fastMode, false);
        await app.commands.configure(id, owner(app), { fastMode: true });
        await until(
            () => (tab.field("agent") as { fastMode?: boolean })?.fastMode === true,
            "fast agent view",
        );
        const enabled = (await app.agentState(id))!;

        assert.deepEqual(enabled, { ...original, serviceTier: "priority" });
        await app.commands.configure(id, owner(app), { fastMode: true });
        assert.equal(
            (await activities(id)).filter((line) => line === "turned fast mode on").length,
            1,
        );
        await app.commands.configure(id, owner(app), { fastMode: false });
        assert.deepEqual(await app.agentState(id), { ...original, serviceTier: "default" });
        assert.equal(
            (await activities(id)).filter((line) => line === "turned fast mode off").length,
            1,
        );
        await until(
            () => (tab.field("agent") as { fastMode?: boolean })?.fastMode === false,
            "normal agent view",
        );
    } finally {
        app.detach(tab.client);
    }
});

test("concurrent thinking, folder, and supported-model changes cannot restore priority after toggling off", async () => {
    const cwd = join(work, "concurrent-configure");
    const changes = [
        { thinkingLevel: "high" },
        { cwd },
        { model: { provider: "openai", modelId: "fast-test-2" } },
    ];

    mkdirSync(cwd);

    // Each individual interleaving must be safe, as must several tabs changing different fields at once.
    for (const queued of [...changes.map((change) => [change]), changes]) {
        const id = await session(true);

        await app.commands.configure(id, owner(app), { thinkingLevel: "low" });
        const original = (await app.agentState(id))!;

        await Promise.all([
            app.commands.configure(id, owner(app), { fastMode: false }),
            ...queued.map((change) => app.commands.configure(id, owner(app), change)),
        ]);
        assert.deepEqual(await app.agentState(id), {
            ...original,
            serviceTier: "default",
            ...Object.assign({}, ...queued),
        });
        assert.equal((await info(id)).fastMode, false);
        assert.equal(
            (await activities(id)).filter((line) => line === "turned fast mode off").length,
            1,
        );
        const text = `concurrent off request ${Number(id)}`;

        await say(app, id, text);
        assert.equal(requestFor(text).tier, "default");
    }
});

test("concurrent provider changes clear priority before later configure calls read it", async () => {
    const id = await session(true);

    await Promise.all([
        app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" } }),
        app.commands.configure(id, owner(app), { thinkingLevel: "high" }),
        app.commands.configure(id, owner(app), { fastMode: false }),
    ]);
    assert.deepEqual((await app.agentState(id))!.model, { provider: "faux", modelId: "faux-1" });
    assert.equal((await app.agentState(id))!.serviceTier, undefined);
    await say(app, id, "concurrent unsupported request");
    assert.equal(requestFor("concurrent unsupported request").tier, undefined);

    await app.commands.configure(id, owner(app), {
        model: { provider: "openai", modelId: "fast-test" },
        fastMode: true,
    });
    await Promise.all([
        app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" } }),
        app.commands.configure(id, owner(app), {
            model: { provider: "openai", modelId: "fast-test-2" },
        }),
    ]);
    assert.deepEqual((await app.agentState(id))!.model, {
        provider: "openai",
        modelId: "fast-test-2",
    });
    assert.equal((await app.agentState(id))!.serviceTier, "default");

    // Enabling fast mode must validate against the queued model change, not the old supported model.
    await Promise.all([
        app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" } }),
        assert.rejects(app.commands.configure(id, owner(app), { fastMode: true }), { status: 400 }),
    ]);
    assert.equal((await app.agentState(id))!.serviceTier, undefined);
    assert.equal((await info(id)).supportsFastMode, false);
});

test("a rejected queued configure does not poison later changes or add activity", async () => {
    const id = await session(true);

    await app.commands.configure(id, owner(app), { thinkingLevel: "low" });
    const before = await activities(id);

    await Promise.all([
        assert.rejects(app.commands.configure(id, owner(app), { fastMode: "false" as never }), {
            status: 400,
        }),
        assert.rejects(
            app.commands.configure(id, owner(app), {
                model: { provider: "openai", modelId: "missing-model" },
            }),
            { status: 400 },
        ),
        app.commands.configure(id, owner(app), { fastMode: false }),
        app.commands.configure(id, owner(app), { thinkingLevel: "high" }),
    ]);
    assert.equal((await app.agentState(id))!.serviceTier, "default");
    assert.equal((await app.agentState(id))!.thinkingLevel, "high");
    assert.deepEqual((await activities(id)).slice(before.length), [
        "turned fast mode off",
        "set thinking to high",
    ]);
    // The queue must remain usable after it drains as well.
    await app.commands.configure(id, owner(app), { fastMode: true });
    assert.equal((await app.agentState(id))!.serviceTier, "priority");
});

test(
    "configure serialization is per conversation, not an app-wide lock",
    { timeout: 10000 },
    async (t) => {
        const blocked = await session(true);
        const independent = await session(true);
        const original = app.requireDriver;
        let entered = 0;

        let release = () => {};

        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        t.mock.method(app, "requireDriver", async (...args: Parameters<App["requireDriver"]>) => {
            await original.apply(app, args);

            if (args[0] === blocked) {
                entered++;

                if (entered === 1) {
                    await gate;
                }
            }
        });
        const pending = [app.commands.configure(blocked, owner(app), { fastMode: false })];

        try {
            await until(() => entered === 1, "first configure held at its access check");
            pending.push(app.commands.configure(blocked, owner(app), { thinkingLevel: "low" }));
            let otherFinished = false;
            const other = app.commands
                .configure(independent, owner(app), { fastMode: false })
                .then(() => {
                    otherFinished = true;
                });

            pending.push(other);
            await until(
                () => otherFinished,
                "another conversation configures while the first is blocked",
                2000,
            );
            assert.equal(entered, 1, "same-conversation work stays queued before its access check");
            assert.equal((await app.agentState(blocked))!.serviceTier, "priority");
            assert.equal((await app.agentState(independent))!.serviceTier, "default");
            release();
            await Promise.all(pending);
            assert.equal(entered, 2);
            assert.equal((await app.agentState(blocked))!.serviceTier, "default");
            assert.equal((await app.agentState(blocked))!.thinkingLevel, "low");
        } finally {
            release();
            await Promise.allSettled(pending);
        }
    },
);

test("generation requests use priority/default independently in each conversation", async () => {
    const fast = await session(true);
    const normal = await session();

    await say(app, fast, "fast conversation");
    await say(app, normal, "normal conversation");
    assert.equal(requestFor("fast conversation").tier, "priority");
    assert.equal(requestFor("normal conversation").tier, "default");
    await app.commands.configure(fast, owner(app), { fastMode: false });
    await say(app, fast, "fast now disabled");
    assert.equal(requestFor("fast now disabled").tier, "default");
    assert.equal((await info(normal)).fastMode, false);
});

test("a new session reuses the last model but not fast mode, sending explicit default without an agent tier", async () => {
    await session(true);
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const agent = (await app.agentState(id))!;

    assert.deepEqual(agent.model, { provider: "openai", modelId: "fast-test" });
    assert.equal(agent.serviceTier, undefined, "no configure call has set a tier on this agent");
    assert.equal((await info(id)).supportsFastMode, true);
    assert.equal((await info(id)).fastMode, false);
    await say(app, id, "new session defaults standard");
    assert.equal(requestFor("new session defaults standard").tier, "default");
});

test("invalid inputs and unsupported models fail atomically; leaving OpenAI clears the tier", async () => {
    const id = await session(true);
    const original = await app.agentState(id);
    const before = await activities(id);

    for (const fastMode of [null, "true", "false", 0, 1, [], {}]) {
        await assert.rejects(
            app.commands.configure(id, owner(app), { fastMode: fastMode as never }),
            { status: 400 },
        );
        assert.deepEqual(await app.agentState(id), original);
    }

    await assert.rejects(
        app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            fastMode: true,
        }),
        { status: 400 },
    );
    assert.deepEqual(await app.agentState(id), original);
    assert.deepEqual(await activities(id), before);
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    assert.equal((await app.agentState(id))!.serviceTier, undefined);
    assert.equal((await info(id)).supportsFastMode, false);
    assert.equal((await info(id)).fastMode, false);
    await app.commands.configure(id, owner(app), { fastMode: false });
    await say(app, id, "unsupported request");
    assert.equal(requestFor("unsupported request").tier, undefined);
    await app.commands.configure(id, owner(app), {
        model: { provider: "openai", modelId: "fast-test" },
    });
    assert.equal((await app.agentState(id))!.serviceTier, "default");
});

test("viewers, scoped-out guests, and non-drivers cannot toggle fast mode", async () => {
    const id = await session();
    const viewer = app.config.addUser("Watcher", "viewer").user;
    const guest = app.config.addUser("Guest", "guest").user;
    const scoped = app.config.addUser("Elsewhere", "guest", [String(await session())]).user;
    const original = await app.agentState(id);

    try {
        await assert.rejects(app.commands.configure(id, viewer, { fastMode: true }), {
            status: 403,
        });
        // Do not reveal the existence of conversations outside a guest's scope.
        await assert.rejects(app.commands.configure(id, scoped, { fastMode: true }), {
            status: 404,
        });

        await app.collab.turns(id, owner(app), { action: "on" });
        await assert.rejects(app.commands.configure(id, guest, { fastMode: true }), /is driving/);
        assert.deepEqual(await app.agentState(id), original);
        await app.collab.turns(id, owner(app), { action: "off" });
        await app.commands.configure(id, guest, { fastMode: true });
        assert.equal((await info(id)).fastMode, true);
    } finally {
        for (const user of [viewer, guest, scoped]) {
            app.config.removeUser(user.id);
        }
    }
});

test("priority and explicit default survive a normal restart", async () => {
    const fast = await session(true);
    const normal = await session();

    await app.close();
    app = await open();
    assert.equal((await app.agentState(fast))!.serviceTier, "priority");
    assert.equal((await app.agentState(normal))!.serviceTier, "default");
    assert.equal((await info(fast)).fastMode, true);
    await say(app, fast, "after normal restart");
    assert.equal(requestFor("after normal restart").tier, "priority");
});

test(
    "a resumed in-flight request keeps its checkpoint tier after fast mode was disabled",
    { timeout: 20000 },
    async () => {
        const id = await session(true);

        pauseNext = true;
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "checkpoint request",
            requestId: crypto.randomUUID(),
        });

        await until(
            () => requests.some((request) => request.text.endsWith("checkpoint request")),
            "paused model request",
        );
        assert.equal(requestFor("checkpoint request").tier, "priority");
        await app.commands.configure(id, owner(app), { fastMode: false });
        await app.close();
        const count = requests.filter((request) =>
            request.text.endsWith("checkpoint request"),
        ).length;

        app = await open();
        await (await app.harness.submission(submissionId, context))!.wait(context);
        assert.equal(
            requests.filter((request) => request.text.endsWith("checkpoint request")).length,
            count + 1,
        );
        assert.equal(requestFor("checkpoint request").tier, "priority");
        assert.equal((await app.agentState(id))!.serviceTier, "default");
        await say(app, id, "next request after checkpoint");
        assert.equal(requestFor("next request after checkpoint").tier, "default");
    },
);

test("forks and subagents inherit fast mode without sharing later changes", async () => {
    const id = await session(true);

    await say(app, id, "fork point");
    const page = await (await app.conversation(id)).entries({}, 100, undefined, context);
    const answer = page.items.find((entry) => entry.kind === "pi.assistant")!;
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(answer.id) });

    assert.equal((await app.agentState(fork))!.serviceTier, "priority");
    await say(app, fork, "fork priority");
    assert.equal(requestFor("fork priority").tier, "priority");
    await say(app, id, "spawn fast helper");
    await until(
        async () =>
            (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.helper?.reported
                .length === 1,
        "child answer",
    );
    const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
        .conversationId;

    assert.equal((await app.agentState(child))!.serviceTier, "priority");
    assert.equal(requestFor("child hello").tier, "priority");
    await until(
        () => requests.some((request) => request.text.includes("[subagent helper answered")),
        "parent receives report",
    );
    await until(() => !app.isBusy(id), "parent report");
    await app.commands.configure(id, owner(app), { fastMode: false });
    assert.equal((await app.agentState(fork))!.serviceTier, "priority");
    assert.equal((await app.agentState(child))!.serviceTier, "priority");
});

test("an unsupported subagent never sends an inherited tier or enables it when returning to OpenAI", async () => {
    const id = await session(true);
    const start = requests.length;

    await say(app, id, "spawn unsupported helper");
    await until(
        async () =>
            (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.helper?.reported
                .length === 1,
        "unsupported child answer",
    );
    const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
        .conversationId;

    assert.equal(requestFor("unsupported child hello").provider, "faux");
    assert.equal(requestFor("unsupported child hello").tier, undefined);
    assert.equal((await info(child)).fastMode, false);
    assert.equal((await info(child)).supportsFastMode, false);
    await app.commands.configure(child, owner(app), {
        model: { provider: "openai", modelId: "fast-test" },
    });
    assert.equal((await app.agentState(child))!.serviceTier, "default");
    await say(app, child, "supported child remains off");
    assert.equal(requestFor("supported child remains off").tier, "default");
    await until(
        () =>
            requests
                .slice(start)
                .some((request) => request.text.includes("[subagent helper answered")),
        "unsupported child report",
    );
    await until(() => !app.isBusy(id), "parent handles unsupported child report");
});

test("resending the first message inherits priority unless its new model is unsupported", async () => {
    const id = await session(true);

    await say(app, id, "first message to resend");
    const page = await (await app.conversation(id)).entries({}, 100, undefined, context);
    const message = page.items.find((entry) => entry.kind === "pi.user")!;

    for (const supported of [true, false]) {
        const text = supported ? "retry with priority" : "retry without priority";
        const { id: fork } = await app.commands.resend(id, owner(app), {
            entryId: Number(message.id),
            text,
            ...(supported ? {} : { model: { provider: "faux", modelId: "faux-1" } }),
        });

        await until(
            () => requests.some((request) => request.text.endsWith(text)),
            "resent model request",
        );
        await until(() => !app.isBusy(fork), "resent answer");
        assert.equal((await app.agentState(fork))!.serviceTier, supported ? "priority" : undefined);
        assert.equal(requestFor(text).tier, supported ? "priority" : undefined);
    }

    assert.equal((await app.agentState(id))!.serviceTier, "priority");
});

test("manual compaction forwards the selected tier", async () => {
    app.settings.applyOverrides({
        compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 },
    });

    try {
        for (const fastMode of [true, false]) {
            const id = await session(fastMode);

            await say(app, id, "older context for summary");
            await say(app, id, "recent context to keep");
            const start = requests.length;
            const taskId = await (
                await app.conversation(id)
            ).compact("Summarize this test", context);
            const receipt = await app.harness.waitForTask(taskId, context);

            assert.equal(receipt.state.outcome.status, "completed");
            const summaries = requests.slice(start);

            assert.equal(summaries.length, 1, "compaction must actually call the model");
            assert.equal(summaries[0]!.tier, fastMode ? "priority" : "default");
        }
    } finally {
        app.settings.applyOverrides({
            compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 },
        });
    }
});

test(
    "a resumed compaction uses its priority checkpoint, not the newly disabled setting",
    { timeout: 20000 },
    async () => {
        app.settings.applyOverrides({
            compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 },
        });
        const id = await session(true);

        await say(app, id, "old context before compaction restart");
        await say(app, id, "new context before compaction restart");
        const start = requests.length;

        pauseNext = true;
        const taskId = await (await app.conversation(id)).compact("checkpoint summary", context);

        await until(() => requests.length > start, "paused compaction request");
        assert.equal(requests.at(-1)!.tier, "priority");
        await app.commands.configure(id, owner(app), { fastMode: false });
        await app.close();
        app = await open();
        const receipt = await app.harness.waitForTask(taskId, context);

        assert.equal(receipt.state.outcome.status, "completed");
        assert.equal(requests.length, start + 2);
        assert.equal(requests.at(-1)!.tier, "priority");
        assert.equal((await app.agentState(id))!.serviceTier, "default");
        await say(app, id, "after compaction restart");
        assert.equal(requestFor("after compaction restart").tier, "default");
    },
);

// These exercise the native pi-ai adapters, not the faux stream. Injected fetch returns
// provider SSE and captures the actual wire body; no socket or API credential is used.
const nativeProviders: Provider[] = [openaiProvider(), openaiCodexProvider()];

for (const provider of nativeProviders) {
    test(`${provider.id} streamSimple sends native service_tier and uses response-tier pricing`, async () => {
        const catalogModel = provider.getModels().find((model) => model.id === "gpt-5.5")!;

        assert.ok(catalogModel);
        const model = {
            ...catalogModel,
            cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 4 },
        };
        const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;

        for (const [requested, returned, multiplier] of [
            ["priority", "priority", 2.5],
            ["default", "default", 1],
            // Codex's existing resolver treats a default response as an echo of its requested tier.
            ["priority", "default", provider.id === "openai-codex" ? 2.5 : 1],
            ["default", "priority", 2.5],
            ["priority", undefined, 2.5],
            [undefined, "default", 1],
        ] as const) {
            const payloads: Record<string, unknown>[] = [];

            const fetch: NonNullable<SimpleStreamOptions["fetch"]> = async (input, init) => {
                const request = new Request(input, init);
                const bytes = Buffer.from(await request.arrayBuffer());
                const body =
                    request.headers.get("content-encoding") === "zstd"
                        ? zstdDecompressSync(bytes)
                        : bytes;

                payloads.push(JSON.parse(body.toString()));
                const event = {
                    type: "response.completed",
                    response: {
                        id: "response-test",
                        status: "completed",
                        service_tier: returned,
                        output: [],
                        usage: {
                            input_tokens: 100,
                            output_tokens: 20,
                            total_tokens: 120,
                            input_tokens_details: { cached_tokens: 40 },
                        },
                    },
                };

                return new Response(
                    `event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
                    {
                        headers: { "content-type": "text/event-stream" },
                    },
                );
            };

            const result = await provider
                .streamSimple(
                    model,
                    normalizeContext({
                        messages: [{ role: "user", content: "hello", timestamp: 0 }],
                    }),
                    {
                        apiKey: token,
                        transport: "sse",
                        fetch,
                        maxRetries: 0,
                        serviceTier: requested,
                    },
                )
                .result();

            assert.notEqual(
                result.stopReason,
                "error",
                result.errorMessage ?? "native request failed",
            );
            assert.equal(payloads.length, 1);
            assert.equal(payloads[0]!.service_tier, requested);
            assert.equal(result.usage.input, 60);
            assert.equal(result.usage.cacheRead, 40);
            assert.equal(result.usage.output, 20);
            assert.ok(Math.abs(result.usage.cost.input - ((60 * 2) / 1e6) * multiplier) < 1e-12);
            assert.ok(Math.abs(result.usage.cost.output - ((20 * 8) / 1e6) * multiplier) < 1e-12);
            assert.ok(Math.abs(result.usage.cost.cacheRead - (40 / 1e6) * multiplier) < 1e-12);
            assert.equal(
                result.usage.cost.total,
                result.usage.cost.input + result.usage.cost.output + result.usage.cost.cacheRead,
            );
        }
    });
}
