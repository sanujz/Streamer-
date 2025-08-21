import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import config from "./config.json" with {type: "json"};
import { join } from "path";
import { platform } from "os";
import { existsSync, readdirSync, statSync, openSync, closeSync } from "fs";
import { spawn } from "child_process";

try {
    const ffmpegName = platform() === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const ffmpegPath = join(process.cwd(), ffmpegName);
    process.env.FFMPEG_PATH = ffmpegPath;
    console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] [INFO] FFmpeg path set to: ${ffmpegPath}`);
} catch (error) {
    console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] [ERROR] Failed to set FFmpeg path: ${error}`);
}

function log(level: string, message: string) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${timestamp}] [${level}] ${message}`);
}

const streamer = new Streamer(new Client());

let is247Mode = false;
let controller247: AbortController;
let lastCommandMessage: any = null;

function getVideoPlaylist(): string[] {
    const videoDir = join(process.cwd(), "Video");
    const videoFiles: string[] = [];
    
    try {
        if (existsSync(videoDir)) {
            const files = readdirSync(videoDir);
            

            const videoEntries = files
                .filter(file => /^video\d+\.mp4$/i.test(file))
                .map(file => {
                    const match = file.match(/^video(\d+)\.mp4$/i);
                    if (match) {
                        return {
                            path: join(videoDir, file),
                            number: parseInt(match[1])
                        };
                    }
                    return null;
                })
                .filter(entry => entry !== null)
                .sort((a, b) => a!.number - b!.number);
            
            return videoEntries.map(entry => entry!.path);
        }
    } catch (error) {
        log("ERROR", `Failed to read Video directory: ${error}`);
    }
    
    return [];
}

let currentVideoIndex = 0;

let isStreamStarting = false;

async function start247Stream() {
    if (!is247Mode || isStreamStarting) return;
    
    if (controller247?.signal.aborted) {
        log("INFO", "Stream was aborted, not starting new stream");
        return;
    }
    
    isStreamStarting = true;
    
    const videoPlaylist = getVideoPlaylist();
    if (videoPlaylist.length === 0) {
        log("ERROR", "No video files found in Video directory");
        isStreamStarting = false;
        return;
    }
    
    const currentVideo = videoPlaylist[currentVideoIndex];
    
    if (!existsSync(currentVideo)) {
        log("ERROR", `Video file not found: ${currentVideo}`);
        log("ERROR", `Current working directory: ${process.cwd()}`);
        log("ERROR", `Video folder contents: ${readdirSync(join(process.cwd(), "Video")).join(", ")}`);
        

        await sendDiscordNotification(`⚠️ **Video Error:** ${currentVideo.split('\\').pop()?.split('/').pop() || 'Unknown'} not found, skipping to next video...`, lastCommandMessage);
        
        if (is247Mode) {
            currentVideoIndex = (currentVideoIndex + 1) % videoPlaylist.length;
            log("INFO", `Trying next video: ${currentVideoIndex + 1}/${videoPlaylist.length}`);
            isStreamStarting = false;
            setTimeout(() => start247Stream(), 5000);
        }
        return;
    }
    
    log("INFO", `Starting 247 stream with video ${currentVideoIndex + 1}/${videoPlaylist.length}: ${currentVideo}`);
    log("INFO", `File size: ${(statSync(currentVideo).size / (1024 * 1024)).toFixed(2)} MB`);
    

    await sendDiscordNotification(`🎬 **Now Playing:** ${currentVideo.split('\\').pop()?.split('/').pop() || 'Unknown'} (${currentVideoIndex + 1}/${videoPlaylist.length})`, lastCommandMessage);
    
    try {
        const fd = openSync(currentVideo, 'r');
        closeSync(fd);
        log("INFO", `File access test passed`);
    } catch (error) {
        log("ERROR", `File access test failed: ${error}`);
        isStreamStarting = false;
        if (is247Mode) {
            currentVideoIndex = (currentVideoIndex + 1) % videoPlaylist.length;
            setTimeout(() => start247Stream(), 5000);
        }
        return;
    }
    
    log("INFO", `Testing FFmpeg compatibility...`);
    
    try {
        const testProcess = spawn('ffmpeg', ['-i', currentVideo, '-f', 'null', '-'], { stdio: 'pipe' });
        
        let hasError = false;
        testProcess.stderr.on('data', (data: any) => {
            const output = data.toString();
            if (output.includes('Invalid data') || output.includes('moov atom not found') || output.includes('No such file or directory')) {
                hasError = true;
                log("ERROR", `FFmpeg cannot read video file: ${currentVideo}`);
                log("ERROR", `FFmpeg output: ${output}`);
            }
        });
        
        testProcess.on('close', async (code: number) => {
            if (code === 0 && !hasError) {
                log("INFO", `FFmpeg compatibility test passed`);
            } else {
                log("ERROR", `FFmpeg compatibility test failed with code ${code}`);
                log("ERROR", `Video file needs to be re-encoded or replaced`);
                

                try {
                    const guild = streamer.client.guilds.cache.first();
                    if (guild) {
                        const systemChannel = guild.systemChannel || guild.channels.cache.find(ch => 'send' in ch);
                        if (systemChannel) {
                            const videoName = currentVideo.split('\\').pop()?.split('/').pop() || 'Unknown';
                            await sendDiscordNotification(`❌ **FFmpeg Error:** ${videoName} has compatibility issues, skipping to next video...`, lastCommandMessage);
                        }
                    }
                } catch (error) {
                    log("ERROR", `Failed to send Discord notification: ${error}`);
                }
                
                isStreamStarting = false;
                
                if (is247Mode) {
                    currentVideoIndex = (currentVideoIndex + 1) % videoPlaylist.length;
                    log("INFO", `Skipping to next video: ${currentVideoIndex + 1}/${videoPlaylist.length}`);
                    setTimeout(() => start247Stream(), 2000);
                }
                return;
            }
        });
        
        testProcess.on('error', (error: any) => {
            log("ERROR", `FFmpeg test process error: ${error.message}`);
            isStreamStarting = false;
        });
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
    } catch (error) {
        log("ERROR", `FFmpeg test failed: ${error}`);
        isStreamStarting = false;
        return;
    }
    
    try {
        const { command, output } = prepareStream(currentVideo, {
            width: config.streamOpts.width,
            height: config.streamOpts.height,
            frameRate: config.streamOpts.fps,
            bitrateVideo: config.streamOpts.bitrateKbps,
            bitrateVideoMax: config.streamOpts.maxBitrateKbps,
            hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
            videoCodec: Utils.normalizeVideoCodec(config.streamOpts.videoCodec)
        }, controller247.signal);
        
        log("INFO", "247 FFmpeg command prepared successfully");
        
        command.on("error", async (err: any) => {
            try {
                log("ERROR", `247 FFmpeg error occurred: ${err.message || err}`);
                log("ERROR", `247 FFmpeg stderr: ${err.stderr || 'No stderr'}`);
                log("ERROR", `247 FFmpeg exit code: ${err.exitCode || 'Unknown'}`);
            } catch (logError) {
                log("ERROR", `Failed to log FFmpeg error: ${logError}`);
            }
            
            isStreamStarting = false;
            if (is247Mode) {
                log("INFO", "Restarting 247 stream after error...");
                setTimeout(() => start247Stream(), 5000);
            }
        });
        
        command.on("stderr", (stderrLine: string) => {
            try {
                log("INFO", `247 FFmpeg: ${stderrLine}`);
            } catch (logError) {
                log("ERROR", `Failed to log FFmpeg stderr: ${logError}`);
            }
        });
        
        try {
            await playStream(output, streamer, undefined, controller247.signal)
                .then(async () => {
                    try {
                        log("INFO", `Video ${currentVideoIndex + 1} ended, moving to next video...`);
                        
                        await sendDiscordNotification(`**Video Completed:** ${currentVideo.split('\\').pop()?.split('/').pop() || 'Unknown'} finished, moving to next video...`, lastCommandMessage);
                        
                        isStreamStarting = false;
                        if (is247Mode) {
                            currentVideoIndex = (currentVideoIndex + 1) % videoPlaylist.length;
                            log("INFO", `Now playing video ${currentVideoIndex + 1}/${videoPlaylist.length}`);
                            setTimeout(() => start247Stream(), 1000);
                        }
                    } catch (error) {
                        log("ERROR", `Error in video completion handler: ${error}`);
                        isStreamStarting = false;
                        if (is247Mode) {
                            setTimeout(() => start247Stream(), 5000);
                        }
                    }
                })
                .catch(async (error) => {
                    try {
                        log("ERROR", `247 stream failed: ${error.message || error}`);
                    } catch (logError) {
                        log("ERROR", `Failed to log stream failure: ${logError}`);
                    }
                    
                    isStreamStarting = false;
                    if (is247Mode) {
                        log("INFO", "Restarting 247 stream after failure...");
                        setTimeout(() => start247Stream(), 5000);
                    }
                });
        } catch (playError) {
            log("ERROR", `Failed to start playStream: ${playError}`);
            isStreamStarting = false;
            if (is247Mode) {
                setTimeout(() => start247Stream(), 5000);
            }
        }
    } catch (error) {
        try {
            log("ERROR", `Failed to prepare 247 stream: ${error instanceof Error ? error.message : String(error)}`);
        } catch (logError) {
            log("ERROR", `Failed to log preparation error: ${logError}`);
        }
        
        isStreamStarting = false;
        if (is247Mode) {
            log("INFO", "Restarting 247 stream after preparation failure...");
            setTimeout(() => start247Stream(), 5000);
        }
    }
}

async function sendDiscordNotification(message: string, originalMessage?: any): Promise<void> {
    try {
        if (originalMessage) {
            await originalMessage.reply(message);
        } else {
            const guild = streamer.client.guilds.cache.first();
            if (guild) {
                const systemChannel = guild.systemChannel || guild.channels.cache.find(ch => 'send' in ch);
                if (systemChannel) {
                    await systemChannel.send(message);
                }
            }
        }
    } catch (error) {
        log("ERROR", `Failed to send Discord notification: ${error}`);
    }
}

streamer.client.on("ready", () => {
    log("INFO", "Streamer initialized successfully");
    log("INFO", `Logged in as: ${streamer.client.user?.tag}`);
    log("INFO", `User ID: ${streamer.client.user?.id}`);
    log("INFO", "Ready to stream!");
    
    try {
        const ffmpegName = platform() === "win32" ? "ffmpeg.exe" : "ffmpeg";
        const ffmpegPath = join(process.cwd(), ffmpegName);
        log("INFO", `FFmpeg path: ${ffmpegPath}`);
        log("INFO", "Local FFmpeg binary found");
    } catch (error) {
        log("ERROR", `Local FFmpeg not found: ${error}`);
    }
});

process.on('uncaughtException', (error) => {
    log("ERROR", `Uncaught Exception: ${error.message}`);
    log("ERROR", `Stack trace: ${error.stack}`);
    log("INFO", "Bot will continue running despite the error");
});

process.on('unhandledRejection', (reason, promise) => {
    log("ERROR", `Unhandled Rejection at: ${promise}, reason: ${reason}`);
    log("INFO", "Bot will continue running despite the rejection");
});

streamer.client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    if (!config.acceptedAuthors.includes(msg.author.id)) return;

    if (!msg.content) return;

    if (msg.content.startsWith("*stream")) {
        lastCommandMessage = msg;
        const args = msg.content.split(" ");
        let targetChannelId: string;
        let startVideoId: number = 0;
        
        if (args.length >= 2) {
            targetChannelId = args[1];
            
            if (args.length >= 3) {
                const videoId = parseInt(args[2]);
                if (!isNaN(videoId) && videoId > 0) {
                    startVideoId = videoId - 1;
                    log("INFO", `Stream mode requested by ${msg.author.tag} (${msg.author.id}) for channel: ${targetChannelId}, starting with video ID: ${videoId}`);
                } else {
                    await msg.reply("**Error:** Invalid video ID. Please use a number (e.g., 1, 2, 3).");
                    return;
                }
            } else {
                log("INFO", `Stream mode requested by ${msg.author.tag} (${msg.author.id}) for channel: ${targetChannelId}`);
            }
        } else {
            const channel = msg.author.voice?.channel;
            if (!channel) {
                log("ERROR", `No channel specified and ${msg.author.tag} is not in a voice channel`);
                await msg.reply("**Error:** No channel specified and you're not in a voice channel. Use `*stream <channelId> [videoId]` or join a voice channel first.");
                return;
            }
            targetChannelId = channel.id;
            log("INFO", `Stream mode requested by ${msg.author.tag} (${msg.author.id}) for their current channel: ${targetChannelId}`);
        }

        const guildId = msg.guildId;
        if (!guildId) {
            log("ERROR", "Could not determine guild ID");
            await msg.reply("**Error:** Could not determine guild ID.");
            return;
        }

        try {
            await streamer.joinVoice(guildId, targetChannelId);
            log("INFO", `Successfully joined voice channel: ${targetChannelId}`);

            const guild = msg.guild;
            if (guild) {
                const voiceChannel = guild.channels.cache.get(targetChannelId);
                if (voiceChannel && voiceChannel instanceof StageChannel) {
                    log("INFO", "Stage channel detected - enabling audio");
                    await streamer.client.user?.voice?.setSuppressed(false);
                }
            }

            controller247?.abort();
            
            is247Mode = true;
            currentVideoIndex = startVideoId;
            controller247 = new AbortController();
            
            log("INFO", "Stream mode activated - video will play continuously");

            const videoPlaylist = getVideoPlaylist();
            if (videoPlaylist.length === 0) {
                log("ERROR", "No video files found in Video directory");
                await msg.reply("**Error:** No video files found in Video directory. Please add some `video<number>.mp4` files.");
                return;
            }
            
            if (startVideoId >= videoPlaylist.length) {
                await msg.reply(`**Error:** Video ID ${startVideoId + 1} is out of range. Only ${videoPlaylist.length} videos found.`);
                return;
            }
            
            log("INFO", `Starting stream mode with playlist system`);
            log("INFO", `Playlist contains ${videoPlaylist.length} videos`);
            log("INFO", `Starting with video ${startVideoId + 1}: ${videoPlaylist[startVideoId]}`);

            log("INFO", `Stream settings: ${config.streamOpts.width}x${config.streamOpts.height} @ ${config.streamOpts.fps}fps, ${config.streamOpts.bitrateKbps}kbps`);

            await msg.reply(`**🎬 Stream Mode Activated!**\n📁 Found ${videoPlaylist.length} videos\n🎥 Starting with: ${videoPlaylist[startVideoId].split('\\').pop()?.split('/').pop()} (ID: ${startVideoId + 1})\n⚙️ Settings: ${config.streamOpts.width}x${config.streamOpts.height} @ ${config.streamOpts.fps}fps`);

            start247Stream();
        } catch (error) {
            log("ERROR", `Failed to join voice channel ${targetChannelId}: ${error instanceof Error ? error.message : String(error)}`);
            await msg.reply(`**Error:** Failed to join voice channel: ${error instanceof Error ? error.message : String(error)}`);
        }
        
    } else if (msg.content.startsWith("*disconnect")) {
        lastCommandMessage = msg;
        log("INFO", `Disconnect requested by ${msg.author.tag} (${msg.author.id})`);
        is247Mode = false;
        controller247?.abort();
        streamer.leaveVoice();
        log("INFO", "Stream mode stopped and disconnected from voice channel");
        await msg.reply("**Stream Mode Stopped**\nAll videos have been stopped and bot has disconnected from voice channel.");
        
    } else if (msg.content.startsWith("*status")) {
        lastCommandMessage = msg;
        if (is247Mode) {
            const videoPlaylist = getVideoPlaylist();
            if (videoPlaylist.length > 0) {
                log("INFO", `Status requested by ${msg.author.tag} (${msg.author.id}) - Stream mode is ACTIVE`);
            log("INFO", `Currently playing video ${currentVideoIndex + 1}/${videoPlaylist.length}: ${videoPlaylist[currentVideoIndex]}`);
            log("INFO", `Next video: ${videoPlaylist[(currentVideoIndex + 1) % videoPlaylist.length]}`);
                
                const currentVideoName = videoPlaylist[currentVideoIndex].split('\\').pop()?.split('/').pop() || 'Unknown';
                const nextVideoName = videoPlaylist[(currentVideoIndex + 1) % videoPlaylist.length].split('\\').pop()?.split('/').pop() || 'Unknown';
                
                await msg.reply(`**📊 Stream Status: ACTIVE**\n🎥 Currently playing: **${currentVideoName}** (${currentVideoIndex + 1}/${videoPlaylist.length})\n⏭️ Next video: **${nextVideoName}**\n📁 Total videos: ${videoPlaylist.length}`);
            } else {
                log("INFO", `Status requested by ${msg.author.tag} (${msg.author.id}) - Stream mode is ACTIVE but no videos found`);
                await msg.reply("**Stream Status: ACTIVE but NO VIDEOS FOUND**\nPlease add some `video<number>.mp4` files to the Video folder.");
            }
        } else {
            log("INFO", `Status requested by ${msg.author.tag} (${msg.author.id}) - Stream mode is INACTIVE`);
            await msg.reply("**📊 Stream Status: INACTIVE**\nNo videos are currently playing.");
        }
        
    } else if (msg.content.startsWith("*fix-videos")) {
        lastCommandMessage = msg;
        log("INFO", `Fix videos requested by ${msg.author.tag} (${msg.author.id})`);
        log("INFO", `This will re-encode your video files to fix compatibility issues`);
        
        await msg.reply("**Video Fix Started**\nRe-encoding videos to fix compatibility issues...\nThis may take a while depending on video size.");
        
        const video1Path = join(process.cwd(), "Video", "Video1.mp4");
        const video1FixedPath = join(process.cwd(), "Video", "Video1-fixed.mp4");
        
        if (existsSync(video1Path)) {
            log("INFO", `Re-encoding Video1.mp4 to fix compatibility...`);
            const encodeProcess1 = spawn('ffmpeg', [
                '-i', video1Path,
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-preset', 'fast',
                '-y',
                video1FixedPath
            ], { stdio: 'pipe' });
            
            encodeProcess1.stderr.on('data', (data: any) => {
                log("INFO", `FFmpeg: ${data.toString().trim()}`);
            });
            
            encodeProcess1.on('close', (code: number) => {
                if (code === 0) {
                    log("INFO", `Video1.mp4 successfully re-encoded to Video1-fixed.mp4`);
                    if (lastCommandMessage) {
                        lastCommandMessage.reply("**Video1.mp4** successfully re-encoded to **Video1-fixed.mp4**");
                    }
                } else {
                    log("ERROR", `Failed to re-encode Video1.mp4 (exit code: ${code})`);
                    if (lastCommandMessage) {
                        lastCommandMessage.reply("**Failed to re-encode Video1.mp4** (exit code: " + code + ")");
                    }
                }
            });
        }
        
        const video2Path = join(process.cwd(), "Video", "Video2.mp4");
        const video2FixedPath = join(process.cwd(), "Video", "Video2-fixed.mp4");
        
        if (existsSync(video2Path)) {
            log("INFO", `Re-encoding Video2.mp4 to fix compatibility...`);
            const encodeProcess2 = spawn('ffmpeg', [
                '-i', video2Path,
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-preset', 'fast',
                '-y',
                video2FixedPath
            ], { stdio: 'pipe' });
            
            encodeProcess2.stderr.on('data', (data: any) => {
                log("INFO", `FFmpeg: ${data.toString().trim()}`);
            });
            
            encodeProcess2.on('close', (code: number) => {
                if (code === 0) {
                    log("INFO", `Video2.mp4 successfully re-encoded to Video2-fixed.mp4`);
                    if (lastCommandMessage) {
                        lastCommandMessage.reply("**Video2.mp4** successfully re-encoded to **Video2-fixed.mp4**");
                    }
                } else {
                    log("ERROR", `Failed to re-encode Video2.mp4 (exit code: ${code})`);
                    if (lastCommandMessage) {
                        lastCommandMessage.reply("**Failed to re-encode Video2.mp4** (exit code: " + code + ")");
                    }
                }
            });
        }
        
    } else if (msg.content.startsWith("*help")) {
        lastCommandMessage = msg;
        log("INFO", `Help requested by ${msg.author.tag} (${msg.author.id})`);
        
        const helpMessage = `**🎬 24/7 Video Bot - Help Menu**

**📋 Available Commands:**

**🎥 *stream** - Start stream mode in your current voice channel
**🎥 *stream <channel_id>** - Start stream mode in specific channel
**🎥 *stream <channel_id> <video_id>** - Start stream mode in specific channel with specific video

**⏹️ *disconnect** - Stop stream mode and disconnect from voice channel
**⏭️ *skip** - Skip/restart current video
**📊 *status** - Check current stream status and video info
**🔧 *fix-videos** - Fix video compatibility issues
**❓ *help** - Show this help menu

**📖 Usage Examples:**
• \`*stream\` - Start in your current voice channel
• \`*stream 123456789\` - Start in channel 123456789
• \`*stream 123456789 3\` - Start in channel 123456789, begin with video3.mp4
• \`*disconnect\` - Stop all videos and disconnect
• \`*skip\` - Skip/restart current video
• \`*status\` - Check what's currently playing

**📁 Video System:**
• Videos are automatically detected from the \`Video\` folder
• Use naming format: \`video1.mp4\`, \`video2.mp4\`, \`video3.mp4\`, etc.
• Videos play in numerical order and loop continuously
• Missing video numbers are automatically skipped

**⚙️ Features:**
• Automatic video detection and playlist creation
• FFmpeg compatibility testing
• Error handling and auto-restart
• Discord status notifications
• Hardware acceleration support
• Video skipping and restart functionality
• Clean video transitions

**💡 Tips:**
• Make sure your videos are in MP4 format
• Use sequential numbering for predictable playback order
• The bot will automatically skip corrupted or missing videos
• Check \`*status\` to see current playlist and progress
• Use \`*skip\` to restart the current video if you want to see it again`;

        await msg.reply(helpMessage);
        
    } else if (msg.content.startsWith("*skip")) {
        lastCommandMessage = msg;
        
        if (!is247Mode) {
            await msg.reply("**❌ Error:** 24/7 mode is not active. Start it first with `*stream`.");
            return;
        }
        
        log("INFO", `Skip requested by ${msg.author.tag} (${msg.author.id})`);
        
        await msg.reply("**⏭️ Skipping current video...**\n*Restarting video stream*");
        
        if (controller247) {
            controller247.abort();
            controller247 = new AbortController();
        }
        
        isStreamStarting = false;
        
        setTimeout(() => start247Stream(), 1000);
    }
});

log("INFO", "Attempting to login with Discord...");
const token = process.env.TOKEN;
if (!token) {
    log("ERROR", "Discord token not found in environment variables (TOKEN). Exiting...");
    process.exit(1);
}
streamer.client.login(token)
    .then(() => log("INFO", "Login successful"))
    .catch((error) => log("ERROR", `Login failed: ${error.message || error}`));
