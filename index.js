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
import cron from 'node-cron';

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
      activeSock = sock;
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
        continue;
      }

      // Learn 360 group JID if not known yet
      if (isGroup) learnGroupJid(chatName, chatJid);

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

// ── OPERATION GROUPS ──────────────────────────────────────────────────────────
const OPERATION_GROUPS = [
  { name: 'SAC & Sailfish Operation Club',      jid: '120363415273290416@g.us', club: 'Setia Alam Club' },
  { name: 'Canopy & Sailfish Operations Club',  jid: '120363418448920703@g.us', club: 'Canopy Club' },
  { name: 'Club 360 x Sailfish Operation',      jid: null,                      club: 'Club 360' }, // JID added when first message arrives
];

// ── AUTO-LEARN GROUP JIDs ─────────────────────────────────────────────────────
// When a message arrives from a 360 group, save its JID
async function learnGroupJid(chatName, chatJid) {
  const group = OPERATION_GROUPS.find(g => !g.jid && chatName.toLowerCase().includes('360'));
  if (group) {
    group.jid = chatJid;
    console.log(`[Cron] Learned 360 group JID: ${chatJid}`);
  }
}

// ── FORMAT DAILY DRAFT MESSAGE ────────────────────────────────────────────────
function formatDraftMessage(club, tasks) {
  const today = new Date().toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });
  const completed = tasks.filter(t => t.status === 'completed');
  const pending   = tasks.filter(t => t.status === 'pending');
  const overdue   = tasks.filter(t => t.status === 'overdue');

  let msg = `🐟 *Sailfish Daily Ops — ${today}*\n`;
  msg += `📍 *${club}*\n\n`;

  if (completed.length) {
    msg += `✅ *Tasks Completed:*\n`;
    completed.forEach(t => msg += `• ${t.staff_name} — ${t.task_text}\n`);
    msg += '\n';
  }

  if (pending.length) {
    msg += `⏳ *Pending Tasks:*\n`;
    pending.forEach(t => msg += `• ${t.staff_name} — ${t.task_text}\n`);
    msg += '\n';
  }

  if (overdue.length) {
    msg += `🔴 *Overdue:*\n`;
    overdue.forEach(t => msg += `• ${t.staff_name} — ${t.task_text}\n`);
    msg += '\n';
  }

  if (!completed.length && !pending.length && !overdue.length) {
    msg += `_No tasks recorded yet. Run dashboard analysis to update._\n`;
  }

  msg += `\n_Sailfish Ops Dashboard · ${new Date().toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}_`;
  return msg;
}

// ── DAILY 8AM DRAFT ──────────────────────────────────────────────────────────
// Runs at 8:00am Malaysia time (UTC+8 = 00:00 UTC)
cron.schedule('0 0 * * *', async () => {
  console.log('[Cron] 8am — generating daily group drafts…');
  const today = new Date().toISOString().split('T')[0];

  for (const group of OPERATION_GROUPS) {
    if (!group.jid) {
      console.log(`[Cron] Skipping ${group.name} — JID not known yet`);
      continue;
    }

    // Fetch tasks for this club
    const { data: tasks, error } = await supabase
      .from('ops_tasks')
      .select('*')
      .eq('club', group.club)
      .order('status', { ascending: true });

    if (error) { console.error(`[Cron] tasks fetch error:`, error.message); continue; }

    const message = formatDraftMessage(group.club, tasks || []);

    // Check if draft already exists for today
    const { data: existing } = await supabase
      .from('group_drafts')
      .select('id')
      .eq('group_jid', group.jid)
      .eq('draft_date', today)
      .eq('status', 'pending')
      .maybeSingle();

    if (existing) {
      // Update existing draft
      await supabase.from('group_drafts').update({ message_text: message }).eq('id', existing.id);
    } else {
      // Insert new draft
      await supabase.from('group_drafts').insert({
        group_name:   group.name,
        group_jid:    group.jid,
        club:         group.club,
        message_text: message,
        status:       'pending',
        draft_date:   today,
      });
    }
    console.log(`[Cron] Draft created for ${group.name}`);
  }
}, { timezone: 'Asia/Kuala_Lumpur' });

// ── POLL FOR APPROVED DRAFTS & SEND ──────────────────────────────────────────
// Check every minute for approved drafts to send
let activeSock = null; // set by startBot

cron.schedule('* * * * *', async () => {
  if (!activeSock) return;

  const { data: approved } = await supabase
    .from('group_drafts')
    .select('*')
    .eq('status', 'approved');

  if (!approved?.length) return;

  for (const draft of approved) {
    try {
      await activeSock.sendMessage(draft.group_jid, { text: draft.message_text });
      await supabase.from('group_drafts').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', draft.id);
      console.log(`[✓] Sent approved draft to ${draft.group_name}`);
    } catch (e) {
      console.error(`[!] Failed to send to ${draft.group_name}:`, e.message);
    }
  }
});

// ── MONTHLY RESET — 1st of month at midnight ──────────────────────────────────
cron.schedule('0 0 1 * *', async () => {
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const monthYear = lastMonth.toISOString().slice(0, 7); // e.g. "2026-06"

  const { error } = await supabase
    .from('ops_tasks')
    .delete()
    .eq('status', 'completed')
    .eq('month_year', monthYear);

  if (error) console.error('[Cron] Monthly reset error:', error.message);
  else console.log(`[Cron] Monthly reset — removed completed tasks from ${monthYear}`);
}, { timezone: 'Asia/Kuala_Lumpur' });

startBot();
