import { describe, expect, test } from "bun:test";

import * as fs from "fs";
import * as path from "path";

import { pathToFileURL } from "url";

import type { ProxyData } from "../src/db";

type DbModule = typeof import("../src/db");

const DB_SOURCE_PATH = path.resolve(import.meta.dir, "../src/db.ts");
const POSTHOG_SOURCE_PATH = path.resolve(import.meta.dir, "../src/posthog.ts");
const ENV_SOURCE_PATH = path.resolve(import.meta.dir, "../src/myEnv.ts");

const withIsolatedDb = async (
    {
        proxyLines,
        persistedProxies = {},
        env = {},
        fetchImpl,
        randomImpl,
    }: {
        proxyLines: string[];
        persistedProxies?: Record<string, Partial<ProxyData>>;
        env?: Record<string, string>;
        fetchImpl?: typeof fetch;
        randomImpl?: () => number;
    },
    run: (db: DbModule) => Promise<void>,
) => {
    const tempDir = fs.mkdtempSync(
        path.resolve(import.meta.dir, "../proxy-master-3000-test-"),
    );
    const previousCwd = process.cwd();
    const tempDbPath = path.join(tempDir, "db-under-test.ts");
    const previousEnv = {
        PORT: process.env.PORT,
        POSTHOG_KEY: process.env.POSTHOG_KEY,
        POSTHOG_HOST: process.env.POSTHOG_HOST,
    };
    const originalFetch = globalThis.fetch;
    const originalRandom = Math.random;

    fs.writeFileSync(path.join(tempDir, "proxies.txt"), `${proxyLines.join("\n")}\n`);
    fs.writeFileSync(
        path.join(tempDir, "proxies.json"),
        JSON.stringify(persistedProxies, null, 2),
    );
    fs.copyFileSync(DB_SOURCE_PATH, tempDbPath);
    fs.copyFileSync(POSTHOG_SOURCE_PATH, path.join(tempDir, "posthog.ts"));
    fs.copyFileSync(ENV_SOURCE_PATH, path.join(tempDir, "myEnv.ts"));

    process.env.PORT = env.PORT ?? "60888";
    process.env.POSTHOG_KEY = env.POSTHOG_KEY ?? "test-posthog-key";
    process.env.POSTHOG_HOST = env.POSTHOG_HOST ?? "https://us.posthog.com";
    globalThis.fetch = fetchImpl ?? ((() => {
        return Promise.resolve(
            new Response(null, {
                status: 200,
            }),
        );
    }) as any as typeof fetch);
    Math.random = randomImpl ?? originalRandom;

    process.chdir(tempDir);

    try {
        const db = await import(pathToFileURL(tempDbPath).href);
        await run(db);
    } finally {
        process.env.PORT = previousEnv.PORT;
        process.env.POSTHOG_KEY = previousEnv.POSTHOG_KEY;
        process.env.POSTHOG_HOST = previousEnv.POSTHOG_HOST;
        globalThis.fetch = originalFetch;
        Math.random = originalRandom;
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
};

describe("proxy score selection", () => {
    test("stable strategy picks the highest scoring proxy", async () => {
        const bestProxyId = "10.0.0.1:8000:user-a:pass-a";
        const weakerProxyId = "10.0.0.2:8000:user-b:pass-b";

        await withIsolatedDb(
            {
                proxyLines: [bestProxyId, weakerProxyId],
                persistedProxies: {
                    [bestProxyId]: {
                        successCount: 7,
                        failureCount: 1,
                    },
                    [weakerProxyId]: {
                        successCount: 4,
                        failureCount: 4,
                    },
                },
            },
            async ({ getProxy }) => {
                const selected = getProxy("stable");

                expect(selected?.id).toBe(bestProxyId);
                expect(selected?.score).toBe(88);
            },
        );
    });

    test("stable strategy switches to another proxy after errors tank the score", async () => {
        const degradedProxyId = "10.0.0.3:8000:user-c:pass-c";
        const healthyProxyId = "10.0.0.4:8000:user-d:pass-d";

        await withIsolatedDb(
            {
                proxyLines: [degradedProxyId, healthyProxyId],
            },
            async ({ getProxy, reportProxyStatus }) => {
                expect(getProxy("stable")?.id).toBe(degradedProxyId);

                const afterError = reportProxyStatus(degradedProxyId, "error");
                expect(afterError?.score).toBe(0);

                const selected = getProxy("stable");

                expect(selected?.id).toBe(healthyProxyId);
                expect(selected?.score).toBe(100);
            },
        );
    });

    test("a success report clears the failure penalty so a recovered proxy becomes best again", async () => {
        const recoveringProxyId = "10.0.0.5:8000:user-e:pass-e";
        const runnerUpProxyId = "10.0.0.6:8000:user-f:pass-f";

        await withIsolatedDb(
            {
                proxyLines: [recoveringProxyId, runnerUpProxyId],
                persistedProxies: {
                    [recoveringProxyId]: {
                        successCount: 9,
                        failureCount: 2,
                        consecutiveFailures: 2,
                        lastFailureAt: "2026-03-14T12:00:00.000Z",
                    },
                    [runnerUpProxyId]: {
                        successCount: 3,
                        failureCount: 1,
                    },
                },
            },
            async ({ getProxy, reportProxyStatus }) => {
                expect(getProxy("stable")?.id).toBe(runnerUpProxyId);

                const recovered = reportProxyStatus(recoveringProxyId, "success");

                expect(recovered?.consecutiveFailures).toBe(0);
                expect(recovered?.score).toBe(83);
                expect(recovered?.cooldownUntil).toBeNull();

                const selected = getProxy("stable");
                expect(selected?.id).toBe(recoveringProxyId);
                expect(selected?.score).toBe(83);
            },
        );
    });

    test("reports success and error events to PostHog with proxy metrics", async () => {
        const proxyId = "10.0.0.7:8000:user-g:pass-g";
        const fetchCalls: Array<{
            input: RequestInfo | URL;
            init?: RequestInit;
        }> = [];
        const fetchMock = ((input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ input, init });
            return Promise.resolve(
                new Response(null, {
                    status: 200,
                }),
            );
        }) as typeof fetch;

        await withIsolatedDb(
            {
                proxyLines: [proxyId],
                fetchImpl: fetchMock,
            },
            async ({ reportProxyStatus }) => {
                reportProxyStatus(proxyId, "success");
                reportProxyStatus(proxyId, "error");
            },
        );

        expect(fetchCalls).toHaveLength(2);

        const [successCall, errorCall] = fetchCalls;
        expect(String(successCall.input)).toBe("https://us.posthog.com/capture/");
        expect(String(errorCall.input)).toBe("https://us.posthog.com/capture/");

        const successBody = JSON.parse(String(successCall.init?.body)) as {
            api_key: string;
            event: string;
            properties: Record<string, string | number | null>;
        };
        const errorBody = JSON.parse(String(errorCall.init?.body)) as {
            api_key: string;
            event: string;
            properties: Record<string, string | number | null>;
        };

        expect(successBody.api_key).toBe("test-posthog-key");
        expect(successBody.event).toBe("proxy_success");
        expect(successBody.properties.distinct_id).toBe(proxyId);
        expect(successBody.properties.proxyId).toBe(proxyId);
        expect(successBody.properties.status).toBe("success");
        expect(successBody.properties.score).toBe(100);
        expect(successBody.properties.successCount).toBe(1);
        expect(successBody.properties.failureCount).toBe(0);
        expect(successBody.properties.consecutiveFailures).toBe(0);

        expect(errorBody.api_key).toBe("test-posthog-key");
        expect(errorBody.event).toBe("proxy_error");
        expect(errorBody.properties.distinct_id).toBe(proxyId);
        expect(errorBody.properties.proxyId).toBe(proxyId);
        expect(errorBody.properties.status).toBe("error");
        expect(errorBody.properties.score).toBe(35);
        expect(errorBody.properties.successCount).toBe(1);
        expect(errorBody.properties.failureCount).toBe(1);
        expect(errorBody.properties.consecutiveFailures).toBe(1);
    });

    test("balanced strategy favors healthier proxies over 1000 requests", async () => {
        const healthyProxyId = "10.0.0.8:8000:user-h:pass-h";
        const flakyProxyId = "10.0.0.9:8000:user-i:pass-i";
        const failingProxyId = "10.0.0.10:8000:user-j:pass-j";
        const selectionCounts = {
            [healthyProxyId]: 0,
            [flakyProxyId]: 0,
            [failingProxyId]: 0,
        };
        let seed = 13;
        const randomImpl = () => {
            seed = (seed * 48271) % 0x7fffffff;
            return seed / 0x7fffffff;
        };

        await withIsolatedDb(
            {
                proxyLines: [healthyProxyId, flakyProxyId, failingProxyId],
                randomImpl,
            },
            async ({ getProxy, reportProxyStatus }) => {
                for (let requestIndex = 0; requestIndex < 1000; requestIndex += 1) {
                    const selected = getProxy("balanced");

                    expect(selected).not.toBeNull();
                    if (!selected) {
                        continue;
                    }

                    selectionCounts[selected.id as keyof typeof selectionCounts] += 1;

                    if (selected.id === healthyProxyId) {
                        reportProxyStatus(selected.id, "success");
                        continue;
                    }

                    if (selected.id === flakyProxyId) {
                        const status = requestIndex % 4 === 0 ? "error" : "success";
                        reportProxyStatus(selected.id, status);
                        continue;
                    }

                    reportProxyStatus(selected.id, "error");
                }

                const stableSelection = getProxy("stable");
                expect(stableSelection?.id).toBe(healthyProxyId);
            },
        );

        console.log(
            "balanced 1000-request distribution",
            JSON.stringify(selectionCounts),
        );
        expect(selectionCounts[healthyProxyId]).toBeGreaterThan(950);
        expect(selectionCounts[flakyProxyId]).toBeGreaterThan(10);
        expect(selectionCounts[flakyProxyId]).toBeLessThan(50);
        expect(selectionCounts[failingProxyId]).toBeLessThan(10);
        expect(selectionCounts[healthyProxyId]).toBeGreaterThan(
            selectionCounts[flakyProxyId],
        );
        expect(selectionCounts[flakyProxyId]).toBeGreaterThan(
            selectionCounts[failingProxyId],
        );
    });
});
