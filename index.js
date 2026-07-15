import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { existsSync, mkdirSync } from 'fs';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://srsukpjjnatjchskmxfk.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const AUTH_DIR      = process.env.AUTH_DIR || './auth_state';

if (!SUPABASE_KEY) {
  console.error('❌ SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const logger   = pino({ level: 'silent' }); // suppress Baileys internal logs

// ── KNOWN CHATS (filter to only save relevant messages) ───────────────────────
// Group chat keywords — we match by partial name since JIDs are numbers
const GROUP_KEYWORDS = [
  'sac & sailfish',
  'setia alam internal',
  'canopy & sailfish',
  'canopy sailfish internal',
  'club 360 x sailfish',
  '360 - sailfish internal',
  'sailfish operation',
  'sailfish internal',
];

// Known staff names
const STAFF = [
  'Abin', 'Arisya', 'Amin Razali', 'Amien',
  'Hakim', 'Norhakim', 'Hamizah', 'Winson', 'Amirah',
  'Jeslia', 'Michael', 'Dina', 'Navin', 'Zul',
  'Ethan', 'Aeman', 'Qistina', 'Madhu', 'Aliah',
  'Aqil', 'Aqilah', 'Ikin', 'Kokila', 'Nuqman',
  'Saiful', 'Sofiya', 'Danish',
];

// Map group name keywords to club
function detectClub(chatName) {
  const n = chatName.toLowerCase();
  if (n.includes('sac') || n.includes('setia alam')) return 'Setia Alam Club';
  if (n.includes('canopy'))                           return 'Canopy Club';
  if (n.includes('360'))                              return '360 Club';
  return 'Unknown';
}

// Should we save this message?
function isRelevantGroup(groupName) {
  const lower = groupName.toLowerCase();
  return GROUP_KEYWORDS.some(kw => lower.includes(kw));
}

// ── SAVE MESSAGE TO SUPABASE ──────────────────────────────────────────────────
async function saveMessage({ chatJid, chatName, senderJid, senderName, text, type, isGroup, timestamp }) {
  const club = isGroup ? detectClub(chatName) : 'Unknown';

  const { error } = await supabase.from('messages').insert({
    chat_jid:    chatJid,
    chat_name:   chatName,
    sender_jid:  senderJid,
    sender_name: senderName,
    message_text: text,
    message_type: type,
    is_group:    isGroup,
    club,
    timestamp:   new Date(timestamp * 1000).toISOString(),
  });

  if (error) {
    console.error(`[DB] Error saving message from ${senderName}:`, error.message);
  } else {
    const label = isGroup ? `[${chatName}]` : `[DM]`;
    console.log(`[✓] ${label} ${senderName}: ${text?.slice(0, 60) || type}`);
  }
}

// ── EXTRACT TEXT FROM MESSAGE ─────────────────────────────────────────────────
function extractMessage(msg) {
  const m = msg.message;
  if (!m) return null;

  if (m.conversation)                        return { text: m.conversation,                        type: 'text' };
  if (m.extendedTextMessage?.text)           return { text: m.extendedTextMessage.text,            type: 'text' };
  if (m.imageMessage?.caption)               return { text: `[Photo] ${m.imageMessage.caption}`,  type: 'image' };
  if (m.imageMessage)                        return { text: '[Photo]',                             type: 'image' };
  if (m.documentMessage?.caption)            return { text: `[Document] ${m.documentMessage.caption}`, type: 'document' };
  if (m.documentMessage)                     return { text: '[Document]',                          type: 'document' };
  if (m.videoMessage?.caption)               return { text: `[Video] ${m.videoMessage.caption}`,  type: 'video' };
  if (m.videoMessage)                        return { text: '[Video]',                             type: 'video' };
  if (m.audioMessage)                        return { text: '[Voice note]',                        type: 'audio' };
  if (m.stickerMessage)                      return { text: '[Sticker]',                           type: 'sticker' };
  if (m.reactionMessage)                     return null; // skip reactions
  if (m.protocolMessage)                     return null; // skip protocol
  return null;
}

// ── CONNECT TO WHATSAPP ───────────────────────────────────────────────────────
async function startBot() {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  console.log(`\n🐟 Sailfish WhatsApp Bot`);
  console.log(`   Baileys version: ${version.join('.')}`);
  console.log(`   Auth dir: ${AUTH_DIR}\n`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false, // we handle QR ourselves
    syncFullHistory: false,   // only receive new messages going forward
    markOnlineOnConnect: false,
  });

  // ── QR CODE ──────────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      qrcode.generate(qr, { small: true });
      console.log('\n📱 QR ready! Open this URL on your phone or computer to scan:');
      console.log('   https://sailfish-whatsapp-bot.onrender.com/qr\n');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[!] Connection closed (code ${code}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      } else {
        console.log('❌ Logged out. Delete auth_state folder and restart to re-pair.');
      }
    }

    if (connection === 'open') {
      currentQR = null;
      console.log('✅ WhatsApp connected!\n');
      console.log('📡 Listening for messages across all chats...');
      console.log('   (Only relevant Sailfish chats will be saved to Supabase)\n');
    }
  });

  // ── SAVE CREDENTIALS ─────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── INCOMING MESSAGES ─────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // only process real new messages

    for (const msg of messages) {
      if (msg.key.fromMe) continue;     // skip own messages
      if (!msg.message)   continue;     // skip empty

      const extracted = extractMessage(msg);
      if (!extracted) continue;

      const chatJid  = msg.key.remoteJid;
      const isGroup  = isJidGroup(chatJid);
      const senderJid = isGroup ? msg.key.participant : chatJid;

      // Get chat name
      let chatName = '';
      try {
        if (isGroup) {
          const meta = sock.groupMetadata ? await sock.groupMetadata(chatJid).catch(() => null) : null;
          chatName = meta?.subject || chatJid;
        } else {
          chatName = msg.pushName || senderJid?.split('@')[0] || 'Unknown';
        }
      } catch {
        chatName = chatJid;
      }

      // Filter: only save relevant group chats, or any individual chat
      if (isGroup && !isRelevantGroup(chatName)) {
        // Skip irrelevant groups silently
        continue;
      }

      const senderName = msg.pushName || senderJid?.split('@')[0] || 'Unknown';

      await saveMessage({
        chatJid,
        chatName,
        senderJid,
        senderName,
        text:      extracted.text,
        type:      extracted.type,
        isGroup,
        timestamp: msg.messageTimestamp,
      });
    }
  });
}

// ── HTTP SERVER — health check + QR code page ─────────────────────────────────
import { createServer } from 'http';
let currentQR = null; // set when QR is ready

createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>🐟 Sailfish WhatsApp Bot</h2>
        <p>No QR code yet — bot may already be connected, or still starting up.</p>
        <p><a href="/qr">Refresh</a></p>
      </body></html>`);
      return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f9f9f9">
        <h2>🐟 Sailfish WhatsApp Bot</h2>
        <p>Scan with WhatsApp → Linked Devices → Link a Device</p>
        <img src="${dataUrl}" style="border:4px solid #25D366;border-radius:12px;margin:20px auto;display:block"/>
        <p style="color:#888;font-size:13px">QR expires in ~60 seconds — refresh page if it doesn't scan</p>
        <p><a href="/qr">Refresh QR</a></p>
      </body></html>`);
    } catch (e) {
      res.writeHead(500); res.end('QR generation error: ' + e.message);
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'sailfish-whatsapp-bot', qrReady: !!currentQR, time: new Date().toISOString() }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`[Health] Server on port ${process.env.PORT || 3000}`);
  console.log(`[QR] Open https://sailfish-whatsapp-bot.onrender.com/qr to scan QR code`);
});

startBot();
