import { Agent, request } from "undici";
import { create as contentDisposition } from "content-disposition-header";

import { destroyInternalStream } from "./manage.js";
import { getHeaders, closeRequest, closeResponse, pipe } from "./shared.js";

const defaultAgent = new Agent();

export default async function (streamInfo, res) {
    const abortController = new AbortController();
    const shutdown = () => (
        closeRequest(abortController),
        closeResponse(res),
        destroyInternalStream(streamInfo.urls)
    );

    try {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-disposition', contentDisposition(streamInfo.filename));

        const { body: stream, headers, statusCode } = await request(streamInfo.urls, {
            headers: {
                ...getHeaders(streamInfo.service),
                Range: streamInfo.range
            },
            signal: abortController.signal,
            maxRedirections: 16,
            dispatcher: defaultAgent,
        });

        res.status(statusCode);

        for (const headerName of ['accept-ranges', 'content-type', 'content-length']) {
            if (headers[headerName]) {
                res.setHeader(headerName, headers[headerName]);
            }
        }

        let receivedBytes = 0;
        stream.on('data', (chunk) => {
            receivedBytes += chunk.length;
        });
        stream.on('end', () => {
            if (receivedBytes === 0) {
                console.error('Empty proxy stream', {
                    service: streamInfo.service,
                    url: streamInfo.urls,
                    statusCode,
                    contentType: headers['content-type'],
                    contentLength: headers['content-length'],
                });
            }
        });
        stream.on('error', (err) => {
            console.error('Proxy stream error', {
                service: streamInfo.service,
                url: streamInfo.urls,
                error: String(err),
            });
        });

        pipe(stream, res, shutdown);
    } catch {
        console.error('Proxy request failed', {
            service: streamInfo.service,
            url: streamInfo.urls,
        });
        shutdown();
    }
}
