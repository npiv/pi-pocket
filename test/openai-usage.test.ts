import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIUsage, weeklyRemaining } from "../src/server/openai-usage.ts";

const week = 7 * 24 * 60 * 60;

test("finds the weekly usage window and reports the percentage remaining", () => {
    assert.deepEqual(
        weeklyRemaining({
            rate_limit: {
                primary_window: {
                    used_percent: 37.4,
                    limit_window_seconds: week,
                    reset_at: 1_800_000_000,
                },
            },
        }),
        { remaining: 63, resetAt: 1_800_000_000 },
    );

    assert.deepEqual(
        weeklyRemaining({
            rate_limit: {
                primary_window: { used_percent: 80, limit_window_seconds: 5 * 60 * 60 },
                secondary_window: { used_percent: 12, limit_window_seconds: week },
            },
        }),
        { remaining: 88 },
    );
});

test("ignores malformed responses and responses without a weekly window", () => {
    assert.equal(weeklyRemaining(null), undefined);
    assert.equal(weeklyRemaining({ rate_limit: {} }), undefined);
    assert.equal(
        weeklyRemaining({
            rate_limit: {
                primary_window: { used_percent: "25", limit_window_seconds: week },
                secondary_window: { used_percent: 25, limit_window_seconds: 24 * 60 * 60 },
            },
        }),
        undefined,
    );
});

test("caches OpenAI usage for a minute and shares an in-flight read", async () => {
    let now = 1_000;
    let authReads = 0;
    let fetches = 0;
    let sentAccount: string | null = null;
    const claims = Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
        }),
    ).toString("base64url");
    const token = `header.${claims}.signature`;
    const models = {
        isUsingSubscription: (provider: string) => provider === "openai-codex",
        getAuth: async () => {
            authReads += 1;

            return { auth: { apiKey: token } };
        },
    };
    const usage = new OpenAIUsage(models, {
        now: () => now,
        fetch: async (_input, init) => {
            fetches += 1;
            sentAccount = new Headers(init?.headers).get("ChatGPT-Account-Id");

            return new Response(
                JSON.stringify({
                    rate_limit: {
                        primary_window: { used_percent: 24, limit_window_seconds: week },
                    },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            );
        },
    });

    assert.deepEqual(await Promise.all([usage.get(), usage.get()]), [
        { remaining: 76 },
        { remaining: 76 },
    ]);
    assert.equal(authReads, 1);
    assert.equal(fetches, 1);
    assert.equal(sentAccount, "account-1");

    now += 59_999;
    assert.deepEqual(await usage.get(), { remaining: 76 });
    assert.equal(fetches, 1);

    now += 1;
    assert.deepEqual(await usage.get(), { remaining: 76 });
    assert.equal(fetches, 2);
});
