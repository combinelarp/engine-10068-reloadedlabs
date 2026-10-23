 // Gyt3lyz based sqlite3 database
// Port of main-api-dev (Blockman GO v1.9.17) + legacy game data API
// Fake Redis: all cache / leaderboard ops are emulated on top of SQLite,
// so no Redis server is needed.
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');

// Minimal .env loader (no dependency). Reads <script dir>/.env and fills
// process.env, but never overrides values already set in the environment.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
})();

const app = express();
app.set('trust proxy', true);
const PORT = 8080;
// Client-facing origin. Priority: explicit BASE_HOST env > the Host header the
// client actually used (e.g. the Cloudflare domain the launcher talks to) >
// auto-detected public IP (fallback for direct VPS access).
const BASE_HOST = process.env.BASE_HOST || 'http://127.0.0.1';
function baseUrl(req) {
  if (process.env.BASE_HOST) return BASE_HOST.replace(/\/$/, '');
  if (req && req.get && req.get('host')) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    return `${proto}://${req.get('host')}`;
  }
  return `http://${publicIp()}`;
}

const DB_DIR = path.join(__dirname, 'database');
const DB_FILES = path.join(DB_DIR, 'files');
const TOKEN_SECRET = '123456';
const GAME_SECRET = 'pq0194mxoqfh48L362G6R09T737E273X';
const MAX_FRIENDS = 100;

// ---- Gameserver connection config (same shape as dispatcher host.json) ----
const GAME_HOST = process.env.GAME_HOST || '127.0.0.1';
const GAME_PORT = parseInt(process.env.GAME_PORT) || 19131;
// Public IP override or auto-detect: gameservers on the same VPS announce a
// loopback ip, but the client must reach them via the VPS public address.
// Set PUBLIC_IP in .env to pin it; otherwise it is detected outbound at boot.
const PUBLIC_IP = process.env.PUBLIC_IP || null;
let detectedPublicIp = null;
function publicIp() {
  if (PUBLIC_IP) return PUBLIC_IP;
  return detectedPublicIp || GAME_HOST;
}
// Auto-detect the outbound (public) IP without sending traffic: connecting a
// UDP socket to 8.8.8.8 and reading the local address reveals the egress IP.
(function detectPublicIp() {
  try {
    const dgram = require('dgram');
    const u = dgram.createSocket('udp4');
    u.once('connect', () => {
      const inf = u.address();
      if (inf && inf.address) detectedPublicIp = inf.address;
      try { u.close(); } catch {}
    });
    u.once('error', () => { try { u.close(); } catch {} });
    u.connect(53, '8.8.8.8');
    setTimeout(() => { try { u.close(); } catch {} }, 2000);
  } catch {}
})();
// Resolve the client-reachable address for a gameserver: the start of the
// address is the detected public ip (loopback/local is never returned), and
// the port is the gameserver's announced listen port.
function gameserverAddress(reportedIp, announcedPort) {
  const remote = normalizeRemoteIp(reportedIp);
  let ip = remote;
  if (!ip || ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1') ip = publicIp();
  return `${ip}:${announcedPort}`;
}
// Address of a gameserver AS THE CLIENT SHOULD CALL IT. The gameservers bind
// a local interface (127.0.0.1) and this API runs on the same box, so the
// client must reach them on the VPS's PUBLIC IP (set PUBLIC_IP in .env) - not
// the domain/Cloudflare-host the client uses for HTTP, which does not forward
// raw game TCP. PUBLIC_IP env > detected public IP > request Host header.
function clientGameserverAddress(req, announcedPort) {
  const configured = publicIp();
  if (configured && configured !== '127.0.0.1' && configured !== '0.0.0.0' && configured !== '::1') {
    return `${configured}:${announcedPort}`;
  }
  const hostHeader = (req && req.get && req.get('host')) || '';
  const host = hostHeader.split(':')[0];
  if (host) return `${host}:${announcedPort}`;
  return gameserverAddress(GAME_HOST, announcedPort);
}
// Parse the `gameserver_ips` field a gameserver puts in its announce config. It
// carries the PUBLIC ip[:port] the client must reach (NAT/public address),
// unlike `ip`/`monitoraddr` which are loopback on this box. Accepts an array of
// address objects/strings, or a comma/space/semicolon separated string such as
// "178.104.63.96:19199". Returns [{ ip, port|null }, ...] with normalized ip.
function parseGameserverIps(raw) {
  const out = [];
  const pushEntry = (ip, port) => {
    ip = String(ip == null ? '' : ip).trim().replace(/^\[|\]$/g, '');
    if (!ip) return;
    ip = normalizeRemoteIp(ip);
    if (ip) out.push({ ip, port: port != null ? String(port) : null });
  };
  const pushToken = (t) => {
    const m = /^([0-9a-fA-F.:]+)(?::(\d+))?$/.exec(t);
    if (m) pushEntry(m[1], m[2]);
  };
  const consume = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { for (const it of v) consume(it); return; }
    if (typeof v === 'object') {
      pushEntry(v.ip || v.ipAddress || v.host || v.addr, v.port);
      return;
    }
    String(v).split(/[,;\s]+/).forEach((t) => { if (t) pushToken(t); });
  };
  consume(raw);
  return out;
}
// Client-reachable address for a gameserver entry. Precedence:
//  1. gameserver_ips advertised by the server (public NAT ip[:port])
//  2. the PUBLIC ip the game's own launcher bat declares (publicIp in its
//     gid folder) - the ground truth for where the server is reachable
//  3. reconstructed fallback: PUBLIC_IP env / Host header / detected public IP
function clientReachableAddr(req, server) {
  if (server) {
    const advIp = server.advertisedIp;
    if (advIp) return `${advIp}:${server.advertisedPort || server.port}`;
    const pubIp = server.publicIp;
    if (pubIp && pubIp !== '127.0.0.1' && pubIp !== '0.0.0.0' && pubIp !== '::1') {
      return `${pubIp}:${server.port}`;
    }
    return clientGameserverAddress(req, server.port);
  }
  return clientGameserverAddress(req, null);
}
// No GAME_SERVERS env list: which gameservers exist (and where they listen) is
// learned exclusively from what each GameServer.exe announces over the room TCP
// socket (GID_SERVERS below). A guessed/configured server list is exactly what
// used to send a client to a different game's port ("teleported to a different
// gid").
// Room server port (same shape as game-service-api host.json roomPort).
const ROOM_PORT = parseInt(process.env.ROOM_PORT) || 9900;
// CDN base used for dispatch map downloads (downurl).
function cdnHost(req) {
  if (process.env.CDN_HOST) return process.env.CDN_HOST.replace(/\/$/, '');
  return apiHost(req);
}
// Public origin of THIS API including the port when one is needed. Never
// doubles a port that is already present (Host header / BASE_HOST).
function apiHost(req) {
  const base = baseUrl(req);
  if (/:\d+$/.test(base)) return base; // port already included
  const host = (req && req.get && req.get('host')) || '';
  if (host && host.includes(':')) return base; // client already included the port
  const proto = String((req && req.headers && (req.headers['x-forwarded-proto'] || req.protocol)) || 'http').toLowerCase();
  if (proto.includes('https')) return base; // TLS terminated upstream (e.g. Cloudflare) -> use the domain as-is
  return `${base}:${PORT}`; // plain http with no explicit port -> append the app port
}
// Safe path join: a path that escapes `root` resolves to a non-existent file.
function safeJoin(root, rest) {
  const full = path.resolve(root, rest || '');
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    return path.join(rootResolved, '__blocked__');
  }
  return full;
}
// Root of the static CDN folder (cdn-serve-js-master/static). Files under
// /maps, /events and /database/files are served from here so the dispatch
// downurl (which redirects clients to CDN_HOST) actually resolves.
const CDN_ROOT = process.env.CDN_ROOT || path.join(__dirname, 'cdn');
// When the gameserver reports rank data to the API (8080), it proves it is
// alive. Used as an online signal for the dispatch watcher.
let gameserverLastSeen = 0;
// Autodetected game id the gameserver is hosting (e.g. "g1015" from rank keys).
let gameserverGid = null;
// The source address the detected gid request came FROM ("localhost" when it
// is local, otherwise the real LAN/WAN ip). Used for the launch address.
let gameserverGidHost = null;
// Static gid identification: gid -> human game name
// (mirrors the folders in D:\BlockmanReloaded\maps).
const GAME_NAMES = {
  g1000: 'Sample', g1001: 'Survival Games', g1002: 'Sky wars', g1003: 'Unknown', g1007: 'Bow Spleef',
  g1008: 'Bedwars (old)', g1009: 'Murder Mystery', g1010: 'TNT Run', g1011: 'Snowball Battle',
  g1013: 'Zombie Infecting', g1014: 'Jail Break', g1015: 'Treasure Hunter', g1016: 'Borderline',
  g1017: 'Hide and Seek', g1018: 'Egg War', g1019: 'Aliens Attack', g1020: 'Mini Town',
  g1021: 'Rainbow Parkour', g1022: 'Capture Flag', g1023: 'Build Battle', g1024: 'Gem Knight',
  g1025: 'Hero Tycoon', g1026: 'TNT Tag', g1027: 'Sky Royale', g1028: 'Ultimate Fighting',
  g1029: 'Mega Walls', g1030: 'Snowman Defender', g1031: 'Ranchers', g1032: 'Blockman Strike',
  g1033: 'Counter Strike', g1035: 'Ranchers Explore', g1036: 'Ender vs Slender', g1037: 'Hide And Seek 2',
  g1038: 'Hide And Seek 2 Hidden mode', g1039: 'Hide And Seek 2 Chase mode', g1040: 'Explore Map', g1041: 'Bird Simulator',
  g1042: 'Build and Shoot (Lobby)', g1043: 'Build and Shoot (Team Mode)', g1044: 'Build and Shoot (Solo Mode)',
  g1045: 'Build and Shoot (Duo Mode)', g1046: 'Bed Wars (Lobby)', g1047: 'Realm City', g1048: 'Sky Block',
  g1049: 'SkyBlockMiningArea', g1050: 'Sky Block Event Zone', g1051: 'The Walking Dead', g1052: 'BlockFort',
  g1053: 'Battle Royale', g1054: 'Lucky Block Skywars', g1055: 'WWE School Simulator',
  g1056: 'TD Angry Pets (Tutorial)', g1057: 'TD Angry Pets', g1058: 'Lucky Block Skywars',
  g1060: 'WWE School Simulator (Champion Match)', g1061: 'Bed Wars (Single mode)', g1062: 'Bed Wars(Two player mode)',
  g1063: 'Bed Wars (4v4v4v4)', g1064: 'Bullets Fly', g1065: 'BedWar 10V10', g1071: 'Clan Wars',
  g1072: 'Clan Wars Battlefield'
};
// Resolve a gid to its game name (case-insensitive). Returns null when unknown.
function gidName(gid) {
  if (!gid) return null;
  return GAME_NAMES[String(gid).toLowerCase()] || null;
}
// Normalize a socket remote address: strip IPv6-mapped prefix and turn ::1
// into 127.0.0.1 so "from localhost vs from a real ip" is distinguishable.
function normalizeRemoteIp(addr) {
  if (!addr) return null;
  const ip = String(addr).replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
  return ip || null;
}

// ---- Authoritative gid -> gameserver registry (gid folders + TCP announce) ----
// Two sources combine, in this order of trust for the DISPATCH address:
//   - GAME_FOLDERS: ground truth parsed from each game's launch bat
//     (D:\BlockmanReloaded\g*/\res\runserver*.bat): the id/port/publicIp/map
//     the ADMIN configured for that game. This is where "the port and the
//     public ip" come from (the announce can carry a stale/wrong listen port,
//     as happened with 19199, but the bat says where the server really is).
//   - TCP announce: which of those servers is LIVE right now (connected=true),
//     plus `gameserver_ips` (public NAT ip[:port]) which overrides the address,
//     plus the map name the server itself reports loading.
// Games are never preconfigured from .env (GAME_SERVERS). A game only becomes
// dispatchable after its GameServer.exe announces over the room TCP socket; the
// folder bat then supplies the port/publicIp for that dispatch. Dispatch never
// points a client at another game's port by mistake (the "teleported to a
// different gid" bug came from guessed ports, not from what the servers said).
const GID_SERVERS = new Map(); // gid(lowercase) -> { gid, ip, port, addr, mapName, connected }
const GID_SERVERS_CONNECTED_LOG = {}; // gid -> true once logged
const GAME_FOLDERS = new Map(); // gid|gtype|folder(lowercase) -> parsed launcher bat
function parseBatArgs(batPath) {
  const text = fs.readFileSync(batPath, 'utf8');
  const m = /^\s*set\s+ARGS=(.*)$/im.exec(text);
  if (!m) return null;
  // The bat stores the JSON with every quote tripled for cmd escaping
  // ("""key""":"""value""", empty value = six quotes). Un-triple once.
  const json = m[1].trim().replace(/"""/g, '"');
  return tryParseJson(json);
}
// Scan D:\BlockmanReloaded\g*\res\runserver*.bat and index every launcher so
// dispatch can use the configured port/publicIp per gid (see GAME_FOLDERS).
function loadGidFolders() {
  const base = path.resolve(__dirname, '..');
  let folders = [];
  try { folders = fs.readdirSync(base).filter((d) => /^g\d+$/.test(d)); } catch {}
  for (const dir of folders) {
    const res = path.join(base, dir, 'res');
    let bats = [];
    try { bats = fs.readdirSync(res).filter((f) => /^runserver.*\.bat$/i.test(f)); } catch { continue; }
    for (const f of bats) {
      try {
        const cfg = parseBatArgs(path.join(res, f));
        if (!cfg) continue;
        const folderGid = String(cfg.id || cfg.gtype || dir).toLowerCase();
        const mapName = cfg.mapid || cfg.name ||
          (cfg.mapdir ? path.basename(String(cfg.mapdir).replace(/\\/g, '/')) : null);
        const entry = {
          folder: dir,
          gid: folderGid,
          id: cfg.id != null ? String(cfg.id) : dir,
          gtype: cfg.gtype != null ? String(cfg.gtype) : null,
          ip: cfg.ip != null ? String(cfg.ip) : '127.0.0.1',
          publicIp: cfg.publicIp != null ? String(cfg.publicIp) : '127.0.0.1',
          port: cfg.port != null ? String(cfg.port) : null,
          mapName: mapName ? String(mapName) : null,
          mapdir: cfg.mapdir != null ? String(cfg.mapdir) : null,
          monitoraddr: cfg.monitoraddr != null ? String(cfg.monitoraddr) : null,
          batPath: path.join(res, f),
        };
        for (const k of [entry.id, entry.gtype, dir].filter(Boolean)) {
          GAME_FOLDERS.set(String(k).toLowerCase(), entry);
        }
      } catch {}
    }
  }
  return GAME_FOLDERS.size;
}
function gidServerFor(gid) {
  if (!gid) return null;
  return GID_SERVERS.get(String(gid).toLowerCase()) || null;
}
function onlineGidServers() {
  const out = [];
  for (const s of GID_SERVERS.values()) {
    if (s.connected) out.push(s);
  }
  return out;
}
// Returns the exact gid server for a gameId, else null. NEVER returns a
// different game's server: dispatching a g1014 request to the first online
// server (which may be g1015) connects the client to the wrong game.
function serverForGame(gameId) {
  const exact = gidServerFor(gameId);
  if (exact && onlineGidServers().some((s) => s.gid === exact.gid)) return exact;
  return null;
}

// Map id for a game: the per-game CDN package name is derived from the gid
// itself (strip "g" -> "m"), e.g. g1033 -> m1033, g1014 -> m1014. This is the
// ONLY reliable map identity - the gameserver's announce can carry a shared /
// stale mapdir (e.g. "m101"), but the map a client must download for a game is
// always its own m<gid> package. BedWar keeps its multi-mode m1008_3 name.
function mapIdForGame(gameId) {
  const g = String(gameId || '').toLowerCase();
  if (g === 'g1008') return 'm1008_3';
  if (/^g(\d+(_\d+)?)$/.test(g)) return 'm' + g.slice(1);
  return g.replace(/^g/, 'm');
}
// Resolve a client-requested gameId to the gameserver that ANNOUNCED itself
// over the room TCP socket with exactly that gid (entry.connected means its
// gameserver is live on the room right now). An unknown game - or a game whose
// server has not announced - returns null and is rejected; it is NEVER routed
// to a different game's server. The map id (mid/downurl) is derived from the
// REQUESTED gid (mapIdForGame), so aliases like g1008_4 keep their own m1008_4.
// - exact announced gid match (g1001, g1014, ...) -> that server
// - multi-mode alias (g1008_4 -> g1008) -> the base game's announced server
// - anything else not currently announced -> null
function resolveGameServer(gameId) {
  const gid = String(gameId || '').toLowerCase();
  if (!gid) return null;
  const server = gidServerFor(gid);
  if (server && server.connected) return { server, mapId: mapIdForGame(gid) };
  const multiMode = /^(g\d+)_\d+$/.exec(gid);
  if (multiMode) {
    const base = gidServerFor(multiMode[1]);
    if (base && base.connected) return { server: base, mapId: mapIdForGame(gid) };
  }
  return null;
}

// SQLite Database Setup
const dbPath = path.join(__dirname, 'game.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initializeTables();
  }
});

// Initialize database tables
function initializeTables() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS UserData (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      subKey TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(userId, subKey)
    )`,
    `CREATE TABLE IF NOT EXISTS Leaderboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      member TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      expireTime INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(key, member)
    )`,
    `CREATE TABLE IF NOT EXISTS LogData (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      serverInfo TEXT,
      gameType TEXT,
      dataAction TEXT,
      data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // Fake Redis string cache (GET/SET/EXPIRE on SQLite)
    `CREATE TABLE IF NOT EXISTS KeyValue (
      key TEXT PRIMARY KEY,
      value TEXT,
      expireTime INTEGER DEFAULT NULL
    )`,
    // Templates from D:\shit\debil\templates (ported to SQLite)
    `CREATE TABLE IF NOT EXISTS account (
      userId INTEGER PRIMARY KEY,
      email TEXT,
      password TEXT,
      creationTime INTEGER NOT NULL DEFAULT 0,
      accessToken TEXT,
      loginTime INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS account_binding (
      userId INTEGER PRIMARY KEY,
      connectId TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS user (
      userId INTEGER PRIMARY KEY,
      nickName TEXT,
      sex INTEGER,
      picUrl TEXT,
      details TEXT,
      birthday TEXT,
      isFreeNickname INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS user_locale (
      userId INTEGER PRIMARY KEY,
      language TEXT,
      country TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS vip (
      userId INTEGER PRIMARY KEY,
      vip INTEGER DEFAULT 0,
      expireDate INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wealth (
      userId INTEGER PRIMARY KEY,
      golds INTEGER DEFAULT 0,
      diamonds INTEGER DEFAULT 0,
      clanGolds INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wealth_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      created INTEGER,
      currency INTEGER,
      inoutType INTEGER,
      orderId TEXT,
      qty INTEGER,
      status INTEGER,
      transactionType INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS game (
      gameId TEXT PRIMARY KEY,
      gameName TEXT,
      iconUrl TEXT,
      isRecommended INTEGER,
      gameTypes TEXT,
      likeCount INTEGER,
      shopEnabled INTEGER,
      rankEnabled INTEGER,
      partyEnabled INTEGER,
      authorId INTEGER,
      creationTime INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS game_detail (
      gameId TEXT PRIMARY KEY,
      bannerUrl TEXT,
      gameDetail TEXT,
      featuredPlay TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS game_like (
      userId INTEGER PRIMARY KEY,
      games TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS game_party_config (
      gameId TEXT PRIMARY KEY,
      maxPlayers INTEGER,
      teamNumber INTEGER,
      teamPlayers INTEGER,
      vipPlayers INTEGER,
      commonPlayers INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS game_update (
      gameId TEXT PRIMARY KEY,
      version INTEGER,
      content TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS friend (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      friendId INTEGER NOT NULL,
      alias TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_friend_user ON friend(userId)`,
    `CREATE TABLE IF NOT EXISTS friend_request (
      requestId INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      friendId INTEGER NOT NULL,
      message TEXT,
      picUrl TEXT,
      nickName TEXT,
      sex INTEGER,
      country TEXT,
      language TEXT,
      status INTEGER,
      creationTime INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS mailbox (
      userId INTEGER PRIMARY KEY,
      data TEXT
    )`,
    `DELETE FROM mailbox WHERE rowid NOT IN (SELECT MIN(rowid) FROM mailbox GROUP BY userId)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_user ON mailbox(userId)`,
    `CREATE TABLE IF NOT EXISTS mailbox_record (
      userId INTEGER PRIMARY KEY,
      data TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS clan (
      clanId INTEGER PRIMARY KEY,
      name TEXT,
      picUrl TEXT,
      tags TEXT,
      details TEXT,
      experience INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      memberCount INTEGER DEFAULT 0,
      freeVerify INTEGER DEFAULT 0,
      language TEXT,
      creationTime INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS clan_donation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      clanId INTEGER NOT NULL,
      nickName TEXT,
      type INTEGER,
      amount INTEGER,
      expReward INTEGER,
      clanGoldReward INTEGER,
      creationTime INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_clan_donation_clan ON clan_donation(clanId)`,
    `CREATE TABLE IF NOT EXISTS clan_member (
      userId INTEGER PRIMARY KEY,
      clanId INTEGER NOT NULL,
      role INTEGER,
      experience INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_clan_member_clan ON clan_member(clanId)`,
    `CREATE TABLE IF NOT EXISTS clan_message (
      messageId INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      clanId INTEGER NOT NULL,
      authorityId INTEGER,
      message TEXT,
      picUrl TEXT,
      nickName TEXT,
      type INTEGER,
      status INTEGER,
      creationTime INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS clan_notice (
      clanId INTEGER PRIMARY KEY,
      content TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS dressing_owned (
      userId INTEGER PRIMARY KEY,
      data TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS dressing_equipped (
      userId INTEGER PRIMARY KEY,
      data TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS discord_links (
      discordId TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      linkedAt INTEGER NOT NULL DEFAULT 0,
      UNIQUE(userId)
    )`,
    `CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      hwid TEXT,
      ip TEXT,
      reason TEXT,
      bannedBy TEXT,
      bannedAt INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS user_hwids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      hwid TEXT NOT NULL,
      ip TEXT,
      firstSeen INTEGER NOT NULL DEFAULT 0,
      lastSeen INTEGER NOT NULL DEFAULT 0,
      UNIQUE(userId, hwid)
    )`,
    // ---- gcubes currency (ported from the standalone Gcubes.js service) ----
    `CREATE TABLE IF NOT EXISTS gcubes_balance (
      userId INTEGER PRIMARY KEY,
      gcubes INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS gcubes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT,
      timestamp INTEGER NOT NULL
    )`,
    // Generic per-user data store (same shape as the gXXXX tables).
    // SQLite types: INT UNSIGNED -> INTEGER, VARCHAR(5000) -> TEXT.
    `CREATE TABLE IF NOT EXISTS player_data (
      userId INTEGER NOT NULL,
      subkey INTEGER NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(userId, subkey)
    )`
  ];

  // Per-game data tables (ported from MySQL schema: gXXXX holds per-user
  // subkeys, gXXXX_log holds the action log). Kept GDPR-friendly, no ids leaked.
  for (let g = 1001; g <= 1060; g++) {
    statements.push(`CREATE TABLE IF NOT EXISTS g${g} (
      userId INTEGER NOT NULL,
      subkey INTEGER NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(userId, subkey)
    )`);
    statements.push(`CREATE TABLE IF NOT EXISTS g${g}_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      serverInfo TEXT,
      gameType TEXT,
      dataAction TEXT,
      data TEXT,
      logTime TEXT NOT NULL
    )`);
  }

  let idx = 0;
  const runNext = () => {
    if (idx >= statements.length) {
      console.log('All database tables initialized');
      seedDefaultGames();
      initDressingCatalog();
      cleanExpiredKeys();
      backfillMaxWealth();
      backfillMaxGcubes();
      setInterval(cleanExpiredKeys, 60000); // Every minute
      return;
    }
    db.run(statements[idx], (err) => {
      if (err) console.error('Error creating table:', statements[idx], err.message);
      idx++;
      runNext();
    });
  };
  runNext();
}

async function seedDefaultGames() {
  try {
    const gids = Array.from(GID_SERVERS.keys()).sort();
    if (gids.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    const iconBase = cdnHost(null);
    const placeholders = gids.map(() => '?').join(',');
    await dbRun(`DELETE FROM game WHERE gameId NOT IN (${placeholders})`, gids);
    const sql = 'INSERT OR IGNORE INTO game (gameId, gameName, iconUrl, isRecommended, gameTypes, likeCount, shopEnabled, rankEnabled, partyEnabled, authorId, creationTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    for (const gid of gids) {
      await dbRun(sql, [gid, gidName(gid) || gid, `${iconBase}/database/files/game-icons/${gid}.png`, 1, JSON.stringify([0, 1]), 0, 1, 1, 1, 0, now]);
    }
    console.log(`[SEED] Synced ${gids.length} real games: ${gids.join(', ')}`);
  } catch (e) {
    console.error('Error seeding default games:', e.message);
  }
}

// Register a single game (insert-if-missing) in the game table. Used when a
// gameserver announces itself over the room socket at runtime so any game -
// including ones added after this API last started - shows up immediately.
async function seedGameRow(gid) {
  if (!gid) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const iconBase = cdnHost(null);
    await dbRun('INSERT OR IGNORE INTO game (gameId, gameName, iconUrl, isRecommended, gameTypes, likeCount, shopEnabled, rankEnabled, partyEnabled, authorId, creationTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [gid, gidName(gid) || gid, `${iconBase}/database/files/game-icons/${gid}.png`, 1, JSON.stringify([0, 1]), 0, 1, 1, 1, 0, now]);
  } catch (e) {
    console.error(`Error seeding game row for ${gid}:`, e.message);
  }
}

function cleanExpiredKeys() {
  const now = Math.floor(Date.now() / 1000);
  db.run('DELETE FROM Leaderboards WHERE expireTime IS NOT NULL AND expireTime < ?', [now], function(err) {
    if (err) console.error('Error cleaning expired leaderboards:', err);
  });
  db.run('DELETE FROM KeyValue WHERE expireTime IS NOT NULL AND expireTime < ?', [now], function(err) {
    if (err) console.error('Error cleaning expired keys:', err);
  });
}

// Middleware
app.use(bodyParser.json({ limit: '5mb' }));
const SENSITIVE_KEYS = /pass(word)?|token|verifycode|secret/i;
function redact(value, depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) out[k] = SENSITIVE_KEYS.test(k) ? '***' : redact(value[k], depth + 1);
  return out;
}
app.use((req, res, next) => {
  try { ICON_BASE = `${apiHost(req)}/database/files/icons`; } catch {}
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl.replace(/(pass(word)?|token)=[^&]*/ig, '$1=***')}`);
  console.log(req.method === 'GET' ? 'Query:' : 'Body:', redact(req.method === 'GET' ? req.query : req.body));
  next();
});
// Any rank/data request coming from the gameserver is still served, but it
// no longer marks that game online. Online is decided by the room server TCP
// connection only (vanilla behavior), so games that run without HTTP keep
// dispatching correctly.
app.use('/api/v1/game', (req, res, next) => {
  next();
});

// Helper functions
function apiResponse(code, message, data = null) {
  return { code, message, data };
}

function validateTableName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_]+$/.test(name);
}

// Promise wrapper for SQLite operations
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// ---- Fake Redis: string cache on SQLite ----
async function kvGet(key) {
  const row = await dbGet('SELECT value FROM KeyValue WHERE key = ? AND (expireTime IS NULL OR expireTime > ?)', [key, Math.floor(Date.now() / 1000)]);
  if (!row) return null;
  if (/^-?\d+$/.test(row.value)) return parseInt(row.value);
  return row.value;
}

async function kvSet(key, data, ttl) {
  const expireTime = ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : null;
  await dbRun('INSERT OR REPLACE INTO KeyValue (key, value, expireTime) VALUES (?, ?, ?)', [key, String(data), expireTime]);
}

async function kvDel(key) {
  await dbRun('DELETE FROM KeyValue WHERE key = ?', [key]);
}

// Leaderboard score write (ZINCRBY / ZADD). Upsert keeps the key's expireTime
// (REPLACE used to wipe it) and new members inherit the key's expiry.
async function lbWriteScore(key, member, count, absolute) {
  const existing = await dbGet('SELECT score FROM Leaderboards WHERE key = ? AND member = ?', [key, member]);
  const score = absolute ? count : (existing ? Number(existing.score) : 0) + count;
  await dbRun(
    `INSERT INTO Leaderboards (key, member, score, expireTime, updated_at)
     VALUES (?, ?, ?, (SELECT expireTime FROM Leaderboards WHERE key = ? AND expireTime IS NOT NULL LIMIT 1), CURRENT_TIMESTAMP)
     ON CONFLICT(key, member) DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP`,
    [key, member, score, key]
  );
}

// =====================================================================
//  Ban / HWID / Discord-link system
// =====================================================================
const CLIENT_IP = {
  from(req) {
    const xff = req.headers && (req.headers['x-forwarded-for'] || '');
    if (xff) return String(xff).split(',')[0].trim();
    return req.ip || (req.socket && req.socket.remoteAddress) || null;
  }
};

// Deterministic hash so a raw hwid string never leaks into logs/DB lookups.
function hwidHash(hwid) {
  if (!hwid) return null;
  const clean = String(hwid).trim().toLowerCase();
  if (!clean) return null;
  return crypto.createHash('sha256').update(clean).digest('hex');
}

// Log a hwid+ip seen for a user (unique per (userId, hwid)).
async function logHwid(userId, rawHwid, ip) {
  if (!userId || !rawHwid) return;
  const hwid = hwidHash(rawHwid);
  const now = Math.floor(Date.now() / 1000);
  await dbRun(
    `INSERT INTO user_hwids (userId, hwid, ip, firstSeen, lastSeen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(userId, hwid) DO UPDATE SET ip = excluded.ip, lastSeen = excluded.lastSeen`,
    [userId, hwid, ip || null, now, now]
  );
}

// All distinct hwids ever seen for a user.
async function hwidsForUser(userId) {
  const rows = await dbAll('SELECT hwid FROM user_hwids WHERE userId = ?', [userId]);
  return rows.map((r) => r.hwid).filter(Boolean);
}

async function activeBanForUser(userId) {
  return dbGet('SELECT * FROM bans WHERE userId = ? AND active = 1 ORDER BY id DESC LIMIT 1', [userId]);
}

async function activeBanForHwid(rawHwid) {
  if (!rawHwid) return null;
  const hwid = hwidHash(rawHwid);
  if (!hwid) return null;
  return dbGet('SELECT * FROM bans WHERE hwid = ? AND active = 1 ORDER BY id DESC LIMIT 1', [hwid]);
}

// Create a ban. If the target has logged hwids, every one of those hwids is
// banned too, so re-registering a new account / using a VPN (new IP) still
// gets caught by the same hardware.
async function banUser({ userId, hwid, ip, reason, bannedBy }) {
  const now = Math.floor(Date.now() / 1000);
  const targetHwids = userId ? await hwidsForUser(userId) : [];
  if (hwid) {
    const hashed = hwidHash(hwid);
    if (hashed && !targetHwids.includes(hashed)) targetHwids.push(hashed);
  }
  let lastId = null;
  const targets = targetHwids.length ? targetHwids : [null];
  for (const h of targets) {
    const res = await dbRun(
      'INSERT INTO bans (userId, hwid, ip, reason, bannedBy, bannedAt, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [userId || 0, h, ip || null, reason || null, bannedBy || null, now]
    );
    lastId = res.lastID;
  }
  return lastId;
}

async function unbanUser(userId) {
  return dbRun('UPDATE bans SET active = 0 WHERE userId = ? AND active = 1', [userId]);
}

async function listActiveBans() {
  return dbAll('SELECT * FROM bans WHERE active = 1 ORDER BY id DESC');
}

// Resolve a target given to /ban: a Discord mention (<@id>), a bare discord
// id (if it has a link), or a plain game userId. Returns { kind, value }.
async function resolveBanTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const mention = raw.match(/^<@!?(\d{15,20})>$/);
  if (mention) return { kind: 'discord', value: mention[1] };
  if (/^\d{15,20}$/.test(raw)) {
    const link = await dbGet('SELECT userId FROM discord_links WHERE discordId = ?', [raw]);
    if (link) return { kind: 'discord', value: raw };
    return { kind: 'user', value: parseInt(raw) };
  }
  if (/^\d{1,14}$/.test(raw)) return { kind: 'user', value: parseInt(raw) };
  return null;
}

async function linkDiscord(discordId, userId) {
  const now = Math.floor(Date.now() / 1000);
  await dbRun(
    'INSERT OR REPLACE INTO discord_links (discordId, userId, linkedAt) VALUES (?, ?, ?)',
    [discordId, userId, now]
  );
}

async function unlinkDiscord(userId) {
  await dbRun('DELETE FROM discord_links WHERE userId = ?', [userId]);
}

async function userIdForDiscord(discordId) {
  const row = await dbGet('SELECT userId FROM discord_links WHERE discordId = ?', [discordId]);
  return row ? row.userId : null;
}

async function discordForUserId(userId) {
  const row = await dbGet('SELECT discordId FROM discord_links WHERE userId = ?', [userId]);
  return row ? row.discordId : null;
}

// ---- JSON row helpers (JSON_* emulation on SQLite) ----
async function getJsonArray(table, keyCol, keyVal, dataCol) {
  const row = await dbGet(`SELECT ${dataCol} FROM ${table} WHERE ${keyCol} = ? LIMIT 1`, [keyVal]);
  if (!row || row[dataCol] == null) return [];
  try {
    const parsed = JSON.parse(row[dataCol]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function setJsonArray(table, keyCol, keyVal, dataCol, value) {
  await dbRun(`INSERT OR REPLACE INTO ${table} (${keyCol}, ${dataCol}) VALUES (?, ?)`, [keyVal, JSON.stringify(value)]);
}

// Merge a JSON array (upsert semantics like JSON_MERGE)
async function mergeJsonArray(table, keyCol, keyVal, dataCol, items) {
  const existing = await getJsonArray(table, keyCol, keyVal, dataCol);
  const merged = existing.concat(items);
  await setJsonArray(table, keyCol, keyVal, dataCol, merged);
}

// ---- Password hashing (scrypt, bcrypt-ish replacement so no native dep needed) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  try {
    const [salt, hash] = stored.split(':');
    const calc = crypto.scryptSync(String(password), salt, 32).toString('hex');
    const a = Buffer.from(calc);
    const b = Buffer.from(hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---- Token helpers (same as main-api-dev webtoken.js) ----
function stripB64(v) {
  return Buffer.from(v).toString('base64').replace(/=+$/, '');
}

function createToken(payload) {
  const salt = stripB64(crypto.randomBytes(32));
  const payloadB64 = stripB64(JSON.stringify(payload));
  const dbToken = `${salt}.${payloadB64}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(dbToken).digest('base64').replace(/=+$/, '');
  const userToken = `${dbToken}.${sig}`;
  return { dbToken, userToken };
}

function verifyToken(userToken, dbToken) {
  if (!userToken || !dbToken) return { isValid: false };
  const parts = userToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[2]) return { isValid: false };
  const expSig = crypto.createHmac('sha256', TOKEN_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64').replace(/=+$/, '');
  const dbSig = crypto.createHmac('sha256', TOKEN_SECRET).update(dbToken).digest('base64').replace(/=+$/, '');
  const safeCmp = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (!safeCmp(parts[2], expSig)) return { isValid: false };
  if (!safeCmp(parts[2], dbSig)) return { isValid: false };
  return { isValid: true, payload: parts[1] };
}

// ---- ID generators ----
let lastIssuedUserId = 0;
let lastIssuedClanId = 0;
async function getNextUserId() {
  const row = await dbGet('SELECT MAX(userId) AS m FROM account');
  let next = (row && row.m ? Number(row.m) : 0) + 16;
  if (next <= lastIssuedUserId) next = lastIssuedUserId + 16; // concurrent registrations
  lastIssuedUserId = next;
  return next;
}

async function getNextClanId() {
  const row = await dbGet('SELECT MAX(clanId) AS m FROM clan');
  let next = (row && row.m ? Number(row.m) : 0) + 4;
  if (next <= lastIssuedClanId) next = lastIssuedClanId + 4;
  lastIssuedClanId = next;
  return next;
}

// ---- Response helpers (dev API format) ----
const Responses = {
  methodNotAllowed: () => ({ status: 400, content: { code: 400, message: 'The method is not supported', data: null } }),
  notFound: () => ({ status: 404, content: { code: 404, message: 'The endpoint is not found', data: null } }),
  success: (data = null) => ({ status: 200, content: { code: 1, message: 'SUCCESS', data } }),
  innerError: () => ({ status: 500, content: { code: 4, message: 'INNER ERROR', data: null } }),
  requiresUserAuthParams: () => ({ status: 400, content: { code: 400, message: 'userId and access-token are expected' } }),
  requiresGameAuthParams: () => ({ status: 400, content: { code: 400, message: 'userId and access-token are expected' } }),
  dispatchAuthFailed: () => ({ status: 401, content: { code: 1001, info: 'Invalid userId or token' } }),
  authFailed: () => ({ status: 401, content: { code: 401, message: 'userId or access-token is invalid' } }),
  userNotExists: () => ({ status: 200, content: { code: 102, message: "The user doesn't exist", data: null } }),
  invalidPassword: () => ({ status: 200, content: { code: 108, message: 'The password is invalid', data: null } }),
  // gcubes (ported from the standalone Gcubes.js service, which always
  // answered HTTP 200 and signalled the outcome through the code field).
  invalidGcubesUserId: () => ({ status: 200, content: { code: 3, message: 'Invalid userId', data: null } }),
  invalidGcubesParams: () => ({ status: 200, content: { code: 3, message: 'Invalid parameters', data: null } }),
  insufficientGcubesBalance: () => ({ status: 200, content: { code: 5, message: 'Insufficient balance', data: null } }),
  gcubesInternalError: () => ({ status: 200, content: { code: 4, message: 'Internal server error', data: null } }),
  profileNotExists: (data = null) => ({ status: 200, content: { code: 1002, message: "The profile doesn't exist", data } }),
  passwordAlreadySet: () => ({ status: 200, content: { code: 3, message: 'The password has already been set', data: null } }),
  profileExists: () => ({ status: 200, content: { code: 1001, message: 'The profile already exists', data: null } }),
  invalidSex: () => ({ status: 400, content: { code: 3, message: 'The sex must be 1 or 2', data: null } }),
  missingRegisterParams: () => ({ status: 400, content: { code: 3, message: 'Expected nickName and sex parameters', data: null } }),
  notValidUser: () => ({ status: 200, content: { code: 3004, message: 'The specified friend id is not a valid user', data: null } }),
  alreadyInClan: () => ({ status: 200, content: { code: 7001, message: 'The user is already in a clan', data: null } }),
  clanNotExists: () => ({ status: 200, content: { code: 7101, message: "The specified clan doesn't exist", data: null } }),
  notEnoughPermissions: () => ({ status: 200, content: { code: 7004, message: "You don't have enough permissions to do this action", data: null } }),
  fileNotFound: () => ({ status: 404, content: { code: 404, message: "The file you tried to access wasn't found", data: null } }),
  fileFound: (file) => ({ status: 200, content: file }),
  dressNotOwned: () => ({ status: 200, content: { code: 4005, message: "User doesn't own this decoration", data: null } }),
  notEnoughWealth: (data = null) => ({ status: 200, content: { code: 5006, message: 'Not enough diamonds or gold', data } }),
  gameNotExists: () => ({ status: 200, content: { code: 2002, message: 'The specified game does not exist', data: null } }),
  notInClan: () => ({ status: 200, content: { code: 7006, message: 'The specified user is not in this clan', data: null } }),
  invalidDonateQuantity: () => ({ status: 200, content: { code: 3, message: 'You need to at least donate 1 of any currency', data: null } }),
  invalidCurrency: () => ({ status: 200, content: { code: 3, message: 'The currency must either be 1 (Diamond) or 2 (Gold)', data: null } }),
  donationExceedsMax: () => ({ status: 200, content: { code: 7011, message: 'The quantity exceeds the donation limit for the specified currency', data: null } }),
  clanMessageNotFound: () => ({ status: 200, content: { code: 11, message: 'The specified userId was not found in the clan messages', data: null } }),
  cannotLeaveClan: () => ({ status: 200, content: { code: 3, message: 'The chief cannot leave its members alone!', data: null } }),
  elderLimitReached: () => ({ status: 200, content: { code: 7010, message: 'Already have the maximum number of elders', data: null } }),
  cannotChangeOwnRole: () => ({ status: 200, content: { code: 3, message: 'You cannnot change your own role', data: null } }),
  alreadyElder: () => ({ status: 200, content: { code: 3, message: 'The specified member is already an elder', data: null } }),
  invalidType: () => ({ status: 200, content: { code: 3, message: 'The specified type is invalid', data: null } }),
  invalidMailStatus: () => ({ status: 200, content: { code: 3, message: 'The specified status is invalid', data: null } }),
  mailNotFound: () => ({ status: 200, content: { code: 2, message: 'The specified mail was not found', data: null } }),
  mailHasNoAttachments: () => ({ status: 200, content: { code: 2, message: "The specified mail doesn't have any attachments", data: null } }),
  alreadyFriend: () => ({ status: 200, content: { code: 3001, message: "You're already friend with this user", data: null } }),
  friendListFull: () => ({ status: 200, content: { code: 3002, message: 'Your friend list is full', data: null } }),
  banned: (reason = null) => ({ status: 403, content: { code: 403, message: 'This account is banned', data: reason ? { reason } : null } })
};

// ---- Page (same as main-api-dev Page.js) ----
class Page {
  constructor(data, totalSize, pageNo, pageSize) {
    this.pageNo = Number(pageNo);
    this.pageSize = Number(pageSize);
    this.totalSize = Number(totalSize);
    if (this.totalSize % pageSize === 0) {
      this.totalPage = (this.totalSize / pageSize);
    } else {
      this.totalPage = Math.floor(this.totalSize / pageSize + 1);
    }
    if (isNaN(this.totalPage)) this.totalPage = 0;
    const startIndex = Page.getStartIndex(this.pageNo, this.pageSize);
    if (Array.isArray(data) && data.length == totalSize) {
      this.data = data.filter((val, i) => i >= startIndex && i < startIndex + this.pageSize);
    } else {
      this.data = Array.isArray(data) ? data : [];
    }
  }

  static getStartIndex(pageNo, pageSize) {
    return pageNo * pageSize;
  }

  static empty() {
    return new Page([], 0, 0, 0);
  }
}

// ---- Enums ----
const Currencies = { ALL: 0, DIAMOND: 1, GOLD: 2, CLAN_GOLD: 3 };
const VipLevels = { NONE: 0, VIP: 1, VIP_PLUS: 2, MVP: 3 };
const ClanRoles = { INVALID: -1, MEMBER: 0, ELDER: 10, CHIEF: 20 };
const ClanDonationTypes = { TASK_ALL: 0, DIAMOND: 1, GOLD: 2, TASK_LEVEL_A: 3, TASK_LEVEL_B: 4, TASK_LEVEL_C: 5, TASK_LEVEL_S: 7 };
const ClanMessageTypes = { JOIN_REQUEST: 0, ELDER_PROMOTION: 1, CHIEF_PROMOTION: 2, MEMBER_REMOVED: 3, MEMBER_LEFT: 4, JOIN_INVITE: 5, RETROGRADED: 6, CLAN_DISSOLVED: 7 };
const ClanPromotionTypes = { ELDER: 1, MEMBER: 2, CHIEF: 3 };
const DressOwnerTypes = { STRICT: 1, TAG_ITEM: 2 };
const MailAttachmentTypes = { CURRENCY: 1, DRESS: 2, VIP: 3 };
const MailStatuses = { UNREAD: 1, READ: 2, DELETE: 3 };
const NoticeTypes = { MAINTENANCE: 'maintenance', ANNOUNCEMENT: 'announcement' };
const RequestStatuses = { PENDING: 0, ACCEPTED: 1, REFUSED: 2 };
const TransactionResults = { ALREADY_PAID: 0, SUCCESS: 1, FAILURE: 2 };
const TransactionTypes = { ADDED: 0, REMOVED: 1 };

// ---- Static configs (inlined from main-api-dev src/config, self-contained) ----
const clanConfig = {
  levels: {
    1: { clanTaskCount: 2, clanTaskCurrency: 100, clanTaskExperience: 32000, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 25, maxDiamondDonate: 6, maxElderCount: 3, maxGoldDonate: 540, personalTaskCount: 3, personalTaskCurrency: 128, personalTaskExperience: 256, taskCompletedCurrencyReward: 256, taskCompletedExperienceReward: 512, upgradeExperience: 500000 },
    2: { clanTaskCount: 2, clanTaskCurrency: 106, clanTaskExperience: 37400, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 27, maxDiamondDonate: 7, maxElderCount: 3, maxGoldDonate: 580, personalTaskCount: 3, personalTaskCurrency: 136, personalTaskExperience: 272, taskCompletedCurrencyReward: 272, taskCompletedExperienceReward: 544, upgradeExperience: 1200000 },
    3: { clanTaskCount: 2, clanTaskCurrency: 112, clanTaskExperience: 43200, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 29, maxDiamondDonate: 8, maxElderCount: 3, maxGoldDonate: 620, personalTaskCount: 3, personalTaskCurrency: 144, personalTaskExperience: 288, taskCompletedCurrencyReward: 288, taskCompletedExperienceReward: 576, upgradeExperience: 3000000 },
    4: { clanTaskCount: 2, clanTaskCurrency: 118, clanTaskExperience: 49400, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 31, maxDiamondDonate: 9, maxElderCount: 3, maxGoldDonate: 660, personalTaskCount: 3, personalTaskCurrency: 152, personalTaskExperience: 304, taskCompletedCurrencyReward: 304, taskCompletedExperienceReward: 608, upgradeExperience: 7000000 },
    5: { clanTaskCount: 2, clanTaskCurrency: 125, clanTaskExperience: 56000, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 33, maxDiamondDonate: 10, maxElderCount: 3, maxGoldDonate: 700, personalTaskCount: 3, personalTaskCurrency: 160, personalTaskExperience: 320, taskCompletedCurrencyReward: 320, taskCompletedExperienceReward: 640, upgradeExperience: 12000000 },
    6: { clanTaskCount: 2, clanTaskCurrency: 131, clanTaskExperience: 63000, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 35, maxDiamondDonate: 11, maxElderCount: 3, maxGoldDonate: 740, personalTaskCount: 3, personalTaskCurrency: 168, personalTaskExperience: 336, taskCompletedCurrencyReward: 336, taskCompletedExperienceReward: 672, upgradeExperience: 18000000 },
    7: { clanTaskCount: 2, clanTaskCurrency: 137, clanTaskExperience: 70400, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 37, maxDiamondDonate: 12, maxElderCount: 3, maxGoldDonate: 780, personalTaskCount: 3, personalTaskCurrency: 176, personalTaskExperience: 352, taskCompletedCurrencyReward: 352, taskCompletedExperienceReward: 704, upgradeExperience: 25000000 },
    8: { clanTaskCount: 2, clanTaskCurrency: 143, clanTaskExperience: 78200, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 39, maxDiamondDonate: 13, maxElderCount: 3, maxGoldDonate: 820, personalTaskCount: 3, personalTaskCurrency: 184, personalTaskExperience: 368, taskCompletedCurrencyReward: 368, taskCompletedExperienceReward: 736, upgradeExperience: 35000000 },
    9: { clanTaskCount: 2, clanTaskCurrency: 150, clanTaskExperience: 86400, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 45, maxDiamondDonate: 14, maxElderCount: 3, maxGoldDonate: 860, personalTaskCount: 3, personalTaskCurrency: 192, personalTaskExperience: 384, taskCompletedCurrencyReward: 384, taskCompletedExperienceReward: 768, upgradeExperience: 50000000 },
    10: { clanTaskCount: 2, clanTaskCurrency: 160, clanTaskExperience: 94600, diamondCurrencyRate: 120, diamondExperienceRate: 120, goldCurrencyRate: 1, goldExperienceRate: 0.5, maxCount: 50, maxDiamondDonate: 15, maxElderCount: 4, maxGoldDonate: 900, personalTaskCount: 3, personalTaskCurrency: 200, personalTaskExperience: 390, taskCompletedCurrencyReward: 390, taskCompletedExperienceReward: 800, upgradeExperience: null }
  },
  vipBoosts: {
    0: { clanTaskCurrencyRate: 1, diamondCurrencyRate: 1, diamondExperienceRate: 1, goldCurrencyRate: 1, goldExperienceRate: 1, maxDiamondDonate: 1, maxGoldDonate: 1, personalTaskCurrencyRate: 1, personalTaskExperienceRate: 1 },
    1: { clanTaskCurrencyRate: 1.2, diamondCurrencyRate: 1, diamondExperienceRate: 1.2, goldCurrencyRate: 1, goldExperienceRate: 1.2, maxDiamondDonate: 1.5, maxGoldDonate: 1.5, personalTaskCurrencyRate: 1.2, personalTaskExperienceRate: 1.2 },
    2: { clanTaskCurrencyRate: 1.5, diamondCurrencyRate: 1, diamondExperienceRate: 1.5, goldCurrencyRate: 1, goldExperienceRate: 1.5, maxDiamondDonate: 2, maxGoldDonate: 2, personalTaskCurrencyRate: 1.5, personalTaskExperienceRate: 1.5 },
    3: { clanTaskCurrencyRate: 2, diamondCurrencyRate: 1, diamondExperienceRate: 2, goldCurrencyRate: 1, goldExperienceRate: 2, maxDiamondDonate: 3, maxGoldDonate: 3, personalTaskCurrencyRate: 2, personalTaskExperienceRate: 2 }
  }
};
const luckyWheelConfig = {
  activityDesc: 'Activity',
  activityEndTime: '2019-06-29',
  remainingTime: 10000000000000,
  gold: {
    drawRewardCount: 0, frequency: 10, luckyValueUpperLimit: 1000, singleQuantity: 100, multiQuantity: 450, oneIncreaseValue: 0,
    rewardInfoList: [
      { pic: 'http://192.168.1.35:3888/gold_block.png', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 1, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 2, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 3, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/Bcubes.png', rewardId: 4, rewardName: '1', rewardType: 'diamond' },
      { pic: '', rewardId: 5, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 6, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/VIP.png', rewardId: 7, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/MVP.png', rewardId: 8, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 9, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 10, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 11, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/Bcubes.png', rewardId: 12, rewardName: '3', rewardType: 'diamond' },
      { pic: '', rewardId: 13, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 14, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/Bcubes.png', rewardId: 15, rewardName: '50', rewardType: 'diamond' }
    ]
  },
  diamond: {
    drawRewardCount: 0, frequency: 10, luckyValueUpperLimit: 400, singleQuantity: 10, multiQuantity: 45, oneIncreaseValue: 0,
    rewardInfoList: [
      { pic: 'http://192.168.1.35:3888/colorful_block.png', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/Bcubes.png', rewardId: 0, rewardName: '100', rewardType: 'diamond' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/VIPplus.png', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/Bcubes.png', rewardId: 0, rewardName: '10', rewardType: 'diamond' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/VIP.png', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/Bcubes.png', rewardId: 0, rewardName: '20', rewardType: 'diamond' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: '', rewardId: 0, rewardName: '', rewardType: '' },
      { pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/MVP.png', rewardId: 0, rewardName: '', rewardType: '' }
    ]
  }
};
const rechargeConfig = [
  { id: 7, productId: 'and.diamond.1', type: 'cube', price: 0, gift: 6, name: 'Bcubes', desc: 'Bcubes', diamonds: 60 },
  { id: 8, productId: 'and.diamond.5', type: 'cube', price: 0, gift: 30, name: 'Bcubes', desc: 'Bcubes', diamonds: 300 },
  { id: 9, productId: 'and.diamond.10', type: 'cube', price: 0, gift: 60, name: 'Bcubes', desc: 'Bcubes', diamonds: 600 },
  { id: 10, productId: 'and.diamond.25', type: 'cube', price: 0, gift: 165, name: 'Bcubes', desc: 'Bcubes', diamonds: 1650 },
  { id: 11, productId: 'and.diamond.50', type: 'cube', price: 0, gift: 360, name: 'Bcubes', desc: 'Bcubes', diamonds: 3600 },
  { id: 12, productId: 'and.diamond.100', type: 'cube', price: 0, gift: 840, name: 'Bcubes', desc: 'Bcubes', diamonds: 8400 }
];
const firstRechargeConfig = [
  { type: 'decoration', name: { en_US: 'Rich Glasses' }, url: 'http://static.sandboxol.com/sandbox/images/banner/custom_glasses.3-.png', id: 261 },
  { type: 'decoration', name: { en_US: 'Rich T_shirt' }, url: 'http://static.sandboxol.com/sandbox/images/banner/clothes_tops.34.png', id: 259 },
  { type: 'decoration', name: { en_US: 'Rich Shorts' }, url: 'http://static.sandboxol.com/sandbox/images/banner/clothes_pants.34.png', id: 260 },
  { type: 'diamond', name: { en_US: '100 Bcubes' }, url: 'http://static.sandboxol.com/sandbox/images/banner/cube.png', quantity: 100 },
  { type: 'gold', name: { en_US: '6999 Gold' }, url: 'http://static.sandboxol.com/sandbox/images/banner/gold.png', quantity: 6999 }
];
const discountsConfig = { vipShopDiscount: 10, mvpShopDiscount: 20 };
const groupChatConfig = { currency: 1, price: 60 };
const nicknameConfig = { currencyType: 1, quantity: 50 };

const WEALTH_TYPES = { 0: 'golds', 1: 'diamonds', 2: 'golds', 3: 'clanGolds' };

// ---- Model helpers ----
async function accountFromUserId(userId) {
  return await dbGet('SELECT * FROM account WHERE userId = ?', [userId]);
}

async function userFromUserId(userId) {
  return await dbGet('SELECT * FROM user WHERE userId = ?', [userId]);
}

async function userExists(userId) {
  const row = await dbGet('SELECT COUNT(1) AS c FROM user WHERE userId = ?', [userId]);
  return row && row.c == 1;
}

function userResponse(row) {
  if (!row) return null;
  return {
    userId: row.userId,
    nickName: row.nickName,
    sex: row.sex,
    picUrl: row.picUrl,
    details: row.details,
    birthday: row.birthday
  };
}

async function vipFromUserId(userId) {
  const row = await dbGet('SELECT * FROM vip WHERE userId = ?', [userId]);
  if (row) {
    return { userId, vip: row.vip, expireDate: row.expireDate };
  }
  return { userId, vip: 0, expireDate: 0 };
}

function vipResponse(v) {
  return { vip: v.vip, expireDate: v.expireDate };
}

// Max riches granted to every player (stored currency: golds, diamonds,
// clanGolds). Applied to existing players at startup via backfillMaxWealth()
// and to every newly created account/profile via seedMaxWealth().
const MAX_WEALTH = { golds: 99999, diamonds: 99999, clanGolds: 99999 };

async function wealthFromUserId(userId) {
  const row = await dbGet('SELECT * FROM wealth WHERE userId = ?', [userId]);
  if (row) return { userId: row.userId, golds: row.golds, diamonds: row.diamonds, clanGolds: row.clanGolds };
  // No wealth row: everyone (new or missing) starts at the max granted riches
  // so existing players and any player created through any path has them.
  return { userId, ...MAX_WEALTH };
}

async function wealthSave(w) {
  await dbRun(
    'INSERT INTO wealth (userId, golds, diamonds, clanGolds) VALUES (?, ?, ?, ?) ON CONFLICT(userId) DO UPDATE SET golds=excluded.golds, diamonds=excluded.diamonds, clanGolds=excluded.clanGolds',
    [w.userId, w.golds, w.diamonds, w.clanGolds]
  );
}

// Grant the max wealth to a player (create the row first time, top it up
// otherwise). Keeps every newly created player at the max balance.
async function seedMaxWealth(userId) {
  if (userId == null) return;
  await wealthSave({ userId, ...MAX_WEALTH });
}

// Backfill: every existing account/profile that lacks a wealth row gets one
// set to MAX_WEALTH, and any existing row is topped up to MAX_WEALTH so all
// current players have the granted balance after an upgrade.
async function backfillMaxWealth() {
  try {
    const rows = await dbAll('SELECT userId FROM account UNION SELECT userId FROM user');
    if (!rows || rows.length === 0) return;
    for (const r of rows) await seedMaxWealth(r.userId);
    console.log(`[WEALTH] Granted max balance to ${rows.length} player(s)`);
  } catch (e) {
    console.error('[WEALTH] backfillMaxWealth error:', e.message);
  }
}

// Max gcubes granted to every player. Mirrors MAX_WEALTH: applied to existing
// players at startup via backfillMaxGcubes() and to every newly created
// account/profile via seedGcubes().
const MAX_GCUBES = 999999;

// Set a player's gcubes to the granted amount (insert first time, overwrite
// otherwise) and drop any cached balance so the new value is visible right
// away instead of after the cache TTL.
async function seedGcubes(userId) {
  if (userId == null) return;
  await dbRun(
    'INSERT INTO gcubes_balance (userId, gcubes) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET gcubes = excluded.gcubes',
    [userId, MAX_GCUBES]
  );
  // Best effort: the row above is the source of truth, so a cache problem here
  // must never fail the grant.
  try {
    await kvDel(`gcubes:${userId}`);
  } catch (e) {
    // ignore - the balance is already persisted
  }
}

// Backfill every existing account/profile to MAX_GCUBES on each server start.
// Wrapped in try/catch so a failure can never take the server down.
async function backfillMaxGcubes() {
  try {
    const rows = await dbAll('SELECT userId FROM account UNION SELECT userId FROM user');
    if (!rows || rows.length === 0) return;
    for (const r of rows) await seedGcubes(r.userId);
    console.log(`[GCUBES] Granted ${MAX_GCUBES} gcubes to ${rows.length} player(s)`);
  } catch (e) {
    console.error('[GCUBES] backfillMaxGcubes error:', e.message);
  }
}

async function addTransaction(userId, currency, inoutType, quantity, transactionType) {
  const orderId = crypto.randomBytes(8).toString('hex');
  await dbRun(
    'INSERT INTO wealth_record (userId, created, currency, inoutType, orderId, qty, status, transactionType) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, Date.now(), currency, inoutType, orderId, quantity, TransactionResults.SUCCESS, transactionType]
  );
  return orderId;
}

// ---- pay base ----
async function addCurrency(userId, currencyType, amount, type) {
  if (amount === 0 || amount == null) return { hasFailed: false };
  const wealth = await wealthFromUserId(userId);
  const key = WEALTH_TYPES[currencyType];
  if (!key || !(key in wealth)) return { hasFailed: false };
  wealth[key] += amount;
  await wealthSave(wealth);
  const orderId = await addTransaction(userId, currencyType, TransactionTypes.ADDED, amount, type);
  return { hasFailed: false, orderId, balance: wealth };
}

async function hasEnoughCurrency(userId, currencyType, amount) {
  if (amount === 0 || amount == null) return true;
  const wealth = await wealthFromUserId(userId);
  const key = WEALTH_TYPES[currencyType];
  return (key in wealth) ? wealth[key] >= amount : false;
}

async function removeCurrency(userId, currencyType, amount, type) {
  if (amount === 0 || amount == null) return { hasFailed: false };
  const wealth = await wealthFromUserId(userId);
  const key = WEALTH_TYPES[currencyType];
  if (!(key in wealth)) return { hasFailed: false };
  let currentAmount = wealth[key];
  currentAmount = currentAmount - Math.floor(amount) < 0 ? 0 : currentAmount - Math.floor(amount);
  wealth[key] = currentAmount;
  await wealthSave(wealth);
  const orderId = await addTransaction(userId, currencyType, TransactionTypes.REMOVED, Math.floor(amount), type);
  return { hasFailed: false, orderId, balance: wealth };
}

// ---- user base ----
async function addVip(userId, vipLevel, days) {
  const vip = await vipFromUserId(userId);
  vip.vip = vipLevel;
  const dayMs = 24 * 60 * 60 * 1000;
  const base = Math.max(Number(vip.expireDate) || 0, Date.now());
  vip.expireDate = base + (Number(days) > 0 ? Number(days) : 0) * dayMs;
  await dbRun('INSERT INTO vip (userId, vip, expireDate) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET vip=excluded.vip, expireDate=excluded.expireDate', [vip.userId, vip.vip, vip.expireDate]);
}

// ---- decoration base ----
async function getOwnedDresses(userId) {
  return await getJsonArray('dressing_owned', 'userId', userId, 'data');
}

async function getEquippedDresses(userId) {
  return await getJsonArray('dressing_equipped', 'userId', userId, 'data');
}

async function addDresses(userId, dresses) {
  const owned = await getOwnedDresses(userId);
  const merged = Array.from(new Set(owned.concat(dresses.map(String).map(Number))));
  await setJsonArray('dressing_owned', 'userId', userId, 'data', merged);
}

async function setEquippedDresses(userId, equippedDresses) {
  await setJsonArray('dressing_equipped', 'userId', userId, 'data', equippedDresses);
}

// ---- Dressing / decoration catalog ----
const dressingTypes = {
  2: 'hair', 3: 'glasses', 4: 'face', 5: 'idle', 6: 'skin', 7: 'background',
  8: 'tops', 9: 'pants', 10: 'shoes', 11: 'hat', 13: 'scarf', 14: 'wing', 15: 'crown'
};
const dressesCategory = { 8: 1, 9: 1, 10: 1, 2: 2, 11: 3, 13: 3, 14: 3, 15: 3, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
const dressesGameType = {
  2: 'custom_hair', 3: 'custom_glasses', 4: 'custom_face', 5: 'animation_idle', 6: 'skin_color',
  8: 'clothes_tops', 9: 'clothes_pants', 10: 'custom_shoes', 11: 'custom_hat', 13: 'custom_scarf',
  14: 'custom_wing', 15: 'custom_crown'
};
const decorationCategories = {};

// Icon base is resolved per request (see middleware) so icons always point at
// the host the client actually used, not whatever was detected at boot.
let ICON_BASE = `${apiHost()}/database/files/icons`;
function withIconBase(it) {
  return it.iconUrl != null ? { ...it, iconUrl: String(it.iconUrl).replace('{base}', ICON_BASE) } : { ...it };
}

function initDressingCatalog() {
  for (const typeId of Object.keys(dressesCategory)) {
    const categoryId = dressesCategory[typeId];
    const p = path.join(DB_FILES, 'decorations', `${dressingTypes[typeId]}.json`);
    if (!fs.existsSync(p)) {
      console.log(`DRESSING ERROR: FAILED AT OBJECT '${dressingTypes[typeId]}'`);
      continue;
    }
    decorationCategories[categoryId] = decorationCategories[categoryId] || [];
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(data)) continue;
    decorationCategories[categoryId] = decorationCategories[categoryId].concat(data);
  }
}

function getDresses(options) {
  if (decorationCategories[options.categoryId] == undefined) return [];
  return decorationCategories[options.categoryId].map(withIconBase).filter((item) => {
    item.status = 0;
    if (options.usingFilter != undefined && options.usingFilter.includes(item.id)) {
      item.status = 1;
      return true;
    }
    if (options.ownerFilter != undefined && options.ownerType == DressOwnerTypes.STRICT) {
      return options.ownerFilter.includes(item.id);
    }
    if (options.hideClanDresses && item.clanLevel > 0) return false;
    if (options.hideFreeDresses && item.currency == 0) return false;
    const sexValidator = item.sex == options.sex || item.sex == 0;
    const currencyValidator = item.currency == options.currency || options.currency == 0;
    if (options.ownerFilter != undefined && options.ownerType == DressOwnerTypes.TAG_ITEM && options.ownerFilter.includes(item.id)) {
      item.hasPurchase = 1;
    }
    return (sexValidator && currencyValidator);
  });
}

function getDressInfo(decorationId) {
  if (decorationId == undefined) return null;
  decorationId = decorationId.toString();
  if (decorationId.length <= 5) return null;
  const dressTypeId = decorationId.substring(0, decorationId.length - 5);
  const categoryId = dressesCategory[dressTypeId];
  if (decorationCategories[categoryId] == undefined) return null;
  const found = decorationCategories[categoryId].find((item) => item.id.toString() == decorationId);
  return found ? withIconBase(found) : null;
}

function getGameDresses(decorationIds) {
  const skin = {};
  for (let i = 0; i < decorationIds.length; i++) {
    const dressInfo = getDressInfo(decorationIds[i]);
    if (!dressInfo || dressesGameType[dressInfo.typeId] == undefined) continue;
    if (dressInfo.typeId == 6) {
      skin['skin_color'] = dressInfo.resourceId;
    } else {
      skin[dressesGameType[dressInfo.typeId]] = String(dressInfo.resourceId).split('.')[1];
    }
  }
  return skin;
}

// ---- Game helpers ----
function gameResponse(row) {
  let types = row.gameTypes;
  if (typeof types === 'string') { try { types = JSON.parse(types); } catch { types = []; } }
  if (!Array.isArray(types)) types = [];
  return {
    gameId: row.gameId,
    gameTitle: row.gameName,
    gameCoverPic: row.iconUrl,
    gameTypes: types,
    praiseNumber: row.likeCount || 0
  };
}

async function gameFromGameId(gameId) {
  return await dbGet('SELECT * FROM game WHERE gameId = ?', [gameId]);
}

async function listGames(pageNo, pageSize) {
  const countRow = await dbGet('SELECT COUNT(1) AS c FROM game');
  const totalSize = countRow ? countRow.c : 0;
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const rows = await dbAll('SELECT * FROM game LIMIT ? OFFSET ?', [pageSize, startIndex]);
  return new Page(rows.map(gameResponse), totalSize, pageNo, pageSize);
}

async function listRealGames(pageNo, pageSize, req) {
  const gids = Array.from(GID_SERVERS.keys()).sort();
  const totalSize = gids.length;
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const slice = gids.slice(startIndex, startIndex + pageSize);
  const rows = slice.map((gid) => ({
    gameId: gid,
    gameTitle: gidName(gid) || gid,
    gameName: gidName(gid) || gid,
    gameCoverPic: `${cdnHost(req)}/database/files/game-icons/${gid}.png`,
    gameTypes: [0, 1],
    praiseNumber: 0
  }));
  return new Page(rows, totalSize, pageNo, pageSize);
}

async function listPartyGames() {
  const rows = await dbAll('SELECT * FROM game WHERE partyEnabled = 1');
  return rows;
}

async function gameDetailFromGameId(gameId) {
  return await dbGet('SELECT * FROM game_detail WHERE gameId = ?', [gameId]);
}

// Load the game description exactly like the stub does: read the
// details/<gameId>.json file, falling back to unknown.json when missing.
// Stub reference: D:\stubs\services\hardcode\controller.js (qq function).
function gameDetailFromFile(gameId) {
  for (const lang of ['RU', 'EN']) {
    const file = path.join(CDN_ROOT, 'details', lang, `${gameId}.json`);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`Error parsing detail ${file}:`, e.message); }
    }
  }
  const unknown = path.join(CDN_ROOT, 'details', 'RU', 'unknown.json');
  if (fs.existsSync(unknown)) {
    try { return JSON.parse(fs.readFileSync(unknown, 'utf8')); } catch (e) { console.error(`Error parsing ${unknown}:`, e.message); }
  }
  return null;
}

async function gameUpdateFromGameId(gameId) {
  return await dbGet('SELECT * FROM game_update WHERE gameId = ?', [gameId]);
}

async function gameLikeFromUserId(userId) {
  const row = await dbGet('SELECT games FROM game_like WHERE userId = ?', [userId]);
  if (!row) return { appreciate: false };
  let games = [];
  try { games = JSON.parse(row.games) || []; } catch { games = []; }
  return { appreciate: games.includes((arguments[1] !== undefined) ? arguments[1] : row.userId) };
}

async function gameLikeResponse(userId, gameId) {
  const row = await dbGet('SELECT games FROM game_like WHERE userId = ?', [userId]);
  let games = [];
  if (row) { try { games = JSON.parse(row.games) || []; } catch { games = []; } }
  return { appreciate: games.map(String).includes(String(gameId)) };
}

// ---- Friend helpers ----
async function friendIsFriend(userId, friendId) {
  const row = await dbGet('SELECT COUNT(1) AS c FROM friend WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)', [userId, friendId, friendId, userId]);
  return row && row.c === 2;
}

async function friendListIdsFromUserId(userId) {
  const rows = await dbAll('SELECT friendId FROM friend WHERE userId = ?', [userId]);
  return rows.map(r => Number(r.friendId));
}

async function friendListFromUserId(userId, pageNo, pageSize) {
  const countRow = await dbGet('SELECT COUNT(1) AS c FROM friend WHERE userId = ?', [userId]);
  const totalSize = countRow ? countRow.c : 0;
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const rows = await dbAll('SELECT * FROM friend WHERE userId = ? LIMIT ? OFFSET ?', [userId, pageSize, startIndex]);
  return new Page(rows, totalSize, pageNo, pageSize);
}

async function friendSearch(userId, query, excludeList, pageNo, pageSize) {
  if (!excludeList || excludeList.length == 0) excludeList = [0];
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const placeholders = excludeList.map(() => '?').join(',');
  const rows = await dbAll(
    `SELECT * FROM user WHERE nickName LIKE ? AND userId != ? AND userId NOT IN (${placeholders}) LIMIT ? OFFSET ?`,
    [`${query}%`, userId, ...excludeList, pageSize, startIndex]
  );
  const countRow = await dbGet('SELECT COUNT(1) AS c FROM user WHERE nickName LIKE ? AND userId != ?', [`${query}%`, userId]);
  return new Page(rows.map(userResponse), countRow ? countRow.c : 0, pageNo, pageSize);
}

async function friendGetInfo(userId) {
  const user = await userFromUserId(userId);
  if (!user) return null;
  const vip = await vipFromUserId(userId);
  let clanInfo = {};
  const clanMember = await dbGet('SELECT * FROM clan_member WHERE userId = ?', [userId]);
  if (clanMember && clanMember.clanId != 0) {
    const clan = await dbGet('SELECT * FROM clan WHERE clanId = ?', [clanMember.clanId]);
    if (clan) {
      clanInfo = { clanId: clan.clanId, clanName: clan.name, role: clanMember.role };
    }
  }
  return { ...userResponse(user), ...vipResponse(vip), ...clanInfo };
}

async function friendFromUserId(userId, friendId) {
  return await dbGet('SELECT * FROM friend WHERE userId = ? AND friendId = ?', [userId, friendId]);
}

async function friendAddFriend(userId, friendId) {
  await dbRun('INSERT OR IGNORE INTO friend (userId, friendId) VALUES (?, ?)', [userId, friendId]);
  await dbRun('INSERT OR IGNORE INTO friend (userId, friendId) VALUES (?, ?)', [friendId, userId]);
}

async function friendRemoveFriend(userId, friendId) {
  await dbRun('DELETE FROM friend WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)', [userId, friendId, friendId, userId]);
}

async function friendRequestFromFriendId(userId, friendId) {
  return await dbGet('SELECT * FROM friend_request WHERE userId = ? AND friendId = ?', [userId, friendId]);
}

async function friendRequestListFromUserId(userId, pageNo, pageSize) {
  const countRow = await dbGet('SELECT COUNT(1) AS c FROM friend_request WHERE userId = ?', [userId]);
  const totalSize = countRow ? countRow.c : 0;
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const rows = await dbAll('SELECT * FROM friend_request WHERE userId = ? ORDER BY creationTime DESC LIMIT ? OFFSET ?', [userId, pageSize, startIndex]);
  const data = rows.map(r => ({
    msg: r.message, nickName: r.nickName, picUrl: r.picUrl, requestId: r.requestId,
    status: r.status, userId: r.friendId, language: r.language, country: r.country, sex: r.sex
  }));
  return new Page(data, totalSize, pageNo, pageSize);
}

async function saveFriendRequest(r) {
  const existing = await friendRequestFromFriendId(r.userId, r.friendId);
  if (existing) {
    await dbRun('UPDATE friend_request SET message = ?, status = ? WHERE userId = ? AND friendId = ?', [r.message, r.status, r.userId, r.friendId]);
  } else {
    await dbRun(
      'INSERT INTO friend_request (userId, friendId, message, picUrl, nickName, sex, country, language, status, creationTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.userId, r.friendId, r.message, r.picUrl, r.nickName, r.sex, r.country, r.language, RequestStatuses.PENDING, r.creationTime]
    );
  }
}

// ---- Mail helpers ----
async function getMailboxByUserId(userId, removeReadMails) {
  let userMails = await getJsonArray('mailbox', 'userId', userId, 'data');
  let globalMails = await getJsonArray('mailbox', 'userId', 0, 'data');
  let mails = userMails.concat(globalMails);
  for (const m of mails) { if (m.status == null) m.status = MailStatuses.UNREAD; }
  let readMails = await getJsonArray('mailbox_record', 'userId', userId, 'data');
  for (let i = 0; i < mails.length; i++) {
    for (let j = 0; j < readMails.length; j++) {
      if (mails[i].id == readMails[j].id) {
        mails[i].status = readMails[j].status;
      }
    }
  }
  mails = mails.filter((m, idx, arr) => m.status !== MailStatuses.DELETE && !(removeReadMails && m.status === MailStatuses.READ));
  return mails;
}

// ---- Clan helpers ----
function clanResponse(row, shownMembers) {
  const levelConfig = clanConfig.levels[row.level] || clanConfig.levels[1];
  let tags = row.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
  if (!Array.isArray(tags)) tags = [];
  return {
    clanId: row.clanId,
    currentCount: row.memberCount,
    details: row.details,
    experience: row.experience,
    headPic: row.picUrl,
    level: row.level,
    name: row.name,
    maxCount: levelConfig.maxCount,
    clanMembers: shownMembers,
    tags: tags,
    freeVerify: row.freeVerify
  };
}

async function clanFromClanId(clanId) {
  return await dbGet('SELECT * FROM clan WHERE clanId = ?', [clanId]);
}

async function clanExists(clanId) {
  const row = await dbGet('SELECT COUNT(1) AS c FROM clan WHERE clanId = ?', [clanId]);
  return row && row.c == 1;
}

async function clanMemberFromUserId(userId) {
  const row = await dbGet('SELECT * FROM clan_member WHERE userId = ?', [userId]);
  if (row) return row;
  return { userId, clanId: 0, role: ClanRoles.INVALID, experience: 0 };
}

async function clanMemberGetInfo(member) {
  if (!member.clanId) return null;
  const user = await userFromUserId(member.userId);
  const vip = await vipFromUserId(member.userId);
  return {
    userId: member.userId,
    clanId: member.clanId,
    role: member.role,
    experience: member.experience,
    expireDate: vip.expireDate,
    headPic: user ? user.picUrl : '',
    nickName: user ? user.nickName : '',
    vip: vip.vip
  };
}

async function clanGetMembers(clanId, onlyAuthorities) {
  const members = [];
  const filter = onlyAuthorities ? ' AND role > ?' : '';
  const params = onlyAuthorities ? [clanId, ClanRoles.MEMBER] : [clanId];
  const rows = await dbAll(`SELECT * FROM clan_member WHERE clanId = ?${filter}`, params);
  for (const r of rows) {
    const info = await clanMemberGetInfo(r);
    if (info) members.push(info);
  }
  return members;
}

async function clanGetElderCount(clanId) {
  const row = await dbGet('SELECT COUNT(1) AS c FROM clan_member WHERE clanId = ? AND role = ?', [clanId, ClanRoles.ELDER]);
  return row ? row.c : 0;
}

async function clanAddMember(clanId, userId, role, memberCount) {
  await dbRun('INSERT INTO clan_member (userId, clanId, role, experience) VALUES (?, ?, ?, 0) ON CONFLICT(userId) DO UPDATE SET clanId=excluded.clanId, role=excluded.role', [userId, clanId, role]);
  memberCount.memberCount += 1;
}

async function clanRemoveMember(clanId, userId) {
  const member = await clanMemberFromUserId(userId);
  if (member.clanId != clanId) return false;
  await dbRun('DELETE FROM clan_member WHERE userId = ?', [userId]);
  return true;
}

function clanAddExperience(clan, experience) {
  clan.experience += experience;
  const levelConfig = clanConfig.levels[clan.level];
  if (levelConfig && levelConfig.upgradeExperience != null && clan.experience >= levelConfig.upgradeExperience) {
    clan.level += 1;
  }
}

async function clanSave(clan) {
  await dbRun(
    'UPDATE clan SET name=?, picUrl=?, tags=?, details=?, experience=?, level=?, memberCount=?, freeVerify=?, language=?, creationTime=? WHERE clanId=?',
    [clan.name, clan.picUrl, JSON.stringify(clan.tags || []), clan.details, clan.experience, clan.level, clan.memberCount, clan.freeVerify, clan.language, clan.creationTime, clan.clanId]
  );
}

async function clanSearch(clanId, query, pageNo, pageSize) {
  const countRow = await dbGet('SELECT COUNT(1) AS c FROM clan WHERE name LIKE ? AND clanId != ?', [`${query}%`, clanId]);
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const rows = await dbAll('SELECT * FROM clan WHERE name LIKE ? AND clanId != ? LIMIT ? OFFSET ?', [`${query}%`, clanId, pageSize, startIndex]);
  return new Page(rows.map(r => clanResponse(r, [])), countRow ? countRow.c : 0, pageNo, pageSize);
}

async function clanMessageFindFirst(userId, type, status) {
  return await dbGet('SELECT * FROM clan_message WHERE userId = ? AND type = ? AND status = ? LIMIT 1', [userId, type, status]);
}

function clanMessageResponse(r) {
  return { clanId: r.clanId, headPic: r.picUrl, id: r.messageId, nickName: r.nickName, status: r.status, type: r.type, userId: r.userId, msg: r.message };
}

async function clanMessageListFromFilter(filter, pageNo, pageSize) {
  const countRow = await dbGet(`SELECT COUNT(1) AS c FROM clan_message WHERE ${filter.where}`, filter.params);
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const rows = await dbAll(`SELECT * FROM clan_message WHERE ${filter.where} ORDER BY creationTime DESC LIMIT ? OFFSET ?`, [...filter.params, pageSize, startIndex]);
  return new Page(rows.map(clanMessageResponse), countRow ? countRow.c : 0, pageNo, pageSize);
}

async function clanMessageSave(m) {
  const existing = await dbGet('SELECT messageId FROM clan_message WHERE messageId = ?', [m.messageId]);
  const values = [m.clanId, m.authorityId, m.message, m.picUrl, m.nickName, m.type, m.status, m.creationTime];
  if (existing) {
    await dbRun('UPDATE clan_message SET clanId=?, authorityId=?, message=?, picUrl=?, nickName=?, type=?, status=?, creationTime=? WHERE messageId=?', [...values, m.messageId]);
  } else {
    await dbRun(
      'INSERT INTO clan_message (userId, clanId, authorityId, message, picUrl, nickName, type, status, creationTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [m.userId, ...values]
    );
  }
}

async function clanNoticeFromClanId(clanId) {
  return await dbGet('SELECT * FROM clan_notice WHERE clanId = ?', [clanId]);
}

async function clanNoticeSave(clanId, content) {
  await dbRun('INSERT INTO clan_notice (clanId, content) VALUES (?, ?) ON CONFLICT(clanId) DO UPDATE SET content=excluded.content', [clanId, content]);
}

async function clanDonationHistoryFromClanId(clanId, pageNo, pageSize) {
  const countRow = await dbGet('SELECT COUNT(1) AS c FROM clan_donation WHERE clanId = ?', [clanId]);
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const rows = await dbAll('SELECT * FROM clan_donation WHERE clanId = ? ORDER BY creationTime DESC LIMIT ? OFFSET ?', [clanId, pageSize, startIndex]);
  const data = rows.map(r => ({
    date: r.creationTime, experienceGot: r.expReward, nickName: r.nickName, quantity: r.amount,
    tribeCurrencyGot: r.clanGoldReward, type: r.type, userId: r.userId
  }));
  return new Page(data, countRow ? countRow.c : 0, pageNo, pageSize);
}

// ---- Dev API router (same auth flow as main-api-dev router.js) ----
const bypassAuthCheck = [
  '/config/files/:configFile',
  '/user/api/v1/app/renew',
  '/user/api/v1/app/login',
  '/user/api/v1/register',
  '/user/api/v1/user/password',
  '/user/api/v1/emails/password/reset',
  '/user/api/v1/sms/send/refound',
  '/game/api/v1/games/announcement/info',
  '/game/api/v1/games/stop/announcement/info',
  // Engine/resource handshake. The client runs these during boot with a
  // possibly stale token, and a rejection here blocks startup outright, so
  // they are always answered regardless of auth or reported version.
  '/game/api/v1/games/resource/version',
  '/game/api/v1/games/engine',
  // Indiegame launcher config. IUserApi/IVersionApi declare these with no
  // auth headers at all, and they run before the client has a token.
  '/api/v1/config/indiegame-check-version',
  '/api/v1/config/indiegame-config',
  '/api/v1/config/indiegame-moregame_introduction',
  '/user/api/v1/user/mac/id'
];
const bypassProfileCheck = [
  '/user/api/v1/login-out',
  '/user/api/v1/app/set-password',
  '/user/api/v1/user/password/modify',
  '/user/api/v1/user/register'
];

async function runUserAuthentication(req) {
  req.getUserId = () => parseInt(req.headers['userid']);
  if (!req.headers['userid'] || !req.headers['access-token']) {
    return { hasSucceeded: false, response: Responses.requiresUserAuthParams() };
  }
  const userId = req.getUserId();
  if (!userId) {
    return { hasSucceeded: false, response: Responses.authFailed() };
  }
  const account = await accountFromUserId(userId);
  if (!account) {
    return { hasSucceeded: false, response: Responses.authFailed() };
  }
  const { isValid } = verifyToken(req.headers['access-token'], account.accessToken);
  if (!isValid) {
    return { hasSucceeded: false, response: Responses.authFailed() };
  }
  return { hasSucceeded: true };
}

async function runCheckForUserProfile(req) {
  const exists = await userExists(req.getUserId());
  if (!exists) return { hasProfile: false, response: Responses.profileNotExists() };
  return { hasProfile: true };
}

function createDevEndpoint(app, endpointPath, methods, functions) {
  app.all(endpointPath, async (req, res) => {
    try {
      const startTime = Date.now();
      const methodIndex = methods.indexOf(req.method);
      if (methodIndex === -1) {
        const r = Responses.methodNotAllowed();
        res.status(r.status).json(r.content);
        return;
      }

      req.getUserId = () => parseInt(req.headers['userid']);

      if (!bypassAuthCheck.includes(endpointPath)) {
        const { hasSucceeded, response } = await runUserAuthentication(req);
        if (!hasSucceeded) {
          res.status(response.status).json(response.content);
          return;
        }
        if (!bypassProfileCheck.includes(endpointPath)) {
          const { hasProfile, response } = await runCheckForUserProfile(req);
          if (!hasProfile) {
            res.status(response.status).json(response.content);
            return;
          }
        }
      }

      const response = await functions[methodIndex](req);
      if (!response || !response.content) {
        const r = Responses.innerError();
        res.status(r.status).json(r.content);
        return;
      }
      res.status(response.status).json(response.content);
      console.log(`[${req.url}] Sent ${req.method}: ${response.status} Operation took ${Date.now() - startTime}ms`);
    } catch (e) {
      console.error(`Error occurred with API: ${req.url}`);
      console.error(e);
      const r = Responses.innerError();
      res.status(r.status).json(r.content);
    }
  });
}

// =====================================================================
//  STATIC / CONFIG / FILE ENDPOINTS (dev)
// =====================================================================

app.all('/api/v1/launch/info', async (req, res) => {
  // Optional launcher identity: the launcher sends x-userid / x-access-token
  // / x-hwid. When present we validate the token, log the hwid, and refuse to
  // serve launch info to banned accounts / banned hardware.
  const claimedUid = parseInt(req.headers['userid'] || req.headers['x-userid']);
  const accessToken = req.headers['access-token'] || req.headers['x-access-token'];
  const rawHwid = req.headers['x-hwid'] || req.headers['hwid'];

  // A valid logged-in account is REQUIRED to launch. Hand the caller a
  // 401 json so the launcher can tell the user to log in.
  let launcherUser = null;
  if (claimedUid && accessToken) {
    const account = await accountFromUserId(claimedUid);
    if (account) {
      const { isValid } = verifyToken(accessToken, account.accessToken);
      if (isValid) {
        launcherUser = claimedUid;
        await logHwid(claimedUid, rawHwid, CLIENT_IP.from(req));
        const uidBan = await activeBanForUser(claimedUid);
        if (uidBan) {
          return res.status(403).json({ banned: true, reason: uidBan.reason || 'This account is banned', code: 403 });
        }
      }
    }
  }
  if (launcherUser == null) {
    return res.status(401).json({ loginRequired: true, message: 'Log in on the website first, then launch from /my/games', code: 401 });
  }
  if (rawHwid) {
    // Ban by hardware id still applies even for a valid account.
    const hwBan = await activeBanForHwid(rawHwid);
    if (hwBan) {
      return res.status(403).json({ banned: true, reason: hwBan.reason || 'This device is banned', code: 403, hwid: true });
    }
  }
  const gid = gameserverGid || null;
  // CurrentVersion lives in the CDN root and names the client version + zip
  // to install, e.g. "version-DevTest" -> version-DevTest.zip.
  let version = null;
  let clientUrl = null;
  try {
    const cvPath = path.join(CDN_ROOT, 'CurrentVersion');
    if (fs.existsSync(cvPath)) {
      version = fs.readFileSync(cvPath, 'utf8').trim();
      if (version) clientUrl = `${cdnHost(req)}/${version}.zip`;
    }
  } catch { version = null; clientUrl = null; }
  const onlineList = onlineGidServers();
  // addr/mapUrl for the requested gid only ever come from the server that
  // announced itself as that gid over TCP. No onlineList[0]/GAME_PORT fallback:
  // guessing another game's port is what teleported clients into a different
  // game. When no gid is known the caller must pick a game from `games`.
  const slotServer = (gid && gidServerFor(gid)) || null;
  const joined = !!(slotServer && slotServer.connected);
  res.type('json').json({
    gid: gid,
    name: gid ? (gidName(gid) || gid) : null,
    online: onlineList.length > 0,
    addr: joined ? clientReachableAddr(req, slotServer) : null,
    games: onlineList.map((s) => ({
      gid: s.gid,
      name: gidName(s.gid) || s.gid,
      addr: clientReachableAddr(req, s),
      map: mapIdForGame(s.gid),
      mapUrl: `${cdnHost(req)}/static/files/games/map/${mapIdForGame(s.gid)}.zip`
    })),
    mapUrl: joined ? `${cdnHost(req)}/static/files/games/map/${mapIdForGame(slotServer.gid)}.zip` : null,
    version: version,
    clientUrl: clientUrl
  });
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.all('/config/files/:configFile', async (req, res) => {
  const configFile = req.params.configFile;
  const p = path.join(DB_DIR, 'appconfigs', `${configFile}.json`);
  let config = {};
  if (fs.existsSync(p)) {
    try { config = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { config = {}; }
  }
  res.status(200).json({ code: 1, message: 'SUCCESS', data: config });
});

const UPLOAD_DIR = path.join(DB_FILES, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.all('/user/api/v1/file', (req, res) => {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > 10 * 1024 * 1024) {
      aborted = true;
      res.status(413).json({ code: 413, message: 'File too large', data: null });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (!buf || buf.length === 0) {
      res.status(500).json({ code: 4, message: 'INNER ERROR', data: null });
      return;
    }
    const fmt = String((req.query && req.query.format) || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'png';
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fmt}`;
    const full = path.join(UPLOAD_DIR, name);
    fs.writeFile(full, buf, (err) => {
      if (err) {
        res.status(500).json({ code: 4, message: 'INNER ERROR', data: null });
        return;
      }
      const urlPath = `${apiHost(req)}/database/files/uploads/${name}`;
      res.status(200).json({ code: 1, message: 'SUCCESS', data: urlPath });
    });
  });
});

app.all('/database/files/*splat', (req, res) => {
  const rest = [].concat(req.params.splat || []).join('/');
  let full = safeJoin(DB_FILES, rest);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    // Fall back to the CDN db folder (cdn/database/files) if present.
    const cdnFiles = path.join(CDN_ROOT, 'database', 'files');
    full = safeJoin(cdnFiles, rest);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      const r = Responses.fileNotFound();
      res.status(r.status).json(r.content);
      return;
    }
  }
  res.sendFile(full);
});

// =====================================================================
//  LEGACY GAME DATA API (kept from original game.js)
// =====================================================================

// GET /api/v1/game/data
app.get('/api/v1/game/data', async (req, res) => {
  try {
    const { userId, subKey, tableName } = req.query;
    if (!userId || subKey === undefined || subKey === '' || !validateTableName(tableName)) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    // Data is stored per game table ("<tableName>:<subKey>") so different
    // games no longer overwrite each other. Falls back to the legacy unscoped
    // row so existing saves are not lost.
    let row = await dbGet(
      'SELECT data FROM UserData WHERE userId = ? AND subKey = ? LIMIT 1',
      [userId, `${tableName}:${subKey}`]
    );
    if (!row) {
      row = await dbGet(
        'SELECT data FROM UserData WHERE userId = ? AND subKey = ? LIMIT 1',
        [userId, String(subKey)]
      );
    }

    return res.json(apiResponse(1, 'Success', row ? {
      userId: Number(userId),
      subKey: Number(subKey),
      data: row.data,
    } : null));
  } catch (err) {
    console.error('GET /data error:', err);
    res.json(apiResponse(4, 'INNER ERROR'));
  }
});

// GET /api/v1/data/init
app.get('/api/v1/data/init', async (req, res) => {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS UserData (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        subKey TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(userId, subKey)
      )
    `);
    res.json({ code: 1, message: 'UserData table created/exists' });
  } catch (err) {
    console.error('/api/v1/data/init error:', err);
    res.json({ code: 4, message: 'INNER ERROR', detail: err.message });
  }
});

// POST /api/v1/game/data
app.post('/api/v1/game/data', async (req, res) => {
  try {
    const { tableName } = req.query;
    const dataArr = req.body;

    if (!validateTableName(tableName) || !Array.isArray(dataArr) || dataArr.length === 0) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    for (const item of dataArr) {
      if (!item || !item.userId || item.subKey == null || item.subKey === '' || item.data == null || item.data === '') {
        return res.json(apiResponse(3, 'PARAM ERROR'));
      }
    }
    for (const { userId, subKey, data } of dataArr) {
      await dbRun(
        'INSERT INTO UserData (userId, subKey, data) VALUES (?, ?, ?) ON CONFLICT(userId, subKey) DO UPDATE SET data = excluded.data',
        [userId, `${tableName}:${subKey}`, typeof data === 'string' ? data : JSON.stringify(data)]
      );
    }

    return res.json(apiResponse(1, 'Success'));
  } catch (err) {
    console.error('POST /data error:', err.message);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

// GET /pay/i/api/v1/wealth/users/:userId  (flat wealth)
app.get('/pay/i/api/v1/wealth/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.json({ code: 3, message: 'PARAM ERROR', data: null });

    const wealth = {
      diamonds: 99999,
      gDiamonds: 99999,
      ngDiamonds: 99999,
      gold: 99999,
      money: 99999,
      gDiamondsProfit: 99999,
      sameUser: 99999,
      firstPunch: 99999
    };

    res.json({
      code: 1,
      message: 'SUCCESS',
      data: {
        userId: Number(userId),
        ...wealth
      }
    });
  } catch (err) {
    console.error('/pay/i/api/v1/wealth/users/:userId error:', err);
    res.json({ code: 4, message: 'INNER ERROR', data: null });
  }
});

// POST /api/v1/game/log
app.post('/api/v1/game/log', async (req, res) => {
  try {
    const { tableName } = req.query;
    const logArr = req.body;

    if (!validateTableName(tableName) || !Array.isArray(logArr) || logArr.length === 0) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    for (const item of logArr) {
      if (!item || !item.userId || !item.serverInfo || !item.gameType || !item.dataAction || item.data == null || item.data === '') {
        return res.json(apiResponse(3, 'PARAM ERROR'));
      }
    }
    const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    for (const { userId, serverInfo, gameType, dataAction, data } of logArr) {
      await dbRun(
        'INSERT INTO LogData (userId, serverInfo, gameType, dataAction, data) VALUES (?, ?, ?, ?, ?)',
        [userId, asText(serverInfo), asText(gameType), asText(dataAction), asText(data)]
      );
    }

    return res.json(apiResponse(1, 'Success'));
  } catch (err) {
    console.error('POST /log error:', err.message);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

// POST /pay/api/v1/pay/users/purchase/game/props
app.post('/pay/api/v1/pay/users/purchase/game/props', async (req, res) => {
  try {
    const userId = Number(req.body?.userId || req.query?.userId || 112);
    const propsId = Number(req.body?.propsId || req.query?.propsId || 0);
    const quantity = Number(req.body?.quantity || req.query?.quantity || 1);
    const currencyNum = Number(req.body?.currency || req.query?.currency || 1);

    const currencyMap = { 1: 'diamonds', 2: 'gold' };
    const currencyKey = currencyMap[currencyNum] || 'diamonds';

    let wealthData = { diamonds: 99999, gold: 99999 };

    const row = await dbGet(
      'SELECT data FROM UserData WHERE userId = ? AND subKey = ? LIMIT 1',
      [userId, 'wealth']
    );

    if (row) {
      try {
        const parsed = JSON.parse(row.data || '{}');
        wealthData.diamonds = Number(parsed.diamonds || 0);
        wealthData.gold = Number(parsed.gold || 0);
      } catch {
        // fallback to defaults
      }
    }

    if (!wealthData[currencyKey]) wealthData[currencyKey] = 0;
    if (wealthData[currencyKey] >= quantity) wealthData[currencyKey] -= quantity;

    const dataStr = JSON.stringify(wealthData);
    await dbRun(
      'REPLACE INTO UserData (userId, subKey, data) VALUES (?, ?, ?)',
      [userId, 'wealth', dataStr]
    );

    res.json({
      code: 1,
      message: 'Success',
      data: {
        userId,
        propsId,
        quantity,
        diamonds: wealthData.diamonds,
        gold: wealthData.gold
      }
    });

  } catch (err) {
    console.error('Purchase API error:', err);
    res.json({
      code: 1,
      message: 'Success',
      data: {
        userId: 112,
        propsId: 0,
        quantity: 0,
        diamonds: 99999,
        gold: 99999
      }
    });
  }
});

// ---- Leaderboard API (fake Redis sorted sets) ----

app.put('/api/v1/game/rank/expire', async (req, res) => {
  try {
    const dataArr = req.body;
    if (!Array.isArray(dataArr)) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    for (const item of dataArr) {
      const expireTime = Number(item.expireTime);
      if (!item.key || !Number.isFinite(expireTime)) continue;
      if (expireTime <= Math.floor(Date.now() / 1000)) {
        await dbRun('DELETE FROM Leaderboards WHERE key = ?', [item.key]);
      } else {
        await dbRun(
          'UPDATE Leaderboards SET expireTime = ? WHERE key = ?',
          [expireTime, item.key]
        );
      }
    }

    return res.json(apiResponse(1, 'Success'));
  } catch (err) {
    console.error('PUT /rank/expire error:', err);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

app.get('/api/v1/game/rank/list', async (req, res) => {
  try {
    const { key, start, end } = req.query;
    if (!key || start === undefined || end === undefined) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    const now = Math.floor(Date.now() / 1000);
    const rows = await dbAll(
      `SELECT member, score FROM Leaderboards 
       WHERE key = ? AND (expireTime IS NULL OR expireTime > ?)
       ORDER BY score DESC 
       LIMIT ? OFFSET ?`,
      [key, now, Number(end) - Number(start) + 1, Number(start)]
    );

    const formatted = rows.map(row => ({
      member: row.member,
      score: parseInt(row.score)
    }));

    return res.json(apiResponse(1, 'Success', formatted));
  } catch (err) {
    console.error('GET /rank/list error:', err);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

app.post('/api/v1/game/rank', async (req, res) => {
  try {
    const dataArr = req.body;
    if (!Array.isArray(dataArr) || dataArr.length === 0) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    for (const item of dataArr) {
      if (!item.key || !item.member || typeof item.count !== 'number' || typeof item.add !== 'boolean') {
        return res.json(apiResponse(3, 'PARAM ERROR'));
      }

      // add=true -> increment (ZINCRBY), add=false -> overwrite score (ZADD)
      await lbWriteScore(item.key, item.member, item.count, !item.add);
    }

    return res.json(apiResponse(1, 'Success'));
  } catch (err) {
    console.error('POST /rank error:', err);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

app.get('/api/v1/game/rank', async (req, res) => {
  try {
    const { key, member } = req.query;
    if (!key || !member) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    const now = Math.floor(Date.now() / 1000);

    const scoreRow = await dbGet(
      'SELECT score FROM Leaderboards WHERE key = ? AND member = ? AND (expireTime IS NULL OR expireTime > ?)',
      [key, member, now]
    );

    const rankRow = await dbGet(
      `SELECT COUNT(*) as rank FROM Leaderboards 
       WHERE key = ? AND score > ? AND (expireTime IS NULL OR expireTime > ?)`,
      [key, scoreRow ? scoreRow.score : 0, now]
    );

    return res.json(apiResponse(1, 'Success', {
      score: scoreRow ? parseFloat(scoreRow.score) : 0,
      rank: scoreRow ? rankRow.rank : -1,
    }));
  } catch (err) {
    console.error('GET /rank error:', err);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

app.post('/api/v1/game/zincrby', async (req, res) => {
  try {
    const dataArr = req.body;
    if (!Array.isArray(dataArr)) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    for (const item of dataArr) {
      if (!item.key || !item.member || typeof item.count !== 'number') {
        return res.json(apiResponse(3, 'PARAM ERROR'));
      }

      await lbWriteScore(item.key, item.member, item.count, false);
    }

    return res.json(apiResponse(1, 'Success'));
  } catch (err) {
    console.error('POST /zincrby error:', err);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

app.put('/api/v1/game/zexpire', async (req, res) => {
  try {
    const dataArr = req.body;
    if (!Array.isArray(dataArr)) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    for (const item of dataArr) {
      const expireTime = Number(item.expireTime);
      if (!item.key || !Number.isFinite(expireTime)) continue;
      if (expireTime <= Math.floor(Date.now() / 1000)) {
        await dbRun('DELETE FROM Leaderboards WHERE key = ?', [item.key]);
      } else {
        await dbRun(
          'UPDATE Leaderboards SET expireTime = ? WHERE key = ?',
          [expireTime, item.key]
        );
      }
    }

    return res.json(apiResponse(1, 'Success'));
  } catch (err) {
    console.error('PUT /zexpire error:', err);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

app.get('/api/v1/game/zrange', async (req, res) => {
  try {
    const { key, start, end } = req.query;
    if (!key || start === undefined || end === undefined) {
      return res.json(apiResponse(3, 'PARAM ERROR'));
    }

    const now = Math.floor(Date.now() / 1000);
    const rows = await dbAll(
      `SELECT member, score FROM Leaderboards 
       WHERE key = ? AND (expireTime IS NULL OR expireTime > ?)
       ORDER BY score ASC 
       LIMIT ? OFFSET ?`,
      [key, now, Number(end) - Number(start) + 1, Number(start)]
    );

    const formatted = rows.map(row => ({
      member: row.member,
      score: parseInt(row.score)
    }));

    return res.json(apiResponse(1, 'Success', formatted));
  } catch (err) {
    console.error('GET /zrange error:', err);
    return res.json(apiResponse(4, 'INNER ERROR'));
  }
});

// =====================================================================
//  USER SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/config/files/:configFile', ['GET'], [async (req) => {
  const configFile = req.params.configFile;
  const p = path.join(DB_DIR, 'appconfigs', `${configFile}.json`);
  let config = {};
  if (fs.existsSync(p)) {
    try { config = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { config = {}; }
  }
  return Responses.success(config);
}]);

createDevEndpoint(app, '/user/api/v1/user/register', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const nickName = req.body?.nickName;
  const sex = req.body?.sex !== undefined && req.body?.sex !== null ? parseInt(req.body.sex) : NaN;

  if (await userExists(userId)) return Responses.profileExists();
  if (!nickName || !sex) return Responses.missingRegisterParams();
  if (sex != 1 && sex != 2) return Responses.invalidSex();

  await dbRun('INSERT INTO user (userId, nickName, sex, picUrl, details, birthday, isFreeNickname) VALUES (?, ?, ?, ?, ?, ?, ?)', [userId, nickName, sex, '', '', '', 1]);
  await dbRun('INSERT OR IGNORE INTO vip (userId, vip, expireDate) VALUES (?, ?, ?)', [userId, 0, 0]);
  await dbRun('INSERT OR IGNORE INTO user_locale (userId, language, country) VALUES (?, ?, ?)', [userId, '', '']);
  await seedMaxWealth(userId);
  await seedGcubes(userId);

  const user = await userFromUserId(userId);
  const vip = await vipFromUserId(userId);
  return Responses.success({ ...userResponse(user), ...vipResponse(vip) });
}]);

createDevEndpoint(app, '/user/api/v1/user/nickName', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const newNickname = req.query?.newName;
  if (newNickname == null) return Responses.innerError();
  await dbRun('UPDATE user SET nickName = ? WHERE userId = ?', [newNickname, userId]);
  const user = await userFromUserId(userId);
  return Responses.success(userResponse(user));
}]);

createDevEndpoint(app, '/user/api/v1/user/nickName/free', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const user = await userFromUserId(userId);
  return Responses.success({
    currencyType: nicknameConfig.currencyType,
    quantity: nicknameConfig.quantity,
    free: user ? !!user.isFreeNickname : true
  });
}]);

createDevEndpoint(app, '/user/api/v1/user/info', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const user = await userFromUserId(userId);
  if (!user) return Responses.profileNotExists();
  const { picUrl, birthday, details } = req.body || {};
  const pic = picUrl != null ? picUrl : user.picUrl;
  const bday = birthday != null ? birthday : user.birthday;
  const det = details != null ? details : user.details;
  await dbRun('UPDATE user SET picUrl = ?, birthday = ?, details = ? WHERE userId = ?', [pic, bday, det, userId]);
  const updated = await userFromUserId(userId);
  return Responses.success(userResponse(updated));
}]);

createDevEndpoint(app, '/user/api/v1/user/details/info', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const user = await userFromUserId(userId);
  const vip = await vipFromUserId(userId);
  return Responses.success({ ...userResponse(user), ...vipResponse(vip) });
}]);

createDevEndpoint(app, '/user/api/v1/user/player/info', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const vip = await vipFromUserId(userId);
  // BuyVipEntity: { vip, expireDate(String) }. The app parses expireDate as a
  // string, so it must be sent as a string (a raw int would break Gson).
  return Responses.success({ vip: vip.vip, expireDate: String(vip.expireDate || 0) });
}]);

// ---- Daily sign-in (GET = list of the 7 daily rewards, PUT = click sign-in) ----
async function dailySignRecord(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const raw = await kvGet(`dailySign.${userId}`);
  let rec = null;
  if (raw) { try { rec = JSON.parse(raw); } catch { rec = null; } }
  if (!rec) return { date: today, signed: false, streak: 0 };
  if (rec.date === today) return rec;
  // New day: the streak carries over only if the player signed yesterday and
  // has not finished the 7-day cycle yet.
  const carry = rec.date === yesterday && rec.signed && rec.streak < 7 ? rec.streak : 0;
  return { date: today, signed: false, streak: carry };
}

async function saveDailySign(userId, rec) {
  await kvSet(`dailySign.${userId}`, JSON.stringify({ date: rec.date, signed: rec.signed, streak: rec.streak }), 7 * 24 * 3600);
}

// 7 days of rewards; the mobile app only needs id/quantity/status; amounts are
// what we actually credit back on sign-in. Return the vanilla shape.
function dailySignInfoList(userId, rec) {
  const rewards = [50, 100, 150, 200, 250, 300, 500];
  const list = {};
  const streak = Math.min(rec.streak, 7);
  for (let i = 1; i <= 7; i++) {
    list[String(i)] = {
      id: i,
      dailyId: i,
      name: `Diamond ${rewards[i - 1]}`,
      quantity: rewards[i - 1],
      status: i <= streak ? 1 : 0,
      type: 'diamond',
      url: '',
      adQuantity: 0,
      adType: ''
    };
  }
  return list;
}

createDevEndpoint(app, '/user/api/v2/users/:userId/daily/sign/in', ['GET', 'PUT'], [
  async (req) => {
    const userId = req.getUserId();
    const rec = await dailySignRecord(userId);
    return Responses.success(dailySignInfoList(userId, rec));
  },
  async (req) => {
    const userId = req.getUserId();
    const rec = await dailySignRecord(userId);
    if (rec.signed) return Responses.innerError();
    rec.signed = true;
    rec.streak = rec.streak + 1;
    await saveDailySign(userId, rec);
    const diamonds = [50, 100, 150, 200, 250, 300, 500][Math.min(rec.streak, 7) - 1];
    await addCurrency(userId, 1, diamonds, 99);
    return Responses.success();
  }
]);

createDevEndpoint(app, '/user/api/v1/users/:userId/daily/tasks/ads/config', ['GET'], [async (req) => {
  // DailyAdsTaskInfo: { currency, quantity, remainTime }
  return Responses.success({ currency: 0, quantity: 80, remainTime: 0 });
}]);

createDevEndpoint(app, '/user/api/v1/users/:userId/daily/tasks/ads', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  await addCurrency(userId, 0, 80, 99);
  const w = await wealthFromUserId(userId);
  // RechargeEntity: { userId, currency, diamonds, golds, rewardQuantity }
  return Responses.success({ userId, currency: 0, diamonds: w.diamonds, golds: w.golds, rewardQuantity: 80 });
}]);

createDevEndpoint(app, '/user/api/v1/users/daily/sign/ads', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  await addCurrency(userId, 1, 60, 99);
  // AdsSignReward: { picUrl, quantity }
  return Responses.success({ picUrl: '', quantity: 60 });
}]);

createDevEndpoint(app, '/user/api/v1/users/new/daily/tasks', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const rec = await dailySignRecord(userId);
  // DailyTaskResponse: { count, hours, minutes, seconds, tasks: List<DailySignInfo> }
  return Responses.success({ count: 7, hours: 0, minutes: 0, seconds: 0, tasks: Object.values(dailySignInfoList(userId, rec)) });
}]);

createDevEndpoint(app, '/user/api/v1/users/dairy/tasks/:type', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const rec = await dailySignRecord(userId);
  // WeekTaskResponse: { count, hours, minutes, seconds, taskMap }
  return Responses.success({ count: 7, hours: 0, minutes: 0, seconds: 0, taskMap: dailySignInfoList(userId, rec) });
}]);

createDevEndpoint(app, '/user/api/v1/users/tasks/:type', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const type = parseInt(req.params.type) || 1;
  const quantity = type === 3 ? 300 : [50, 100, 150, 200, 250, 300, 500][Math.min(type, 7) - 1];
  await addCurrency(userId, 1, quantity, 99);
  const w = await wealthFromUserId(userId);
  // RechargeEntity
  return Responses.success({ userId, currency: 1, diamonds: w.diamonds, golds: w.golds, rewardQuantity: quantity });
}]);

createDevEndpoint(app, '/user/api/v1/clan/decoration/advertising/:userId', ['GET', 'PUT'], [
  async () => Responses.success({ adType: 1, currency: 0, nextCurrency: 0, nextQty: 0, qty: 0, status: 1 }),
  async (req) => {
    const userId = req.getUserId();
    await addCurrency(userId, 0, 50, 99);
    const w = await wealthFromUserId(userId);
    // DressAdsReward: { userId, currency, diamonds, golds, rewardQuantity }
    return Responses.success({ userId, currency: 0, diamonds: w.diamonds, golds: w.golds, rewardQuantity: 50 });
  }
]);

createDevEndpoint(app, '/user/api/v1/report/push', ['POST'], [async () => Responses.success()]);

createDevEndpoint(app, '/user/api/v1/user/language', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const language = req.query?.language || '';
  await dbRun('INSERT INTO user_locale (userId, language, country) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET language=excluded.language', [userId, language, '']);
  return Responses.success();
}]);

createDevEndpoint(app, '/user/api/v1/users/prefect/info/reward/:userId', ['POST'], [async (req) => {
  const userId = req.getUserId();
  await addCurrency(userId, 0, 200, 99);
  await addCurrency(userId, 1, 100, 99);
  const w = await wealthFromUserId(userId);
  // BuyGameResponse: { userId, diamonds, golds, orderId }
  return Responses.success({ userId, diamonds: w.diamonds, golds: w.golds, orderId: crypto.randomBytes(8).toString('hex') });
}])

// =====================================================================
//  ACCOUNT SERVICE (main-api-dev + mobile IUserApi)
// =====================================================================

// ---- Verification codes (no real SMS/email gateway on this private server;
//      the code is stored and echoed back in the response so the app flow
//      stays usable. Code is stored per phone/email with a 5 min TTL.) ----
async function storeVerifyCode(channel, target, code) {
  await kvSet(`verify.${channel}.${String(target).toLowerCase()}`, code, 300);
}

async function verifyCodeMatches(channel, target, submitted) {
  const stored = await kvGet(`verify.${channel}.${String(target).toLowerCase()}`);
  if (stored == null) return false; // no (or expired) code -> reject
  return String(stored) === String(submitted);
}

function randCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function accountFromEmail(email) {
  if (!email) return null;
  return await dbGet('SELECT * FROM account WHERE lower(email) = ?', [String(email).trim().toLowerCase()]);
}

async function phoneOwner(phone) {
  if (!phone) return null;
  const row = await dbGet('SELECT userId FROM account_binding WHERE connectId = ?', [String(phone)]);
  return row ? row.userId : null;
}

createDevEndpoint(app, '/user/api/v1/app/auth-token', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const account = await accountFromUserId(userId);
  if (!account) return Responses.authFailed();
  return Responses.success({
    userId,
    accessToken: req.headers['access-token'],
    hasBinding: !!(account.email || (await phoneOwner(userId))),
    hasPassword: account.password != null
  });
}]);

createDevEndpoint(app, '/user/api/v1/app/renew', ['POST'], [async () => {
  const userId = await getNextUserId();
  const tokenObject = createToken({ userId });
  await dbRun('INSERT INTO account (userId, email, password, creationTime, accessToken, loginTime) VALUES (?, ?, ?, ?, ?, ?)', [userId, '', null, Date.now(), tokenObject.dbToken, null]);
  await seedMaxWealth(userId);
  await seedGcubes(userId);
  return Responses.success({ userId, accessToken: tokenObject.userToken, hasBinding: false, hasPassword: false });
}]);

// Mobile account registration. LoginRegisterAccountForm { uid, password,
// confirmPassword, deviceId, imei, needReward, os, platform, appType }.
// `uid` is the account name the user picks and is stored in account.email so
// /app/login can find the account by name or number.
createDevEndpoint(app, '/user/api/v1/register', ['POST'], [async (req) => {
  const accountName = String((req.body && (req.body.uid || req.body.email)) || '').trim();
  const password = req.body && req.body.password;
  if (!accountName || !password || password.length < 4) {
    return { status: 200, content: { code: 3, message: 'Expected an account name and a password (4+ characters)', data: null } };
  }
  const existing = await accountFromEmail(accountName);
  if (existing) {
    return { status: 200, content: { code: 3, message: 'The account already exists', data: null } };
  }
  const userId = await getNextUserId();
  const tokenObject = createToken({ userId });
  const hashed = hashPassword(password);
  await dbRun('INSERT INTO account (userId, email, password, creationTime, accessToken, loginTime) VALUES (?, ?, ?, ?, ?, ?)', [userId, accountName.toLowerCase(), hashed, Date.now(), tokenObject.dbToken, Date.now()]);
  await seedMaxWealth(userId);
  await seedGcubes(userId);
  return Responses.success({ userId, accessToken: tokenObject.userToken, hasPassword: true });
}]);

createDevEndpoint(app, '/user/api/v1/app/set-password', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const password = req.body?.password;
  const account = await accountFromUserId(userId);
  if (!account) return Responses.authFailed();
  if (account.password) return Responses.passwordAlreadySet();
  if (!password || String(password).length < 4) return { status: 200, content: { code: 3, message: 'Expected a password (4+ characters)', data: null } };
  const hashed = hashPassword(password);
  await dbRun('UPDATE account SET password = ? WHERE userId = ?', [hashed, userId]);
  return Responses.success();
}]);

// Login accepts either the numeric userId (legacy launcher) or the account
// name picked at registration (mobile LoginRegisterAccountForm.uid).
createDevEndpoint(app, '/user/api/v1/app/login', ['POST'], [async (req) => {
  const identifier = String((req.body && req.body.uid) || '').trim();
  const password = req.body?.password;
  let account = null;
  if (/^\d+$/.test(identifier)) {
    account = await accountFromUserId(parseInt(identifier));
  }
  if (!account) {
    account = await accountFromEmail(identifier);
  }
  if (!account) return Responses.userNotExists();
  if (!verifyPassword(password, account.password)) return Responses.invalidPassword();

  const tokenObject = createToken({ userId: account.userId });
  await dbRun('UPDATE account SET accessToken = ?, loginTime = ? WHERE userId = ?', [tokenObject.dbToken, Date.now(), account.userId]);

  const hasProfile = await userExists(account.userId);
  const accountResponse = { userId: account.userId, accessToken: tokenObject.userToken, hasPassword: account.password != null };
  if (!hasProfile) return Responses.profileNotExists(accountResponse);
  return Responses.success(accountResponse);
}]);

createDevEndpoint(app, '/user/api/v1/login-out', ['PUT'], [async () => Responses.success()]);

createDevEndpoint(app, '/user/api/v1/user/password/modify', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const { oldPassword, newPassword } = req.body || {};
  const account = await accountFromUserId(userId);
  if (!account) return Responses.authFailed();
  if (!verifyPassword(oldPassword, account.password)) return Responses.invalidPassword();
  if (!newPassword || String(newPassword).length < 4) return { status: 200, content: { code: 3, message: 'Expected a new password (4+ characters)', data: null } };
  const hashed = hashPassword(newPassword);
  await dbRun('UPDATE account SET password = ? WHERE userId = ?', [hashed, userId]);
  return Responses.success();
}]);

// ---- Mobile binding / security endpoints (IUserApi.smali) ----

// POST /user/api/v1/sms/send/refound?phone=&type= (no auth) - resend a code
// NOTE: registered BEFORE /sms/send/:phone so the literal "refound" path wins.
createDevEndpoint(app, '/user/api/v1/sms/send/refound', ['POST'], [async (req) => {
  const phone = req.query?.phone;
  if (!phone) return { status: 200, content: { code: 3, message: 'Expected phone query parameter', data: null } };
  const code = randCode();
  await storeVerifyCode('sms', phone, code);
  return Responses.success({ code, expireIn: 300 });
}]);

// POST /user/api/v1/sms/send/{phone}?type=... (auth) - issue a phone code
createDevEndpoint(app, '/user/api/v1/sms/send/:phone', ['POST'], [async (req) => {
  const phone = req.params.phone;
  const code = randCode();
  await storeVerifyCode('sms', phone, code);
  return Responses.success({ code, expireIn: 300 });
}]);

// POST /user/api/v1/user/bind/phone (PhoneBindForm, auth)
createDevEndpoint(app, '/user/api/v1/user/bind/phone', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const { phone, verifyCode, password } = req.body || {};
  const account = await accountFromUserId(userId);
  if (!account) return Responses.authFailed();
  if (account.password && !verifyPassword(password, account.password)) return Responses.invalidPassword();
  if (!phone) return { status: 200, content: { code: 3, message: 'Expected phone parameter', data: null } };
  const owner = await phoneOwner(phone);
  if (owner && owner !== userId) return { status: 200, content: { code: 3, message: 'The phone is already bound', data: null } };
  if (!(await verifyCodeMatches('sms', phone, verifyCode))) return { status: 200, content: { code: 3, message: 'The verify code is invalid', data: null } };
  await dbRun('INSERT OR REPLACE INTO account_binding (userId, connectId) VALUES (?, ?)', [userId, String(phone)]);
  return Responses.success();
}]);

// POST /user/api/v1/user/unbind/phone (PhoneBindForm, auth)
createDevEndpoint(app, '/user/api/v1/user/unbind/phone', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const { phone, verifyCode } = req.body || {};
  if (!(await verifyCodeMatches('sms', phone || '', verifyCode))) return { status: 200, content: { code: 3, message: 'The verify code is invalid', data: null } };
  await dbRun('DELETE FROM account_binding WHERE userId = ?', [userId]);
  return Responses.success();
}]);

// POST /user/api/v1/users/bind/email (EmailBindForm, auth)
createDevEndpoint(app, '/user/api/v1/users/bind/email', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const { email, verifyCode, password } = req.body || {};
  const account = await accountFromUserId(userId);
  if (!account) return Responses.authFailed();
  if (account.password && !verifyPassword(password, account.password)) return Responses.invalidPassword();
  if (!email) return { status: 200, content: { code: 3, message: 'Expected email parameter', data: null } };
  const existing = await accountFromEmail(email);
  if (existing && existing.userId !== userId) return { status: 200, content: { code: 3, message: 'The email is already bound', data: null } };
  if (!(await verifyCodeMatches('email', email, verifyCode))) return { status: 200, content: { code: 3, message: 'The verify code is invalid', data: null } };
  await dbRun('UPDATE account SET email = ? WHERE userId = ?', [String(email).toLowerCase(), userId]);
  return Responses.success();
}]);

// DELETE /user/api/v1/users/{userId}/emails (auth) - unbind email
createDevEndpoint(app, '/user/api/v1/users/:userId/emails', ['DELETE'], [async (req) => {
  const userId = req.getUserId();
  await dbRun('UPDATE account SET email = ? WHERE userId = ?', ['', userId]);
  return Responses.success();
}]);

// POST /user/api/v1/user/password (PhoneBindForm, no auth) - reset password
// via the phone's verify code.
createDevEndpoint(app, '/user/api/v1/user/password', ['POST'], [async (req) => {
  const { phone, verifyCode, password } = req.body || {};
  if (!(await verifyCodeMatches('sms', phone || '', verifyCode))) return { status: 200, content: { code: 3, message: 'The verify code is invalid', data: null } };
  const userId = await phoneOwner(phone);
  if (!userId) return Responses.userNotExists();
  if (!password || password.length < 4) return { status: 200, content: { code: 3, message: 'Expected a new password (4+ characters)', data: null } };
  await dbRun('UPDATE account SET password = ? WHERE userId = ?', [hashPassword(password), userId]);
  return Responses.success();
}]);

// POST /user/api/v1/emails/{email} (auth) - issue an email verify code
createDevEndpoint(app, '/user/api/v1/emails/:email', ['POST'], [async (req) => {
  const email = req.params.email || req.query?.email;
  if (!email) return { status: 200, content: { code: 3, message: 'Expected email', data: null } };
  const code = randCode();
  await storeVerifyCode('email', email, code);
  return Responses.success({ code, expireIn: 300 });
}]);

// POST /user/api/v1/emails/password/reset?email= (no auth) - password reset
// email. No mail gateway: the code is stored (and echoed) for the app flow.
createDevEndpoint(app, '/user/api/v1/emails/password/reset', ['POST'], [async (req) => {
  const email = req.query?.email;
  if (!email) return { status: 200, content: { code: 3, message: 'Expected email query parameter', data: null } };
  const code = randCode();
  await storeVerifyCode('email', email, code);
  return Responses.success({ code, expireIn: 300 });
}]);

// POST /user/api/v1/users/sharing/reward?type= (auth) - small share reward
createDevEndpoint(app, '/user/api/v1/users/sharing/reward', ['POST'], [async (req) => {
  const userId = req.getUserId();
  await addCurrency(userId, 0, 100, 99);
  return Responses.success();
}]);

// =====================================================================
//  GAME SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/game/api/v2/games/recommendation', ['GET'], [async (req) => {
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const games = await listRealGames(pageNo, pageSize, req);
  return Responses.success(games);
}]);

createDevEndpoint(app, '/game/api/v1/games/playlist/recently', ['GET'], [async () => Responses.success([])]);

createDevEndpoint(app, '/game/api/v1/games/playlist/friends', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/game/api/v1/games/:gameId/appreciation', ['PUT'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/game/api/v1/games', ['GET'], [async (req) => {
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const games = await listRealGames(pageNo, pageSize, req);
  return Responses.success(games);
}]);

// GET /game/api/v2/game/auth  and  GET /game/api/v1/game/auth
// Both exist in the wild and return the same MiniGameToken entity
// (com.sandboxol.greendao.entity.MiniGameToken). The indiegame client calls
// the v1 path (IGameApi:48 miniGameToken) with
//   ?typeId&targetId&gameVersion + userId / Access-Token / CloudFront-Viewer-Country
// and then consumes web/l.java:52:
//   map.put("rid", getRegion())
//   RetrofitFactory.create(getDispUrl(), IGameApi.class).newMiniGameDispatcher(
//       map, uid, getToken())          -> POST /v1/dispatch
//   dispatch.signature  = getSignature()
//   dispatch.timestamp  = getTimestamp().longValue()
// so dispUrl must be this server and must resolve to the /v1/dispatch route.
const gameAuthHandler = async (req) => {
  const userId = String(req.getUserId());
  const uidBan = await activeBanForUser(parseInt(userId));
  if (uidBan) return Responses.banned(uidBan.reason);
  const rawHwid = req.headers['x-hwid'] || req.headers['hwid'] || req.query.hwid;
  if (rawHwid) {
    const hwBan = await activeBanForHwid(rawHwid);
    if (hwBan) return Responses.banned(hwBan.reason);
    await logHwid(parseInt(userId), rawHwid, CLIENT_IP.from(req));
  }
  const gameId = String(req.query.typeId || '');
  // Stub logic (gmar): token = the game id, signature = sha1(GAME_SECRET +
  // userId + timestamp) with a fixed timestamp "10". The gameserver validates
  // this exact signature when the client connects ("check user token"), so
  // it must match what the stub embeds in its db.json per user.
  // Stub reference: D:\stubs\services\hardcode\controller.js (gmar) + db.json.
  const ts = '10';
  const signature = crypto.createHash('sha1').update(GAME_SECRET + userId + ts).digest('hex');
  await kvSet(`cache.game.token.${userId}`, JSON.stringify({ timestamp: ts, gameId }), 24 * 3600);
  const data = {
    dispUrl: baseUrl(req),
    region: '1001',
    signature,
    timestamp: ts,
    token: gameId
  };
  return Responses.success(data);
};

createDevEndpoint(app, '/game/api/v2/game/auth', ['GET'], [gameAuthHandler]);
createDevEndpoint(app, '/game/api/v1/game/auth', ['GET'], [gameAuthHandler]);

createDevEndpoint(app, '/game/api/v1/party/auth', ['GET'], [async () => Responses.innerError()]);

// =====================================================================
//  GAMESERVER CONNECTION / DISPATCH (mirrors the dispatcher service)
// =====================================================================
// Client flow: POST /game/api/v2/game/auth -> mini game token, then
// POST /v4/dispatch?gameId= -> tells the client which gameserver (gaddr)
// to connect to and hands over the per-user game token (signature).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//======================================================================
//  GAMESERVER CONNECTION / DISPATCH (mirrors the dispatcher service)
//======================================================================
// Client flow: POST /game/api/v2/game/auth -> mini game token, then
// POST /v4/dispatch?gameId= -> tells the client which gameserver (gaddr)
// to connect to and hands over the per-user game token (signature).
//
// VANILLA DISPATCHING: a game is online when its gameserver holds an open
// TCP connection to the room server (below). No HTTP rank/data request and
// no port probe is needed to decide online state - the gameserver reaches
// out to the room on startup, and the socket closing is the offline signal.
const RoomConstants = {
  GAME_SERVER_CONNECT: 1,
  GAME_SERVER_DISCONNECT: 3,
  GAME_SERVER_HEARTBEAT: 4,
  GAME_SERVER_GAME_STATUS: 150,
  GAME_SERVER_USER_IN: 151,
  GAME_SERVER_USER_OUT: 152,
  GAME_SERVER_SYNC_USERS: 155,

  ROOM_MANAGER_CONNECT_REPLY: 2,
  ROOM_MANAGER_USER_ATTRIBUTE: 154,
  ROOM_MANAGER_KICK_USER_OUT: 160
};

function createRoomPacket(type, data) {
  return { length: Buffer.byteLength(String(data), 'utf8'), type, data };
}

function parseRoomPacket(requestData) {
  const packetLength = requestData.readInt32BE(0);
  const packetType = requestData.readInt32BE(4);
  const packetData = requestData.toString('utf8', 8, packetLength + 4);
  return createRoomPacket(packetType, packetData);
}

function sendRoomResponse(socket, response) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.from(String(response.data), 'utf8');
  const packet = Buffer.alloc(body.length + 12);
  packet.writeInt32BE(body.length + 4, 0);
  packet.writeInt32BE(response.type, 4);
  body.copy(packet, 8);
  socket.write(packet);
}

const roomServers = new Map();

function addRoomServer(socket, serverAddr, gid) {
  roomServers.set(socket, { socket, serverAddr, gid });
}

function removeRoomServer(socket) {
  const entry = roomServers.get(socket);
  roomServers.delete(socket);
  if (entry && entry.gid) {
    const gidKey = String(entry.gid).toLowerCase();
    // A gameserver that reconnected already has a newer live socket: only mark
    // the game offline when no other socket still announces it.
    const stillLive = Array.from(roomServers.values()).some((e) => e.gid && String(e.gid).toLowerCase() === gidKey);
    const g = GID_SERVERS.get(gidKey);
    if (g && !stillLive) g.connected = false;
  }
}

function getRoomServerSocket(serverAddr) {
  for (const entry of roomServers.values()) {
    if (entry.serverAddr == serverAddr) return entry.socket;
  }
  return null;
}

// Extract a gid from whatever identifying field a gameserver puts in its room
// connect config. Real GameServer.exe announces several aliases, so accept all
// of them and normalize (lowercase). Detects EVERY announced game, not just the
// ones pre-listed from bat files.
function extractAnnouncedGid(serverInfo) {
  if (!serverInfo) return null;
  const keys = ['id', 'gid', 'gameId', 'gtype', 'mapid', 'mapId', 'type', 'tableName', 'name'];
  for (const k of keys) {
    const v = serverInfo[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (/^[a-z]?\d+(_\d+)?$/i.test(s) && /(^g\d)/i.test(s)) return s.toLowerCase();
  }
  return null;
}

// Extract the map name a gameserver runs from its announce config. It is the
// basename of mapdir / the "name"/"mapid" it was launched with, i.e. the folder
// the client builds as ./map/<name> and loads its anvil world from. Dispatch's
// mid + downurl MUST equal this (not a hardcoded gid -> m rule), otherwise the
// client downloads one map and the server announces another (ANVIL_FILE_FAIL).
function extractAnnouncedMapName(serverInfo) {
  if (!serverInfo || typeof serverInfo !== 'object') return null;
  const keys = ['mapName', 'mapname', 'map', 'mapid', 'mapId', 'name', 'mapdir'];
  for (const k of keys) {
    const v = serverInfo[k];
    if (v == null) continue;
    let s = String(v).trim().replace(/\\/g, '/');
    const idx = s.lastIndexOf('/');
    if (idx >= 0) s = s.slice(idx + 1); // "./map/m1008_3" -> "m1008_3"
    s = s.replace(/^\.+$/, '').trim();
    if (!s || !/^[a-zA-Z0-9_]+$/.test(s)) continue;
    if (/^g\d+$/i.test(s)) continue; // that key held the game id, not a map id
    return s;
  }
  return null;
}

// Try to parse a JSON object out of a text blob: first the whole blob, then the
// first balanced { ... } found inside it (real gameservers may prefix the JSON
// with framing/protocol junk we do not understand). Returns null when nothing
// JSON-shaped is parseable.
function tryParseJson(text) {
  if (!text) return null;
  const direct = String(text).trim();
  if (direct.startsWith('{')) {
    try { return JSON.parse(direct); } catch {}
  }
  const start = String(text).indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < String(text).length; i++) {
    const ch = String(text)[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = String(text).slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

// Unwrap the announce payload: accept {config:{...}} (reference shape), a bare
// config object, or a config nested under a non-config key. Returns the object
// to read port/ip/id from, or null.
function unwrapServerInfo(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.config && typeof parsed.config === 'object') return parsed.config;
  if (parsed.server && typeof parsed.server === 'object') return parsed.server;
  if (parsed.serverInfo && typeof parsed.serverInfo === 'object') return parsed.serverInfo;
  if (parsed.data && typeof parsed.data === 'object' && parsed.data.port != null) return parsed.data;
  return parsed;
}

function onGameServerConnects(socket, rawData) {
  // Whatever the gameserver sends first (framed type 1 packet, any other packet
  // type, or even a bare JSON blob), try to read a server config out of it.
  const parsed = tryParseJson(rawData);
  if (!parsed) return null;
  const serverInfo = unwrapServerInfo(parsed);
  if (!serverInfo) return null;
  const announcedPort = serverInfo.port != null ? String(serverInfo.port) : null;
  if (!announcedPort) return null;
  // Authoritative client address is what the gameserver advertises in
  // `gameserver_ips` (its PUBLIC ip[:port]): prefer that over reconstructing
  // from ip/monitoraddr, which are loopback on this box. When gameserver_ips
  // includes a port that port is used for the client, otherwise we keep the
  // announced `port` field.
  const gsIps = parseGameserverIps(serverInfo.gameserver_ips != null ? serverInfo.gameserver_ips : serverInfo.gameserverIps);
  const publicGs = gsIps.find((e) => e.ip && e.ip !== '127.0.0.1' && e.ip !== '0.0.0.0' && e.ip !== '::1');
  const announcedIp = serverInfo.ip || GAME_HOST;
  const socketIp = normalizeRemoteIp(socket.remoteAddress);
  const sourceIp = (socketIp && socketIp !== '127.0.0.1') ? socketIp : announcedIp;
  // Resolve the gid: prefer the id the gameserver itself announces in its
  // config, then fall back to an entry already announced on this port. Also
  // match this announce against the GAME_FOLDERS registry (parsed launch bats):
  // when the announce carries no gid, the configured PORT identifies the game.
  let configGid = extractAnnouncedGid(serverInfo);
  const announcedMap = extractAnnouncedMapName(serverInfo);
  let folder = configGid ? GAME_FOLDERS.get(String(configGid).toLowerCase()) : null;
  if (!folder) {
    for (const f of GAME_FOLDERS.values()) {
      if (f.port && String(f.port) === announcedPort) { folder = f; break; }
    }
    if (!configGid && folder) configGid = folder.gid;
  }
  // DISPATCH ADDRESS (port + ip), precedence:
  //   gameserver_ips NAT port/ip > gid folder bat (publicIp/port, admin's
  //   ground truth) > announce port + reconstructed public ip.
  const folderPublicIp = (folder && folder.publicIp &&
    folder.publicIp !== '127.0.0.1' && folder.publicIp !== '0.0.0.0' && folder.publicIp !== '::1')
    ? folder.publicIp : null;
  const effectivePort = (publicGs && publicGs.port) ? publicGs.port
    : (folder && folder.port) ? folder.port
    : announcedPort;
  const addr = publicGs ? `${publicGs.ip}:${effectivePort}`
    : folderPublicIp ? `${folderPublicIp}:${effectivePort}`
    : gameserverAddress(sourceIp, effectivePort);
  const effectiveIp = addr.split(':')[0];
  let entry = configGid ? gidServerFor(configGid) : null;
  if (!entry) {
    for (const e of GID_SERVERS.values()) {
      if (String(e.port) === effectivePort) { entry = e; break; }
    }
  }
  const isNew = !entry;
  if (!entry) {
    entry = { gid: configGid || `p${effectivePort}`, ip: effectiveIp, port: effectivePort, addr, mapName: announcedMap, lastSeen: Date.now(), detected: true };
    entry.gid = String(entry.gid).toLowerCase();
    GID_SERVERS.set(entry.gid, entry);
    // A brand-new game announced itself over the room socket: register it in
    // the game table so it appears in lists/details immediately, and drop any
    // game rows whose server is no longer announced.
    seedGameRow(entry.gid);
    pruneStaleGameRows();
  }
  entry.addr = addr;
  entry.ip = effectiveIp;
  entry.port = effectivePort;
  // Map identity (mid/downurl): what the running server ACTUALLY announces it
  // is loading - the client must download the exact map the server has. The
  // launcher bat's map name is used ONLY as a fallback when no announce map is
  // present yet (never guessing a different map than the server runs).
  entry.mapName = announcedMap || (folder && folder.mapName) || entry.mapName;
  entry.publicIp = publicGs ? publicGs.ip : (folderPublicIp || entry.publicIp || null);
  entry.folderPort = folder && folder.port ? folder.port : (entry.folderPort || null);
  entry.folder = folder ? folder.folder : (entry.folder || null);
  entry.advertisedIp = publicGs ? publicGs.ip : (entry.advertisedIp || null);
  entry.advertisedPort = publicGs && publicGs.port ? publicGs.port : (entry.advertisedPort || null);
  entry.lastSeen = Date.now();
  entry.detected = true;
  entry.connected = true;
  if (!GID_SERVERS_CONNECTED_LOG[entry.gid] || entry._lastAddr !== addr || entry._lastMap !== entry.mapName) {
    entry._lastAddr = addr;
    entry._lastMap = entry.mapName;
    GID_SERVERS_CONNECTED_LOG[entry.gid] = true;
    const portSrc = (publicGs && publicGs.port) ? 'gsips' : (folder && folder.port) ? 'folder' : 'announce';
    console.log(`[DISPATCH] gameserver host gid=${entry.gid} -> ${addr} mid=${entry.mapName || '-'} port-src=${portSrc}${folder ? ` folder=${folder.folder}` : ''} gameserver_ips=${JSON.stringify(gsIps)} (TCP) connected to room${isNew ? ' [NEW]' : ''}${publicGs ? ' [gameserver_ips]' : ''}`);
  }
  addRoomServer(socket, addr, entry.gid);
  return createRoomPacket(0, '');
}

// Async maintenance (fire-and-forget): while a server is down the game table
// should stop advertising it. Re-sync the DB list to the games that are
// actually announced over TCP so the client never sees a game that has no live
// server (and therefore can never be mis-dispatched to another game).
async function pruneStaleGameRows() {
  try {
    const gids = Array.from(GID_SERVERS.keys());
    if (!gids.length) return;
    const placeholders = gids.map(() => '?').join(',');
    await dbRun(`DELETE FROM game WHERE gameId NOT IN (${placeholders})`, gids);
  } catch (e) {
    console.error('Error pruning stale games:', e.message);
  }
}

// A full framed packet arrived from the gameserver. GAME_SERVER_CONNECT packets
// are announces; ANY other packet whose payload contains a JSON server config
// is also treated as an announce, so a gameserver that uses an unexpected type
// code still registers itself on its very first room call. EVERY packet is
// acknowledged with an empty response (like the reference room server): the
// gameserver only keeps the room link (and therefore its players) alive while
// it receives replies to its periodic heartbeat/keepalive packets. Ignoring
// them for a few minutes makes the gameserver declare the room dead and boot
// everyone with "network is abnormal" / ID_DISCONNECTION_NOTIFICATION.
function onRoomPacket(socket, data) {
  let request;
  try {
    request = parseRoomPacket(data);
  } catch (e) {
    return null;
  }
  // Detect the different TCP calls the gameservers make: log the FIRST
  // occurrence of each packet type per socket (with a payload snippet), so we
  // can see what actually arrives - connect announce, game status, user in/out,
  // heartbeats, etc. - and which packet carries the port/ip/map we route on.
  if (!socket._seenTypes) socket._seenTypes = new Set();
  if (request.type != null && !socket._seenTypes.has(request.type)) {
    socket._seenTypes.add(request.type);
    const snippet = String(request.data || '').replace(/\s+/g, ' ').slice(0, 200);
    console.log(`[ROOM] new tcp packet type=${request.type} from=${socket.remoteAddress} payload=${snippet || '(empty)'}`);
  }
  // Walk every data payload we got, but only the FIRST announce registers.
  const response = onGameServerConnects(socket, request.data);
  if (response) return response;
  return createRoomPacket(0, '');
}

function sendUserToServer(addr, serverUser) {
  const packet = createRoomPacket(RoomConstants.ROOM_MANAGER_USER_ATTRIBUTE, JSON.stringify(serverUser));
  const socket = getRoomServerSocket(addr);
  if (socket == null) return;
  sendRoomResponse(socket, packet);
}

// Max size we'll allow a single incoming room packet to claim to be, to stop
// a corrupt/garbage length header from making us buffer unbounded memory.
const MAX_ROOM_PACKET_SIZE = 10 * 1024 * 1024;

function startRoomServer() {
  const roomServer = net.createServer((socket) => {
    // TCP is a byte stream: one 'data' event can hold zero/one/many packets,
    // and one packet can be split across several events. Buffer per-connection
    // and only parse complete framed packets, looping in case several arrived.
    // If the byte stream is NOT our framed protocol, fall back to scanning the
    // accumulated text for a JSON server config so a real GameServer.exe that
    // uses its own wire format is still auto-detected from its first call.
    let buffer = Buffer.alloc(0);
    let rawLogged = false;
    socket.on('data', (data) => {
      buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
      // 1) framed protocol
      while (buffer.length >= 4) {
        let packetLength;
        try { packetLength = buffer.readInt32BE(0); } catch { break; }
        if (packetLength < 4 || packetLength > MAX_ROOM_PACKET_SIZE) break; // not our framing
        const totalSize = packetLength + 8;
        if (buffer.length < totalSize) break; // wait for the rest of the packet
        const packet = buffer.subarray(0, totalSize);
        buffer = buffer.subarray(totalSize);
        try {
          const response = onRoomPacket(socket, packet);
          if (response) sendRoomResponse(socket, response);
        } catch (e) {
          console.error('Room packet error:', e);
        }
      }
      // 2) non-framed auto-detect: try to read a server config out of whatever
      // bytes the gameserver sent on its very first call.
      if (buffer.length > 0) {
        const text = buffer.toString('utf8');
        const parsed = tryParseJson(text);
        if (parsed && unwrapServerInfo(parsed) && unwrapServerInfo(parsed).port != null) {
          try {
            const response = onGameServerConnects(socket, text);
            if (response) sendRoomResponse(socket, response);
          } catch (e) {
            console.error('Room packet error:', e);
          }
          buffer = Buffer.alloc(0);
        } else if (!rawLogged && buffer.length > 0) {
          rawLogged = true;
          console.log(`[DISPATCH] room data did not parse as a gameserver announce (${buffer.length} bytes): ${buffer.toString('hex').slice(0, 160)}`);
        }
      }
    });
    socket.on('error', (err) => {
      if (err.message && err.message.includes('ECONNRESET')) {
        console.error('Server disconnected unexpectedly: Did the server crash?');
      } else {
        console.error(err);
      }
    });
    socket.on('close', () => {
      removeRoomServer(socket);
    });
  });

  roomServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Room server PORT=${ROOM_PORT} already in use, skipping`);
    } else {
      console.error('Room server error:', err);
    }
  });

  roomServer.listen(ROOM_PORT, () => {
    console.log(`Room server started PORT=${ROOM_PORT}`);
  });
}

createDevEndpoint(app, '/v4/dispatch', ['POST'], [async (req) => {
  const userId = req.getUserId();
  const uidBan = await activeBanForUser(userId);
  if (uidBan) return Responses.banned(uidBan.reason);
  const rawHwid = req.headers['x-hwid'] || req.headers['hwid'] || req.query.hwid;
  if (rawHwid) {
    const hwBan = await activeBanForHwid(rawHwid);
    if (hwBan) return Responses.banned(hwBan.reason);
    await logHwid(userId, rawHwid, CLIENT_IP.from(req));
  }
  const gameId = String(req.query?.gameId || '0');
  const cached = await kvGet(`cache.game.token.${userId}`);
  let tokenData = null;
  if (cached) { try { tokenData = JSON.parse(cached); } catch { tokenData = null; } }
  const timestamp = (tokenData && tokenData.timestamp) || '10';
  const gameToken = crypto.createHash('sha1').update(GAME_SECRET + userId + timestamp).digest('hex');
  // Only dispatch to the exact server hosting the requested game. An invalid
  // gameId (no running server) is rejected instead of silently landing on a
  // default port, which makes the client connect to the wrong game.
  const target = resolveGameServer(gameId);
  if (!target) return Responses.gameNotExists();
  const srv = target.server;
  const srvPort = String(srv.port);
  const addr = clientReachableAddr(req, srv);
  const mid = target.mapId;
  // Room handoff, mirroring the reference dispatcher: the user must be
  // forwarded to the gameserver's room socket BEFORE the client opens its
  // TCP connection, otherwise the gameserver has no ServerUser record for
  // the connecting client and rejects/ignores it ("connect server timeout").
  const user = await userFromUserId(userId);
  if (user) {
    const vip = await vipFromUserId(userId);
    const userDresses = await getEquippedDresses(userId);
    const gameSkinData = getGameDresses(userDresses);
    const serverUser = {
      id: user.userId,
      sex: user.sex,
      vip: vip.vip,
      skin: gameSkinData,
      team: crypto.randomInt(2, 5),
      pioneer: true,
      rid: 1001,
      clz: 0
    };
    const roomAddr = srv.addr;
    sendUserToServer(roomAddr, serverUser);
  }
  console.log(`[DISPATCH] ${addr} DISPATCHED user=${userId} game=${gameId} gid=${srv.gid} mid=${mid}`);
  return Responses.success({
    gaddr: addr,
    name: mid,
    signature: gameToken,
    croomid: '0',
    timestamp,
    mname: mid,
    downurl: `${cdnHost(req)}/static/files/games/map/${mid}.zip`,
    region: '1001',
    dispUrl: apiHost(req),
    mid,
    rver: 0
  });
}]);

// POST /v1/dispatch (Blockman Forge dispatcher) - matches the stub response
// shape but dispatches to the REAL gameserver discovered at startup / via the
// room-server TCP announce, and hands the user off to the gameserver's room
// socket BEFORE the client opens its TCP connection (otherwise the gameserver
// has no ServerUser record and the client gets "connect server timeout").
// Stub reference: D:\stubs\services\game\service.js (dispatch) + controller.
app.all('/v1/dispatch', async (req, res) => {
  try {
    const xUid = req.headers['x-shahe-uid'];
    const xToken = req.headers['x-shahe-token'];
    if (!xUid || !xToken) {
      const r = Responses.requiresGameAuthParams();
      return res.status(r.status).json(r.content);
    }
    const userId = parseInt(xUid);
    const gameId = String(xToken);

    // Real gameserver for this game (port comes from the runserver bat /
    // the gameserver's own TCP announce to the room server, NOT a stub map).
    // The bat registry is authoritative for the port: always use the exact
    // game's discovered port so the client never gets another game's port,
    // regardless of the gameserver's room-connection state. An invalid game
    // (no server hosting it locally) is rejected, never dispatched to a
    // default/wrong server.
    const target = resolveGameServer(gameId);
    if (!target) {
      const r = Responses.gameNotExists();
      return res.status(r.status).json(r.content);
    }
    const srv = target.server;
    const srvPort = String(srv.port);

    // mapId from the resolved server (handles g1008 -> m1008_3 multi-mode
    // override like the stub). Built AFTER resolution so aliases such as
    // g1008_4 keep their own map id.
    let mapId = target.mapId;

    // roomAddr: the gameserver's authoritative address as known by the room
    // server (srv.addr is refreshed on each room TCP announce). If no room
    // socket is registered yet, sendUserToServer() below is a no-op and the
    // gameserver will still accept the client since it validates the dispatch
    // signature on connection.
    const roomAddr = srv.addr;
    const gaddr = clientReachableAddr(req, srv);
    console.log('[DISPATCH] /v1/dispatch game=' + gameId + ' room=' + roomAddr + ' gaddr=' + gaddr + ' mid=' + mapId);

    // Room handoff: forward the user to the gameserver BEFORE the client TCP.
    const user = await userFromUserId(userId);
    if (user) {
      const vip = await vipFromUserId(userId);
      const userDresses = await getEquippedDresses(userId);
      const gameSkinData = getGameDresses(userDresses);
      const serverUser = {
        id: user.userId,
        sex: user.sex,
        vip: vip.vip,
        skin: gameSkinData,
        team: crypto.randomInt(2, 5),
        pioneer: true,
        rid: 1001,
        clz: 0
      };
      sendUserToServer(roomAddr, serverUser);
    }

    const data = {
      gaddr,
      type: gameId,
      mid: mapId,
      mname: mapId,
      downurl: `${cdnHost(req)}/static/files/games/map/${mapId}.zip`,
      name: '',
      signature: crypto.createHash('sha1').update(GAME_SECRET + userId + '10').digest('hex'),
      timestamp: 10,
      userId
    };
    console.log('[DISPATCH] /v1/dispatch', data);
    const r = Responses.success(data);
    res.status(r.status).json(r.content);
  } catch (e) {
    console.error('Error occurred with API: /v1/dispatch');
    console.error(e);
    const r = Responses.innerError();
    res.status(r.status).json(r.content);
  }
});

// GET /game/api/v1/games/resource/version
// Client contract (webapi/indiegame):
//   resCheck(@Query("ver") int, @Query("platform") String, @Header("userId") long,
//            @Header("Access-Token") String) -> HttpResponse<ResCheckEntity>
//
// ResCheckEntity has exactly three fields: { String md5; boolean update; String url; }
// There is no version field in the response - the client sends its own resource
// version as ?ver= (read from its local version.json by indiegame.d.p /
// VersionUtils) and the SERVER decides whether an update is needed.
//
// Client-side flow:
//   checkupdate/a.java:274  download starts only when isUpdate() is true
//   checkupdate/c.java:64   and only when getUrl() != null
//   d/a/c.java (DownloadTask)
//     - filename comes from the URL (last path segment)
//     - HEAD for contentLength; 0 -> immediate failure
//     - resumes via RANGE, then compares md5 (lowercased) and renames the
//       finished download to updateRes.tar.gz
//
// So `url` MUST be null (not "") when there is nothing to fetch: "" is not null,
// which makes the client try to download the empty string and fail with
// "failed to download update of version".
const ANDROID_RES_FILE = 'CurrentAndroidRes.zip';
// Version of the bundle in cdn/CurrentAndroidRes.zip. A client reporting an
// equal or newer ?ver= is already up to date and is told so. Bump this (or set
// RESOURCE_VERSION) after replacing the bundle to push it to everyone.
const RESOURCE_VERSION = parseInt(process.env.RESOURCE_VERSION) || 1;

let androidResInfo = null; // { md5, size }, hashed once because the bundle is ~98 MB
async function getAndroidResInfo() {
  if (androidResInfo) return androidResInfo;
  const file = path.join(CDN_ROOT, ANDROID_RES_FILE);
  let md5 = '';
  let size = 0;
  try {
    size = fs.statSync(file).size;
    md5 = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(file);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  } catch (e) {
    console.warn(`[RESOURCE] ${ANDROID_RES_FILE} unreadable: ${e.message}`);
  }
  androidResInfo = { md5, size };
  return androidResInfo;
}

createDevEndpoint(app, '/game/api/v1/games/resource/version', ['GET'], [async (req) => {
  const rawVer = req.query?.ver;
  const clientVer = Number.parseInt(rawVer, 10);
  const platform = String(req.query?.platform ?? '');

  if (Number.isInteger(clientVer) && clientVer >= RESOURCE_VERSION) {
    console.log(`[RESOURCE] ver=${rawVer ?? '(none)'} platform=${platform || '-'} -> up to date (hosted v${RESOURCE_VERSION}), no download`);
    return Responses.success({ md5: null, update: false, url: null });
  }

  const res = await getAndroidResInfo();
  const resUrl = `${cdnHost(req)}/${ANDROID_RES_FILE}`;
  console.log(`[RESOURCE] ver=${rawVer ?? '(none)'} platform=${platform || '-'} -> update to v${RESOURCE_VERSION} (${res.size} bytes)`);
  return Responses.success({ md5: res.md5, update: true, url: resUrl });
}]);

// The only engine version this server hosts resource bundles for. Any other
// engineVersion is refused: we have no content for it.
const SUPPORTED_ENGINE_VERSION = 10039;

// GET /game/api/v2/games/app-engine/check-update
// The client asks whether the engine / common / game resource bundles need
// downloading. Only engineVersion 10039 is hosted, and there is no newer
// bundle to hand out, so the answer is an EMPTY list: that needs no
// AppEngineResourceUpdateResult fields and means "nothing to fetch", so the
// client skips the resource download instead of failing on a bad URL.
createDevEndpoint(app, '/game/api/v2/games/app-engine/check-update', ['GET'], [async (req) => {
  const rawEngineVersion = req.query?.engineVersion;
  const engineVersion = Number.parseInt(rawEngineVersion, 10);
  const gameType = String(req.query?.gameType ?? '');
  const engineType = String(req.query?.engineType ?? '');
  const commonResVersion = req.query?.commonResVersion ?? 0;
  const gameResVersion = req.query?.gameResVersion ?? 0;

  // engineVersion missing or not a number -> cannot be the hosted version.
  if (!Number.isInteger(engineVersion) || engineVersion !== SUPPORTED_ENGINE_VERSION) {
    console.log(`[APP-ENGINE] refused engineVersion=${rawEngineVersion ?? '(none)'} gameType=${gameType || '-'} engineType=${engineType || '-'} (only ${SUPPORTED_ENGINE_VERSION} is hosted)`);
    return Responses.gameNotExists();
  }

  console.log(`[APP-ENGINE] check-update engineVersion=${engineVersion} commonRes=${commonResVersion} gameRes=${gameResVersion} gameType=${gameType || '-'} engineType=${engineType || '-'} -> up to date`);
  return Responses.success([]);
}]);

// PUT /game/api/v1/games/engine
// Client contract (IGameApi):
//   countUploadVersion(@Query("engineVersion") String,
//                      @Header("CloudFront-Viewer-Country") String,
//                      @Header("userId") long, @Header("Access-Token") String)
//     -> HttpResponse   (no entity)
//
// The client only reports which engine it booted. Accept whatever it sends so
// an old or unexpected engineVersion never blocks startup; the version that
// actually matters is enforced at app-engine/check-update.
createDevEndpoint(app, '/game/api/v1/games/engine', ['PUT'], [async (req) => {
  const engineVersion = String(req.query?.engineVersion ?? '');
  const country = String(req.headers?.['cloudfront-viewer-country'] ?? '');
  console.log(`[ENGINE] client reported engineVersion=${engineVersion || '(none)'} country=${country || '-'} -> accepted`);
  return Responses.success();
}]);

// ---------------------------------------------------------------------
// Indiegame launcher config (webapi/indiegame).
//
// These are what the "check update" screen runs on, in this order
// (view/fragment/checkupdate/a.java - CheckUpdateModel):
//   1. GET  /api/v1/config/indiegame-check-version  -> LatestVersion
//      a.java:82  does latestVersion.getDownInfoMap().get("jailbreak"), so
//                 downInfoMap MUST be non-null or the client NPEs.
//      a.java:139 prompts for an APK update only if 77 < newVersionCode, so
//                 newVersionCode <= 77 means "no APK update".
//   2. GET  /api/v1/config/indiegame-config         -> AppConfig
//      a.java:216 `if (appConfig.isOpenUpdateSO())` gates the whole engine
//                 resource update. With it false the client sends
//                 "token.copy.resource" and never touches /games/resource/version.
//   A failure in either one surfaces as R.string.check_update_failure_app_version
//   ("failed to download version update, try again"), which is why these must
//   exist even though this server hosts no APK updates at all.
// ---------------------------------------------------------------------

// Version code this server pretends to be. 77 is the boundary checked at
// a.java:139, so 0 keeps the client on the "already latest" path.
const INDIEGAME_VERSION_CODE = 77;

// GET /api/v1/config/indiegame-check-version
createDevEndpoint(app, '/api/v1/config/indiegame-check-version', ['GET'], [async () => {
  return Responses.success({
    apkUrl: null,
    apkMd5: null,
    picUrl: null,
    content: '',
    updateInfo: '',
    langMap: {},
    newVersionCode: INDIEGAME_VERSION_CODE,
    smallerThanVersion: 0,
    forceUpdateMinVersionCode: 0,
    forceUpdateMaxVersionCode: 0,
    needTobeForceUpdateVersions: [],
    // status 0 = nothing to download for this channel (a.java:84 case 0).
    downInfoMap: { jailbreak: { status: 0, url: null } }
  });
}]);

// GET /api/v1/config/indiegame-config
// isOpenUpdateSO is deliberately false: this server does not ship engine
// resource updates, and leaving it true pushes the client into the
// /games/resource/version download path on every boot.
createDevEndpoint(app, '/api/v1/config/indiegame-config', ['GET'], [async () => {
  return Responses.success({
    isOpenUpdateSO: false,
    isOpenMorePay: false,
    isShowAds: false,
    isShowCampaign: false,
    isShowChest: false,
    isShowShare: false,
    isShowThirdPart: false
  });
}]);

// GET /api/v1/config/indiegame-moregame_introduction -> List<BannerInfo>
createDevEndpoint(app, '/api/v1/config/indiegame-moregame_introduction', ['GET'], [async () => Responses.success([])]);

// POST /user/api/v1/user/mac/id -> countDaily, plain HttpResponse with no entity
createDevEndpoint(app, '/user/api/v1/user/mac/id', ['POST'], [async () => Responses.success()]);

createDevEndpoint(app, '/game/api/v2/games/:gameId', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const gameId = req.params.gameId;
  const self = gameDetailFromFile(gameId);
  if (!self) return Responses.gameNotExists();
  const online = 0;
  const like = 0;
  const data = {
    appreciate: false,
    authorInfo: self.author,
    bannerPic: self.banner,
    currentPage: 0,
    currentSize: 0,
    gameBannerVideoInfos: [],
    gameCoverPic: self.pic,
    gameDetail: self.desc,
    gameId,
    gameMode: 0,
    gameName: self.name,
    gamePayInfo: {},
    gameTitle: self.name,
    gameTypes: self.tags,
    isNewEngine: self.eng,
    isOpenParty: self.party,
    isPay: self.pay,
    isRankOnline: self.rank,
    isShopOnline: self.shop,
    onlineNumber: online,
    praiseNumber: like,
    realPlayGameList: [],
    resVersion: 0,
    turntableStatus: 0,
    version: 0,
    visitorEnter: 0,
    warmUpResponse: {
      authorInfo: self.author,
      bannerPic: self.banner,
      featuredPlay: self.screenshot,
      gameCoverPic: self.pic,
      gameDetail: self.desc,
      gameId,
      gameTitle: self.name,
      images: self.banner,
      isPublish: 1
    }
  };
  const appreciate = await gameLikeResponse(userId, gameId);
  if (appreciate) data.appreciate = appreciate.appreciate;
  return Responses.success(data);
}]);

createDevEndpoint(app, '/game/api/v1/games/warmup/:gameId/languages/:language', ['GET'], [async (req) => {
  const gameId = req.params.gameId;
  const game = await gameFromGameId(gameId);
  if (!game) return Responses.gameNotExists();
  const gameDetail = await gameDetailFromGameId(gameId);
  return Responses.success(gameDetail || {});
}]);

createDevEndpoint(app, '/game/api/v1/game/chat/room', ['POST', 'DELETE'], [
  async () => Responses.innerError(),
  async () => Responses.innerError()
]);

createDevEndpoint(app, '/game/api/v2/games/recommendation/type', ['GET'], [async (req) => {
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const games = await listRealGames(pageNo, pageSize, req);
  return Responses.success(games);
}]);

createDevEndpoint(app, '/game/api/v1/games/:gameId/rank', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/game/api/v1/games/:gameId/uses/rank', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/game/api/v1/games/all/open/party', ['GET'], [async () => {
  const partyGames = await listPartyGames();
  return Responses.success(partyGames);
}]);

createDevEndpoint(app, '/game/api/v1/games/config/app/:gameId', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/game/api/v1/games/team/member/:teamId', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/game/api/v1/game/:gameId/turntable', ['GET', 'PUT'], [
  async () => Responses.innerError(),
  async () => Responses.innerError()
]);

createDevEndpoint(app, '/game/api/v1/game/:gameId/turntable/props', ['GET'], [async () => Responses.success()]);

createDevEndpoint(app, '/game/api/v1/games/app-engine/upgrade', ['GET'], [async () => Responses.success({})]);

createDevEndpoint(app, '/game/api/v1/games/update/tip/info/app/:gameId', ['GET'], [async (req) => {
  const gameId = req.params.gameId;
  const update = await gameUpdateFromGameId(gameId);
  return Responses.success(update ? { count: update.version, content: update.content } : { count: 0, content: '' });
}]);

createDevEndpoint(app, '/game/api/v1/games/update/list/:userId', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/game/api/v1/games/announcement/info', ['GET'], [async () => {
  const p = path.join(DB_DIR, 'notices', 'announcement.json');
  let notice = null;
  if (fs.existsSync(p)) { try { notice = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { notice = null; } }
  return Responses.success(notice);
}]);

createDevEndpoint(app, '/game/api/v1/games/stop/announcement/info', ['GET'], [async () => {
  const p = path.join(DB_DIR, 'notices', 'maintenance.json');
  let notice = null;
  if (fs.existsSync(p)) { try { notice = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { notice = null; } }
  return Responses.success(notice);
}]);

createDevEndpoint(app, '/game/api/v1/games/ugc', ['GET'], [async () => Responses.success(Page.empty())]);

createDevEndpoint(app, '/game/api/v1/games/ugc/status', ['GET'], [async () => Responses.innerError()]);

// =====================================================================
//  FRIEND SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/friend/api/v1/friends', ['GET', 'POST', 'DELETE'], [
  async (req) => {
    const userId = req.getUserId();
    const pageNo = parseInt(req.query?.pageNo) || 0;
    const pageSize = parseInt(req.query?.pageSize) || 10;
    const friends = await friendListFromUserId(userId, pageNo, pageSize);
    return Responses.success(friends);
  },
  async (req) => {
    const userId = req.getUserId();
    const friendId = parseInt(req.body?.friendId);
    const message = req.body?.msg;
    if (isNaN(friendId) || friendId === userId || !(await userExists(friendId))) return Responses.notValidUser();
    if (await friendIsFriend(userId, friendId)) return Responses.alreadyFriend();
    if ((await friendListIdsFromUserId(userId)).length >= MAX_FRIENDS) return Responses.friendListFull();
    const user = await userFromUserId(userId);
    const locale = await dbGet('SELECT * FROM user_locale WHERE userId = ?', [userId]);
    await saveFriendRequest({
      userId: friendId,
      friendId: userId,
      message,
      picUrl: user ? user.picUrl : '',
      nickName: user ? user.nickName : '',
      sex: user ? user.sex : 0,
      country: locale ? locale.country : '',
      language: locale ? locale.language : '',
      status: RequestStatuses.PENDING,
      creationTime: Date.now()
    });
    return Responses.success();
  },
  async (req) => {
    const userId = req.getUserId();
    const friendId = parseInt(req.query?.friendId);
    if (isNaN(friendId)) return Responses.notValidUser();
    if (!await friendIsFriend(userId, friendId)) return Responses.notValidUser();
    await friendRemoveFriend(userId, friendId);
    return Responses.success();
  }
]);

createDevEndpoint(app, '/friend/api/v1/friends/requests', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const requests = await friendRequestListFromUserId(userId, pageNo, pageSize);
  return Responses.success(requests);
}]);

createDevEndpoint(app, '/friend/api/v1/friends/info/:nickName', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const nickName = req.params.nickName;
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  if (!nickName) return Responses.success(Page.empty());
  const excludeList = await friendListIdsFromUserId(userId);
  const results = await friendSearch(userId, nickName, excludeList, pageNo, pageSize);
  return Responses.success(results);
}]);

createDevEndpoint(app, '/friend/api/v1/friends/info/id/:friendId', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const friendId = parseInt(req.params.friendId);
  if (userId === friendId) return Responses.success();
  if (await friendIsFriend(userId, friendId)) return Responses.success();
  if (!await userExists(friendId)) return Responses.success();
  const friendInfo = await friendGetInfo(friendId);
  const friend = await friendFromUserId(userId, friendId);
  if (friend && friendInfo) {
    friendInfo.friend = true;
    friendInfo.alias = friend.alias;
  }
  return Responses.success(friendInfo);
}]);

createDevEndpoint(app, '/friend/api/v1/friends/:friendId/alias', ['POST', 'DELETE'], [
  async (req) => {
    const userId = req.getUserId();
    const friendId = parseInt(req.params.friendId);
    const alias = req.query?.alias;
    const friend = await friendFromUserId(userId, friendId);
    if (!friend) return Responses.notValidUser();
    if (alias != null) {
      await dbRun('UPDATE friend SET alias = ? WHERE userId = ? AND friendId = ?', [alias, userId, friendId]);
    }
    return Responses.success();
  },
  async (req) => {
    const userId = req.getUserId();
    const friendId = parseInt(req.params.friendId);
    const friend = await friendFromUserId(userId, friendId);
    if (!friend) return Responses.notValidUser();
    if (friend.alias) {
      await dbRun('UPDATE friend SET alias = NULL WHERE userId = ? AND friendId = ?', [userId, friendId]);
    }
    return Responses.success();
  }
]);

createDevEndpoint(app, '/friend/api/v1/friends/:friendId/agreement', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const friendId = parseInt(req.params.friendId);
  if (userId === friendId || !await userExists(friendId)) return Responses.notValidUser();
  const friendRequest = await friendRequestFromFriendId(userId, friendId);
  if (!friendRequest) return Responses.notValidUser();
  if ((await friendListIdsFromUserId(userId)).length >= MAX_FRIENDS) return Responses.friendListFull();
  if ((await friendListIdsFromUserId(friendId)).length >= MAX_FRIENDS) return Responses.friendListFull();
  await dbRun('UPDATE friend_request SET status = ? WHERE userId = ? AND friendId = ?', [RequestStatuses.ACCEPTED, userId, friendId]);
  await friendAddFriend(userId, friendId);
  return Responses.success();
}]);

createDevEndpoint(app, '/friend/api/v1/friends/:friendId/rejection', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const friendId = parseInt(req.params.friendId);
  if (userId === friendId || !await userExists(friendId)) return Responses.notValidUser();
  const friendRequest = await friendRequestFromFriendId(userId, friendId);
  if (!friendRequest) return Responses.notValidUser();
  await dbRun('UPDATE friend_request SET status = ? WHERE userId = ? AND friendId = ?', [RequestStatuses.REFUSED, userId, friendId]);
  return Responses.success();
}]);

createDevEndpoint(app, '/friend/api/v2/friends/:friendId', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const friendId = parseInt(req.params.friendId);
  if (!await userExists(friendId)) return Responses.userNotExists();
  const friendInfo = await friendGetInfo(friendId);
  const friend = await friendFromUserId(userId, friendId);
  if (friend && friendInfo) {
    friendInfo.friend = true;
    friendInfo.alias = friend.alias;
  }
  return Responses.success(friendInfo);
}]);

createDevEndpoint(app, '/friend/api/v1/friends/status', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const userFriendList = await friendListIdsFromUserId(userId);
  const status = [];
  for (let i = 0; i < userFriendList.length; i++) {
    status.push({ userId: userFriendList[i], status: 0, gameId: '', gameName: '' });
  }
  return Responses.success({ curFriendCount: userFriendList.length, maxFriendCount: MAX_FRIENDS, status });
}]);

createDevEndpoint(app, '/friend/api/v1/friends/recommendation', ['GET'], [async () => Responses.success([])]);

// =====================================================================
//  MAIL SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/mailbox/api/v1/mail', ['GET', 'PUT'], [
  async (req) => {
    const userId = req.getUserId();
    const mails = await getMailboxByUserId(userId, false);
    return Responses.success(mails);
  },
  async (req) => {
    const userId = req.getUserId();
    const mailIds = (req.query?.ids || '').split(',').map(x => parseInt(x));
    const targetStatus = parseInt(req.query?.status);
    if (targetStatus < MailStatuses.READ || targetStatus > MailStatuses.DELETE) return Responses.invalidMailStatus();
    const mails = await getMailboxByUserId(userId, false);
    if (mails.length == 0) return Responses.success();
    const statuses = [];
    for (let i = 0; i < mails.length; i++) {
      if (!mailIds.includes(mails[i].id)) continue;
      if (mails[i].status === MailStatuses.UNREAD && targetStatus === MailStatuses.DELETE) continue;
      if (mails[i].status === MailStatuses.UNREAD && (mails[i].attachment || []).length > 0 && targetStatus > MailStatuses.UNREAD) continue;
      statuses.push({ id: mails[i].id, status: targetStatus });
    }
    await mergeJsonArray('mailbox_record', 'userId', userId, 'data', statuses);
    return Responses.success();
  }
]);

createDevEndpoint(app, '/mailbox/api/v1/mail/attachment', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const mailId = parseInt(req.query?.mailId);
  const mails = await getMailboxByUserId(userId, true);
  const targetMail = mails.find(m => m.id === mailId);
  if (!targetMail) return Responses.mailNotFound();
  const mailAttachments = targetMail.attachment || [];
  if (mailAttachments.length == 0) return Responses.mailHasNoAttachments();
  for (const attachment of mailAttachments) {
    switch (attachment.type) {
      case MailAttachmentTypes.CURRENCY:
        await addCurrency(userId, attachment.itemId, attachment.qty);
        break;
      case MailAttachmentTypes.DRESS:
        await addDresses(userId, [attachment.itemId]);
        break;
      case MailAttachmentTypes.VIP:
        await addVip(userId, attachment.vipLevel, attachment.vipDuration);
        break;
    }
  }
  await mergeJsonArray('mailbox_record', 'userId', userId, 'data', [{ id: targetMail.id, status: MailStatuses.READ }]);
  return Responses.success();
}]);

createDevEndpoint(app, '/mailbox/api/v1/mail/new', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const mails = await getMailboxByUserId(userId, false);
  let hasNewMail = false;
  for (let i = 0; i < mails.length; i++) {
    if (mails[i].status === MailStatuses.UNREAD) { hasNewMail = true; break; }
  }
  return Responses.success(hasNewMail);
}]);

// =====================================================================
//  DECORATION SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/decoration/api/v1/decorations/using', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const equippedDressesInfo = [];
  const equippedDresses = await getEquippedDresses(userId);
  for (let i = 0; i < equippedDresses.length; i++) {
    const dressInfo = getDressInfo(equippedDresses[i]);
    if (dressInfo == null) continue;
    dressInfo.status = 1;
    equippedDressesInfo.push(JSON.parse(JSON.stringify(dressInfo)));
  }
  return Responses.success(equippedDressesInfo);
}]);

createDevEndpoint(app, '/decoration/api/v:version/decorations/:typeId', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const categoryId = parseInt(req.params.typeId);
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const ownedDresses = await getOwnedDresses(userId);
  const usingDresses = await getEquippedDresses(userId);
  const filteredDresses = getDresses({
    categoryId,
    ownerFilter: ownedDresses,
    usingFilter: usingDresses,
    ownerType: DressOwnerTypes.STRICT
  });
  const data = new Page(filteredDresses, filteredDresses.length, pageNo, pageSize);
  return Responses.success(data);
}]);

createDevEndpoint(app, '/decoration/api/v1/decorations/:otherId/using', ['GET'], [async (req) => {
  const targetId = parseInt(req.params.otherId);
  const equippedDressesInfo = [];
  const equippedDresses = await getEquippedDresses(targetId);
  for (let i = 0; i < equippedDresses.length; i++) {
    const dressInfo = getDressInfo(equippedDresses[i]);
    if (dressInfo == null) continue;
    dressInfo.status = 1;
    equippedDressesInfo.push(JSON.parse(JSON.stringify(dressInfo)));
  }
  return Responses.success(equippedDressesInfo);
}]);

createDevEndpoint(app, '/decoration/api/v1/decorations/using/:decorationId', ['PUT', 'DELETE'], [
  async (req) => {
    const userId = req.getUserId();
    const decorationId = parseInt(req.params.decorationId);
    const ownedDresses = await getOwnedDresses(userId);
    if (!ownedDresses.includes(decorationId)) return Responses.dressNotOwned();
    const equippedDresses = await getEquippedDresses(userId);
    const dressInfo = getDressInfo(decorationId);
    if (equippedDresses.includes(decorationId)) return Responses.success(dressInfo || null);
    const typeId = decorationId.toString().substring(0, decorationId.toString().length - 5);
    const newEquipped = equippedDresses.filter(d => d.toString().slice(0, -5) !== typeId);
    newEquipped.push(decorationId);
    await setEquippedDresses(userId, newEquipped);
    return Responses.success(dressInfo || null);
  },
  async (req) => {
    const userId = req.getUserId();
    const decorationId = parseInt(req.params.decorationId);
    const ownedDresses = await getOwnedDresses(userId);
    if (!ownedDresses.includes(decorationId)) return Responses.dressNotOwned();
    const equippedDresses = await getEquippedDresses(userId);
    if (!equippedDresses.includes(decorationId)) return Responses.success();
    const newEquipped = equippedDresses.filter(d => d != decorationId);
    await setEquippedDresses(userId, newEquipped);
    return Responses.success();
  }
]);

// =====================================================================
//  PAY SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/pay/api/v1/wealth/user', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const wealth = await wealthFromUserId(userId);
  return Responses.success(wealth);
}]);

// =====================================================================
//  GAMEAIDE SERVICE (main-api-dev)  -- ported from D:\shit\gsgsgs
//  The gameserver (Lord) inner client hits these to load segment/
//  integral (PoliceConfig/Lord money) and party/friend data. Before this
//  port they were unregistered -> "http status code : 0" errors.
// =====================================================================

// SEGMENTS mirror the reference: [segment, minIntegral]
const GAMEAIDE_SEGMENTS = [
  [0, 1000],
  [1, 1100],
  [2, 1300],
  [3, 1600],
  [4, 2100],
];

async function wealthIntegral(userId) {
  const w = await wealthFromUserId(userId);
  // Integral is derived from the player's stored wealth so the money
  // loader never crashes comparing a nil value.
  return w ? (Number(w.golds) + Number(w.diamonds)) : 0;
}

function segmentForIntegral(integral) {
  let segment = 0;
  for (let i = GAMEAIDE_SEGMENTS.length - 1; i >= 0; i -= 1) {
    const minIntegral = GAMEAIDE_SEGMENTS[i][1];
    if (integral >= minIntegral) return GAMEAIDE_SEGMENTS[i][0];
  }
  return segment;
}

// GET /gameaide/api/v1/segment/integral  (inner segment info)
// GET /gameaide/api/v1/inner/user/segment/info
// GET /gameaide/api/v1/inner/user/segment/info?gameId=..&userId=..
createDevEndpoint(app, '/gameaide/api/v1/segment/integral', ['GET'], [async (req) => {
  const userId = parseInt(req.query?.userId) || req.getUserId();
  const integral = await wealthIntegral(userId);
  const segment = segmentForIntegral(integral);
  return Responses.success({
    userId: String(userId),
    integral,
    segment,
    rank: 99999,
    timeRemains: 0,
    needReward: 0,
  });
}]);

// GET /gameaide/api/v1/inner/user/segment/info
createDevEndpoint(app, '/gameaide/api/v1/inner/user/segment/info', ['GET'], [async (req) => {
  const userId = parseInt(req.query?.userId) || req.getUserId();
  const integral = await wealthIntegral(userId);
  const segment = segmentForIntegral(integral);
  return Responses.success({ userId: String(userId), integral, segment });
}]);

createDevEndpoint(app, '/pay/api/v1/wealth/record/users/:userId', ['GET'], [async (req) => {
  const userId = parseInt(req.params.userId);
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const countRow = await dbGet('SELECT COUNT(1) AS c FROM wealth_record WHERE userId = ?', [userId]);
  const totalSize = countRow ? countRow.c : 0;
  const startIndex = Page.getStartIndex(pageNo, pageSize);
  const rows = await dbAll('SELECT * FROM wealth_record WHERE userId = ? ORDER BY created DESC LIMIT ? OFFSET ?', [userId, pageSize, startIndex]);
  return Responses.success(new Page(rows, totalSize, pageNo, pageSize));
}]);

createDevEndpoint(app, '/pay/api/v1/first/punch/reward', ['GET'], [async () => Responses.success(firstRechargeConfig)]);

createDevEndpoint(app, '/pay/api/v1/pay/products', ['GET'], [async () => Responses.success(rechargeConfig)]);

createDevEndpoint(app, '/pay/api/v1/pay/products/vip', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/pay/api/v1/pay/payssion/flag', ['GET'], [async () => Responses.success(false)]);

// =====================================================================
//  CLAN SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/clan/api/v1/clan/tribe/recommendation', ['GET'], [async () => Responses.success([])]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe', ['GET', 'POST', 'PUT', 'DELETE'], [
  async (req) => {
    const clanId = parseInt(req.query?.clanId);
    if (isNaN(clanId)) return Responses.clanNotExists();
    const clan = await clanFromClanId(clanId);
    if (!clan) return Responses.clanNotExists();
    const shownMembers = await clanGetMembers(clanId, true);
    return Responses.success(clanResponse(clan, shownMembers));
  },
  async (req) => {
    const userId = req.getUserId();
    const { name, headPic, details, tags } = req.body || {};
    const clanMember = await clanMemberFromUserId(userId);
    if (clanMember.clanId != 0) return Responses.alreadyInClan();
    const clanId = await getNextClanId();
    const clan = { clanId, name, picUrl: headPic, tags: tags || [], details, experience: 0, level: 1, memberCount: 0, freeVerify: 0, language: '', creationTime: Date.now() };
    await dbRun('INSERT INTO clan (clanId, name, picUrl, tags, details, experience, level, memberCount, freeVerify, language, creationTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [clan.clanId, clan.name, clan.picUrl, JSON.stringify(clan.tags), clan.details, clan.experience, clan.level, clan.memberCount, clan.freeVerify, clan.language, clan.creationTime]);
    const memberCountHolder = { memberCount: 0 };
    await clanAddMember(clan.clanId, userId, ClanRoles.CHIEF, memberCountHolder);
    await dbRun('UPDATE clan SET memberCount = ? WHERE clanId = ?', [1, clan.clanId]);
    return Responses.success();
  },
  async (req) => {
    const userId = req.getUserId();
    const { name, headPic, details, tags } = req.body || {};
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    if (clanMember.role < ClanRoles.ELDER) return Responses.notEnoughPermissions();
    const clan = await clanFromClanId(clanMember.clanId);
    if (!clan) return Responses.clanNotExists();
    clan.name = name != null ? name : clan.name;
    clan.picUrl = headPic != null ? headPic : clan.picUrl;
    clan.details = details != null ? details : clan.details;
    clan.tags = tags != null ? tags : clan.tags;
    await clanSave(clan);
    return Responses.success(clan);
  },
  async (req) => {
    const userId = req.getUserId();
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    if (clanMember.role < ClanRoles.CHIEF) return Responses.notEnoughPermissions();
    const clanId = clanMember.clanId;
    await dbRun('DELETE FROM clan_member WHERE clanId = ?', [clanId]);
    await dbRun('DELETE FROM clan WHERE clanId = ?', [clanId]);
    await dbRun('DELETE FROM clan_notice WHERE clanId = ?', [clanId]);
    return Responses.success();
  }
]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member', ['GET', 'POST', 'PUT', 'DELETE'], [
  async (req) => {
    const userId = req.getUserId();
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    const clanMembers = await clanGetMembers(clanMember.clanId, false);
    return Responses.success(clanMembers);
  },
  async (req) => {
    const userId = req.getUserId();
    const clanId = parseInt(req.body?.clanId);
    const message = req.body?.msg;
    const clanMember = await clanMemberFromUserId(userId);
    if (clanMember.clanId != 0) return Responses.alreadyInClan();
    if (isNaN(clanId) || !await clanExists(clanId)) return Responses.clanNotExists();
    const user = await userFromUserId(userId);
    const request = await clanMessageFindFirst(userId, ClanMessageTypes.JOIN_REQUEST, RequestStatuses.PENDING);
    if (request) {
      await dbRun('UPDATE clan_message SET clanId = ?, message = ?, picUrl = ?, nickName = ? WHERE messageId = ?',
        [clanId, message, user ? user.picUrl : '', user ? user.nickName : '', request.messageId]);
    } else {
      await clanMessageSave({ userId, messageId: null, clanId, authorityId: null, message, picUrl: user ? user.picUrl : '', nickName: user ? user.nickName : '', type: ClanMessageTypes.JOIN_REQUEST, status: RequestStatuses.PENDING, creationTime: Date.now() });
    }
    return Responses.success();
  },
  async (req) => {
    const userId = req.getUserId();
    const memberId = parseInt(req.query?.otherId);
    const type = parseInt(req.query?.type);
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    if (clanMember.role < ClanRoles.CHIEF) return Responses.notEnoughPermissions();
    if (userId == memberId) return Responses.cannotChangeOwnRole();
    const targetMember = await clanMemberFromUserId(memberId);
    if (!targetMember.clanId) return Responses.notInClan();
    const clan = await clanFromClanId(clanMember.clanId);
    const clanLevelConfig = clanConfig.levels[clan.level];
    const elderCount = await clanGetElderCount(clan.clanId);
    const tUser = await userFromUserId(memberId);
    const msgBase = { userId: memberId, messageId: null, clanId: clan.clanId, picUrl: tUser ? tUser.picUrl : '', nickName: tUser ? tUser.nickName : '', creationTime: Date.now() };

    switch (type) {
      case ClanPromotionTypes.ELDER: {
        if (targetMember.role == ClanRoles.ELDER) return Responses.alreadyElder();
        if (elderCount + 1 > clanLevelConfig.maxElderCount) return Responses.elderLimitReached();
        await dbRun('UPDATE clan_member SET role = ? WHERE userId = ?', [ClanRoles.ELDER, memberId]);
        await clanMessageSave({ ...msgBase, type: ClanMessageTypes.ELDER_PROMOTION, status: RequestStatuses.ACCEPTED });
        break;
      }
      case ClanPromotionTypes.MEMBER: {
        await dbRun('UPDATE clan_member SET role = ? WHERE userId = ?', [ClanRoles.MEMBER, memberId]);
        await clanMessageSave({ ...msgBase, type: ClanMessageTypes.RETROGRADED, status: RequestStatuses.ACCEPTED });
        break;
      }
      case ClanPromotionTypes.CHIEF: {
        await dbRun('UPDATE clan_member SET role = ? WHERE userId = ?', [ClanRoles.MEMBER, userId]);
        await dbRun('UPDATE clan_member SET role = ? WHERE userId = ?', [ClanRoles.CHIEF, memberId]);
        await clanMessageSave({ ...msgBase, type: ClanMessageTypes.CHIEF_PROMOTION, status: RequestStatuses.ACCEPTED });
        break;
      }
      default:
        return Responses.invalidType();
    }
    return Responses.success();
  },
  async (req) => {
    const userId = req.getUserId();
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    if (clanMember.role == ClanRoles.CHIEF) return Responses.cannotLeaveClan();
    const clanId = clanMember.clanId;
    await dbRun('DELETE FROM clan_member WHERE userId = ?', [userId]);
    const user = await userFromUserId(userId);
    await clanMessageSave({ userId, messageId: null, clanId, picUrl: user ? user.picUrl : '', nickName: user ? user.nickName : '', type: ClanMessageTypes.MEMBER_LEFT, status: RequestStatuses.ACCEPTED, creationTime: Date.now(), authorityId: null, message: '' });
    const clan = await clanFromClanId(clanId);
    if (clan) {
      clan.memberCount = Math.max(0, clan.memberCount - 1);
      await clanSave(clan);
    }
    return Responses.success();
  }
]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/base', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.notInClan();
  const clan = await clanFromClanId(clanMember.clanId);
  if (!clan) return Responses.clanNotExists();
  const shownMembers = await clanGetMembers(clan.clanId, true);
  return Responses.success(clanResponse(clan, shownMembers));
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member/remove', ['DELETE'], [async (req) => {
  const userId = req.getUserId();
  const memberId = parseInt(req.query?.otherId);
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.notInClan();
  if (clanMember.role < ClanRoles.ELDER) return Responses.notEnoughPermissions();
  const clan = await clanFromClanId(clanMember.clanId);
  if (!clan) return Responses.clanNotExists();
  if (memberId === userId) return Responses.cannotChangeOwnRole();
  const targetMembership = await clanMemberFromUserId(memberId);
  if (targetMembership.clanId == clan.clanId && targetMembership.role >= clanMember.role) return Responses.notEnoughPermissions();
  const removed = await clanRemoveMember(clan.clanId, memberId);
  if (!removed) return Responses.notValidUser();
  const memberUser = await userFromUserId(memberId);
  await clanMessageSave({ userId: memberId, messageId: null, clanId: clan.clanId, picUrl: memberUser ? memberUser.picUrl : '', nickName: memberUser ? memberUser.nickName : '', type: ClanMessageTypes.MEMBER_REMOVED, status: RequestStatuses.ACCEPTED, creationTime: Date.now(), authorityId: null, message: '' });
  clan.memberCount = Math.max(0, clan.memberCount - 1);
  await clanSave(clan);
  return Responses.success();
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member/message', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const clanMember = await clanMemberFromUserId(userId);
  const clanId = clanMember.clanId;
  let filter;
  switch (clanMember.role) {
    case ClanRoles.MEMBER:
      filter = { where: 'clanId = ? AND (type IN (?,?,?,?) OR (type = ? AND status = ?))', params: [clanId, ClanMessageTypes.ELDER_PROMOTION, ClanMessageTypes.CHIEF_PROMOTION, ClanMessageTypes.MEMBER_REMOVED, ClanMessageTypes.MEMBER_LEFT, ClanMessageTypes.JOIN_INVITE, RequestStatuses.ACCEPTED] };
      break;
    case ClanRoles.ELDER:
      filter = { where: 'clanId = ? AND type IN (?,?,?,?,?)', params: [clanId, ClanMessageTypes.JOIN_REQUEST, ClanMessageTypes.ELDER_PROMOTION, ClanMessageTypes.CHIEF_PROMOTION, ClanMessageTypes.MEMBER_REMOVED, ClanMessageTypes.MEMBER_LEFT] };
      break;
    case ClanRoles.CHIEF:
      filter = { where: 'clanId = ? AND type IN (?,?,?)', params: [clanId, ClanMessageTypes.JOIN_REQUEST, ClanMessageTypes.MEMBER_REMOVED, ClanMessageTypes.MEMBER_LEFT] };
      break;
    default:
      filter = { where: 'userId = ? AND type IN (?,?,?)', params: [userId, ClanMessageTypes.MEMBER_REMOVED, ClanMessageTypes.JOIN_INVITE, ClanMessageTypes.CLAN_DISSOLVED] };
      break;
  }
  const messages = await clanMessageListFromFilter(filter, pageNo, pageSize);
  return Responses.success(messages);
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member/invite', ['POST'], [async (req) => {
  const userId = req.getUserId();
  let friendIds = req.query?.friendIds;
  if (!Array.isArray(friendIds)) friendIds = [friendIds];
  const targetFriends = (friendIds || []).map(x => parseInt(x)).filter(n => !isNaN(n));
  const message = req.query?.msg;
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.notInClan();
  if (clanMember.role < ClanRoles.ELDER) return Responses.notEnoughPermissions();
  const user = await userFromUserId(userId);
  const userFriendList = await friendListIdsFromUserId(userId);
  for (const friendId of targetFriends) {
    if (!userFriendList.includes(friendId)) continue;
    const invite = await clanMessageFindFirst(friendId, ClanMessageTypes.JOIN_INVITE, RequestStatuses.PENDING);
    if (invite) {
      await dbRun('UPDATE clan_message SET picUrl = ?, nickName = ?, message = ? WHERE messageId = ?', [user ? user.picUrl : '', user ? user.nickName : '', message, invite.messageId]);
    } else {
      await clanMessageSave({ userId: friendId, messageId: null, clanId: clanMember.clanId, picUrl: user ? user.picUrl : '', nickName: user ? user.nickName : '', type: ClanMessageTypes.JOIN_INVITE, status: RequestStatuses.PENDING, message, creationTime: Date.now(), authorityId: null });
    }
  }
  return Responses.success();
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member/agreement', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const targetUserId = parseInt(req.query?.otherId);
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.notInClan();
  if (clanMember.role < ClanRoles.ELDER) return Responses.notEnoughPermissions();
  const request = await clanMessageFindFirst(targetUserId, ClanMessageTypes.JOIN_REQUEST, RequestStatuses.PENDING);
  if (!request) return Responses.clanMessageNotFound();
  if (request.clanId != clanMember.clanId) return Responses.clanMessageNotFound();
  const clan = await clanFromClanId(clanMember.clanId);
  if (!clan) return Responses.clanNotExists();
  const targetMembership = await clanMemberFromUserId(targetUserId);
  if (targetMembership.clanId) return Responses.alreadyInClan();
  const holder = { memberCount: 0 };
  await clanAddMember(clan.clanId, targetUserId, ClanRoles.MEMBER, holder);
  clan.memberCount += 1;
  await clanSave(clan);
  await dbRun('UPDATE clan_message SET status = ? WHERE messageId = ?', [RequestStatuses.ACCEPTED, request.messageId]);
  return Responses.success();
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member/rejection', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const targetUserId = parseInt(req.query?.otherId);
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.notInClan();
  if (clanMember.role < ClanRoles.ELDER) return Responses.notEnoughPermissions();
  const request = await clanMessageFindFirst(targetUserId, ClanMessageTypes.JOIN_REQUEST, RequestStatuses.PENDING);
  if (!request || request.clanId != clanMember.clanId) return Responses.clanMessageNotFound();
  await dbRun('UPDATE clan_message SET status = ? WHERE messageId = ?', [RequestStatuses.REFUSED, request.messageId]);
  return Responses.success();
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member/agreement/invitation', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const clanMember = await clanMemberFromUserId(userId);
  if (clanMember.clanId != 0) return Responses.alreadyInClan();
  const request = await clanMessageFindFirst(userId, ClanMessageTypes.JOIN_INVITE, RequestStatuses.PENDING);
  if (!request) return Responses.clanMessageNotFound();
  const clan = await clanFromClanId(request.clanId);
  if (!clan) return Responses.clanNotExists();
  const holder = { memberCount: 0 };
  await clanAddMember(clan.clanId, userId, ClanRoles.MEMBER, holder);
  clan.memberCount += 1;
  await clanSave(clan);
  await dbRun('UPDATE clan_message SET status = ? WHERE messageId = ?', [RequestStatuses.ACCEPTED, request.messageId]);
  return Responses.success();
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/member/rejection/invitation', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const clanMember = await clanMemberFromUserId(userId);
  if (clanMember.clanId != 0) return Responses.alreadyInClan();
  const request = await clanMessageFindFirst(userId, ClanMessageTypes.JOIN_INVITE, RequestStatuses.PENDING);
  if (!request) return Responses.clanMessageNotFound();
  await dbRun('UPDATE clan_message SET status = ? WHERE messageId = ?', [RequestStatuses.REFUSED, request.messageId]);
  return Responses.success();
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/bulletin', ['GET', 'POST'], [
  async (req) => {
    const userId = req.getUserId();
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    const notice = await clanNoticeFromClanId(clanMember.clanId);
    return Responses.success({ content: notice ? notice.content : '' });
  },
  async (req) => {
    const userId = req.getUserId();
    const content = req.body?.content || '';
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    if (clanMember.role < ClanRoles.ELDER) return Responses.notEnoughPermissions();
    await clanNoticeSave(clanMember.clanId, content);
    return Responses.success();
  }
]);

createDevEndpoint(app, '/clan/api/v1/clan/decorations/:typeId', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/clan/api/v1/clan/decorations/details/:decorationId', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/clan/api/v1/clan/decorations/purchase', ['PUT'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/blurry/info', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const clanName = req.query?.clanName;
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const clanMember = await clanMemberFromUserId(userId);
  const clanId = clanMember.clanId || 0;
  const isClanExists = !isNaN(clanName) && await clanExists(clanName);
  if (isClanExists) {
    const clan = await clanFromClanId(clanName);
    if (clan) return Responses.success(new Page([clanResponse(clan, [])], 1, pageNo, pageSize));
  }
  const results = await clanSearch(clanId, clanName || '', pageNo, pageSize);
  return Responses.success(results);
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/donation', ['GET', 'POST'], [
  async (req) => {
    const userId = req.getUserId();
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    const clan = await clanFromClanId(clanMember.clanId);
    if (!clan) return Responses.clanNotExists();
    const vip = await vipFromUserId(userId);
    const levelConfig = clanConfig.levels[clan.level] || clanConfig.levels[1];
    const boost = clanConfig.vipBoosts[vip.vip] || clanConfig.vipBoosts[0];
    const currentGold = (await kvGet(`cache.donation.${Currencies.GOLD}.${userId}`)) || 0;
    const currentDiamond = (await kvGet(`cache.donation.${Currencies.DIAMOND}.${userId}`)) || 0;
    const currentTask = (await kvGet(`cache.donation.task.${userId}`)) || 0;
    return Responses.success({
      currentGold,
      currentDiamond,
      currentTask,
      currentExperience: clan.experience,
      clanId: clan.clanId,
      level: clan.level,
      maxDiamond: levelConfig.maxDiamondDonate * boost.maxDiamondDonate,
      maxExperience: levelConfig.upgradeExperience,
      maxGold: levelConfig.maxGoldDonate * boost.maxGoldDonate,
      maxTask: levelConfig.personalTaskCount + levelConfig.clanTaskCount
    });
  },
  async (req) => {
    const userId = req.getUserId();
    const currency = parseInt(req.query?.currency);
    const quantity = parseInt(req.query?.quantity);
    const clanMember = await clanMemberFromUserId(userId);
    if (!clanMember.clanId) return Responses.notInClan();
    if (currency != Currencies.DIAMOND && currency != Currencies.GOLD) return Responses.invalidCurrency();
    if (!(quantity > 0)) return Responses.invalidDonateQuantity();
    const vip = await vipFromUserId(userId);
    const clan = await clanFromClanId(clanMember.clanId);
    if (!clan) return Responses.clanNotExists();
    const levelConfig = clanConfig.levels[clan.level] || clanConfig.levels[1];
    const boost = clanConfig.vipBoosts[vip.vip] || clanConfig.vipBoosts[0];
    const capped = { amount: 0, expReward: 0, clanGoldReward: 0 };
    const currentGold = (await kvGet(`cache.donation.${Currencies.GOLD}.${userId}`)) || 0;
    const currentDiamond = (await kvGet(`cache.donation.${Currencies.DIAMOND}.${userId}`)) || 0;
    const maxDiamond = levelConfig.maxDiamondDonate * boost.maxDiamondDonate;
    const maxGold = levelConfig.maxGoldDonate * boost.maxGoldDonate;

    if (currency === Currencies.DIAMOND) {
      if (currentDiamond + quantity > maxDiamond) return Responses.donationExceedsMax();
      capped.amount = currentDiamond + quantity;
      capped.expReward = quantity * levelConfig.diamondExperienceRate * boost.diamondExperienceRate;
      capped.clanGoldReward = quantity * levelConfig.diamondCurrencyRate * boost.diamondCurrencyRate;
    } else {
      if (currentGold + quantity > maxGold) return Responses.donationExceedsMax();
      capped.amount = currentGold + quantity;
      capped.expReward = quantity * levelConfig.goldExperienceRate * boost.goldExperienceRate;
      capped.clanGoldReward = quantity * levelConfig.goldCurrencyRate * boost.goldCurrencyRate;
    }

    capped.expReward = Math.floor(capped.expReward);
    capped.clanGoldReward = Math.floor(capped.clanGoldReward);
    if (!await hasEnoughCurrency(userId, currency, quantity)) return Responses.notEnoughWealth();
    await removeCurrency(userId, currency, quantity);
    await addCurrency(userId, Currencies.CLAN_GOLD, capped.clanGoldReward);

    const user = await userFromUserId(userId);
    await dbRun('INSERT INTO clan_donation (userId, clanId, nickName, type, amount, expReward, clanGoldReward, creationTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, clan.clanId, user ? user.nickName : '', currency, capped.amount, capped.expReward, capped.clanGoldReward, Date.now()]);
    await kvSet(`cache.donation.${currency}.${userId}`, capped.amount, 86400);
    await kvSet(`cache.donation.task.${userId}`, 0, 86400);

    const memberRow = await dbGet('SELECT * FROM clan_member WHERE userId = ?', [userId]);
    clanAddExperience(clan, capped.expReward);
    await clanSave(clan);
    if (memberRow) {
      await dbRun('UPDATE clan_member SET experience = ? WHERE userId = ?', [(memberRow.experience || 0) + capped.expReward, userId]);
    }

    return Responses.success({ experienceGot: capped.expReward, tribeCurrencyGot: capped.clanGoldReward });
  }
]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/donation/history', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.notInClan();
  const history = await clanDonationHistoryFromClanId(clanMember.clanId, pageNo, pageSize);
  return Responses.success(history);
}]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/id', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.success(0);
  return Responses.success(clanMember.clanId);
}]);

createDevEndpoint(app, '/clan/api/v1/clan/rank', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/clan/api/v1/clan/user/rank', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/clan/api/v1/clan/tribe/currency', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const wealth = await wealthFromUserId(userId);
  return Responses.success(wealth.clanGolds);
}]);

createDevEndpoint(app, '/clan/api/v1/clan/personal/tasks', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/clan/api/v1/clan/tasks', ['GET', 'PUT'], [
  async () => Responses.innerError(),
  async () => Responses.innerError()
]);

createDevEndpoint(app, '/clan/api/v1/clan/tasks/accept', ['PUT'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/clan/api/v1/clan/free/verification', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  const isFreeVerify = parseInt(req.query?.freeVerify);
  const clanMember = await clanMemberFromUserId(userId);
  if (!clanMember.clanId) return Responses.clanNotExists();
  if (clanMember.role < ClanRoles.ELDER) return Responses.notEnoughPermissions();
  const clan = await clanFromClanId(clanMember.clanId);
  if (!clan) return Responses.clanNotExists();
  clan.freeVerify = isFreeVerify;
  await clanSave(clan);
  return Responses.success({ freeVerify: isFreeVerify });
}]);

// =====================================================================
//  SHOP SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/shop/api/v1/shop/decorations/buy', ['PUT'], [async (req) => {
  const userId = req.getUserId();
  let decorationIds = req.query?.decorationId;
  if (!Array.isArray(decorationIds)) decorationIds = [decorationIds];

  const vip = await vipFromUserId(userId);
  const user = await userFromUserId(userId);

  let diamondsNeeded = 0;
  let goldNeeded = 0;
  const purchasedDresses = [];
  const purchaseResults = {};
  const ownedNow = new Set((await getOwnedDresses(userId)).map(Number));

  for (let i = 0; i < decorationIds.length; i++) {
    const dressInfo = getDressInfo(decorationIds[i]);
    if (dressInfo == null) {
      purchaseResults[decorationIds[i]] = false;
      continue;
    }
    if (ownedNow.has(Number(dressInfo.id))) { purchaseResults[dressInfo.id] = true; continue; }
    const discount = vip.vip == VipLevels.VIP_PLUS ? discountsConfig.vipShopDiscount : (vip.vip == VipLevels.MVP ? discountsConfig.mvpShopDiscount : 0);
    let actualPrice = dressInfo.price;
    if (discount > 0) actualPrice = actualPrice * (100 - discount) / 100;
    const hasEnough = await hasEnoughCurrency(userId, dressInfo.currency, Math.ceil(actualPrice));
    if (!hasEnough) {
      if (dressInfo.currency === Currencies.GOLD) goldNeeded += dressInfo.price;
      else if (dressInfo.currency === Currencies.DIAMOND) diamondsNeeded += dressInfo.price;
      purchaseResults[dressInfo.id] = false;
      continue;
    }
    await removeCurrency(userId, dressInfo.currency, actualPrice, 3);
    ownedNow.add(Number(dressInfo.id));
    purchaseResults[dressInfo.id] = true;
    purchasedDresses.push(dressInfo.id);
  }

  await addDresses(userId, purchasedDresses);

  if (diamondsNeeded > 0 || goldNeeded > 0) {
    return Responses.notEnoughWealth({ decorationPurchaseStatus: purchaseResults, diamondsNeed: diamondsNeeded, golds: goldNeeded });
  }
  return Responses.success({ decorationPurchaseStatus: purchaseResults });
}]);

createDevEndpoint(app, '/shop/api/v1/shop/decorations/:typeId', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const categoryId = parseInt(req.params.typeId);
  const currencyType = parseInt(req.query?.currency) || 0;
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const user = await userFromUserId(userId);
  const ownedDresses = await getOwnedDresses(userId);
  const dressesData = getDresses({
    categoryId,
    currency: currencyType,
    sex: user ? user.sex : 0,
    hideClanDresses: true,
    hideFreeDresses: true,
    ownerFilter: ownedDresses,
    ownerType: DressOwnerTypes.TAG_ITEM
  });
  const data = new Page(dressesData, dressesData.length, pageNo, pageSize);
  return Responses.success(data);
}]);

createDevEndpoint(app, '/shop/api/:version/shop/game/props', ['PUT'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/shop/api/v1/pay/game/:gameId', ['PUT'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/shop/api/v1/shop/decorations/pages/:typeId', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const categoryId = parseInt(req.params.typeId);
  const currencyType = parseInt(req.query?.currency) || 0;
  const pageNo = parseInt(req.query?.pageNo) || 0;
  const pageSize = parseInt(req.query?.pageSize) || 10;
  const user = await userFromUserId(userId);
  const ownedDresses = await getOwnedDresses(userId);
  const dressesData = getDresses({
    categoryId,
    currency: currencyType,
    sex: user ? user.sex : 0,
    hideClanDresses: true,
    hideFreeDresses: true,
    ownerFilter: ownedDresses,
    ownerType: DressOwnerTypes.TAG_ITEM
  });
  return Responses.success(new Page(dressesData, dressesData.length, pageNo, pageSize));
}]);

// =====================================================================
//  MSG SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/msg/api/v1/msg/group/chat/list', ['GET'], [async () => Responses.success(Page.empty())]);

createDevEndpoint(app, '/msg/api/v1/group/chat/price', ['GET'], [async () => Responses.success(groupChatConfig)]);

// =====================================================================
//  ACTIVITY SERVICE (main-api-dev)
// =====================================================================

createDevEndpoint(app, '/activity/api/v1/signIn', ['GET', 'POST'], [
  async () => Responses.innerError(),
  async () => Responses.innerError()
]);

createDevEndpoint(app, '/activity/api/v1/activity/title', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/activity/api/v1/activity/action', ['GET'], [async () => Responses.innerError()]);

createDevEndpoint(app, '/activity/api/v1/lucky/turntable/gold/status', ['GET'], [async (req) => {
  const userId = req.getUserId();
  const freeWheel = await kvGet(`cache.activity.wheel.free.${userId}`);
  return Responses.success({ isFree: freeWheel == null ? 1 : 0 });
}]);

createDevEndpoint(app, '/activity/api/v1/lucky/turntable', ['GET', 'POST'], [
  async (req) => {
    const userId = req.getUserId();
    const type = req.query?.type;
    if (type != 'gold' && type != 'diamond') return Responses.invalidType();
    const activityInfo = { ...luckyWheelConfig[type] };
    activityInfo.activityDesc = luckyWheelConfig.activityDesc;
    const freeWheel = await kvGet(`cache.activity.wheel.free.${userId}`);
    activityInfo.isFree = (freeWheel == null && type != 'diamond' ? 1 : 0);
    return Responses.success(activityInfo);
  },
  async () => Responses.success({
    rewardId: 4,
    rewardType: 'diamond',
    rewardName: '1',
    pic: 'http://static.sandboxol.com/sandbox/activity/treasurebox/Bcubes.png',
    userLuckyValue: 0,
    isTransform: 0,
    luckyValue: 0,
    before: null,
    now: null
  })
]);

createDevEndpoint(app, '/activity/api/v1/lucky/turntable/block/reward', ['GET'], [async () => Responses.success({
  userBlock: 10,
  exchangeEndTime: '',
  tips: '',
  remainingTime: 9999,
  blockShopRewardInfoList: [
    { rewardId: 0, rewardName: '', rewardType: '', needBlock: 0, pic: '', exchangeUpperLimit: 0 }
  ]
})]);

// =====================================================================
//  Discord moderation bot (discord.js, slash commands)
//  Commands:
//    /link <userId>        - link this Discord account to a game userId
//    /ban <target> [reason]- ban a user (by userId or Discord mention/id)
//    /unban <userId>       - remove an active ban
//    /bans                 - list active bans
//  Only Discord ids in DISCORD_ADMIN_IDS (comma separated in .env) may use
//  /ban /unban /bans. The bot is optional: without a token it logs a warning
//  and the API keeps working.
// =====================================================================
let discordClient = null;
let discordClientId = null;
let discordAdmins = new Set();
try {
  discordAdmins = new Set(
    String(process.env.DISCORD_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
} catch { discordAdmins = new Set(); }

function isDiscordAdmin(discordId) {
  return discordAdmins.has(String(discordId));
}

function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN || '';
  if (!token) {
    console.log('Discord bot disabled: DISCORD_BOT_TOKEN not set in .env');
    return;
  }
  let discord;
  try {
    discord = require('discord.js');
  } catch (e) {
    console.error('Discord bot disabled: discord.js not installed:', e.message);
    return;
  }
  const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = discord;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  discordClient = client;

  const commands = [
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link this Discord account to a game userId')
      .addStringOption((o) => o.setName('userid').setDescription('Your game userId').setRequired(true)),
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user (userId or Discord mention/id)')
      .addStringOption((o) => o.setName('target').setDescription('Game userId or Discord mention/id').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the ban').setRequired(false)),
    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Remove an active ban')
      .addStringOption((o) => o.setName('userid').setDescription('Game userId to unban').setRequired(true)),
    new SlashCommandBuilder()
      .setName('bans')
      .setDescription('List active bans')
  ];

  client.once('ready', async () => {
    discordClientId = client.application ? client.application.id : null;
    console.log(`Discord bot online as ${client.user.tag} (${client.user.id})`);
    console.log(`Discord admins: ${discordAdmins.size ? Array.from(discordAdmins).join(', ') : 'NONE (no one can ban)'}`);
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map((c) => c.toJSON()) });
      console.log('Discord slash commands registered');
    } catch (e) {
      console.error('Discord command registration failed:', e.message);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      const authorId = interaction.user.id;
      switch (interaction.commandName) {
        case 'link': {
          const userId = parseInt(interaction.options.getString('userid'));
          if (!userId || userId <= 0) {
            await interaction.reply({ content: 'Provide a valid numeric game userId.', ephemeral: true });
            return;
          }
          const prof = await userExists(userId);
          if (!prof) {
            await interaction.reply({ content: `No game account exists with userId \`${userId}\`. Register on the website first.`, ephemeral: true });
            return;
          }
          // Steal the binding if another Discord account already linked this userId.
          const prev = await dbGet('SELECT discordId FROM discord_links WHERE userId = ?', [userId]);
          if (prev && prev.discordId !== authorId) {
            await dbRun('DELETE FROM discord_links WHERE discordId = ?', [prev.discordId]);
          }
          await linkDiscord(authorId, userId);
          console.log(`[DISCORD] ${authorId} linked discord -> userId ${userId}`);
          await interaction.reply({ content: `Linked <@${authorId}> to game userId \`${userId}\`.`, ephemeral: true });
          break;
        }
        case 'ban': {
          if (!isDiscordAdmin(authorId)) {
            await interaction.reply({ content: 'You are not a whitelisted admin. This action was aborted.', ephemeral: true });
            return;
          }
          const targetStr = interaction.options.getString('target');
          const reason = interaction.options.getString('reason') || 'No reason provided';
          const target = await resolveBanTarget(targetStr);
          if (!target) {
            await interaction.reply({ content: `Could not resolve target \`${targetStr}\`. Use a game userId or Discord id.`, ephemeral: true });
            return;
          }
          const ip = null;
          if (target.kind === 'discord') {
            const tUid = await userIdForDiscord(target.value);
            if (!tUid) {
              await interaction.reply({ content: `Discord \`${target.value}\` is not linked to any game account. Ask them to run /link first.`, ephemeral: true });
              return;
            }
            await banUser({ userId: tUid, ip, reason, bannedBy: authorId });
            const nick = (await userFromUserId(tUid))?.nickName || `user ${tUid}`;
            console.log(`[DISCORD] ${authorId} banned discord ${target.value} -> userId ${tUid}`);
            await interaction.reply({ content: `Banned **${nick}** (userId \`${tUid}\`, discord \`${target.value}\`)\nReason: ${reason}`, ephemeral: false });
          } else {
            await banUser({ userId: target.value, ip, reason, bannedBy: authorId });
            const nick = (await userFromUserId(target.value))?.nickName || `user ${target.value}`;
            console.log(`[DISCORD] ${authorId} banned userId ${target.value}`);
            await interaction.reply({ content: `Banned **${nick}** (userId \`${target.value}\`)\nReason: ${reason}`, ephemeral: false });
          }
          break;
        }
        case 'unban': {
          if (!isDiscordAdmin(authorId)) {
            await interaction.reply({ content: 'You are not a whitelisted admin. This action was aborted.', ephemeral: true });
            return;
          }
          const userId = parseInt(interaction.options.getString('userid'));
          if (!userId || userId <= 0) {
            await interaction.reply({ content: 'Provide a valid numeric game userId.', ephemeral: true });
            return;
          }
          await unbanUser(userId);
          console.log(`[DISCORD] ${authorId} unbanned userId ${userId}`);
          await interaction.reply({ content: `Removed active bans for userId \`${userId}\`. (Linked hardware ids keep their own bans.)`, ephemeral: false });
          break;
        }
        case 'bans': {
          if (!isDiscordAdmin(authorId)) {
            await interaction.reply({ content: 'You are not a whitelisted admin. This action was aborted.', ephemeral: true });
            return;
          }
          const bans = await listActiveBans();
          if (!bans.length) {
            await interaction.reply({ content: 'No active bans.', ephemeral: true });
            return;
          }
          const embed = new EmbedBuilder().setTitle('Active bans').setColor(0xFF5555);
          const lines = bans.map((b) => {
            const nick = null;
            const dId = null;
            return `userId \`${b.userId}\`${b.hwid ? ` hwid:\`${String(b.hwid).slice(0, 8)}…\`` : ''}${b.ip ? ` ip:\`${b.ip}\`` : ''}\nreason: ${b.reason || 'none'}`;
          });
          for (let i = 0; i < lines.length; i += 10) {
            embed.addFields({ name: 'Bans', value: lines.slice(i, i + 10).join('\n') });
          }
          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.error('Discord interaction error:', e);
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp({ content: 'An error occurred.', ephemeral: true });
        else await interaction.reply({ content: 'An error occurred.', ephemeral: true });
      } catch {}
    }
  });

  client.login(token).catch((e) => {
    console.error('Discord bot login failed:', e.message);
    discordClient = null;
  });
}

// CDN fallback: serve the cdn-serve-js-master/static dirs (maps, events,
// database files) so anything the API returns via downurl/iconUrl that is
// not under DB_FILES actually resolves.
if (fs.existsSync(CDN_ROOT)) {
  // /static/files/games/map/m<mapId>.zip -> serve from cdn/maps/map/<name>.
  app.use('/static/files/games/map/', (req, res, next) => {
    const name = path.basename(req.path);
    if (/^m[\w]+\.zip$/i.test(name)) {
      const mapFile = path.join(CDN_ROOT, 'maps', 'map', name);
      if (fs.existsSync(mapFile)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(mapFile);
      }
      // Some games only ship the g<gid>.zip (e.g. g1001.zip) without an
      // m<mapid>.zip copy. Resolve the gid by stripping the multi-mode
      // suffix (m1008_3 -> g1008) and matching that in cdn/maps/.
      const gid = name.replace(/^m(\d+).*\.zip$/i, 'g$1');
      const mapsDir = path.join(CDN_ROOT, 'maps');
      let files = [];
      try { files = fs.readdirSync(mapsDir); } catch { files = []; }
      const mapFile2 = files.find((f) => f.toLowerCase() === `${gid}.zip`.toLowerCase());
      if (mapFile2) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(path.join(mapsDir, mapFile2));
      }
      return res.status(404).json({ error: `map ${name} not found` });
    }
    next();
  });

  // /maps/g<gid>.zip -> serve only the zip whose filename matches that gid.
  // Never substitute another gid's map (that caused wrong map downloads).
  app.use('/maps/', (req, res, next) => {
    const name = path.basename(req.path);
    if (/^g(\d+)\.zip$/i.test(name)) {
      const gid = RegExp.$1;
      const mapsDir = path.join(CDN_ROOT, 'maps');
      let files = [];
      try { files = fs.readdirSync(mapsDir); } catch { files = []; }
      const wanted = ['g' + gid, 'g' + gid + '.'];
      const mapFile = files.find(f =>
        (/^g\d+\.zip$/i.test(f) && f.toLowerCase() === `g${gid}.zip`.toLowerCase()) ||
        wanted.some(w => f.toLowerCase().startsWith(w.toLowerCase()))
      );
      if (mapFile) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(path.join(mapsDir, mapFile));
      }
      return res.status(404).json({ error: `map g${gid} not found` });
    }
    next();
  });

  for (const sub of ['maps', 'events', 'database/files']) {
    const subPath = path.join(CDN_ROOT, sub);
    if (fs.existsSync(subPath)) {
      app.use(`/${sub}/`, express.static(subPath, {
        setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
      }));
    }
  }
  app.use(express.static(CDN_ROOT, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
  }));

  // /Client.zip -> full game client archive used by the bmgolauncher uri to
  // install into AppData/Local/Blockmango.
  app.all('/Client.zip', (req, res) => {
    const zip = process.env.CLIENT_ZIP || path.join(CDN_ROOT, 'Client.zip');
    if (fs.existsSync(zip)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(zip);
    }
    return res.status(404).json({ error: 'Client.zip not found' });
  });
}

// =====================================================================
//  Website: about page (/) + login/register + /my/games
// =====================================================================

// Shared page shell so every route renders the same head/nav.
function webPage(title, body, extra = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { --bg:#0b0f17; --card:#141a26; --line:#232b3b; --txt:#dbe4f0; --mut:#8b98ab; --acc:#5b8cff; --ok:#34d399; --bad:#ff5d5d; }
* { box-sizing:border-box; }
body { margin:0; font-family:'Segoe UI',system-ui,sans-serif; background:var(--bg); color:var(--txt); }
nav { display:flex; align-items:center; gap:18px; padding:14px 28px; background:var(--card); border-bottom:1px solid var(--line); }
nav a { color:var(--txt); text-decoration:none; font-weight:600; }
nav a:hover { color:var(--acc); }
.wrap { max-width:960px; margin:0 auto; padding:28px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; margin:16px 0; }
.btn { display:inline-block; background:var(--acc); color:#fff; border:0; border-radius:10px; padding:11px 22px; font-weight:700; cursor:pointer; text-decoration:none; margin:6px 6px 6px 0; }
.btn.ghost { background:transparent; border:1px solid var(--line); color:var(--txt); }
.btn.danger { background:var(--bad); }
.btn.ok { background:var(--ok); color:#062b1d; }
input { width:100%; padding:11px 12px; border-radius:10px; border:1px solid var(--line); background:#0f1522; color:var(--txt); font-size:15px; }
label { display:block; margin:12px 0 6px; color:var(--mut); font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
.mut { color:var(--mut); }
.badge { padding:4px 10px; border-radius:20px; font-size:12px; font-weight:700; background:#1d2533; color:var(--mut); }
.badge.on { background:rgba(52,211,153,.12); color:var(--ok); }
.game { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:16px 0; border-bottom:1px solid var(--line); }
.game:last-child { border-bottom:0; }
.launch { min-width:170px; text-align:center; }
.unknown { color:var(--mut); font-style:italic; }
</style>
${extra}
</head>
<body>
<nav>
  <a href="/">Blockman Reloaded</a>
  <a href="/my/games">My games</a>
  <span id="navAuth" style="margin-left:auto"></span>
</nav>
<div class="wrap">${body}</div>
<script>
(function () {
  var uid = null, tok = null;
  try { uid = localStorage.getItem('bm_uid'); tok = localStorage.getItem('bm_token'); } catch (e) {}
  var box = document.getElementById('navAuth');
  if (!box) return;
  var esc = function (t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  if (uid && tok) {
    box.innerHTML = '<span class="mut" style="margin-right:10px">Signed in as <b>userId ' + esc(uid) + '</b></span>' +
      '<button class="btn ghost" style="padding:7px 16px" onclick="attemptLogout()">Logout</button>';
    window.attemptLogout = function () {
      try { localStorage.removeItem('bm_uid'); localStorage.removeItem('bm_token'); } catch (e) {}
      location.href = '/';
    };
    var username = null;
    try {
      username = JSON.parse((localStorage.getItem('bm_profile') || '{}')).nickName || null;
    } catch (e) {}
    box.innerHTML = '<span class="mut" style="margin-right:10px">Signed in as <b>' + esc(username || 'userId ' + uid) + '</b></span>' +
      '<button class="btn ghost" style="padding:7px 16px" onclick="attemptLogout()">Logout</button>';
  } else {
    box.innerHTML = '<a href="/register" class="btn ghost" style="padding:7px 16px">Register</a>' +
      '<a href="/login" class="btn" style="padding:7px 16px">Login</a>';
  }
})();
</script>
</body>
</html>`;
}

function hwIdScript() {
  return `<script>
function hwid() {
  try {
    const p = [];
    for (let k in localStorage) { if (/^hwid_/.test(k)) p.push(localStorage.getItem(k).slice(16)); }
    if (p.length) return p[0];
    const t = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const r = crypto.getRandomValues(new Uint8Array(21));
    for (let i = 0; i < 21; i++) s += t[r[i] % t.length];
    localStorage.setItem('hwid_local', 'hwid_local______' + s); // 16-char prefix, matches slice(16) above
    return s;
  } catch (e) { return String(Date.now()); }
}
async function hfetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['x-hwid'] = hwid();
  const r = await fetch(url, opts);
  return r;
}
</script>`;
}

app.get('/', (req, res) => {
  res.send(webPage('Blockman Reloaded', `
    <div class="card">
      <h1>Blockman Reloaded</h1>
      <p class="mut">A private Blockman GO server. Create an account or log in to play on your own PCs.</p>
      <a class="btn" href="/register">Register</a>
      <a class="btn ghost" href="/login">Login</a>
    </div>
    <div class="card">
      <h2>How it works</h2>
      <ol class="mut">
        <li>Register / log in above to get your userId.</li>
        <li>Open <b>/my/games</b> and hit <b>Launch</b> on any game.</li>
        <li>The custom launcher installs the client and map automatically.</li>
      </ol>
      <p class="mut">Every launch is tracked by your hardware id, so creating a new account over a VPN won't hide a banned device.</p>
    </div>`));
});

app.get('/register', (req, res) => {
  res.send(webPage('Register', `
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>Register</h1>
      <div id="msg" class="mut"></div>
      <label for="email">Email / username</label><input id="email" autocomplete="username">
      <label for="pass">Password</label><input id="pass" type="password" autocomplete="new-password">
      <label for="nick">Nickname</label><input id="nick" autocomplete="nickname">
      <button class="btn ok" id="go" style="margin-top:18px">Create account</button>
    </div>
    ${hwIdScript()}
    <script>
    document.getElementById('go').onclick = async () => {
      const msg = document.getElementById('msg');
      const body = { email: document.getElementById('email').value.trim(), password: document.getElementById('pass').value, nickName: document.getElementById('nick').value.trim() };
      if (!body.email || !body.password || !body.nickName) { msg.textContent = 'Fill all fields.'; return; }
      const r = await hfetch('/api/v1/web/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.userId) { msg.textContent = j.message || 'Registration failed.'; return; }
      localStorage.setItem('bm_uid', j.userId);
      localStorage.setItem('bm_token', j.accessToken);
      try { localStorage.setItem('bm_profile', JSON.stringify({ nickName: body.nickName || '' })); } catch (e) {}
      msg.textContent = 'Account created. Redirecting...';
      location.href = '/my/games';
    };
    </script>`));
});

app.get('/login', (req, res) => {
  res.send(webPage('Login', `
    <div class="card" style="max-width:420px;margin:40px auto">
      <h1>Login</h1>
      <div id="msg" class="mut"></div>
      <label for="email">Email / username</label><input id="email" autocomplete="username">
      <label for="pass">Password</label><input id="pass" type="password" autocomplete="current-password">
      <button class="btn ok" id="go" style="margin-top:18px">Log in</button>
    </div>
    ${hwIdScript()}
    <script>
    document.getElementById('go').onclick = async () => {
      const msg = document.getElementById('msg');
      const body = { email: document.getElementById('email').value.trim(), password: document.getElementById('pass').value };
      if (!body.email || !body.password) { msg.textContent = 'Fill both fields.'; return; }
      const r = await hfetch('/api/v1/web/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.userId) { msg.textContent = (j.code === 403 ? 'This account is banned.' : (j.message || 'Login failed.')); return; }
      localStorage.setItem('bm_uid', j.userId);
      localStorage.setItem('bm_token', j.accessToken);
      try { localStorage.setItem('bm_profile', JSON.stringify({ nickName: j.nickName || '' })); } catch (e) {}
      msg.textContent = 'Logged in. Redirecting...';
      location.href = '/my/games';
    };
    </script>`));
});

app.get('/my/games', async (req, res) => {
  res.send(webPage('My games', `
    <div class="card">
      <h1>My games</h1>
      <p class="mut">Servers are listed from the API. Press Launch to install + start that game on this PC.</p>
      <div id="list"><span class="mut">Loading servers...</span></div>
    </div>
    ${hwIdScript()}
    <script>
    function esc(t) {
      return String(t).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    async function boot() {
      const uid = localStorage.getItem('bm_uid');
      const token = localStorage.getItem('bm_token');
      const list = document.getElementById('list');
      if (!uid || !token) {
        list.innerHTML = '<b>You must be logged in to play.</b> <a class="btn" href="/login" style="padding:7px 16px">Log in</a> <a class="btn ghost" href="/register" style="padding:7px 16px">Register</a>';
        return;
      }
      try {
        const r = await fetch('/api/v1/launch/info', { headers: { 'x-hwid': hwid(), 'userid': uid, 'access-token': token } });
        const j = await r.json();
        if (j.loginRequired) { list.innerHTML = '<b>Session expired.</b> <a class="btn" href="/login" style="padding:7px 16px">Log in again</a>'; return; }
        if (j.banned) { list.innerHTML = '<b style="color:var(--bad)">This account/device is banned: ' + esc(j.reason || '') + '</b>'; return; }
        const games = j.games || [];
        if (!games.length) { list.innerHTML = '<span class="mut">No servers currently online.</span>'; return; }
        let html = '';
        for (const g of games) {
          const name = g.name || g.gid || 'Unknown';
          const addr = g.addr || '';
          const q = 'uid=' + encodeURIComponent(uid||'') + '&token=' + encodeURIComponent(token||'') + '&hwid=' + encodeURIComponent(hwid());
          html += '<div class="game"><div><b>' + esc(name) + '</b> <span class="mut">' + esc(addr) + '</span></div>' +
                  '<a class="btn launch" href="bmgolauncher://' + esc(addr) + '?' + esc(q) + '">Launch</a></div>';
        }
        list.innerHTML = html;
      } catch (e) {
        list.innerHTML = '<b style="color:var(--bad)">Failed to reach the API.</b>';
      }
    }
    boot();
    setInterval(boot, 15000);
    </script>`));
});

app.post('/api/v1/web/register', async (req, res) => {
  try {
    const { email, password, nickName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ code: 400, message: 'email and password are required' });
    }
    if (String(password).length < 4) {
      return res.status(400).json({ code: 400, message: 'password must be at least 4 characters' });
    }
    const name = String(email).trim();
    const existing = await accountFromEmail(name);
    if (existing) {
      return res.status(409).json({ code: 409, message: 'An account with that email already exists' });
    }
    const userId = await getNextUserId();
    const tokenObject = createToken({ userId });
    await dbRun('INSERT INTO account (userId, email, password, creationTime, accessToken, loginTime) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, name.toLowerCase(), hashPassword(password), Date.now(), tokenObject.dbToken, Date.now()]);
    await dbRun('INSERT OR IGNORE INTO user (userId, nickName, sex, picUrl, details, birthday, isFreeNickname) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, (nickName || name), 2, '', '', '', 1]);
    await dbRun('INSERT OR IGNORE INTO vip (userId, vip, expireDate) VALUES (?, ?, ?)', [userId, 0, 0]);
    await dbRun('INSERT OR IGNORE INTO user_locale (userId, language, country) VALUES (?, ?, ?)', [userId, '', '']);
    await seedMaxWealth(userId);
  await seedGcubes(userId);
    const rawHwid = req.headers['x-hwid'] || req.headers['hwid'] || req.query.hwid;
    await logHwid(userId, rawHwid, CLIENT_IP.from(req));
    console.log(`[WEB] registered userId ${userId} (${name})`);
    res.json({ userId, accessToken: tokenObject.userToken, nickName: (nickName || name) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: 'Registration failed' });
  }
});

app.post('/api/v1/web/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ code: 400, message: 'email and password are required' });
    }
    const rawIdentifier = String(email).trim();
    let account = null;
    if (/^\d+$/.test(rawIdentifier)) {
      account = await accountFromUserId(Number(rawIdentifier));
    }
    if (!account) {
      account = await accountFromEmail(rawIdentifier);
    }
    if (!account || !verifyPassword(password, account.password)) {
      return res.status(401).json({ code: 102, message: "The user doesn't exist or the password is wrong" });
    }
    const uidBan = await activeBanForUser(account.userId);
    if (uidBan) {
      return res.status(403).json({ code: 403, message: 'This account is banned', reason: uidBan.reason });
    }
    const rawHwid = req.headers['x-hwid'] || req.headers['hwid'] || req.query.hwid;
    const hwBan = rawHwid ? await activeBanForHwid(rawHwid) : null;
    if (hwBan) {
      return res.status(403).json({ code: 403, message: 'This device is banned', reason: hwBan.reason });
    }
    const tokenObject = createToken({ userId: account.userId });
    await dbRun('UPDATE account SET accessToken = ?, loginTime = ? WHERE userId = ?', [tokenObject.dbToken, Date.now(), account.userId]);
    await logHwid(account.userId, rawHwid, CLIENT_IP.from(req));
    const nickRow = await userFromUserId(account.userId);
    console.log(`[WEB] login userId ${account.userId}`);
    res.json({ userId: account.userId, accessToken: tokenObject.userToken, nickName: (nickRow && nickRow.nickName) || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: 'Login failed' });
  }
});

// =====================================================================
// GCUBES API (ported from the standalone Gcubes.js service)
// The original was its own express app with a hardcoded MySQL pool and a real
// Redis client. Here it rides on this server: SQLite via dbGet/dbRun and the
// fake-Redis KeyValue cache via kvGet/kvSet. Response codes are unchanged
// (1 success, 3 invalid, 4 internal, 5 insufficient), the same envelope
// Responses already speaks.
// =====================================================================

function isValidGcubesUserId(id) {
  return /^[0-9]+$/.test(String(id));
}

// Serialised per user so a concurrent modify can't interleave the
// read-modify-write. sqlite here is single-connection, so queue on userId only.
const gcubesLocks = new Map();

async function withGcubesLock(userId, fn) {
  const prev = gcubesLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  gcubesLocks.set(userId, prev.then(() => current));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (gcubesLocks.get(userId) === current) gcubesLocks.delete(userId);
  }
}

// GET /api/v1/gcubes/:userId - balance, cache first, SQLite fallback.
app.get('/api/v1/gcubes/:userId', async (req, res) => {
  const userId = req.params.userId;
  if (!isValidGcubesUserId(userId)) {
    return res.json(Responses.invalidGcubesUserId().content);
  }

  try {
    const cacheKey = `gcubes:${userId}`;
    let gcubes = await kvGet(cacheKey);

    if (gcubes === null) {
      const row = await dbGet('SELECT gcubes FROM gcubes_balance WHERE userId = ? LIMIT 1', [userId]);
      gcubes = row ? row.gcubes : 0;
      await kvSet(cacheKey, gcubes, 3600);
    } else {
      gcubes = parseInt(gcubes, 10);
    }

    const r = Responses.success({ userId: Number(userId), gcubes });
    res.status(r.status).json(r.content);
  } catch (err) {
    console.error('GET gcubes error:', err);
    const r = Responses.gcubesInternalError();
    res.status(r.status).json(r.content);
  }
});

// POST /api/v1/gcubes/modify - add/subtract, refuses to go negative, logs it.
app.post('/api/v1/gcubes/modify', async (req, res) => {
  const { userId, amount, reason } = req.body || {};
  if (!isValidGcubesUserId(userId) || typeof amount !== 'number' || amount === 0) {
    return res.json(Responses.invalidGcubesParams().content);
  }

  try {
    const newBalance = await withGcubesLock(String(userId), async () => {
      const row = await dbGet('SELECT gcubes FROM gcubes_balance WHERE userId = ? LIMIT 1', [userId]);
      const current = row ? row.gcubes : 0;
      const next = current + amount;
      if (next < 0) return null;

      if (row) {
        await dbRun('UPDATE gcubes_balance SET gcubes = ? WHERE userId = ?', [next, userId]);
      } else {
        await dbRun('INSERT INTO gcubes_balance (userId, gcubes) VALUES (?, ?)', [userId, next]);
      }
      await dbRun(
        'INSERT INTO gcubes_log (userId, amount, reason, timestamp) VALUES (?, ?, ?, ?)',
        [userId, amount, reason || 'N/A', Date.now()]
      );
      return next;
    });

    if (newBalance === null) {
      return res.json(Responses.insufficientGcubesBalance().content);
    }

    await kvSet(`gcubes:${userId}`, newBalance, 3600);
    const r = Responses.success({ userId: Number(userId), gcubes: newBalance });
    res.status(r.status).json(r.content);
  } catch (err) {
    console.error('POST gcubes/modify error:', err);
    const r = Responses.gcubesInternalError();
    res.status(r.status).json(r.content);
  }
});

// 404 handler
app.use((req, res) => {
  console.warn(`Unknown route: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ code: 404, message: 'Not Found' });
});

// JSON error handler (bad JSON body, etc.)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 600 ? (err.status || err.statusCode) : 500;
  console.error(`Request error on ${req.method} ${req.originalUrl}:`, err && err.message);
  res.status(status).json({ code: status, message: status === 400 ? 'Bad Request' : 'INNER ERROR', data: null });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down server...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed.');
    }
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
  console.log(`SQLite database: ${dbPath}`);
  const folderCount = loadGidFolders();
  console.log(`Gameserver registry: ${folderCount} gid folder launcher(s) indexed for port/publicIp; liveness + gameserver_ips from TCP announce`);
  console.log(`Room server port: ${ROOM_PORT}`);
  console.log(`CDN host: ${cdnHost()}`);
  console.log(`CDN root: ${CDN_ROOT}`);
  console.log(`Database files: ${DB_FILES}`);
  startRoomServer();
  startDiscordBot();
});
httpServer.on('error', (err) => {
  console.error(`HTTP server error (port ${PORT}):`, err.message);
  process.exit(1);
});