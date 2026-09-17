/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Audius Feed Bot — Account 2 Engine
 * ═══════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'http';
import { sdk } from '@audius/sdk';
import { Wallet } from 'ethers';

// ─── Crash Prevention Safety Nets ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason?.message || reason);
});

let isStartupNotificationSent = false;
let activeDiscoveryNode = 'https://discoveryprovider.audius.co';
let audiusSdk = null;

// Track active bot messages & skipped tracks
const sentTelegramMessageIds = [];
const pendingSkips = new Set(); // Stores tracks flagged for skip by user

// Queues & Activity Tracker
const streamingQueue = []; // Tracks queued for background streaming

// ─── Render RAM Protection System ──────────────────────────────────────────
setInterval(() => {
  const memory = process.memoryUsage();
  if (global.gc && memory.heapUsed > 250 * 1024 * 1024) {
    console.log(`[RAM] 🧹 Triggering GC. Heap: ${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
    global.gc();
  }
}, 30_000);

// ─── Keep-Alive Server for Render ─────────────────────────────────────────
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Audius Fast Bot 2 is running!\n');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Server active on port ${PORT}`);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Configuration ────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // Primary Bot (Main Controller & Executor)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8706784155:AAGj2Q8RU6DFU4MJk4oiFgfDuvxpiMasJ7s',
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID || '5876482404',

  AUDIUS_USER_ID:     process.env.AUDIUS_USER_ID || 'ygvzYM4',
  APP_NAME:           process.env.AUDIUS_APP_NAME || 'audius-client',
  
  AUDIUS_API_KEY:      process.env.AUDIUS_API_KEY || 'd30faf377491796757ef4c1b0cca8a407920e663',
  AUDIUS_API_SECRET:   process.env.AUDIUS_API_SECRET || 'c827b34952ebb827c16ff35c52be18d60197afa3946d43420699d23224dea335',
  AUDIUS_BEARER_TOKEN: process.env.AUDIUS_BEARER_TOKEN || 'dMmhd_MX9e3ytbAZmTKW9fnVAcSBppfasGiz-sIHYyc=',
  CACHE_FILE:          path.join(__dirname, 'cache_acc2.json'),

  REFRESH_INTERVAL_MS: 5_000,
  MIN_ACTION_DELAY_SEC: 3,
  MAX_ACTION_DELAY_SEC: 10,

  MAX_LIKES_THRESHOLD: 10,
  MAX_REPOSTS_THRESHOLD: 10,
  MAX_DURATION_SEC: 300,       // 5 Minutes Max Track Duration

  LIKE_PROBABILITY: 0.80,      // 80% Chance to Like
  REPOST_PROBABILITY: 1.00     // 100% Chance to Repost
});

let isBotActive = true;
let lastUpdateId = 0;
let latestSeenTrackName = "None detected yet";
const startTime = Date.now();
const actionToggles = { likeEnabled: true, repostEnabled: true };

const getRandomDelaySec = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getUptime() {
  const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const log = {
  info: (msg) => console.log(`  [${new Date().toLocaleTimeString()}]  ℹ️  ${msg}`),
  ok:   (msg) => console.log(`  [${new Date().toLocaleTimeString()}]  ✅  ${msg}`),
  warn: (msg) => console.log(`  [${new Date().toLocaleTimeString()}]  ⚠️  ${msg}`),
  error:(msg) => console.error(`  [${new Date().toLocaleTimeString()}]  ❌  ${msg}`),
};

// ─── Audius SDK Initialization ─────────────────────────────────────────────

function getAudiusSDK() {
  if (!audiusSdk) {
    audiusSdk = sdk({
      apiKey: CONFIG.AUDIUS_API_KEY,
      apiSecret: CONFIG.AUDIUS_API_SECRET,
      bearerToken: CONFIG.AUDIUS_BEARER_TOKEN,
    });
  }
  return audiusSdk;
}

// ─── Fast Action Runners & Undo Handlers ──────────────────────────────────

async function sendAudiusSignedAction(trackId, actionType) {
  try {
    const privateKey = process.env.AUDIUS_PRIVATE_KEY;
    if (!privateKey) return false;

    const cleanHex = String(privateKey).replace(/^0x/, '').trim();
    if (cleanHex.length !== 64) return false;

    const wallet = new Wallet(`0x${cleanHex}`);
    const timestamp = Math.floor(Date.now() / 1000);

    const messageToSign = `action:${actionType}:track:${trackId}:timestamp:${timestamp}`;
    const signature = await wallet.signMessage(messageToSign);

    const response = await fetch(`https://identityservice.audius.co/tracks/${trackId}/${actionType}`, {
      method: actionType.startsWith('un') ? 'DELETE' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': CONFIG.AUDIUS_USER_ID,
      },
      body: JSON.stringify({
        userId: CONFIG.AUDIUS_USER_ID,
        trackId: trackId,
        timestamp: timestamp,
        signature: signature,
        publicKey: wallet.address,
      }),
    });

    return response.ok;
  } catch (err) {
    log.error(`Signed ${actionType} Exception on ${trackId}: ${err.message}`);
    return false;
  }
}

async function apiLikeTrack(trackId) {
  if (process.env.AUDIUS_PRIVATE_KEY) {
    return await sendAudiusSignedAction(trackId, 'favorite');
  }

  try {
    const audius = getAudiusSDK();
    await audius.tracks.favoriteTrack({
      trackId: trackId,
      userId: CONFIG.AUDIUS_USER_ID,
    });
    return true;
  } catch (err) {
    log.error(`SDK Like Error on track ${trackId}: ${err.message}`);
    return false;
  }
}

async function apiUnlikeTrack(trackId) {
  if (process.env.AUDIUS_PRIVATE_KEY) {
    return await sendAudiusSignedAction(trackId, 'unfavorite');
  }

  try {
    const audius = getAudiusSDK();
    await audius.tracks.unfavoriteTrack({
      trackId: trackId,
      userId: CONFIG.AUDIUS_USER_ID,
    });
    return true;
  } catch (err) {
    log.error(`SDK Unlike Error on track ${trackId}: ${err.message}`);
    return false;
  }
}

async function apiRepostTrack(trackId) {
  if (process.env.AUDIUS_PRIVATE_KEY) {
    return await sendAudiusSignedAction(trackId, 'repost');
  }

  try {
    const audius = getAudiusSDK();
    await audius.tracks.repostTrack({
      trackId: trackId,
      userId: CONFIG.AUDIUS_USER_ID,
    });
    return true;
  } catch (err) {
    log.error(`SDK Repost Error on track ${trackId}: ${err.message}`);
    return false;
  }
}

async function apiUnrepostTrack(trackId) {
  if (process.env.AUDIUS_PRIVATE_KEY) {
    return await sendAudiusSignedAction(trackId, 'unrepost');
  }

  try {
    const audius = getAudiusSDK();
    await audius.tracks.undorepostTrack({
      trackId: trackId,
      userId: CONFIG.AUDIUS_USER_ID,
    });
    return true;
  } catch (err) {
    log.error(`SDK Unrepost Error on track ${trackId}: ${err.message}`);
    return false;
  }
}

// ─── Headless Audio Streaming & Idle Queue Worker ─────────────────────────

async function performHeadlessStream(trackId, durationSec) {
  try {
    const streamUrl = `${activeDiscoveryNode}/v1/tracks/${trackId}/stream?app_name=${CONFIG.APP_NAME}`;
    log.info(`🎧 Initiating background audio stream on track ${trackId} for ${durationSec}s...`);

    const controller = new AbortController();

    // Fire stream request in background
    fetch(streamUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Audius-Client/2.0' }
    }).catch(() => {});

    // Stream for durationSec, monitoring if bot is paused or queue reset
    for (let i = 0; i < durationSec; i++) {
      if (!isBotActive || streamingQueue.length === 0 || streamingQueue[0]?.id !== trackId) {
        controller.abort();
        log.info(`⏸️ Streaming task interrupted for track ${trackId}.`);
        return false;
      }
      await sleep(1000);
    }

    controller.abort();
    return true;
  } catch {
    return true;
  }
}

async function processStreamingQueue(processedSet) {
  if (streamingQueue.length === 0) return;

  const track = streamingQueue[0];

  const artistAndTitle = `${track.artist} - ${track.title}`;
  const trackUrl = `https://audius.co${track.permalink}`;

  // Calculate random 30% to 60% stream duration (realistic listening session)
  const pct = Math.floor(Math.random() * 31) + 30; // Random int from 30 to 60
  const streamDurationSec = Math.floor((track.duration || 180) * (pct / 100));

  log.info(`▶️ Idle Task: Streaming "${artistAndTitle}" (${pct}% = ${streamDurationSec}s)...`);

  const completed = await performHeadlessStream(track.id, streamDurationSec);

  // Check if queue item changed or was cleared mid-stream
  if (streamingQueue.length === 0 || streamingQueue[0].id !== track.id) {
    return;
  }

  streamingQueue.shift();
  saveCache(processedSet);

  if (completed) {
    const streamCard =
      `🎧 <b>Background Stream Complete! (Bot 2)</b>\n\n` +
      `🎵 <b>Track:</b> <a href="${trackUrl}">${escapeHtml(artistAndTitle)}</a>\n` +
      `⏱️ <b>Streamed:</b> <code>${streamDurationSec}s</code> (${pct}% of track)`;

    await sendTelegramAlert(streamCard);
  }
}

// ─── Dynamic Discovery Node Selector ───────────────────────────────────────

async function selectDiscoveryNode() {
  try {
    const res = await fetch('https://api.audius.co');
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json.data) && json.data.length > 0) {
        const hosts = json.data;
        activeDiscoveryNode = hosts[Math.floor(Math.random() * hosts.length)];
        log.ok(`Selected live Discovery Node: ${activeDiscoveryNode}`);
        return;
      }
    }
  } catch (err) {
    log.warn(`Could not fetch node list: ${err.message}. Using fallback node.`);
  }
}

// ─── Telegram Helpers ──────────────────────────────────────────────────────

async function deleteTelegramMessage(messageId) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = CONFIG.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !messageId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch {}
}

async function cleanUpOldTelegramMessages() {
  if (sentTelegramMessageIds.length >= 20) {
    const messagesToDelete = sentTelegramMessageIds.splice(0, 18);
    for (const msgId of messagesToDelete) {
      await deleteTelegramMessage(msgId);
      await sleep(150);
    }
  }
}

async function sendTelegramAlert(htmlText, includeMenu = false, inlineKeyboard = null) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = CONFIG.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;

  const payload = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  };

  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  } else if (includeMenu) {
    payload.reply_markup = {
      keyboard: [
        [{ text: '/start_bot' }, { text: '/stop_bot' }],
        [{ text: '/active' }, { text: '/status' }],
        [{ text: '/toggle_like' }, { text: '/toggle_repost' }],
        [{ text: '/clear_cache' }]
      ],
      resize_keyboard: true,
      persistent: true,
    };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok && data.result?.message_id) {
        const newMsgId = data.result.message_id;
        sentTelegramMessageIds.push(newMsgId);
        await cleanUpOldTelegramMessages();
        return newMsgId;
      }
      break;
    } catch (err) {
      if (attempt < 3) await sleep(2000);
    }
  }
  return null;
}

async function editTelegramMessage(messageId, htmlText, inlineKeyboard = null) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = CONFIG.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !messageId) return;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: htmlText,
    parse_mode: 'HTML',
  };

  if (inlineKeyboard !== null) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`Telegram Edit Error: ${err.message}`);
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  if (!token || !callbackQueryId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: false }),
    });
  } catch {}
}

async function registerTelegramMenu() {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'active', description: '🟢 Check active status & top track' },
          { command: 'start_bot', description: '▶️ Resume feed monitoring' },
          { command: 'stop_bot', description: '⏸️ Pause feed monitoring' },
          { command: 'toggle_like', description: '❤️ Toggle Auto-Like ON/OFF' },
          { command: 'toggle_repost', description: '🔁 Toggle Auto-Repost ON/OFF' },
          { command: 'status', description: '📊 View live bot status' },
          { command: 'clear_cache', description: '🗑️ Reset cache & stream queue' },
        ],
      }),
    });
    log.ok('Telegram command menu registered.');
  } catch {}
}

async function pollTelegramUpdates(processedSet) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const targetChatId = String(CONFIG.TELEGRAM_CHAT_ID);
  if (!token || !targetChatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);

      if (update.callback_query) {
        const query = update.callback_query;
        const dataStr = query.data;

        if (dataStr && dataStr.startsWith('skip:')) {
          const trackIdToSkip = dataStr.replace('skip:', '');
          pendingSkips.add(trackIdToSkip);
          await answerCallbackQuery(query.id, '⏭️ Track skip requested!');
        } else if (dataStr && dataStr.startsWith('undo:')) {
          const trackIdToUndo = dataStr.replace('undo:', '');
          await answerCallbackQuery(query.id, '⏳ Processing Undo...');

          const [unliked, unreposted] = await Promise.all([
            apiUnlikeTrack(trackIdToUndo),
            apiUnrepostTrack(trackIdToUndo)
          ]);

          const undoResultCard = 
            `↩️ <b>Actions Reversed (Bot 2)</b>\n\n` +
            `<b>Track ID:</b> <code>${trackIdToUndo}</code>\n` +
            `<b>Results:</b>\n` +
            `• Unliked: ${unliked ? '✅' : '⚠️'}\n` +
            `• Unreposted: ${unreposted ? '✅' : '⚠️'}`;

          if (query.message?.message_id) {
            await editTelegramMessage(query.message.message_id, undoResultCard, []);
          }
        }
        continue;
      }

      const msg = update.message || update.edited_message;
      if (!msg || !msg.text || String(msg.chat?.id) !== targetChatId) continue;

      const text = msg.text.trim();
      if (text.startsWith('/active')) {
        const activeStr = `🟢 <b>Bot 2 Active</b>\n\n🎵 <b>Top Track:</b> <i>${escapeHtml(latestSeenTrackName)}</i>`;
        await sendTelegramAlert(activeStr, true);
      } else if (text.startsWith('/start_bot')) {
        isBotActive = true;
        await sendTelegramAlert('▶️ <b>Audius Bot 2 Resumed</b> — Monitoring active.', true);
      } else if (text.startsWith('/stop_bot')) {
        isBotActive = false;
        await sendTelegramAlert('⏸️ <b>Audius Bot 2 Paused</b> — Feed monitoring held.', true);
      } else if (text.startsWith('/toggle_like')) {
        actionToggles.likeEnabled = !actionToggles.likeEnabled;
        await sendTelegramAlert(`❤️ <b>Bot 2 Auto-Like:</b> ${actionToggles.likeEnabled ? 'ON ✅' : 'OFF ❌'}`, true);
      } else if (text.startsWith('/toggle_repost')) {
        actionToggles.repostEnabled = !actionToggles.repostEnabled;
        await sendTelegramAlert(`🔁 <b>Bot 2 Auto-Repost:</b> ${actionToggles.repostEnabled ? 'ON ✅' : 'OFF ❌'}`, true);
      } else if (text.startsWith('/clear_cache')) {
        processedSet.clear();
        streamingQueue.length = 0;
        saveCache(processedSet);
        await sendTelegramAlert('🗑️ <b>Bot 2 Cache Cleared!</b> — Re-scanning feed items now...', true);
      } else if (text.startsWith('/status')) {
        const msgStr =
          `📊 <b>Audius Bot 2 Status</b>\n\n` +
          `<b>State:</b> ${isBotActive ? '🟢 Active' : '🔴 Paused'}\n` +
          `<b>Discovery Node:</b> <code>${escapeHtml(activeDiscoveryNode)}</code>\n` +
          `<b>Auto-Like (80%):</b> ${actionToggles.likeEnabled ? '✅' : '❌'}\n` +
          `<b>Auto-Repost (100%):</b> ${actionToggles.repostEnabled ? '✅' : '❌'}\n\n` +
          `🎵 <b>Latest Track in Feed:</b>\n• <i>${escapeHtml(latestSeenTrackName)}</i>\n\n` +
          `📈 <b>Stats:</b>\n• <b>Cached Tracks:</b> ${processedSet.size}\n• <b>Streaming Queue:</b> ${streamingQueue.length}\n• <b>System Uptime:</b> ${getUptime()}`;
        await sendTelegramAlert(msgStr, true);
      }
    }
  } catch (err) {
    await sleep(3000);
  }
}

function startTelegramPoller(processedSet) {
  const poll = async () => {
    while (true) {
      await pollTelegramUpdates(processedSet);
      await sleep(1500);
    }
  };
  poll();
}

// ─── Feed Extractor & Cache ────────────────────────────────────────────────

async function fetchFeedAPI() {
  const feedUrl = `${activeDiscoveryNode}/v1/users/${CONFIG.AUDIUS_USER_ID}/feed?limit=10&app_name=${CONFIG.APP_NAME}`;
  
  try {
    const res = await fetch(feedUrl, { headers: { 'Accept': 'application/json' } });

    if (!res.ok) {
      log.error(`Feed fetch failed (${res.status}). Refreshing node...`);
      await selectDiscoveryNode();
      return [];
    }

    const json = await res.json();
    const items = json.data || [];

    const parsedTracks = [];
    for (const item of items) {
      const trackObj = item.activity_item || item.item || item.track || item;
      
      if (trackObj && (trackObj.id || trackObj.track_id)) {
        parsedTracks.push({
          id: trackObj.id || trackObj.track_id,
          title: trackObj.title || 'Untitled Track',
          artist: trackObj.user?.name || trackObj.user?.handle || 'Unknown Artist',
          permalink: trackObj.permalink || `/${trackObj.user?.handle || 'track'}/${trackObj.id || trackObj.track_id}`,
          favorite_count: trackObj.favorite_count || 0,
          repost_count: trackObj.repost_count || 0,
          duration: trackObj.duration || 180,
          activity_timestamp: item.activity_timestamp || trackObj.created_at || 0,
        });
      }
    }

    return parsedTracks;
  } catch (err) {
    log.error(`API Fetch Exception: ${err.message}`);
    return [];
  }
}

function saveCache(processedSet) {
  const arr = Array.from(processedSet);
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  try {
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify({ processedTrackIds: arr }, null, 2));
  } catch {}
}

// ─── Countdown with Interactive Skip ──────────────────────────────────────

async function runLiveCountdownInTelegram(artistAndTitle, trackUrl, delaySeconds, trackId) {
  const safeTitle = escapeHtml(artistAndTitle);
  
  const getCardText = (sec) =>
    `⏳ <b>New Track Detected! (Bot 2)</b>\n\n` +
    `🎵 <b>Track:</b> <a href="${trackUrl}">${safeTitle}</a>\n` +
    `⏱️ <b>Processing in:</b> <code>${sec}s</code>…`;

  const skipButtonKeyboard = [
    [{ text: '⏭️ Skip Track', callback_data: `skip:${trackId}` }]
  ];

  const msgId = await sendTelegramAlert(getCardText(delaySeconds), false, skipButtonKeyboard);

  for (let sec = delaySeconds; sec > 0; sec--) {
    if (pendingSkips.has(String(trackId))) {
      log.info(`⏭️ Interrupted countdown! Track skipped: "${artistAndTitle}"`);
      return { msgId, wasSkipped: true };
    }

    if (msgId) {
      await editTelegramMessage(msgId, getCardText(sec), skipButtonKeyboard);
    }
    await sleep(1000);
  }

  const wasSkipped = pendingSkips.has(String(trackId));
  return { msgId, wasSkipped };
}

// ─── Main Execution Loop ───────────────────────────────────────────────────

async function runFastLoop() {
  // Wipe cache and memory completely on startup to ensure instant scanning
  const processedSet = new Set();
  streamingQueue.length = 0;
  saveCache(processedSet);
  log.ok('🧹 Cache wiped on startup. Bot 2 will immediately process current feed.');

  await selectDiscoveryNode();
  await registerTelegramMenu();
  startTelegramPoller(processedSet);

  if (!isStartupNotificationSent) {
    isStartupNotificationSent = true;
    await sendTelegramAlert('🚀 <b>Audius Feed Bot Online</b> — Cache cleared & live monitoring active.', true);
  }

  log.info(`Monitoring Account 2 feed every ${CONFIG.REFRESH_INTERVAL_MS / 1000}s…`);

  while (true) {
    try {
      if (isBotActive) {
        const tracks = await fetchFeedAPI();

        if (tracks.length > 0) {
          latestSeenTrackName = `${tracks[0].artist} - ${tracks[0].title}`;
        }

        let newTrackProcessed = false;

        for (const track of tracks) {
          const permalink = track.permalink;
          const artistAndTitle = `${track.artist} - ${track.title}`;
          const safeTitle = escapeHtml(track.title);
          const safeArtist = escapeHtml(track.artist);
          const trackUrl = `https://audius.co${permalink}`;

          if (processedSet.has(permalink)) continue;

          // Skip if track duration exceeds 5 minutes (300 seconds)
          if (track.duration > CONFIG.MAX_DURATION_SEC) {
            log.warn(`Duration limit exceeded (${track.duration}s > 300s) on "${artistAndTitle}". Skipping.`);
            processedSet.add(permalink);
            saveCache(processedSet);
            continue;
          }

          // 1. If main bot execution is paused via /stop_bot, mark track as seen and skip actions
          if (!isBotActive) {
            processedSet.add(permalink);
            saveCache(processedSet);
            log.info(`⏸️ Main bot paused. Actions skipped for "${artistAndTitle}".`);
            continue;
          }

          // 2. Threshold Check
          if (track.favorite_count >= CONFIG.MAX_LIKES_THRESHOLD || track.repost_count >= CONFIG.MAX_REPOSTS_THRESHOLD) {
            log.warn(`Threshold reached on "${artistAndTitle}". Skipping.`);
            processedSet.add(permalink);
            saveCache(processedSet);
            continue;
          }

          newTrackProcessed = true;

          // 3. Countdown & Action Execution on Primary Bot
          const delaySeconds = getRandomDelaySec(CONFIG.MIN_ACTION_DELAY_SEC, CONFIG.MAX_ACTION_DELAY_SEC);
          log.info(`⏳ New track found: "${artistAndTitle}". Starting ${delaySeconds}s countdown…`);

          const { msgId: countdownMsgId, wasSkipped } = await runLiveCountdownInTelegram(artistAndTitle, trackUrl, delaySeconds, track.id);

          if (wasSkipped) {
            pendingSkips.delete(String(track.id));
            processedSet.add(permalink);
            saveCache(processedSet);

            const skippedCard = 
              `⏭️ <b>Track Skipped (Bot 2)</b>\n\n` +
              `<b>Track:</b> <a href="${trackUrl}">${escapeHtml(artistAndTitle)}</a>\n` +
              `<b>Status:</b> Skipped by user command. No actions taken.`;

            if (countdownMsgId) {
              await editTelegramMessage(countdownMsgId, skippedCard, []);
            }
            log.ok(`Skipped track execution for "${artistAndTitle}"`);
            continue;
          }

          // Action probabilities (80% Like Roll, 100% Repost Roll)
          const shouldLike = actionToggles.likeEnabled && Math.random() < CONFIG.LIKE_PROBABILITY;
          const shouldRepost = actionToggles.repostEnabled && Math.random() < CONFIG.REPOST_PROBABILITY;

          log.info(`⚡ Executing actions on: "${artistAndTitle}" (Like Roll: ${shouldLike}, Repost Roll: ${shouldRepost})`);

          const [liked, reposted] = await Promise.all([
            shouldLike ? apiLikeTrack(track.id) : Promise.resolve(false),
            shouldRepost ? apiRepostTrack(track.id) : Promise.resolve(false)
          ]);

          processedSet.add(permalink);
          saveCache(processedSet);

          // Queue for background streaming (newest items added to tail)
          streamingQueue.push(track);

          // Persistent Undo Inline Keyboard Button
          const undoButtonKeyboard = [
            [{ text: '↩️ Undo (Unlike & Unrepost)', callback_data: `undo:${track.id}` }]
          ];

          const completedCard =
            `🎵 <b>Track Successfully Processed! (Bot 2)</b>\n\n` +
            `<b>Track:</b> <a href="${trackUrl}">${escapeHtml(artistAndTitle)}</a>\n` +
            `<b>Stats:</b> ❤️ ${track.favorite_count} Likes | 🔁 ${track.repost_count} Reposts\n` +
            `<b>Waited:</b> ${delaySeconds}s\n\n` +
            `<b>Actions Taken:</b>\n` +
            `• Liked (80% Roll): ${shouldLike ? (liked ? '✅' : '⚠️') : '⏭️ (Rolled Off)'}\n` +
            `• Reposted (100% Roll): ${shouldRepost ? (reposted ? '✅' : '⚠️') : '⏭️'}\n\n` +
            `📌 <i>Added to Stream Queue (${streamingQueue.length} pending)</i>`;

          if (countdownMsgId) {
            await editTelegramMessage(countdownMsgId, completedCard, undoButtonKeyboard);
          } else {
            await sendTelegramAlert(completedCard, false, undoButtonKeyboard);
          }

          log.ok(`Successfully processed "${artistAndTitle}"`);
        }

        // If no new tracks were found in this check, process 1 item from idle streaming queue
        if (!newTrackProcessed) {
          await processStreamingQueue(processedSet);
        }
      }
    } catch (err) {
      log.error(`Main Loop Error: ${err.message}`);
    }

    await sleep(CONFIG.REFRESH_INTERVAL_MS);
  }
}

runFastLoop();