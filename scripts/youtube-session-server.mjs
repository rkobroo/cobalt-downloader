#!/usr/bin/env node
import http from "node:http";
import process from "node:process";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.YOUTUBE_SESSION_PORT ?? 8080);
const PAYLOAD_PATH = process.env.YOUTUBE_SESSION_PAYLOAD_PATH;

const DEFAULT_PAYLOAD = {
    potoken: "MnhV2E32UoNWVVXkiVqbr31arfqr3SvbH6Kbih4XcUX4APXhucdD_tvReFBSOd1FThUnEi5ZXio1mR-unurn_m7fomHflfgJLOQxdd0BfjiNHHaW8cMhcaW5L1Med1VJ0SNIr45WjV_ETknW572Wqpg20PsVH4P8uHQ=",
    visitor_data: "CgtUMHRVZk1Sb2Zfayicla3NBjIKCgJHQhIEGgAgaw==",
    updated: Date.now()
};

const loadPayload = async () => {
    if (!PAYLOAD_PATH) {
        return DEFAULT_PAYLOAD;
    }

    try {
        const contents = await readFile(PAYLOAD_PATH, "utf8");
        return JSON.parse(contents);
    } catch (error) {
        console.error(
            "failed to load youtube session payload from",
            PAYLOAD_PATH,
            "(" + error.message + ")"
        );
        return DEFAULT_PAYLOAD;
    }
};

const createResponse = (res, status, body) => {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/token") {
        const payload = await loadPayload();
        return createResponse(res, 200, payload);
    }

    res.writeHead(404).end();
});

server.listen(PORT, () => {
    console.log(`youtube session server listening on http://127.0.0.1:${PORT}/token`);
});

server.on("error", (error) => {
    console.error("youtube session server error:", error);
    process.exit(1);
});
