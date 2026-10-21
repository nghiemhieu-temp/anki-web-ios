/**
 * Anki Web iOS - Core Application Logic
 * Supports .apkg import via JSZip + sql.js, IndexedDB persistence, iOS touch UX, and SRS study.
 */

// Global State
const state = {
  db: null,                 // IndexedDB instance
  sqlModule: null,          // SQL.js instance
  decks: [],                // All saved decks
  activeDeck: null,         // Current deck being studied
  allCards: [],             // All cards of current deck
  cards: [],                // Cards due right now in study queue
  currentIndex: 0,          // Current card index in active queue
  isFlipped: false,         // Flip state
  mediaBlobUrls: new Map(), // deckId:filename -> objectUrl
  countdownTimerId: null,   // Realtime countdown timer ticker ID
  totalSessionCards: 0,     // Total cards in current session
  sessionCompletedCount: 0  // Cards reviewed in current session
};

// ==========================================================================
// IndexedDB Storage Layer
// ==========================================================================
const DB_NAME = 'AnkiWebiOS_DB';
const DB_VERSION = 1;

function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('decks')) {
        db.createObjectStore('decks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('cards')) {
        const cardStore = db.createObjectStore('cards', { keyPath: 'id' });
        cardStore.createIndex('deckId', 'deckId', { unique: false });
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      state.db = event.target.result;
      resolve(state.db);
    };

    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      reject(event.target.error);
    };
  });
}

function saveDeckToDB(deck, cards, mediaMap = new Map()) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(['decks', 'cards', 'media'], 'readwrite');
    const deckStore = tx.objectStore('decks');
    const cardStore = tx.objectStore('cards');
    const mediaStore = tx.objectStore('media');

    deckStore.put(deck);

    cards.forEach(card => cardStore.put(card));

    mediaMap.forEach((blob, filename) => {
      mediaStore.put({
        key: `${deck.id}:${filename}`,
        deckId: deck.id,
        filename,
        blob
      });
    });

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function loadAllDecksFromDB() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('decks', 'readonly');
    const store = tx.objectStore('decks');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

function loadCardsForDeckFromDB(deckId) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('cards', 'readonly');
    const store = tx.objectStore('cards');
    const index = store.index('deckId');
    const req = index.getAll(deckId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

function deleteDeckFromDB(deckId) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(['decks', 'cards', 'media'], 'readwrite');
    tx.objectStore('decks').delete(deckId);

    // Delete cards
    const cardStore = tx.objectStore('cards');
    const cardIndex = cardStore.index('deckId');
    const cardReq = cardIndex.getAllKeys(deckId);
    cardReq.onsuccess = () => {
      cardReq.result.forEach(key => cardStore.delete(key));
    };

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function updateCardInDB(card) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction('cards', 'readwrite');
    const store = tx.objectStore('cards');
    store.put(card);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function resetDeckProgressInDB(deckId) {
  return new Promise(async (resolve, reject) => {
    try {
      const cards = await loadCardsForDeckFromDB(deckId);
      const tx = state.db.transaction('cards', 'readwrite');
      const store = tx.objectStore('cards');
      cards.forEach(card => {
        card.due = 0;
        card.state = 'new';
        card.ivl = 0;
        card.reps = 0;
        card.lapses = 0;
        card.lastReviewed = null;
        store.put(card);
      });
      tx.oncomplete = () => resolve(cards.length);
      tx.onerror = (e) => reject(e.target.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function loadMediaBlob(deckId, filename) {
  const cacheKey = `${deckId}:${filename}`;
  if (state.mediaBlobUrls.has(cacheKey)) {
    return state.mediaBlobUrls.get(cacheKey);
  }

  return new Promise((resolve) => {
    try {
      const tx = state.db.transaction('media', 'readonly');
      const store = tx.objectStore('media');
      const req = store.get(cacheKey);
      req.onsuccess = () => {
        if (req.result && req.result.blob) {
          const url = URL.createObjectURL(req.result.blob);
          state.mediaBlobUrls.set(cacheKey, url);
          resolve(url);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// ==========================================================================
// SQL.js Initialization
// ==========================================================================
async function getSqlInstance() {
  if (state.sqlModule) return state.sqlModule;
  if (typeof initSqlJs === 'undefined') {
    throw new Error('Thư viện sql.js chưa được tải!');
  }
  state.sqlModule = await initSqlJs({
    locateFile: (file) => `./vendor/${file}`
  });
  return state.sqlModule;
}

// ==========================================================================
// APKG Unpacker & Anki Database Parser
// ==========================================================================
async function parseApkgFile(file, onProgress) {
  onProgress(10, 'Đang nạp dữ liệu từ iPhone...');
  const arrayBuffer = await file.arrayBuffer();

  onProgress(25, 'Đang giải nén tập tin .apkg...');
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 1. Locate Anki SQLite database file (ưu tiên collection.anki2 vì anki21 có thể bị nén zstandard)
  let dbFile = zip.file('collection.anki2') || zip.file('collection.anki21');
  if (!dbFile) {
    // Check if files are nested in a folder
    const files = Object.keys(zip.files);
    const candidate = files.find(f => f.endsWith('collection.anki2') || f.endsWith('collection.anki21'));
    if (candidate) dbFile = zip.file(candidate);
  }

  if (!dbFile) {
    throw new Error('Không tìm thấy file cơ sở dữ liệu collection.anki2 trong file .apkg này!');
  }

  onProgress(30, 'Đang tải bản đồ media (ảnh/âm thanh)...');
  // 2. Read media dictionary
  let mediaMap = new Map(); // internalId -> realFilename
  const mediaJsonFile = zip.file('media');
  if (mediaJsonFile) {
    try {
      const mediaText = await mediaJsonFile.async('text');
      const parsedMedia = JSON.parse(mediaText);
      for (const [key, filename] of Object.entries(parsedMedia)) {
        const mediaFile = zip.file(key);
        if (mediaFile) {
          const blob = await mediaFile.async('blob');
          mediaMap.set(filename, blob);
        }
      }
    } catch (e) {
      console.warn('Lỗi khi đọc file media:', e);
    }
  }

  onProgress(55, 'Đang khởi tạo máy ảo SQLite (WebAssembly)...');
  const SQL = await getSqlInstance();
  const dbData = await dbFile.async('uint8array');
  const sqliteDb = new SQL.Database(dbData);

  onProgress(75, 'Đang đọc thẻ và mẫu câu hỏi...');

  // 3. Extract Decks & Models metadata from `col`
  let decksJson = {};
  let modelsJson = {};
  try {
    const colRes = sqliteDb.exec('SELECT decks, models FROM col;');
    if (colRes.length > 0 && colRes[0].values.length > 0) {
      decksJson = JSON.parse(colRes[0].values[0][0]);
      modelsJson = JSON.parse(colRes[0].values[0][1]);
    }
  } catch (err) {
    console.warn('Không đọc được col metadata:', err);
  }

  // 4. Query notes and cards
  const query = `
    SELECT c.id, c.nid, c.did, c.ord, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses,
           n.mid, n.flds, n.tags
    FROM cards c
    JOIN notes n ON c.nid = n.id
    ORDER BY c.due ASC, c.id ASC;
  `;
  const cardsRes = sqliteDb.exec(query);

  if (!cardsRes.length || !cardsRes[0].values.length) {
    throw new Error('Bộ thẻ không chứa thẻ học nào!');
  }

  const rows = cardsRes[0].values;
  const defaultDeckId = String(Date.now());
  let targetDeckName = file.name.replace(/\.[^/.]+$/, '');

  // Detect deck name from decksJson if available
  const deckKeys = Object.keys(decksJson);
  const nonDefaultDeck = deckKeys.map(k => decksJson[k]).find(d => d.name && d.name !== 'Default');
  if (nonDefaultDeck) {
    targetDeckName = nonDefaultDeck.name;
  }

  const parsedDeck = {
    id: defaultDeckId,
    name: targetDeckName,
    cardCount: rows.length,
    createdAt: new Date().toISOString()
  };

  const parsedCards = [];

  for (let i = 0; i < rows.length; i++) {
    const [cId, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, mid, flds, tags] = rows[i];
    const fields = (flds || '').split('\x1f');
    const model = modelsJson[mid];

    let frontHtml = '';
    let backHtml = '';

    if (model && model.tmpls && model.tmpls[ord]) {
      const tmpl = model.tmpls[ord];
      frontHtml = renderTemplate(tmpl.qfmt, fields, model.flds, ord, false);
      backHtml = renderTemplate(tmpl.afmt, fields, model.flds, ord, true, frontHtml);
    } else {
      // Fallback: Front = field 0, Back = field 1
      frontHtml = fields[0] || 'Câu hỏi trống';
      backHtml = fields.slice(1).join('<hr/>') || 'Đáp án trống';
    }

    parsedCards.push({
      id: `${defaultDeckId}_${cId}`,
      deckId: defaultDeckId,
      nid,
      ord,
      front: frontHtml,
      back: backHtml,
      tags: tags ? tags.trim().split(/\s+/).filter(Boolean) : [],
      due: due || 0,
      ivl: ivl || 0,
      factor: factor || 2500,
      reps: reps || 0,
      lapses: lapses || 0,
      state: 'new'
    });
  }

  sqliteDb.close();

  onProgress(90, 'Đang lưu vào bộ nhớ iPhone (IndexedDB)...');
  await saveDeckToDB(parsedDeck, parsedCards, mediaMap);
  onProgress(100, 'Hoàn tất nhập dữ liệu!');

  return parsedDeck;
}

// Template renderer for Anki templates, Conditionals, Furigana & Cloze deletion
function renderTemplate(template, fields, modelFields, cardOrd, isBack, frontSideHtml = '') {
  if (!template) return '';

  let html = template;

  // 1. Replace {{FrontSide}}
  if (isBack && frontSideHtml) {
    const cleanFront = frontSideHtml.replace(/<audio[\s\S]*?<\/audio>/gi, '');
    html = html.replace(/\{\{FrontSide\}\}/gi, cleanFront);
  }

  // 2. Build dictionary of FieldName -> value
  const fieldDict = {};
  if (modelFields && Array.isArray(modelFields)) {
    modelFields.forEach((fld, idx) => {
      fieldDict[fld.name] = fields[idx] !== undefined ? fields[idx] : '';
    });
  } else {
    fields.forEach((val, idx) => {
      fieldDict[`Field${idx + 1}`] = val;
    });
  }

  // Helper: check if an Anki field is empty
  function isFieldEmpty(val) {
    if (!val) return true;
    const stripped = val.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    return stripped.length === 0;
  }

  // Helper: format Japanese Furigana (e.g. 日本[にほん] -> <ruby>日本<rt>にほん</rt></ruby>)
  function formatFurigana(text, type) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/ ?([^ >\n\r]+?)\[([^\]\n\r]+?)\]/g, (match, kanji, kana) => {
      if (type === 'kanji') return kanji;
      if (type === 'kana') return kana;
      return `<ruby>${kanji}<rt>${kana}</rt></ruby>`;
    });
  }

  // 3. Process Anki Conditionals:
  // {{#FieldName}}content{{/FieldName}} -> keep content only if field is non-empty
  // {{^FieldName}}content{{/FieldName}} -> keep content only if field IS empty
  for (const [name, val] of Object.entries(fieldDict)) {
    const escapedName = escapeRegex(name);
    const hasContent = !isFieldEmpty(val);

    // {{#FieldName}}...{{/FieldName}}
    const condPattern = new RegExp(`\\{\\{#${escapedName}\\}\\}([\\s\\S]*?)\\{\\{/${escapedName}\\}\\}`, 'g');
    html = html.replace(condPattern, (m, inner) => {
      return hasContent ? inner : '';
    });

    // {{^FieldName}}...{{/FieldName}}
    const invCondPattern = new RegExp(`\\{\\{\\^${escapedName}\\}\\}([\\s\\S]*?)\\{\\{/${escapedName}\\}\\}`, 'g');
    html = html.replace(invCondPattern, (m, inner) => {
      return !hasContent ? inner : '';
    });
  }

  // 4. Process Field Modifiers & Replacements
  for (const [name, rawVal] of Object.entries(fieldDict)) {
    const escapedName = escapeRegex(name);
    const val = rawVal || '';

    // Cloze deletion: {{cloze:FieldName}}
    const clozeRegex = new RegExp(`\\{\\{cloze:${escapedName}\\}\\}`, 'g');
    html = html.replace(clozeRegex, processCloze(val, cardOrd + 1, isBack));

    // {{furigana:FieldName}}
    const furiRegex = new RegExp(`\\{\\{furigana:${escapedName}\\}\\}`, 'g');
    html = html.replace(furiRegex, formatFurigana(val, 'ruby'));

    // {{kanji:FieldName}}
    const kanjiRegex = new RegExp(`\\{\\{kanji:${escapedName}\\}\\}`, 'g');
    html = html.replace(kanjiRegex, formatFurigana(val, 'kanji'));

    // {{kana:FieldName}}
    const kanaRegex = new RegExp(`\\{\\{kana:${escapedName}\\}\\}`, 'g');
    html = html.replace(kanaRegex, formatFurigana(val, 'kana'));

    // {{text:FieldName}}
    const textRegex = new RegExp(`\\{\\{text:${escapedName}\\}\\}`, 'g');
    html = html.replace(textRegex, val.replace(/<[^>]*>/g, ''));

    // {{hint:FieldName}}
    const hintRegex = new RegExp(`\\{\\{hint:${escapedName}\\}\\}`, 'g');
    html = html.replace(hintRegex, isFieldEmpty(val) ? '' : `<details class="hint-details"><summary>Gợi ý (${name})</summary><div>${val}</div></details>`);

    // Standard {{FieldName}} (also supports ruby furigana if syntax exists)
    const standardRegex = new RegExp(`\\{\\{${escapedName}\\}\\}`, 'g');
    html = html.replace(standardRegex, formatFurigana(val, 'ruby'));
  }

  // 5. Standalone cloze if template didn't use {{cloze:...}}
  if (html.includes('{{c')) {
    html = processCloze(html, cardOrd + 1, isBack);
  }

  // 6. Clean up any remaining unparsed tags (e.g. {{#...}}, {{/...}}, {{...}})
  html = html.replace(/\{\{[#^/][^}]+\}\}/g, '');
  html = html.replace(/\{\{[a-zA-Z0-9_:#\^/ \-]+?\}\}/g, '');

  return html;
}

function processCloze(text, targetClozeNum, isBack) {
  // Matches {{c1::answer}} or {{c1::answer::hint}}
  const clozePattern = /\{\{c(\d+)::([^:]+?)(?:::([^}]+?))?\}\}/g;
  return text.replace(clozePattern, (match, num, answer, hint) => {
    const n = parseInt(num, 10);
    if (n === targetClozeNum) {
      if (isBack) {
        return `<span class="cloze">${answer}</span>`;
      } else {
        return `<span class="cloze">[${hint || '...'}]</span>`;
      }
    } else {
      return answer;
    }
  });
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convert sound tags [sound:filename.mp3] and <img> src inside card content
async function prepareCardMedia(htmlContent, deckId) {
  let processed = htmlContent;

  // 1. Process [sound:filename]
  const soundRegex = /\[sound:([^\]]+)\]/g;
  const soundMatches = [...processed.matchAll(soundRegex)];
  for (const match of soundMatches) {
    const soundFile = match[1];
    const blobUrl = await loadMediaBlob(deckId, soundFile);
    if (blobUrl) {
      const audioTag = `
        <div class="audio-wrap">
          <button class="audio-btn" onclick="playAudio('${blobUrl}')">
            🔊 Phát âm thanh
          </button>
        </div>
      `;
      processed = processed.replace(match[0], audioTag);
    } else {
      // Audio file not embedded, keep simple indicator
      processed = processed.replace(match[0], `<span class="audio-btn">🔊 ${soundFile}</span>`);
    }
  }

  // 2. Process <img src="filename">
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
  const imgMatches = [...processed.matchAll(imgRegex)];
  for (const match of imgMatches) {
    const origSrc = match[1];
    if (!origSrc.startsWith('http') && !origSrc.startsWith('data:') && !origSrc.startsWith('blob:')) {
      const blobUrl = await loadMediaBlob(deckId, origSrc);
      if (blobUrl) {
        processed = processed.replace(origSrc, blobUrl);
      }
    }
  }

  // 3. Fallback cleanup for cards containing legacy unparsed template tags
  processed = processed.replace(/\{\{#[^}]+\}\}\s*\{\{\/[^}]+\}\}/g, '');
  processed = processed.replace(/\{\{[#^/][^}]+\}\}/g, '');
  processed = processed.replace(/\{\{[a-zA-Z0-9_:#\^/ \-]+?\}\}/g, '');

  return processed;
}

window.playAudio = function(url) {
  try {
    const audio = new Audio(url);
    audio.play().catch(e => console.log('Audio autoplay prevented:', e));
  } catch (err) {
    console.error('Lỗi khi phát audio:', err);
  }
};

// ==========================================================================
// Demo Deck Generator
// ==========================================================================
async function generateDemoDeck() {
  const deckId = 'demo-deck-sample';
  const demoDeck = {
    id: deckId,
    name: 'Từ Vựng Tiếng Anh & Mẹo Giao Tiếp',
    cardCount: 6,
    createdAt: new Date().toISOString()
  };

  const sampleCards = [
    {
      id: `${deckId}_1`,
      deckId,
      front: `<h3>Serendipity</h3><p style="color:#94a3b8; font-size: 0.9rem;">(Noun /ˌser.ənˈdɪp.ə.ti/)</p>`,
      back: `<h3>Sự may mắn bất ngờ</h3><p>Khả năng tình cờ tìm thấy những điều hay ho, có giá trị mà không chủ định tìm kiếm.</p><hr/><p style="font-style:italic; font-size: 0.95rem; color:#cbd5e1;">"Finding my favorite book in an old coffee shop was pure serendipity."</p>`,
      tags: ['Vocab', 'English', 'Advanced'],
      state: 'new'
    },
    {
      id: `${deckId}_2`,
      deckId,
      front: `<p>Trong tiếng Anh, thành ngữ nào mang nghĩa <strong>"Làm việc thâu đêm suốt sáng"</strong>?</p>`,
      back: `<h3>Burn the midnight oil</h3><p>Nguồn gốc: Đốt đèn dầu học/làm việc xuyên đêm trước kỳ thi hoặc thời hạn gấp.</p><hr/><p><em>"She had to burn the midnight oil to pass the IELTS exam."</em></p>`,
      tags: ['Idiom'],
      state: 'new'
    },
    {
      id: `${deckId}_3`,
      deckId,
      front: `<p>Điền từ thích hợp (Cloze):</p><br/><p>The meeting was postponed due to <span class="cloze">[tình huống bất khả kháng...]</span>.</p>`,
      back: `<p>The meeting was postponed due to <span class="cloze">unforeseen circumstances</span>.</p><hr/><p><strong>unforeseen circumstances:</strong> những tình huống bất ngờ không lường trước được.</p>`,
      tags: ['Business-English'],
      state: 'new'
    },
    {
      id: `${deckId}_4`,
      deckId,
      front: `<h3>Kanji: 日本</h3><p>Cách đọc Hiragana và ý nghĩa là gì?</p>`,
      back: `<h3>にほん (Nihon / Nippon)</h3><p><strong>Nghĩa:</strong> Nhật Bản (Xứ sở mặt trời mọc)</p><p>日: Mặt trời / Ngày | 本: Gốc, sách</p>`,
      tags: ['Japanese', 'Kanji', 'N5'],
      state: 'new'
    },
    {
      id: `${deckId}_5`,
      deckId,
      front: `<h3>Procrastination</h3><p>Từ này có nghĩa là gì trong tâm lý học & đời sống?</p>`,
      back: `<h3>Sự trì hoãn</h3><p>Thói quen lùi lại hoặc chậm trễ làm một công việc cần thiết, thường thay thế bằng những việc ít quan trọng hơn nhưng thoải mái hơn.</p>`,
      tags: ['Psychology', 'Self-help'],
      state: 'new'
    },
    {
      id: `${deckId}_6`,
      deckId,
      front: `<p>Mẹo lật thẻ nhanh trên <strong>Anki Web iOS</strong>:</p>`,
      back: `<p>✓ Chạm trực tiếp vào mặt thẻ để lật.</p><p>✓ Sử dụng phím <strong>Space</strong> nếu dùng bàn phím ngoài.</p><p>✓ Chọn 1 trong 4 nút đánh giá: <strong>Học lại, Khó, Tốt, Dễ</strong>.</p>`,
      tags: ['Guide'],
      state: 'new'
    }
  ];

  await saveDeckToDB(demoDeck, sampleCards);
  return demoDeck;
}

// ==========================================================================
// UI View Controller & Study Logic
// ==========================================================================
const DOM = {
  // Screens
  viewDecks: document.getElementById('view-decks'),
  viewStudy: document.getElementById('view-study'),
  btnBack: document.getElementById('btn-back'),
  appTitle: document.getElementById('app-title'),
  btnResetDeck: document.getElementById('btn-reset-deck'),
  btnPwaGuide: document.getElementById('btn-pwa-guide'),

  // Deck Screen elements
  apkgInput: document.getElementById('apkg-input'),
  dropZone: document.getElementById('drop-zone'),
  btnLoadDemo: document.getElementById('btn-load-demo'),
  decksContainer: document.getElementById('decks-container'),
  deckCountBadge: document.getElementById('deck-count-badge'),

  // Study Screen elements
  studyDeckName: document.getElementById('study-deck-name'),
  studyCounter: document.getElementById('study-counter'),
  progressFill: document.getElementById('progress-fill'),
  studyProgressBar: document.querySelector('.study-progress-bar'),
  statNew: document.getElementById('stat-new'),
  statLearn: document.getElementById('stat-learn'),
  statRev: document.getElementById('stat-rev'),

  // Card elements
  cardStage: document.getElementById('card-stage'),
  flashcard: document.getElementById('flashcard'),
  cardFrontContent: document.getElementById('card-front-content'),
  cardBackContent: document.getElementById('card-back-content'),
  cardTagsBadge: document.getElementById('card-tags-badge'),

  // Controls
  bottomActionBar: document.querySelector('.bottom-action-bar'),
  actionShowAnswer: document.getElementById('action-show-answer'),
  actionRatingGroup: document.getElementById('action-rating-group'),
  btnShowAnswer: document.getElementById('btn-show-answer'),
  btnPrevCard: document.getElementById('btn-prev-card'),
  btnFlipCard: document.getElementById('btn-flip-card'),
  btnShuffleDeck: document.getElementById('btn-shuffle-deck'),
  btnNextCard: document.getElementById('btn-next-card'),

  // Completion / Realtime Waiting Screen
  studyCompleted: document.getElementById('study-completed'),
  countdownTimer: document.getElementById('countdown-timer'),
  countdownDate: document.getElementById('countdown-date'),
  srsDue1d: document.getElementById('srs-due-1d'),
  srsDue3d: document.getElementById('srs-due-3d'),
  srsDue5d: document.getElementById('srs-due-5d'),
  btnResetCompleted: document.getElementById('btn-reset-completed'),
  btnCramStudy: document.getElementById('btn-cram-study'),
  btnBackToDecks: document.getElementById('btn-back-to-decks'),

  // Modals
  modalLoading: document.getElementById('modal-loading'),
  loadingTitle: document.getElementById('loading-title'),
  loadingDesc: document.getElementById('loading-desc'),
  modalProgressFill: document.getElementById('modal-progress-fill'),
  modalGuide: document.getElementById('modal-guide'),
  btnCloseGuide: document.getElementById('btn-close-guide'),
  btnGuideOk: document.getElementById('btn-guide-ok')
};

// Switch Views
function showDecksView() {
  stopCountdownTicker();
  DOM.viewStudy.classList.remove('active');
  DOM.viewDecks.classList.add('active');
  DOM.btnBack.classList.add('hidden');
  DOM.btnResetDeck.classList.add('hidden');
  DOM.appTitle.textContent = 'Anki Web iOS';
  state.activeDeck = null;
  refreshDecksList();
}

async function showStudyView(deck, mode = 'due') {
  stopCountdownTicker();
  state.activeDeck = deck;
  DOM.viewDecks.classList.remove('active');
  DOM.viewStudy.classList.add('active');
  DOM.btnBack.classList.remove('hidden');
  DOM.btnResetDeck.classList.remove('hidden');
  DOM.appTitle.textContent = deck.name;
  DOM.studyDeckName.textContent = deck.name;

  showLoading('Đang tải thẻ học...', 'Vui lòng chờ...');
  state.allCards = await loadCardsForDeckFromDB(deck.id);
  hideLoading();

  if (!state.allCards || state.allCards.length === 0) {
    alert('Bộ thẻ này không có dữ liệu thẻ!');
    showDecksView();
    return;
  }

  const now = Date.now();
  if (mode === 'due') {
    // Chỉ lấy thẻ mới hoặc thẻ đã đến hạn ôn tập (realtime)
    state.cards = state.allCards.filter(c => c.state === 'new' || !c.due || c.due <= now);
  } else {
    // Ôn tập sớm (Cram mode): Học toàn bộ tất cả thẻ
    state.cards = [...state.allCards];
  }

  if (state.cards.length === 0) {
    showCompletedView();
    return;
  }

  // Khôi phục giao diện lật thẻ (nếu trước đó đang hiển thị màn hình hoàn thành)
  DOM.cardStage.classList.remove('hidden');
  DOM.bottomActionBar.classList.remove('hidden');
  DOM.studyProgressBar.classList.remove('hidden');
  DOM.studyCompleted.classList.add('hidden');

  state.totalSessionCards = state.cards.length;
  state.sessionCompletedCount = 0;
  state.currentIndex = 0;
  state.isFlipped = false;
  renderCurrentCard();
}

function showCompletedView() {
  stopCountdownTicker();

  // Ẩn vùng học thẻ, hiện màn hình hoàn thành
  DOM.cardStage.classList.add('hidden');
  DOM.bottomActionBar.classList.add('hidden');
  DOM.studyProgressBar.classList.add('hidden');
  DOM.studyCompleted.classList.remove('hidden');

  const allCards = state.allCards || [];
  const now = Date.now();
  const futureCards = allCards.filter(c => c.due && c.due > now);

  // Thống kê phân loại thẻ theo thời gian hẹn
  const due1d = allCards.filter(c => c.ivl === 1).length;
  const due3d = allCards.filter(c => c.ivl === 3).length;
  const due5d = allCards.filter(c => c.ivl === 5).length;

  DOM.srsDue1d.textContent = due1d;
  DOM.srsDue3d.textContent = due3d;
  DOM.srsDue5d.textContent = due5d;

  if (futureCards.length > 0) {
    const nextDue = Math.min(...futureCards.map(c => c.due));
    startCountdownTicker(nextDue);
  } else {
    DOM.countdownTimer.textContent = 'Hoàn tất';
    DOM.countdownDate.textContent = 'Tất cả thẻ đã được ôn tập xong!';
  }
}

// Bộ đếm thời gian Realtime lùi từng giây
function startCountdownTicker(targetTimestamp) {
  stopCountdownTicker();

  function updateClock() {
    const now = Date.now();
    const diff = targetTimestamp - now;

    if (diff <= 0) {
      DOM.countdownTimer.textContent = '00:00:00';
      DOM.countdownDate.textContent = '⚡ Đã có thẻ đến hạn ôn tập! Bấm bên dưới để học ngay.';
      stopCountdownTicker();
      return;
    }

    const days = Math.floor(diff / (24 * 3600 * 1000));
    const hours = Math.floor((diff % (24 * 3600 * 1000)) / (3600 * 1000));
    const minutes = Math.floor((diff % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((diff % (60 * 1000)) / 1000);

    const pad = (n) => String(n).padStart(2, '0');

    if (days > 0) {
      DOM.countdownTimer.textContent = `${days} ngày ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    } else {
      DOM.countdownTimer.textContent = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }

    const dueDateObj = new Date(targetTimestamp);
    DOM.countdownDate.textContent = `Hẹn lúc ${dueDateObj.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} ngày ${dueDateObj.toLocaleDateString('vi-VN')}`;
  }

  updateClock();
  state.countdownTimerId = setInterval(updateClock, 1000);
}

function stopCountdownTicker() {
  if (state.countdownTimerId) {
    clearInterval(state.countdownTimerId);
    state.countdownTimerId = null;
  }
}

async function renderCurrentCard() {
  if (state.currentIndex < 0) state.currentIndex = 0;
  if (state.currentIndex >= state.cards.length) {
    state.currentIndex = state.cards.length - 1;
  }

  const card = state.cards[state.currentIndex];
  state.isFlipped = false;
  DOM.flashcard.classList.remove('flipped');

  // Cập nhật thanh tiến độ phiên học
  const total = state.totalSessionCards || (state.cards.length + state.sessionCompletedCount);
  const currentNum = Math.min(state.sessionCompletedCount + 1, total);
  DOM.studyCounter.textContent = `${currentNum} / ${total}`;
  DOM.progressFill.style.width = `${Math.round((state.sessionCompletedCount / total) * 100)}%`;

  // Thống kê thẻ Realtime toàn bộ bộ thẻ:
  // - Xanh dương (Mới): số thẻ mới chưa học
  // - Vàng (Đang học / Khó): số thẻ đánh giá Học lại / Khó
  // - Xanh lá (Ôn tập / Đã thuộc): số thẻ đánh giá Thường / Dễ
  const all = state.allCards || state.cards;
  const newCount = all.filter(c => c.state === 'new').length;
  const learnCount = all.filter(c => c.state === 'learn').length;
  const revCount = all.filter(c => c.state === 'rev').length;
  DOM.statNew.textContent = newCount;
  DOM.statLearn.textContent = learnCount;
  DOM.statRev.textContent = revCount;

  // Tags
  DOM.cardTagsBadge.textContent = card.tags && card.tags.length ? card.tags.join(', ') : '';

  // Render Front & Back HTML
  DOM.cardFrontContent.innerHTML = await prepareCardMedia(card.front, card.deckId);
  DOM.cardBackContent.innerHTML = await prepareCardMedia(card.back, card.deckId);

  // Nút hiển thị
  DOM.actionShowAnswer.classList.remove('hidden');
  DOM.actionRatingGroup.classList.add('hidden');
}

function flipCard() {
  state.isFlipped = !state.isFlipped;
  if (state.isFlipped) {
    DOM.flashcard.classList.add('flipped');
    DOM.actionShowAnswer.classList.add('hidden');
    DOM.actionRatingGroup.classList.remove('hidden');
  } else {
    DOM.flashcard.classList.remove('flipped');
    DOM.actionShowAnswer.classList.remove('hidden');
    DOM.actionRatingGroup.classList.add('hidden');
  }
}

// Tính mốc thời gian ôn tập chuẩn Anki:
// - Khó: sang ngày hôm sau (bắt đầu từ 04:00 sáng mai)
// - Thường: 3 ngày sau (04:00 sáng sau 3 ngày)
// - Dễ: 5 ngày sau (04:00 sáng sau 5 ngày)
function calculateNextDueDate(daysAhead) {
  const now = new Date();
  const d = new Date();
  // Nếu học đêm khuya trước 4h sáng, coi như phiên học của ngày hôm trước
  if (now.getHours() < 4) {
    d.setDate(d.getDate() + (daysAhead - 1));
  } else {
    d.setDate(d.getDate() + daysAhead);
  }
  // Mốc bắt đầu ngày học mới là 04:00 sáng để sáng ngủ dậy là có thẻ học
  d.setHours(4, 0, 0, 0);
  return d.getTime();
}

// Xử lý đánh giá SRS Realtime (Khó -> hôm sau, Thường -> 3 ngày sau, Dễ -> 5 ngày sau)
async function handleRating(rating) {
  // rating: 1 = Học lại (< 1 phút), 2 = Khó (Hôm sau), 3 = Thường (3 ngày sau), 4 = Dễ (5 ngày sau)
  const card = state.cards[state.currentIndex];
  const now = Date.now();

  if (rating === 1) {
    // Học lại: hẹn 1 phút, đưa về cuối danh sách trong phiên học
    card.state = 'learn';
    card.ivl = 0;
    card.due = now + 60 * 1000;
    card.reps = (card.reps || 0) + 1;
    await updateCardInDB(card);

    if (state.cards.length > 1) {
      const [retryingCard] = state.cards.splice(state.currentIndex, 1);
      state.cards.push(retryingCard);
      renderCurrentCard();
    } else {
      // Chỉ còn 1 thẻ duy nhất: lật lại mặt trước để học lại
      state.isFlipped = false;
      DOM.flashcard.classList.remove('flipped');
      DOM.actionShowAnswer.classList.remove('hidden');
      DOM.actionRatingGroup.classList.add('hidden');
    }
    return;
  }

  if (rating === 2) {
    // Khó: sang ngày hôm sau (04:00 sáng mai)
    card.state = 'learn';
    card.ivl = 1;
    card.due = calculateNextDueDate(1);
  } else if (rating === 3) {
    // Thường: 3 ngày sau (04:00 sáng sau 3 ngày)
    card.state = 'rev';
    card.ivl = 3;
    card.due = calculateNextDueDate(3);
  } else if (rating === 4) {
    // Dễ: 5 ngày sau (04:00 sáng sau 5 ngày)
    card.state = 'rev';
    card.ivl = 5;
    card.due = calculateNextDueDate(5);
  }

  card.reps = (card.reps || 0) + 1;
  await updateCardInDB(card);

  // Ghi nhận hoàn thành 1 thẻ trong phiên học hiện tại
  state.sessionCompletedCount++;

  // Thẻ đã hẹn lịch sau (hôm sau, 3 ngày, 5 ngày) -> loại khỏi hàng chờ học hiện tại
  state.cards.splice(state.currentIndex, 1);

  if (state.cards.length === 0) {
    showCompletedView();
  } else {
    if (state.currentIndex >= state.cards.length) {
      state.currentIndex = state.cards.length - 1;
    }
    renderCurrentCard();
  }
}

// Hàm Đặt lại tiến độ (Reset thời gian)
async function confirmAndResetDeck(deckId, deckName = '') {
  const name = deckName || (state.activeDeck ? state.activeDeck.name : '');
  const msg = name 
    ? `Bạn có chắc muốn đặt lại toàn bộ thời gian học của bộ thẻ "${name}"?\n\nTất cả thẻ sẽ trở về trạng thái mới để bạn học lại từ đầu ngay lập tức.`
    : `Bạn có chắc muốn đặt lại toàn bộ thời gian học của bộ thẻ này để học lại từ đầu không?`;

  if (confirm(msg)) {
    showLoading('Đang đặt lại tiến độ...', 'Vui lòng chờ...');
    const count = await resetDeckProgressInDB(deckId);
    hideLoading();
    alert(`✅ Đã đặt lại thời gian học thành công cho ${count} thẻ!`);

    if (state.activeDeck && state.activeDeck.id === deckId) {
      await showStudyView(state.activeDeck, 'due');
    } else {
      await refreshDecksList();
    }
  }
}

// Refresh deck list on home screen (Hiển thị thẻ Cần học vs Đang chờ)
async function refreshDecksList() {
  state.decks = await loadAllDecksFromDB();
  DOM.deckCountBadge.textContent = `${state.decks.length} bộ thẻ`;
  DOM.decksContainer.innerHTML = '';

  if (state.decks.length === 0) {
    DOM.decksContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗂️</div>
        <p>Chưa có bộ thẻ nào.</p>
        <span>Hãy chọn file <strong>.apkg</strong> từ máy hoặc bấm <strong>"Tải bộ thẻ mẫu"</strong> ở trên để bắt đầu ngay!</span>
      </div>
    `;
    return;
  }

  const now = Date.now();
  for (const deck of state.decks) {
    const cards = await loadCardsForDeckFromDB(deck.id);
    const dueCount = cards.filter(c => c.state === 'new' || !c.due || c.due <= now).length;
    const waitingCount = cards.length - dueCount;

    const cardEl = document.createElement('div');
    cardEl.className = 'deck-item-card';
    cardEl.innerHTML = `
      <div class="deck-item-info">
        <span class="deck-item-name">${escapeHtml(deck.name)}</span>
        <div class="deck-item-meta">
          <span>📚 ${deck.cardCount || cards.length} thẻ</span>
          ${dueCount > 0 ? `<span class="deck-meta-pill deck-meta-due">⚡ ${dueCount} cần học</span>` : ''}
          ${waitingCount > 0 ? `<span class="deck-meta-pill deck-meta-wait">⏳ ${waitingCount} đang chờ</span>` : ''}
        </div>
      </div>
      <div class="deck-item-actions">
        <button class="btn-deck-study">${dueCount > 0 ? `Học ngay (${dueCount})` : 'Ôn tập'}</button>
        <button class="btn-deck-reset" title="Đặt lại thời gian học (Reset)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
          </svg>
        </button>
        <button class="btn-deck-delete" title="Xóa bộ thẻ">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    cardEl.querySelector('.btn-deck-study').addEventListener('click', (e) => {
      e.stopPropagation();
      showStudyView(deck, 'due');
    });

    cardEl.querySelector('.btn-deck-reset').addEventListener('click', async (e) => {
      e.stopPropagation();
      await confirmAndResetDeck(deck.id, deck.name);
    });

    cardEl.querySelector('.btn-deck-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Bạn có chắc muốn xóa bộ thẻ "${deck.name}" không?`)) {
        await deleteDeckFromDB(deck.id);
        refreshDecksList();
      }
    });

    cardEl.addEventListener('click', () => showStudyView(deck, 'due'));
    DOM.decksContainer.appendChild(cardEl);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Modal Loaders
function showLoading(title, desc = '', percent = 0) {
  DOM.loadingTitle.textContent = title;
  DOM.loadingDesc.textContent = desc;
  DOM.modalProgressFill.style.width = `${percent}%`;
  DOM.modalLoading.classList.remove('hidden');
}

function updateLoadingProgress(percent, desc) {
  DOM.modalProgressFill.style.width = `${percent}%`;
  if (desc) DOM.loadingDesc.textContent = desc;
}

function hideLoading() {
  DOM.modalLoading.classList.add('hidden');
}

// ==========================================================================
// Event Listeners & Touch Handlers
// ==========================================================================
function setupEventListeners() {
  // Navigation
  DOM.btnBack.addEventListener('click', showDecksView);

  // Reset thời gian bộ thẻ khi đang học
  DOM.btnResetDeck.addEventListener('click', () => {
    if (state.activeDeck) {
      confirmAndResetDeck(state.activeDeck.id, state.activeDeck.name);
    }
  });

  // Nút hành động trên màn hình Hoàn thành / Chờ ôn tập
  DOM.btnResetCompleted.addEventListener('click', () => {
    if (state.activeDeck) {
      confirmAndResetDeck(state.activeDeck.id, state.activeDeck.name);
    }
  });

  DOM.btnCramStudy.addEventListener('click', () => {
    if (state.activeDeck) {
      showStudyView(state.activeDeck, 'all');
    }
  });

  DOM.btnBackToDecks.addEventListener('click', showDecksView);

  // File Upload (.apkg) - Input đã phủ kín khung nên bắt sự kiện change trực tiếp
  DOM.apkgInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      showLoading('Đang đọc file .apkg...', 'Chuẩn bị dữ liệu', 10);
      const newDeck = await parseApkgFile(file, (percent, msg) => {
        updateLoadingProgress(percent, msg);
      });
      hideLoading();
      DOM.apkgInput.value = '';
      await refreshDecksList();
      showStudyView(newDeck);
    } catch (err) {
      hideLoading();
      DOM.apkgInput.value = '';
      alert('Không thể mở file Anki này: ' + err.message);
      console.error(err);
    }
  });

  // Load Demo Deck
  DOM.btnLoadDemo.addEventListener('click', async () => {
    try {
      showLoading('Đang tải bộ thẻ mẫu...', 'Khởi tạo từ vựng...', 50);
      const demo = await generateDemoDeck();
      hideLoading();
      await refreshDecksList();
      showStudyView(demo);
    } catch (err) {
      hideLoading();
      alert('Lỗi tạo bộ thẻ mẫu: ' + err.message);
    }
  });

  // Card Flip Events
  DOM.flashcard.addEventListener('click', (e) => {
    // Avoid flipping if clicking on audio button or link
    if (e.target.closest('button') || e.target.closest('a')) return;
    flipCard();
  });
  DOM.btnShowAnswer.addEventListener('click', flipCard);
  DOM.btnFlipCard.addEventListener('click', flipCard);

  // SRS Rating Buttons
  document.querySelectorAll('.btn-rate').forEach(btn => {
    btn.addEventListener('click', () => {
      const rating = parseInt(btn.dataset.rating, 10);
      handleRating(rating);
    });
  });

  // Previous / Next / Shuffle
  DOM.btnPrevCard.addEventListener('click', () => {
    if (state.currentIndex > 0) {
      state.currentIndex--;
      renderCurrentCard();
    }
  });

  DOM.btnNextCard.addEventListener('click', () => {
    if (state.currentIndex < state.cards.length - 1) {
      state.currentIndex++;
      renderCurrentCard();
    }
  });

  DOM.btnShuffleDeck.addEventListener('click', () => {
    if (!state.cards || state.cards.length <= 1) return;
    for (let i = state.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.cards[i], state.cards[j]] = [state.cards[j], state.cards[i]];
    }
    state.currentIndex = 0;
    renderCurrentCard();
  });

  // Keyboard Shortcuts (Space to flip, 1-4 for rating)
  window.addEventListener('keydown', (e) => {
    if (!DOM.viewStudy.classList.contains('active')) return;

    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      flipCard();
    } else if (state.isFlipped) {
      if (e.key === '1') handleRating(1);
      if (e.key === '2') handleRating(2);
      if (e.key === '3') handleRating(3);
      if (e.key === '4') handleRating(4);
    } else {
      if (e.key === 'ArrowLeft' && state.currentIndex > 0) {
        state.currentIndex--;
        renderCurrentCard();
      } else if (e.key === 'ArrowRight' && state.currentIndex < state.cards.length - 1) {
        state.currentIndex++;
        renderCurrentCard();
      }
    }
  });

  // Touch Swipe gestures for iPhone
  let touchStartX = 0;
  let touchStartY = 0;

  DOM.flashcard.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });

  DOM.flashcard.addEventListener('touchend', (e) => {
    const diffX = e.changedTouches[0].screenX - touchStartX;
    const diffY = e.changedTouches[0].screenY - touchStartY;

    // Detect horizontal swipe if deltaX > 50 and deltaY < 40
    if (Math.abs(diffX) > 60 && Math.abs(diffY) < 50) {
      if (diffX < 0) {
        // Swipe left -> Next card
        if (state.currentIndex < state.cards.length - 1) {
          state.currentIndex++;
          renderCurrentCard();
        }
      } else {
        // Swipe right -> Prev card
        if (state.currentIndex > 0) {
          state.currentIndex--;
          renderCurrentCard();
        }
      }
    }
  }, { passive: true });

  // PWA Guide Modal
  DOM.btnPwaGuide.addEventListener('click', () => {
    DOM.modalGuide.classList.remove('hidden');
  });
  DOM.btnCloseGuide.addEventListener('click', () => {
    DOM.modalGuide.classList.add('hidden');
  });
  DOM.btnGuideOk.addEventListener('click', () => {
    DOM.modalGuide.classList.add('hidden');
  });

  // Service Worker Registration for PWA Offline Support
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        console.log('ServiceWorker registered:', reg.scope);
      }).catch((err) => {
        console.warn('ServiceWorker registration error:', err);
      });
    });
  }
}

// App Initialization
async function initApp() {
  try {
    await initIndexedDB();
    setupEventListeners();
    await refreshDecksList();
  } catch (err) {
    console.error('App init error:', err);
  }
}

document.addEventListener('DOMContentLoaded', initApp);
