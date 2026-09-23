const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

if (!process.env.FFMPEG_PATH) {
    try {
        const ffmpegStaticPath = require('ffmpeg-static');
        if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
            try { fs.chmodSync(ffmpegStaticPath, 0o755); } catch {}
            process.env.FFMPEG_PATH = ffmpegStaticPath;
        }
    } catch {
    }
}

if (typeof globalThis.Bun === 'undefined') {
    globalThis.Bun = { __fakedToSkipZmqAudioFilter: true };
}

const { Client } = require('discord.js-selfbot-v13');
const { Streamer, prepareStream, playStream, GatewayOpCodes } = require('@dank074/discord-video-stream');

const CONFIG_PATH = path.join(__dirname, 'config.json');

let cfg = null;
const c = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    green:   '\x1b[38;5;83m',
    cyan:    '\x1b[38;5;51m',
    magenta: '\x1b[38;5;207m',
    yellow:  '\x1b[38;5;220m',
    red:     '\x1b[38;5;203m',
    gray:    '\x1b[38;5;245m',
    white:   '\x1b[97m',
};

const tag = (color, label) => `${c.bold}${color}[${label}]${c.reset}`;

const log = {
    auth:   (...m) => console.log(tag(c.green,   'AUTH  '), ...m),
    voice:  (...m) => console.log(tag(c.cyan,    'VOICE '), ...m),
    stream: (...m) => console.log(tag(c.magenta, 'STREAM'), ...m),
    warn:   (...m) => console.log(tag(c.yellow,  'WARN  '), ...m),
    error:  (...m) => console.log(tag(c.red,     'ERROR '), ...m),
    info:   (...m) => console.log(tag(c.gray,    'INFO  '), ...m),
};

function banner() {
    const line = `${c.bold}${c.cyan}`;
    const rst  = c.reset;
    console.log();
    console.log(`${line}  ╔══════════════════════════════════════╗${rst}`);
    console.log(`${line}  ║${rst}  ${c.bold}${c.white}Discord Stream Bot${rst}                  ${line}║${rst}`);
    console.log(`${line}  ║${rst}  ${c.dim}Stream video into voice 24/7${rst}         ${line}║${rst}`);
    console.log(`${line}  ╠══════════════════════════════════════╣${rst}`);
    console.log(`${line}  ║${rst}  ${c.gray}Made by  ${c.white}iron web10${rst}                  ${line}║${rst}`);
    console.log(`${line}  ╚══════════════════════════════════════╝${rst}`);
    console.log();
}

function readConfigFile() {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        log.warn(`config.json could not be parsed (${err.message}) — starting fresh.`);
        return {};
    }
}

function writeConfigFile(data) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 4) + '\n');
}

async function ask(rl, question, defaultValue = '') {
    const suffix = defaultValue !== '' ? ` (${defaultValue})` : '';
    const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
    return answer || defaultValue;
}

async function ensureConfig() {
    const data = readConfigFile();

    data.server = data.server || {};
    data.stream = data.stream || {};
    data.stream.quality = data.stream.quality || {};

    const needsToken   = !data.token;
    const needsGuild   = !data.server.id;
    const needsChannel = !data.server.channel;
    const needsSources = !Array.isArray(data.stream.sources) || data.stream.sources.length === 0;
    const needsQuality = !data.stream.quality.width || !data.stream.quality.height
        || !data.stream.quality.fps || !data.stream.quality.bitrate;

    if (needsToken || needsGuild || needsChannel || needsSources || needsQuality) {
        log.info('Missing configuration detected — let\'s set it up.');
        console.log();

        const rl = readline.createInterface({ input: stdin, output: stdout });

        if (needsToken) {
            data.token = await ask(rl, 'Discord user token');
        }
        if (needsGuild) {
            data.server.id = await ask(rl, 'Server (guild) ID');
        }
        if (needsChannel) {
            data.server.channel = await ask(rl, 'Voice channel ID');
        }
        if (needsSources) {
            const raw = await ask(
                rl,
                'Video source(s) — comma-separated. Local file, remote URL, or .m3u/.m3u8',
                'stream.mp4'
            );
            data.stream.sources = raw.split(',').map(s => s.trim()).filter(Boolean);
        }
        if (needsQuality) {
            data.stream.quality.width   = Number(await ask(rl, 'Width',  data.stream.quality.width  || 1280));
            data.stream.quality.height  = Number(await ask(rl, 'Height', data.stream.quality.height || 720));
            data.stream.quality.fps     = Number(await ask(rl, 'FPS',    data.stream.quality.fps    || 25));
            data.stream.quality.bitrate = Number(await ask(rl, 'Bitrate (kbps)', data.stream.quality.bitrate || 1800));
        }

        rl.close();
        console.log();

        writeConfigFile(data);
        log.info(`Configuration saved to ${c.bold}${c.white}config.json${c.reset}`);
    }

    return data;
}

function loadToken() {
    const token = cfg.token?.trim();
    if (!token) {
        log.error('No token set in config.json.');
        process.exit(1);
    }
    return token;
}

function logFfmpegSource() {
    if (process.env.FFMPEG_PATH) {
        log.info(`Using bundled FFmpeg binary ${c.gray}(${process.env.FFMPEG_PATH})${c.reset}`);
    } else {
        log.warn('ffmpeg-static not found — falling back to a system "ffmpeg" on PATH.');
    }
}

function setUndeafened(streamer) {
    streamer.sendOpcode(GatewayOpCodes.VOICE_STATE_UPDATE, {
        guild_id:   cfg.server.id,
        channel_id: cfg.server.channel,
        self_mute:  false,
        self_deaf:  false,
        self_video: false,
    });
}

const isRemoteUrl = (src) => /^https?:\/\//i.test(src);
const isM3U8      = (src) => /\.m3u8(\?.*)?$/i.test(src);
const isM3U       = (src) => /\.m3u(\?.*)?$/i.test(src) && !isM3U8(src);

function fetchText(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
                res.resume();
                return fetchText(res.headers.location, redirects - 1).then(resolve, reject);
            }
            if (res.statusCode && res.statusCode >= 400) {
                return reject(new Error(`HTTP ${res.statusCode} while fetching ${url}`));
            }
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function expandSource(src) {
    if (!isM3U(src)) return [src];

    try {
        const text = isRemoteUrl(src)
            ? await fetchText(src)
            : fs.readFileSync(src, 'utf8');

        const entries = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));

        if (entries.length === 0) {
            log.warn(`Playlist ${src} is empty, skipping.`);
            return [];
        }

        log.info(`Playlist ${c.bold}${c.white}${src}${c.reset} ${c.gray}(${entries.length} entries)${c.reset}`);
        return entries;
    } catch (err) {
        log.error(`Could not read playlist ${src} — ${err.message}`);
        return [];
    }
}

async function buildPlaylist() {
    const rawSources = (Array.isArray(cfg.stream.sources) && cfg.stream.sources.length > 0)
        ? cfg.stream.sources
        : [cfg.stream.file];

    const playlist = [];
    for (const src of rawSources) {
        const expanded = await expandSource(src);
        playlist.push(...expanded);
    }

    if (playlist.length === 0) {
        log.error('No valid video source configured.');
        process.exit(1);
    }

    return playlist;
}
function buildInputOptions(src) {
    const remote = isRemoteUrl(src);
    const hls = isM3U8(src);
    const opts = [];

    if (remote) {
        opts.push('-timeout', '15000000');
    }

    if (hls) {
        opts.push('-allowed_extensions', 'ALL');
    } else if (remote) {
        opts.push(
            '-reconnect', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-re'
        );
    } else {
        opts.push('-stream_loop', '-1', '-re');
    }

    return opts;
}

async function startStream(streamer, playlist, index = 0) {
    const { width, height, fps, bitrate } = cfg.stream.quality;
    const src = playlist[index % playlist.length];
    const nextIndex = (index + 1) % playlist.length;

    const kind = isM3U8(src) ? 'HLS' : isRemoteUrl(src) ? 'remote' : 'local';

    const opts = {
        width,
        height,
        frameRate: fps,
        bitrateVideo: bitrate,
        minimizeLatency: true,
        customInputOptions: buildInputOptions(src),
    };

    log.stream(`Playing (${kind}) ${c.bold}${c.white}${src}${c.reset} ${c.gray}(${width}x${height} · ${fps}fps · ${bitrate}kbps)${c.reset}`);

    let command;
    try {
        const prepared = prepareStream(src, opts);
        command = prepared.command;

        command.on('error', err => log.error('FFmpeg —', err.message));
        command.on('start', cmdLine => log.info(`${c.gray}ffmpeg ${cmdLine}${c.reset}`));
        command.on('stderr', line => log.info(`${c.gray}[ffmpeg] ${line}${c.reset}`));

        log.stream(`Connecting to the demuxer, waiting for the first video frame...`);
        await playStream(prepared.output, streamer);
        log.stream(`Source ended — moving to the next one...`);
    } catch (err) {
        log.error(`Playback (${src}) —`, err.message);
    } finally {
        try { command?.kill('SIGTERM'); } catch {}
    }

    setTimeout(() => startStream(streamer, playlist, nextIndex).catch(console.error), 3000);
}

async function launch() {
    banner();

    cfg = await ensureConfig();
    logFfmpegSource();

    const token = loadToken();
    const client = new Client({ checkUpdate: false });
    const streamer = new Streamer(client);

    client.once('ready', async () => {
        log.auth(`Logged in as ${c.bold}${c.white}${client.user.tag}${c.reset}`);

        const vc = client.channels.cache.get(cfg.server.channel);
        if (!vc?.isVoice()) {
            log.error(`Channel ${cfg.server.channel} not found or is not a voice channel.`);
            return;
        }

        await streamer.joinVoice(cfg.server.id, cfg.server.channel);
        setUndeafened(streamer);
        log.voice(`Joined ${c.bold}${c.white}${vc.name}${c.reset} ${c.gray}(${cfg.server.id})${c.reset}`);

        await new Promise(r => setTimeout(r, 3000));

        const playlist = await buildPlaylist();
        startStream(streamer, playlist, 0).catch(console.error);
    });

    client.on('disconnect', () => {
        log.warn(`Disconnected — reconnecting in 10s...`);
        setTimeout(launch, 10000);
    });

    await client.login(token).catch(err => {
        log.error(`Login failed — ${err.message}`);
        process.exit(1);
    });
}

launch();
