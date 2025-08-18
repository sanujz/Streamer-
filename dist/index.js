import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import config from "./config.json" with { type: "json" };
import { join, dirname } from "path";
import { fileURLToPath } from "url";
// Set FFmpeg path to local executable
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ffmpegPath = join(__dirname, 'ffmpeg');
// Set environment variables for FFmpeg
process.env.FFMPEG_PATH = ffmpegPath;
process.env.PATH = `${process.env.PATH}:${join(__dirname, '..')}`;
// Helper function for formatted logging
function log(level, message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${timestamp}] [${level}] ${message}`);
}
const streamer = new Streamer(new Client());
// ready event
streamer.client.on("ready", () => {
    log("INFO", "Streamer initialized successfully");
    log("INFO", `Logged in as: ${streamer.client.user?.tag}`);
    log("INFO", `User ID: ${streamer.client.user?.id}`);
    log("INFO", "Ready to stream!");
    log("INFO", `FFmpeg path set to: ${ffmpegPath}`);
});
let controller;
// message event
streamer.client.on("messageCreate", async (msg) => {
    if (msg.author.bot)
        return;
    if (!config.acceptedAuthors.includes(msg.author.id))
        return;
    if (!msg.content)
        return;
    if (msg.content.startsWith("$play-live")) {
        const args = parseArgs(msg.content);
        if (!args)
            return;
        const channel = msg.author.voice?.channel;
        if (!channel)
            return;
        log("INFO", `Live stream requested by ${msg.author.tag} (${msg.author.id})`);
        const channelName = 'name' in channel ? channel.name : 'Unknown Channel';
        const guildName = msg.guild?.name || 'Unknown Guild';
        log("INFO", `Joining voice channel: ${channelName} (${channel.id}) in guild: ${guildName} (${msg.guildId})`);
        await streamer.joinVoice(msg.guildId, channel.id);
        if (channel instanceof StageChannel) {
            log("INFO", "Stage channel detected - enabling audio");
            await streamer.client.user?.voice?.setSuppressed(false);
        }
        controller?.abort();
        controller = new AbortController();
        log("INFO", `Starting live stream with URL: ${args.url}`);
        log("INFO", `Stream settings: ${config.streamOpts.width}x${config.streamOpts.height} @ ${config.streamOpts.fps}fps, ${config.streamOpts.bitrateKbps}kbps`);
        try {
            const { command, output } = prepareStream(args.url, {
                width: config.streamOpts.width,
                height: config.streamOpts.height,
                frameRate: config.streamOpts.fps,
                bitrateVideo: config.streamOpts.bitrateKbps,
                bitrateVideoMax: config.streamOpts.maxBitrateKbps,
                hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
                videoCodec: Utils.normalizeVideoCodec(config.streamOpts.videoCodec)
            }, controller.signal);
            log("INFO", "FFmpeg command prepared successfully");
            command.on("error", (err) => {
                log("ERROR", `FFmpeg error occurred: ${err.message || err}`);
                log("ERROR", `FFmpeg stderr: ${err.stderr || 'No stderr'}`);
                log("ERROR", `FFmpeg exit code: ${err.exitCode || 'Unknown'}`);
            });
            command.on("stderr", (stderrLine) => {
                log("INFO", `FFmpeg: ${stderrLine}`);
            });
            await playStream(output, streamer, undefined, controller.signal)
                .then(() => log("INFO", "Live stream started successfully"))
                .catch((error) => {
                log("ERROR", `Failed to start live stream: ${error.message || error}`);
                controller.abort();
            });
        }
        catch (error) {
            log("ERROR", `Failed to prepare stream: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
    }
    else if (msg.content.startsWith("$play-cam")) {
        const args = parseArgs(msg.content);
        if (!args)
            return;
        const channel = msg.author.voice?.channel;
        if (!channel)
            return;
        log("INFO", `Camera stream requested by ${msg.author.tag} (${msg.author.id})`);
        const channelName = 'name' in channel ? channel.name : 'Unknown Channel';
        const guildName = msg.guild?.name || 'Unknown Guild';
        log("INFO", `Joining voice channel: ${channelName} (${channel.id}) in guild: ${guildName} (${msg.guildId})`);
        const vc = await streamer.joinVoice(msg.guildId, channel.id);
        if (channel instanceof StageChannel) {
            log("INFO", "Stage channel detected - enabling audio");
            await streamer.client.user?.voice?.setSuppressed(false);
        }
        controller?.abort();
        controller = new AbortController();
        log("INFO", `Starting camera stream with URL: ${args.url}`);
        log("INFO", `Stream settings: ${config.streamOpts.width}x${config.streamOpts.height} @ ${config.streamOpts.fps}fps, ${config.streamOpts.bitrateKbps}kbps`);
        try {
            const { command, output } = prepareStream(args.url, {
                width: config.streamOpts.width,
                height: config.streamOpts.height,
                frameRate: config.streamOpts.fps,
                bitrateVideo: config.streamOpts.bitrateKbps,
                bitrateVideoMax: config.streamOpts.maxBitrateKbps,
                hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
                videoCodec: Utils.normalizeVideoCodec(config.streamOpts.videoCodec)
            }, controller.signal);
            log("INFO", "FFmpeg command prepared successfully");
            command.on("error", (err) => {
                log("ERROR", `FFmpeg error occurred: ${err.message || err}`);
                log("ERROR", `FFmpeg stderr: ${err.stderr || 'No stderr'}`);
                log("ERROR", `FFmpeg exit code: ${err.exitCode || 'Unknown'}`);
            });
            command.on("stderr", (stderrLine) => {
                log("INFO", `FFmpeg: ${stderrLine}`);
            });
            await playStream(output, streamer, undefined, controller.signal)
                .then(() => log("INFO", "Camera stream started successfully"))
                .catch((error) => {
                log("ERROR", `Failed to start camera stream: ${error.message || error}`);
                controller.abort();
            });
        }
        catch (error) {
            log("ERROR", `Failed to prepare camera stream: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
    }
    else if (msg.content.startsWith("$disconnect")) {
        log("INFO", `Disconnect requested by ${msg.author.tag} (${msg.author.id})`);
        controller?.abort();
        streamer.leaveVoice();
        log("INFO", "Disconnected from voice channel");
    }
    else if (msg.content.startsWith("$stop-stream")) {
        log("INFO", `Stop stream requested by ${msg.author.tag} (${msg.author.id})`);
        controller?.abort();
        log("INFO", "Stream stopped");
    }
});
// login
log("INFO", "Attempting to login with Discord...");
streamer.client.login(config.token)
    .then(() => log("INFO", "Login successful"))
    .catch((error) => log("ERROR", `Login failed: ${error.message || error}`));
function parseArgs(message) {
    const args = message.split(" ");
    if (args.length < 2)
        return;
    const url = args[1];
    // Validate URL
    try {
        new URL(url);
    }
    catch (error) {
        console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] [ERROR] Invalid URL provided: ${url}`);
        return;
    }
    return { url };
}
