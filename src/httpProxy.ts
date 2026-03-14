import type { ProxySelection } from "./db";

import type {
    IncomingMessage,
    ServerResponse,
} from "http";

import * as http from "http";
import * as net from "net";

const REQUEST_TIMEOUT_MS = 30_000;

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

export const buildProxyAuthorization = (proxy: ProxySelection) => {
    const credentials = `${proxy.conn.user}:${proxy.conn.password}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

export const isAbsoluteUrl = (value: string) => {
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
};

export const buildForwardRawHeaders = (
    request: IncomingMessage,
    fallbackHost: string,
): string[] => {
    const filteredHeaders: string[] = [];
    let hasHostHeader = false;

    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const key = request.rawHeaders[index];
        const value = request.rawHeaders[index + 1];

        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            continue;
        }

        if (key.toLowerCase() === "host") {
            hasHostHeader = true;
        }

        filteredHeaders.push(key, value);
    }

    if (!hasHostHeader) {
        filteredHeaders.push("Host", fallbackHost);
    }

    return filteredHeaders;
};

export const filterResponseRawHeaders = (response: IncomingMessage): string[] => {
    const filteredHeaders: string[] = [];

    for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const key = response.rawHeaders[index];
        const value = response.rawHeaders[index + 1];

        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            continue;
        }

        filteredHeaders.push(key, value);
    }

    return filteredHeaders;
};

export const writeJson = (
    response: ServerResponse,
    statusCode: number,
    payload: unknown,
) => {
    const body = Buffer.from(JSON.stringify(payload, null, 2));

    response.writeHead(statusCode, {
        "content-length": body.length,
        "content-type": "application/json; charset=utf-8",
    });
    response.end(body);
};

export const forwardHttpRequestViaProxy = async (
    proxy: ProxySelection,
    clientRequest: IncomingMessage,
    clientResponse: ServerResponse,
): Promise<number> => {
    const targetUrl = clientRequest.url;
    if (!targetUrl || !isAbsoluteUrl(targetUrl)) {
        throw new Error("HTTP proxy requests must use an absolute URL");
    }

    const parsedTarget = new URL(targetUrl);
    if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
        throw new Error("Only http and https targets are supported");
    }

    const rawHeaders = buildForwardRawHeaders(clientRequest, parsedTarget.host);

    return new Promise<number>((resolve, reject) => {
        const upstreamRequest = http.request({
            headers: [
                ...rawHeaders,
                "Proxy-Authorization",
                buildProxyAuthorization(proxy),
            ],
            host: proxy.conn.ip,
            method: clientRequest.method,
            path: parsedTarget.toString(),
            port: Number(proxy.conn.port),
        });

        upstreamRequest.setTimeout(REQUEST_TIMEOUT_MS, () => {
            upstreamRequest.destroy(new Error("Upstream proxy request timed out"));
        });

        upstreamRequest.on("response", (upstreamResponse) => {
            const responseHeaders = [
                ...filterResponseRawHeaders(upstreamResponse),
                "X-Proxy-Id",
                proxy.id,
                "X-Proxy-Score",
                String(proxy.score),
            ];

            clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
            upstreamResponse.pipe(clientResponse);
            upstreamResponse.on("end", () => {
                resolve(upstreamResponse.statusCode ?? 502);
            });
            upstreamResponse.on("error", reject);
        });

        upstreamRequest.on("error", reject);
        clientRequest.on("aborted", () => {
            upstreamRequest.destroy(new Error("Client aborted request"));
        });

        clientRequest.pipe(upstreamRequest);
    });
};

export const createConnectTunnel = async (
    proxy: ProxySelection,
    targetAuthority: string,
): Promise<{ socket: net.Socket; buffered: Buffer }> => {
    return new Promise((resolve, reject) => {
        const socket = net.connect({
            host: proxy.conn.ip,
            port: Number(proxy.conn.port),
        });

        const cleanup = () => {
            socket.removeAllListeners("connect");
            socket.removeAllListeners("data");
            socket.removeAllListeners("timeout");
            socket.removeAllListeners("error");
        };

        socket.setTimeout(REQUEST_TIMEOUT_MS);

        socket.once("connect", () => {
            const connectRequest = [
                `CONNECT ${targetAuthority} HTTP/1.1`,
                `Host: ${targetAuthority}`,
                `Proxy-Authorization: ${buildProxyAuthorization(proxy)}`,
                "Proxy-Connection: Keep-Alive",
                "",
                "",
            ].join("\r\n");

            socket.write(connectRequest);
        });

        let buffer = Buffer.alloc(0);

        socket.on("data", (chunk) => {
            const bufferChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            buffer = Buffer.concat([buffer, bufferChunk]);
            const headerEnd = buffer.indexOf("\r\n\r\n");

            if (headerEnd === -1) {
                return;
            }

            const headerBlock = buffer.subarray(0, headerEnd).toString("utf-8");
            const [statusLine] = headerBlock.split("\r\n");
            const remainder = buffer.subarray(headerEnd + 4);

            cleanup();

            if (!statusLine.includes(" 200 ")) {
                socket.destroy();
                reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
                return;
            }

            resolve({ buffered: remainder, socket });
        });

        socket.once("timeout", () => {
            cleanup();
            socket.destroy(new Error("Upstream proxy CONNECT timed out"));
        });

        socket.once("error", (error) => {
            cleanup();
            reject(error);
        });
    });
};
