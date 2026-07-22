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
  { name: 'Setia Alam Internal groups',   jid: '120363417699792237@g.us', club: 'Setia Alam Club' },
  { name: 'Canopy sailfish internal group', jid: '120363418448920703@g.us', club: 'Canopy Club' },
  { name: '360 - Sailfish Internal Group', jid: '120363417742194794@g.us', club: 'Club 360' },
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

  // Group tasks by staff name
  const staffMap = {};
  for (const t of tasks) {
    if (!staffMap[t.staff_name]) staffMap[t.staff_name] = { done: [], pending: [], overdue: [] };
    if (t.status === 'completed') staffMap[t.staff_name].done.push(t.task_text);
    else if (t.status === 'pending') staffMap[t.staff_name].pending.push(t.task_text);
    else if (t.status === 'overdue') staffMap[t.staff_name].overdue.push(t.task_text);
  }

  // Overdue alert section at top
  const overdueEntries = Object.entries(staffMap).filter(([,t]) => t.overdue.length);

  const pendingEntries = Object.entries(staffMap).filter(([,t]) => t.pending.length);
  const doneEntries    = Object.entries(staffMap).filter(([,t]) => t.done.length);

  let msg = `🐟 *Sailfish Daily Ops — ${today}*\n📍 *${club}*\n`;

  // OVERDUE JOBS
  if (overdueEntries.length) {
    msg += `\n🔴 *OVERDUE JOBS:*\n`;
    for (const [name, t] of overdueEntries) {
      for (const o of t.overdue) {
        msg += `  • ${name} — ${o}\n`;
      }
    }
  }

  // PENDING JOBS
  if (pendingEntries.length) {
    msg += `\n⏳ *PENDING JOBS:*\n`;
    for (const [name, t] of pendingEntries) {
      for (const p of t.pending) {
        msg += `  • ${name} — ${p}\n`;
      }
    }
  }

  // JOBS DONE (specific but short — each task on its own line)
  if (doneEntries.length) {
    msg += `\n✅ *JOBS DONE:*\n`;
    for (const [name, t] of doneEntries) {
      for (const d of t.done) {
        msg += `  • ${name} — ${d.slice(0, 60)}\n`;
      }
    }
  }

  if (!overdueEntries.length && !pendingEntries.length && !doneEntries.length) {
    msg += `\n_No tasks recorded yet._\n`;
  }

  msg += `\n_${new Date().toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })} · Sailfish Ops_`;
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
      .eq('status', 'approved')
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
        status:        'approved',
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

 // ── 10PM NIGHTLY ANALYSIS ─────────────────────────────────────────────────────
cron.schedule('0 22 * * *', async () => {
  console.log('[Cron] 10pm — running nightly AI analysis…');
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) { console.error('[Cron] No ANTHROPIC_API_KEY — skipping analysis'); return; }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: msgs, error: msgErr } = await supabase
    .from('messages').select('*').gte('timestamp', since).order('timestamp');
  if (msgErr || !msgs?.length) { console.log('[Cron] No messages to analyse'); return; }
  const { data: staffRows } = await supabase
    .from('staff').select('name, role, branches(name)').eq('status', 'active');
  const roster = (staffRows||[]).map(s =>
    `- ${s.name} | ${s.role||'staff'} | ${s.branches?.name||'Unknown'}`).join('\n');
  const rawText = msgs.map(m =>
    `[${new Date(m.timestamp).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur'})}] ${m.chat_name} — ${m.sender_name}: ${m.message_text||m.message_type}`
  ).join('\n');
  const prompt = `You are an operations assistant for Sailfish Sdn Bhd swim academies.\n\nSTAFF ROSTER:\n${roster}\n\nRAW WHATSAPP MESSAGES:\n${rawText.length > 40000 ? rawText.slice(-40000) + '\n[Older messages truncated]' : rawText}\n\nYOUR TASK: For each staff member build their profile from ALL messages.\n- completedTasks: things reported done ("done","selesai","✅","siap","completed") — return as [{task,date}] where date is "DD MMM"\n- pendingTasks: things not yet done or outstanding\n- overdueTasks: things due but not done\n- attendance: 7-day boolean array [Mon-Sun] — check Daily Attendance Reports first: staff listed under any shift (AM/Middle/PM) = true, listed under AL/MC/Off Day/UL = false\n- lastActive: most recent message timestamp\n\nReturn ONLY valid JSON, no markdown:\n{"staff":[{"name":"Abin","club":"Setia Alam Club","role":"technician","completedTasks":[{"task":"example","date":"15 Jul"}],"pendingTasks":[],"overdueTasks":[],"attendance":[true,true,true,false,true,true,true],"lastActive":"17 Jul 09:05","notes":""}]}`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16000, messages: [{ role: 'user', content: prompt }] })
    });
    const aiData = await res.json();
    if (aiData.error) throw new Error(aiData.error.message);
    const raw = aiData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const today = new Date().toISOString().split('T')[0];
    const monthYear = today.slice(0, 7);
    for (const s of parsed.staff || []) {
      for (const t of s.completedTasks || []) {
        await supabase.from('ops_tasks').upsert(
          { staff_name: s.name, club: s.club, task_text: t.task||t, status: 'completed', month_year: monthYear },
          { onConflict: 'staff_name,club,task_text' });
      }
      for (const t of s.pendingTasks || []) {
        await supabase.from('ops_tasks').upsert(
          { staff_name: s.name, club: s.club, task_text: t, status: 'pending', month_year: monthYear },
          { onConflict: 'staff_name,club,task_text' });
      }
      for (const t of s.overdueTasks || []) {
        await supabase.from('ops_tasks').upsert(
          { staff_name: s.name, club: s.club, task_text: t, status: 'overdue', month_year: monthYear },
          { onConflict: 'staff_name,club,task_text' });
      }
      const att = s.attendance || [];
      for (let i = 0; i < att.length; i++) {
        if (att[i] === null || att[i] === undefined) continue;
        const d = new Date(); d.setDate(d.getDate() - (att.length - 1 - i));
        const dateStr = d.toISOString().split('T')[0];
        await supabase.from('staff_attendance').upsert(
          { staff_name: s.name, club: s.club, date: dateStr, present: !!att[i], month_year: dateStr.slice(0,7) },
          { onConflict: 'staff_name,club,date' });
      }
    }
    console.log(`[Cron] Nightly analysis complete — ${parsed.staff?.length||0} staff processed`);
  } catch (e) {
    console.error('[Cron] Nightly analysis failed:', e.message);
  }
}, { timezone: 'Asia/Kuala_Lumpur' });
