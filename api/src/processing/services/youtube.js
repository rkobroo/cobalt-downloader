import { YtDlp } from "ytdlp-nodejs";
import { getCookie } from "../cookie/manager.js";
import { getYouTubeSession } from "../helpers/youtube-session.js";

const ytdlp = new YtDlp();

const logFetchFailure = (id, error) => {
    console.error("yt-dlp failed", {
        id,
        message: error?.message,
        code: error?.code,
        stack: error?.stack?.split("\n")?.[0],
    });
};
const AUDIO_EXTENSIONS = new Set([
    "aac",
    "flac",
    "mp3",
    "m4a",
    "opus",
    "vorbis",
    "wav",
    "alac",
]);
const HTTP_PREFIX = "http";

function createSessionHeaders(session) {
    if (!session) {
        return;
    }

    const headers = {};
    if (session.visitor_data) {
        headers["X-Goog-Visitor-Id"] = session.visitor_data;
    }

    if (session.potoken) {
        headers["X-Youtube-Identity-Token"] = session.potoken;
    }

    return Object.keys(headers).length ? headers : undefined;
}

function createCookieHeader(session) {
    const cookieParts = [];
    const youtubeCookie = getCookie("youtube");
    const existingNames = new Set();

    if (youtubeCookie) {
        cookieParts.push(youtubeCookie.toString());
        Object.keys(youtubeCookie.values()).forEach((name) => existingNames.add(name));
    }

    if (session?.visitor_data && !existingNames.has("VISITOR_INFO1_LIVE")) {
        cookieParts.push(`VISITOR_INFO1_LIVE=${session.visitor_data}`);
    }

    return cookieParts.length ? cookieParts.join("; ") : undefined;
}

function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function hasAudio(format) {
    const acodec = typeof format?.acodec === "string" ? format.acodec.toLowerCase() : "";
    return acodec && acodec !== "none";
}

function hasVideo(format) {
    const vcodec = typeof format?.vcodec === "string" ? format.vcodec.toLowerCase() : "";
    return vcodec && vcodec !== "none";
}

function isHttpFormat(format) {
    const url = typeof format?.url === "string" ? format.url.trim() : "";
    if (!url.startsWith(HTTP_PREFIX)) {
        return false;
    }

    const protocol = typeof format.protocol === "string" ? format.protocol.toLowerCase() : "";
    if (!protocol) {
        return true;
    }

    if (protocol.includes("dash") || protocol.includes("m3u8") || protocol.includes("fragment")) {
        return false;
    }

    return true;
}

function compareVideoQuality(a, b) {
    const heightDiff = toNumber(b.height) - toNumber(a.height);
    if (heightDiff !== 0) {
        return heightDiff;
    }

    const tbrDiff = toNumber(b.tbr) - toNumber(a.tbr);
    if (tbrDiff !== 0) {
        return tbrDiff;
    }

    return toNumber(b.width) - toNumber(a.width);
}

function compareAudioQuality(a, b) {
    const tbrDiff = toNumber(b.tbr) - toNumber(a.tbr);
    if (tbrDiff !== 0) {
        return tbrDiff;
    }

    return toNumber(b.filesize) - toNumber(a.filesize);
}

function pickBestFormat(formats, predicate, comparator) {
    const candidates = formats.filter(predicate);
    if (!candidates.length) {
        return;
    }

    return candidates.sort(comparator)[0];
}

function pickSubtitle(info, lang) {
    if (!lang) {
        return;
    }

    const normalized = lang.toLowerCase();
    const sources = [info?.subtitles, info?.automatic_captions];

    for (const source of sources) {
        if (!source) {
            continue;
        }

        const direct = source[lang] ?? source[normalized];
        if (direct?.length) {
            return direct[0].url;
        }

        const fallbackKey = Object.keys(source).find((key) => key?.toLowerCase() === normalized);
        if (fallbackKey) {
            return source[fallbackKey][0].url;
        }
    }
}

function normalizeInfo(info) {
    if (info?._type === "playlist" && Array.isArray(info.entries) && info.entries.length) {
        return info.entries[0];
    }

    return info;
}

function extractJson(stdout) {
    const trimmed = (stdout ?? "").trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
        throw new Error("unable to parse yt-dlp output");
    }

    return JSON.parse(trimmed.slice(start, end + 1));
}

async function fetchVideoInfo(videoUrl, sourceAddress) {
    const options = {
        dumpSingleJson: true,
        skipDownload: true,
        quiet: true,
        noWarnings: true,
        noColor: true,
        noProgress: true,
    };

    if (sourceAddress) {
        options.sourceAddress = sourceAddress;
    }

    const session = getYouTubeSession();
    const sessionHeaders = createSessionHeaders(session);
    const cookieHeader = createCookieHeader(session);

    if (sessionHeaders) {
        options.addHeaders = sessionHeaders;
    }

    if (cookieHeader) {
        options.cookies = cookieHeader;
    }

    const result = await ytdlp.execAsync(videoUrl, options);
    if (!result?.stdout) {
        throw new Error("empty yt-dlp output");
    }

    return extractJson(result.stdout);
}

function buildFilenameAttributes({ info, id, extension, resolution, qualityLabel }) {
    const attrs = {
        service: "youtube",
        id,
        title: info?.title,
        author: info?.uploader,
        extension,
    };

    if (resolution) {
        attrs.resolution = resolution;
    }

    if (qualityLabel) {
        attrs.qualityLabel = qualityLabel;
    }

    return attrs;
}

function buildOriginalRequest(o, url) {
    return {
        id: o.id,
        quality: o.quality,
        codec: o.codec,
        container: o.container,
        dubLang: o.dubLang,
        youtubeHLS: o.youtubeHLS,
        subtitleLang: o.subtitleLang,
        isAudioMuted: o.isAudioMuted,
        isAudioOnly: o.isAudioOnly,
        requestIP: o.requestIP,
        url,
    };
}

export default async function (o) {
    const videoUrl = `https://www.youtube.com/watch?v=${o.id}`;
    let rawInfo;

    try {
        rawInfo = await fetchVideoInfo(videoUrl, o.requestIP);
    } catch (error) {
        logFetchFailure(o.id, error);
        return { error: "fetch.fail" };
    }

    const videoInfo = normalizeInfo(rawInfo);
    const formats = Array.isArray(videoInfo?.formats) ? videoInfo.formats : [];

    if (!formats.length) {
        return { error: "youtube.no_matching_format" };
    }

    const muxed = pickBestFormat(
        formats,
        (format) => isHttpFormat(format) && hasVideo(format) && hasAudio(format),
        compareVideoQuality
    );

    const videoOnly = pickBestFormat(
        formats,
        (format) => isHttpFormat(format) && hasVideo(format) && !hasAudio(format),
        compareVideoQuality
    );

    const audioOnly = pickBestFormat(
        formats,
        (format) => isHttpFormat(format) && hasAudio(format) && !hasVideo(format),
        compareAudioQuality
    );

    const metadata = {
        title: videoInfo?.title,
        artist: videoInfo?.uploader,
    };

    const subtitleUrl = pickSubtitle(videoInfo, o.subtitleLang);
    if (subtitleUrl && o.subtitleLang) {
        metadata.sublanguage = o.subtitleLang;
    }

    const audioExt =
        typeof audioOnly?.ext === "string" ? audioOnly.ext.toLowerCase() : undefined;
    const bestAudio = audioExt && AUDIO_EXTENSIONS.has(audioExt) ? audioExt : undefined;
    const originalRequest = buildOriginalRequest(o, videoUrl);

    if (o.isAudioOnly) {
        const audioStream = audioOnly ?? muxed;

        if (!audioStream) {
            return { error: "youtube.no_matching_format" };
        }

        return {
            type: "proxy",
            urls: audioStream.url,
            bestAudio,
            filenameAttributes: buildFilenameAttributes({
                info: videoInfo,
                id: o.id,
                extension: audioStream.ext ?? "m4a",
                qualityLabel: "audio",
            }),
            fileMetadata: metadata,
            subtitles: subtitleUrl,
            isAudioOnly: true,
            originalRequest,
        };
    }

    if (muxed && !o.isAudioMuted) {
        return {
            type: "proxy",
            urls: muxed.url,
            bestAudio,
            filenameAttributes: buildFilenameAttributes({
                info: videoInfo,
                id: o.id,
                extension: muxed.ext ?? "mp4",
                resolution:
                    muxed.width && muxed.height ? `${muxed.width}x${muxed.height}` : undefined,
                qualityLabel: muxed.height ? `${muxed.height}p` : undefined,
            }),
            fileMetadata: metadata,
            subtitles: subtitleUrl,
            originalRequest,
        };
    }

    if (!videoOnly || !audioOnly) {
        if (muxed) {
            return {
                type: "proxy",
                urls: muxed.url,
                bestAudio,
                filenameAttributes: buildFilenameAttributes({
                    info: videoInfo,
                    id: o.id,
                    extension: muxed.ext ?? "mp4",
                    resolution:
                        muxed.width && muxed.height ? `${muxed.width}x${muxed.height}` : undefined,
                    qualityLabel: muxed.height ? `${muxed.height}p` : undefined,
                }),
                fileMetadata: metadata,
                subtitles: subtitleUrl,
                originalRequest,
            };
        }

        return { error: "youtube.no_matching_format" };
    }

    return {
        type: "merge",
        urls: [videoOnly.url, audioOnly.url],
        bestAudio,
        filenameAttributes: buildFilenameAttributes({
            info: videoInfo,
            id: o.id,
            extension: videoOnly.ext ?? "mp4",
            resolution:
                videoOnly.width && videoOnly.height ? `${videoOnly.width}x${videoOnly.height}` : undefined,
            qualityLabel: videoOnly.height ? `${videoOnly.height}p` : undefined,
        }),
        fileMetadata: metadata,
        subtitles: subtitleUrl,
        originalRequest,
    };
}
