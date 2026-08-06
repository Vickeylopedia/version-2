/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Audius Feed Bot — Account 2 Engine (Dual Telegram Notification System)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'http';
import { sdk } from '@audius/sdk';
import { Wallet } from 'ethers';

// ─── Unhandled Exception Safety Net ─────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

let isStartupNotificationSent = false;
let isInitialRun = true;
let activeDiscoveryNode = 'https://discoveryprovider.audius.co';
let audiusSdk = null;

// Track active bot messages & skipped tracks
const sentTelegramMessageIds = [];
const pendingSkips = new Set(); // Stores tracks flagged for skip by user

// ─── Render RAM Protection System ──────────────────────────────────────────
setInterval(() => {
  const memory = process.memoryUsage();
  const heapUsedMb = (memory.heapUsed / 1024 / 1024).toFixed(2);
  const rssMb = (memory.rss / 1024 / 1024).toFixed(2);

  if (global.gc && memory.heapUsed > 300 * 1024 * 1024) {
    console.log(`[RAM] 🧹 Triggering GC. Heap: ${heapUsedMb}MB | RSS: ${rssMb}MB`);
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
  // Primary Bot (Main Controller & Executor — Phone 1)
  TELEGRAM_BOT_TOKEN: '8706784155:AAGj2Q8RU6DFU4MJk4oiFgfDuvxpiMasJ7s',
  TELEGRAM_CHAT_ID:   '5876482404',

  // Secondary Bot (Notifier Only — Phone 2)
  NOTIFIER_BOT_TOKEN: '7640572608:AAF9Q3ufDvqshy3RtJ1CkLAdVu5jcNeYCNk',
  NOTIFIER_CHAT_ID:   '7776788573',

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
  debug:(msg) => console.log(`  [${new Date().toLocaleTimeString()}]  🔍  ${msg}`),
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
    if (!privateKey) {
      log.error(`Missing AUDIUS_PRIVATE_KEY environment variable!`);
      return false;
    }

    const cleanHex = String(privateKey).replace(/^0x/, '').trim();
    if (cleanHex.length !== 64) {
      log.error(`Invalid AUDIUS_PRIVATE_KEY length (${cleanHex.length} chars). Expected 64 hex characters.`);
      return false;
    }

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
    if (typeof audius.tracks.unrepostTrack === 'function') {
      await audius.tracks.unrepostTrack({
        trackId: trackId,
        userId: CONFIG.AUDIUS_USER_ID,
      });
      return true;
    } else if (typeof audius.tracks.undorepostTrack === 'function') {
      await audius.tracks.undorepostTrack({
        trackId: trackId,
        userId: CONFIG.AUDIUS_USER_ID,
      });
      return true;
    } else {
      const res = await fetch(`${activeDiscoveryNode}/v1/tracks/${trackId}/repost?app_name=${CONFIG.APP_NAME}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      return res.ok;
    }
  } catch (err) {
    log.error(`SDK Unrepost Error on track ${trackId}: ${err.message}`);
    return false;
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

// ─── Telegram Helpers & Secondary Notifier Support ─────────────────────────

async function sendSecondaryNotifierAlert(htmlText) {
  const token = CONFIG.NOTIFIER_BOT_TOKEN;
  const chatId = CONFIG.NOTIFIER_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
  } catch (err) {
    console.error(`Secondary Telegram Send Error: ${err.message}`);
  }
}

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
    log.info(`🧹 Auto-cleaned ${messagesToDelete.length} old Telegram messages.`);
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
    return null;
  } catch (err) {
    console.error(`Telegram Send Error: ${err.message}`);
    return null;
  }
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

async function pollTelegramUpdates(processedSet) {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const targetChatId = String(CONFIG.TELEGRAM_CHAT_ID);
  if (!token || !targetChatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=2`);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);

      // Handle Callback Buttons (Skip & Permanent Undo)
      if (update.callback_query) {
        const query = update.callback_query;
        const dataStr = query.data;

        if (dataStr && dataStr.startsWith('skip:')) {
          const trackIdToSkip = dataStr.replace('skip:', '');
          pendingSkips.add(trackIdToSkip);
          await answerCallbackQuery(query.id, '⏭️ Track skip requested!');
          log.info(`⏭️ Skip button clicked for track ID: ${trackIdToSkip}`);
        } else if (dataStr && dataStr.startsWith('undo:')) {
          const trackIdToUndo = dataStr.replace('undo:', '');
          await answerCallbackQuery(query.id, '⏳ Processing Undo (Unlike & Unrepost)...');
          log.info(`↩️ Undo requested for track ID: ${trackIdToUndo}`);

          // Execute Unlike & Unrepost
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

      // Handle Text Commands
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
        saveCache(processedSet);
        await sendTelegramAlert('🗑️ <b>Bot 2 Cache Cleared!</b> — Re-scanning feed items now...', true);
      } else if (text.startsWith('/status')) {
        const msgStr =
          `📊 <b>Audius Bot 2 Status</b>\n\n` +
          `<b>State:</b> ${isBotActive ? '🟢 Active' : '🔴 Paused'}\n` +
          `<b>Discovery Node:</b> <code>${escapeHtml(activeDiscoveryNode)}</code>\n` +
          `<b>Auto-Like:</b> ${actionToggles.likeEnabled ? '✅' : '❌'}\n` +
          `<b>Auto-Repost:</b> ${actionToggles.repostEnabled ? '✅' : '❌'}\n\n` +
          `🎵 <b>Latest Track in Feed:</b>\n• <i>${escapeHtml(latestSeenTrackName)}</i>\n\n` +
          `📈 <b>Stats:</b>\n• <b>Cached Tracks:</b> ${processedSet.size}\n• <b>System Uptime:</b> ${getUptime()}`;
        await sendTelegramAlert(msgStr, true);
      }
    }
  } catch {}
}

function startTelegramPoller(processedSet) {
  setInterval(() => pollTelegramUpdates(processedSet), 2000);
}

// ─── Feed Extractor & Cache ────────────────────────────────────────────────

async function fetchFeedAPI() {
  const feedUrl = `${activeDiscoveryNode}/v1/users/${CONFIG.AUDIUS_USER_ID}/feed?limit=5&app_name=${CONFIG.APP_NAME}`;
  
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

function loadCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, 'utf-8'));
      if (Array.isArray(data.processedTrackIds)) return new Set(data.processedTrackIds);
    }
  } catch {}
  return new Set();
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
  const processedSet = loadCache();
  
  await selectDiscoveryNode();
  startTelegramPoller(processedSet);

  if (!isStartupNotificationSent) {
    isStartupNotificationSent = true;
    await sendTelegramAlert('🚀 <b>Audius Feed Bot 2 Online</b> — Live with Skip, Permanent Undo & Dual Notifier.', true);
    await sendSecondaryNotifierAlert('🚀 <b>Feed Notifier Connected</b> — Ready to report new feed tracks.');
  }

  log.info(`Monitoring Account 2 feed every ${CONFIG.REFRESH_INTERVAL_MS / 1000}s…`);

  while (true) {
    if (isBotActive) {
      const tracks = await fetchFeedAPI();

      if (tracks.length > 0) {
        latestSeenTrackName = `${tracks[0].artist} - ${tracks[0].title}`;
      }

      if (isInitialRun) {
        log.info('📌 Initializing baseline... Marking current feed tracks as seen.');
        for (const track of tracks) {
          processedSet.add(track.permalink);
        }
        saveCache(processedSet);
        isInitialRun = false;
        await sleep(CONFIG.REFRESH_INTERVAL_MS);
        continue;
      }

      for (const track of tracks) {
        const permalink = track.permalink;
        const artistAndTitle = `${track.artist} - ${track.title}`;
        const safeTitle = escapeHtml(track.title);
        const safeArtist = escapeHtml(track.artist);
        const trackUrl = `https://audius.co${permalink}`;

        if (processedSet.has(permalink)) continue;

        // 1. Immediately Dispatch Alert Card to your Second Phone (Notifier Bot)
        const secondaryNotificationCard =
          `🎵 <b>New Feed Track Detected!</b>\n\n` +
          `<b>Song Title:</b> <a href="${trackUrl}">${safeTitle}</a>\n` +
          `<b>Artist:</b> <code>${safeArtist}</code>\n\n` +
          `📊 <b>Initial Stats:</b>\n` +
          `❤️ <b>Likes:</b> ${track.favorite_count}\n` +
          `🔁 <b>Reposts:</b> ${track.repost_count}`;

        await sendSecondaryNotifierAlert(secondaryNotificationCard);

        // 2. Threshold Check
        if (track.favorite_count >= CONFIG.MAX_LIKES_THRESHOLD || track.repost_count >= CONFIG.MAX_REPOSTS_THRESHOLD) {
          log.warn(`Threshold reached on "${artistAndTitle}". Skipping.`);
          processedSet.add(permalink);
          saveCache(processedSet);
          continue;
        }

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

        log.info(`⚡ Executing actions on: "${artistAndTitle}"`);

        // Execute Like & Repost Actions directly
        const [liked, reposted] = await Promise.all([
          actionToggles.likeEnabled ? apiLikeTrack(track.id) : Promise.resolve(false),
          actionToggles.repostEnabled ? apiRepostTrack(track.id) : Promise.resolve(false)
        ]);

        processedSet.add(permalink);
        saveCache(processedSet);

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
          `• Liked: ${actionToggles.likeEnabled ? (liked ? '✅' : '⚠️') : '⏭️'}\n` +
          `• Reposted: ${actionToggles.repostEnabled ? (reposted ? '✅' : '⚠️') : '⏭️'}`;

        if (countdownMsgId) {
          await editTelegramMessage(countdownMsgId, completedCard, undoButtonKeyboard);
        } else {
          await sendTelegramAlert(completedCard, false, undoButtonKeyboard);
        }

        log.ok(`Successfully processed "${artistAndTitle}"`);
      }
    }

    await sleep(CONFIG.REFRESH_INTERVAL_MS);
  }
}

runFastLoop();