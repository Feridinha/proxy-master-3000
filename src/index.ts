import proxies, { getProxy, reportProxyStatus } from "./db";
import {
    createConnectTunnel,
    forwardHttpRequestViaProxy,
    isAbsoluteUrl,
    writeJson,
} from "./httpProxy";
import myEnv from "./myEnv";

import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";

import * as http from "http";

const readBody = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
};

const handleRoot = (_request: IncomingMessage, response: ServerResponse) => {
    writeJson(response, 200, {
        success: true,
        uptime: process.uptime(),
        proxies,
    });
};

const handleManualProxyReport = async (
    request: IncomingMessage,
    response: ServerResponse,
    proxyId: string,
) => {
    const body = await readBody(request);

    let status: "success" | "error" | null = null;

    try {
        const parsed = JSON.parse(body.toString("utf-8")) as {
            status?: string;
        };
        if (parsed.status === "success" || parsed.status === "error") {
            status = parsed.status;
        }
    } catch {
        status = null;
    }

    if (!status) {
        writeJson(response, 400, {
            success: false,
            message:
                "Body must contain JSON with status=success or status=error",
        });
        return;
    }

    const proxy = reportProxyStatus(proxyId, status);
    if (!proxy) {
        writeJson(response, 404, {
            success: false,
            message: "Proxy not found",
        });
        return;
    }

    writeJson(response, 200, {
        success: true,
        proxy,
    });
};

const handleLocalRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
): Promise<boolean> => {
    const rawUrl = request.url ?? "/";
    const url = new URL(
        rawUrl,
        `http://${request.headers.host ?? "localhost"}`,
    );

    if (request.method === "GET" && url.pathname === "/") {
        handleRoot(request, response);
        return true;
    }

    const reportMatch =
        request.method === "POST"
            ? url.pathname.match(/^\/proxy\/(.+)$/)
            : null;

    if (reportMatch) {
        await handleManualProxyReport(
            request,
            response,
            decodeURIComponent(reportMatch[1]),
        );
        return true;
    }

    return false;
};

const handleProxyRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
) => {
    const proxy = getProxy("stable");
    if (!proxy) {
        writeJson(response, 503, {
            success: false,
            message: "No proxies available",
        });
        return;
    }

    try {
        const upstreamStatus = await forwardHttpRequestViaProxy(
            proxy,
            request,
            response,
        );

        if (upstreamStatus === 407) {
            reportProxyStatus(proxy.id, "error");
            return;
        }

        reportProxyStatus(proxy.id, "success");
    } catch (error) {
        reportProxyStatus(proxy.id, "error");

        if (!response.headersSent) {
            writeJson(response, 502, {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Proxy request failed",
                proxyId: proxy.id,
            });
            return;
        }

        response.destroy(error instanceof Error ? error : undefined);
    }
};

const writeConnectError = (socket: Duplex, message: string) => {
    const body = Buffer.from(message, "utf-8");
    socket.write(
        [
            "HTTP/1.1 502 Bad Gateway",
            "Content-Type: text/plain; charset=utf-8",
            `Content-Length: ${body.length}`,
            "Connection: close",
            "",
            message,
        ].join("\r\n"),
    );
    socket.end();
};

const handleConnect = async (
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
) => {
    const targetAuthority = request.url;
    if (!targetAuthority) {
        writeConnectError(clientSocket, "Missing CONNECT target");
        return;
    }

    const proxy = getProxy("stable");
    if (!proxy) {
        writeConnectError(clientSocket, "No proxies available");
        return;
    }

    try {
        const { buffered, socket: upstreamSocket } = await createConnectTunnel(
            proxy,
            targetAuthority,
        );

        reportProxyStatus(proxy.id, "success");

        clientSocket.write(
            [
                "HTTP/1.1 200 Connection Established",
                "Proxy-Agent: proxy-master-3000",
                `X-Proxy-Id: ${proxy.id}`,
                "",
                "",
            ].join("\r\n"),
        );

        if (head.length > 0) {
            upstreamSocket.write(head);
        }

        if (buffered.length > 0) {
            clientSocket.write(buffered);
        }

        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);

        upstreamSocket.on("error", () => {
            clientSocket.destroy();
        });

        clientSocket.on("error", () => {
            upstreamSocket.destroy();
        });
    } catch (error) {
        reportProxyStatus(proxy.id, "error");
        writeConnectError(
            clientSocket,
            error instanceof Error ? error.message : "CONNECT tunnel failed",
        );
    }
};

const server = http.createServer(async (request, response) => {
    const rawUrl = request.url ?? "/";

    if (!isAbsoluteUrl(rawUrl)) {
        const handled = await handleLocalRoute(request, response);
        if (handled) {
            return;
        }

        writeJson(response, 400, {
            success: false,
            message:
                "Configure this service as an HTTP proxy, for example curl --proxy http://host:port https://example.com",
        });
        return;
    }

    await handleProxyRequest(request, response);
});

server.on("connect", (request, clientSocket, head) => {
    void handleConnect(request, clientSocket, head);
});

server.listen(myEnv.PORT);
