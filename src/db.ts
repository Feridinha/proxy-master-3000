import * as fs from "fs";
import * as path from "path";

import { captureProxyStatusEvent } from "./posthog";

const PROXIES_FILE = path.resolve(process.cwd(), "proxies.json");
const PROXY_LIST_FILE = path.resolve(process.cwd(), "proxies.txt");
const MAX_COOLDOWN_MS = 15 * 60 * 1000;

export interface ProxyConnection {
    user: string;
    password: string;
    ip: string;
    port: string;
}

export interface ProxyData {
    score: number;
    uptime: number;
    successCount: number;
    failureCount: number;
    requestsCount: number;
    consecutiveFailures: number;
    lastUsedAt: string | null;
    lastReportedAt: string | null;
    lastFailureAt: string | null;
    conn: ProxyConnection;
}

export interface ProxySelection {
    id: string;
    score: number;
    uptime: number;
    successCount: number;
    failureCount: number;
    requestsCount: number;
    consecutiveFailures: number;
    cooldownUntil: string | null;
    conn: ProxyConnection;
}

export type ProxySelectionStrategy = "balanced" | "stable";

const createProxyData = (line: string): ProxyData => {
    const [ip, port, user, password] = line.split(":");

    return {
        score: 100,
        uptime: 1,
        successCount: 0,
        failureCount: 0,
        requestsCount: 0,
        consecutiveFailures: 0,
        lastUsedAt: null,
        lastReportedAt: null,
        lastFailureAt: null,
        conn: { ip, port, user, password },
    };
};

const recalculateMetrics = (proxy: ProxyData) => {
    const totalChecks = proxy.successCount + proxy.failureCount;
    const uptime = totalChecks === 0 ? 1 : proxy.successCount / totalChecks;
    const failurePenalty = Math.min(proxy.consecutiveFailures * 15, 80);

    proxy.uptime = Number(uptime.toFixed(4));
    proxy.score = Math.max(0, Math.round(proxy.uptime * 100 - failurePenalty));
};

const normalizeProxy = (key: string, value: Partial<ProxyData>): ProxyData => {
    const base = createProxyData(key);
    const proxy: ProxyData = {
        ...base,
        ...value,
        conn: {
            ...base.conn,
            ...(value.conn ?? {}),
        },
    };

    recalculateMetrics(proxy);
    return proxy;
};

const loadProxies = (): Record<string, ProxyData> => {
    try {
        const raw = JSON.parse(
            fs.readFileSync(PROXIES_FILE, "utf-8"),
        ) as Record<string, Partial<ProxyData>>;

        return Object.fromEntries(
            Object.entries(raw).map(([key, value]) => [
                key,
                normalizeProxy(key, value),
            ]),
        );
    } catch {
        return {};
    }
};

const saveProxies = (data: Record<string, ProxyData>) => {
    fs.writeFileSync(PROXIES_FILE, JSON.stringify(data, null, 2));
};

const proxies = loadProxies();

const getCooldownMs = (proxy: ProxyData): number => {
    if (proxy.consecutiveFailures < 2 || !proxy.lastFailureAt) {
        return 0;
    }

    return Math.min(
        MAX_COOLDOWN_MS,
        30_000 * 2 ** (proxy.consecutiveFailures - 2),
    );
};

const getCooldownUntil = (proxy: ProxyData): number | null => {
    if (!proxy.lastFailureAt) {
        return null;
    }

    const cooldownMs = getCooldownMs(proxy);
    if (cooldownMs === 0) {
        return null;
    }

    return new Date(proxy.lastFailureAt).getTime() + cooldownMs;
};

const isCoolingDown = (proxy: ProxyData, now = Date.now()) => {
    const cooldownUntil = getCooldownUntil(proxy);
    return cooldownUntil !== null && cooldownUntil > now;
};

const pickWeightedProxy = (
    entries: Array<[string, ProxyData]>,
    now = Date.now(),
): [string, ProxyData] => {
    const minRequests = Math.min(
        ...entries.map(([, proxy]) => proxy.requestsCount),
    );

    const weighted = entries.map(([id, proxy]) => {
        const reliabilityWeight = Math.max(0.05, proxy.score / 100);
        const loadWeight = 1 / (proxy.requestsCount - minRequests + 1);
        const idleMs = proxy.lastUsedAt
            ? now - new Date(proxy.lastUsedAt).getTime()
            : 5 * 60 * 1000;
        const recencyWeight = 1 + Math.min(1, idleMs / (5 * 60 * 1000));
        const weight = reliabilityWeight * loadWeight * recencyWeight;

        return { id, proxy, weight };
    });

    const totalWeight = weighted.reduce((acc, item) => acc + item.weight, 0);
    let cursor = Math.random() * totalWeight;

    for (const item of weighted) {
        cursor -= item.weight;
        if (cursor <= 0) {
            return [item.id, item.proxy];
        }
    }

    const fallback = weighted[weighted.length - 1];
    return [fallback.id, fallback.proxy];
};

const pickStableProxy = (
    entries: Array<[string, ProxyData]>,
): [string, ProxyData] => {
    const sorted = [...entries].sort((left, right) => {
        const [, a] = left;
        const [, b] = right;

        if (b.score !== a.score) {
            return b.score - a.score;
        }

        if (b.uptime !== a.uptime) {
            return b.uptime - a.uptime;
        }

        if (a.consecutiveFailures !== b.consecutiveFailures) {
            return a.consecutiveFailures - b.consecutiveFailures;
        }

        if (a.requestsCount !== b.requestsCount) {
            return a.requestsCount - b.requestsCount;
        }

        const aLastUsedAt = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
        const bLastUsedAt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;

        return aLastUsedAt - bLastUsedAt;
    });

    const [, bestProxy] = sorted[0];
    const topTier = sorted.filter(([, proxy]) => {
        return (
            bestProxy.score - proxy.score <= 5 &&
            bestProxy.uptime - proxy.uptime <= 0.05
        );
    });

    return topTier[0];
};

const toSelection = (id: string, proxy: ProxyData): ProxySelection => {
    const cooldownUntil = getCooldownUntil(proxy);

    return {
        id,
        score: proxy.score,
        uptime: proxy.uptime,
        successCount: proxy.successCount,
        failureCount: proxy.failureCount,
        requestsCount: proxy.requestsCount,
        consecutiveFailures: proxy.consecutiveFailures,
        cooldownUntil: cooldownUntil
            ? new Date(cooldownUntil).toISOString()
            : null,
        conn: proxy.conn,
    };
};

export const populateProxies = async () => {
    const text = fs.readFileSync(PROXY_LIST_FILE, "utf-8");
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const incoming = new Set(lines);
    let changed = false;

    for (const key of Object.keys(proxies)) {
        if (!incoming.has(key)) {
            delete proxies[key];
            changed = true;
        }
    }

    for (const line of lines) {
        if (proxies[line]) {
            const normalized = normalizeProxy(line, proxies[line]);
            if (JSON.stringify(normalized) !== JSON.stringify(proxies[line])) {
                proxies[line] = normalized;
                changed = true;
            }
            continue;
        }

        proxies[line] = createProxyData(line);
        changed = true;
    }

    if (changed) {
        saveProxies(proxies);
    }
};

export const getProxy = (
    strategy: ProxySelectionStrategy = "balanced",
): ProxySelection | null => {
    const entries = Object.entries(proxies);
    if (entries.length === 0) {
        return null;
    }

    const now = Date.now();
    const available = entries.filter(([, proxy]) => !isCoolingDown(proxy, now));
    const pool = available.length > 0 ? available : entries;
    const [id, selected] =
        strategy === "stable"
            ? pickStableProxy(pool)
            : pickWeightedProxy(pool, now);

    selected.requestsCount += 1;
    selected.lastUsedAt = new Date(now).toISOString();
    recalculateMetrics(selected);
    saveProxies(proxies);

    return toSelection(id, selected);
};

export const reportProxyStatus = (
    id: string,
    status: "success" | "error",
): ProxySelection | null => {
    const proxy = proxies[id];
    if (!proxy) {
        return null;
    }

    const now = new Date().toISOString();

    if (status === "success") {
        proxy.successCount += 1;
        proxy.consecutiveFailures = 0;
        proxy.lastFailureAt = null;
    } else {
        proxy.failureCount += 1;
        proxy.consecutiveFailures += 1;
        proxy.lastFailureAt = now;
    }

    proxy.lastReportedAt = now;
    recalculateMetrics(proxy);
    saveProxies(proxies);

    const selection = toSelection(id, proxy);
    void captureProxyStatusEvent(selection, status);

    return selection;
};

await populateProxies();

export default proxies;
