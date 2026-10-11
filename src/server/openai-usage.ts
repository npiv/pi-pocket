/**
 * OpenAI's weekly ChatGPT subscription usage, read from the same OAuth sign-in Pi uses for Codex. The result is kept
 * briefly so every browser can ask for it without every browser asking OpenAI.
 */
import type { AuthResult, AuthOperationOptions } from "@earendil-works/pi-ai";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const PROVIDERS = ["openai-codex", "openai"] as const;

export type OpenAIWeeklyUsage = {
    remaining: number;
    resetAt?: number;
};

type UsageModels = {
    isUsingSubscription(providerId: string): boolean;
    getAuth(providerId: string, overrides?: AuthOperationOptions): Promise<AuthResult | undefined>;
};

type UsageWindow = {
    used_percent?: unknown;
    limit_window_seconds?: unknown;
    reset_at?: unknown;
};

/** The weekly window in a `/wham/usage` response, as a whole percentage left. */
export function weeklyRemaining(value: unknown): OpenAIWeeklyUsage | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const rateLimit = (value as { rate_limit?: unknown }).rate_limit;

    if (typeof rateLimit !== "object" || rateLimit === null || Array.isArray(rateLimit)) {
        return undefined;
    }

    const limits = rateLimit as { primary_window?: unknown; secondary_window?: unknown };
    const windows = [limits.primary_window, limits.secondary_window];

    for (const candidate of windows) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
            continue;
        }

        const window = candidate as UsageWindow;
        const seconds = window.limit_window_seconds;
        const used = window.used_percent;

        if (
            typeof seconds !== "number" ||
            seconds < WEEK_SECONDS * 0.95 ||
            seconds > WEEK_SECONDS * 1.05 ||
            typeof used !== "number" ||
            !Number.isFinite(used)
        ) {
            continue;
        }

        const remaining = Math.round(100 - Math.max(0, Math.min(100, used)));
        const resetAt = window.reset_at;

        return {
            remaining,
            ...(typeof resetAt === "number" && Number.isFinite(resetAt) ? { resetAt } : {}),
        };
    }

    return undefined;
}

/** The ChatGPT account id carried inside OpenAI's access token, needed by the usage endpoint. */
function accountId(token: string): string | undefined {
    try {
        const payload = token.split(".")[1];

        if (payload === undefined) {
            return undefined;
        }

        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
            "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
        };
        const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;

        return typeof id === "string" && id !== "" ? id : undefined;
    } catch {
        return undefined;
    }
}

export class OpenAIUsage {
    readonly #models: UsageModels;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    #cached?: { at: number; value: OpenAIWeeklyUsage | undefined };
    #loading?: Promise<OpenAIWeeklyUsage | undefined>;

    constructor(models: UsageModels, options: { fetch?: typeof fetch; now?: () => number } = {}) {
        this.#models = models;
        this.#fetch = options.fetch ?? fetch;
        this.#now = options.now ?? Date.now;
    }

    /** The latest weekly percentage. Failures are absent and cached too, so an unavailable endpoint stays quiet. */
    get(): Promise<OpenAIWeeklyUsage | undefined> {
        const now = this.#now();

        if (this.#cached !== undefined && now - this.#cached.at < CACHE_MS) {
            return Promise.resolve(this.#cached.value);
        }

        if (this.#loading !== undefined) {
            return this.#loading;
        }

        const loading = this.#load()
            .catch(() => undefined)
            .then((value) => {
                this.#cached = { at: this.#now(), value };

                return value;
            })
            .finally(() => {
                if (this.#loading === loading) {
                    this.#loading = undefined;
                }
            });

        this.#loading = loading;

        return loading;
    }

    async #load(): Promise<OpenAIWeeklyUsage | undefined> {
        for (const provider of PROVIDERS) {
            if (!this.#models.isUsingSubscription(provider)) {
                continue;
            }

            try {
                const auth = await this.#models.getAuth(provider, {
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                const token = auth?.auth.apiKey;

                if (token === undefined) {
                    continue;
                }

                const id = accountId(token);
                const response = await this.#fetch(USAGE_URL, {
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${token}`,
                        ...(id === undefined ? {} : { "ChatGPT-Account-Id": id }),
                        "user-agent": "pi-pocket",
                    },
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });

                if (!response.ok) {
                    continue;
                }

                const usage = weeklyRemaining(await response.json());

                if (usage !== undefined) {
                    return usage;
                }
            } catch {
                // Another configured OpenAI subscription may still work. If none does, the status simply stays hidden.
            }
        }

        return undefined;
    }
}
