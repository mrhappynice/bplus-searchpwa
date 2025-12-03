// Global State
let db = null;
let sqlite3 = null; // Store reference
let sidecarAvailable = false;

// --- 1. Database Layer (SQLite WASM) ---
async function initPwa() {
    console.log('Initializing SQLite WASM...');
    try {
        sqlite3 = await window.sqlite3InitModule({
            print: console.log,
            printErr: console.error,
        });

        // Try OPFS, fallback to memory
        if (sqlite3.opfs) {
            db = new sqlite3.oo1.OpfsDb('/bplus_research.db');
            console.log('Using OPFS persistent storage.');
        } else {
            db = new sqlite3.oo1.DB('/bplus_memory.db', 'ct');
            console.log('Warning: Using transient memory storage (Headers missing?).');
        }

        // Initialize Schema
        db.exec(`
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sources TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL UNIQUE,
                content TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS search_providers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                api_url TEXT,
                api_headers TEXT,
                result_path TEXT,
                title_path TEXT, 
                url_path TEXT,
                content_path TEXT,
                is_enabled BOOLEAN DEFAULT 1
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
        `);

        // SEED DEFAULTS
        const count = db.selectValue("SELECT count(*) FROM search_providers");
        if(count === 0) {
            // Note: For TVMaze, we use an empty string '' for result_path to indicate the root array
            db.exec(`INSERT INTO search_providers (name, type, api_url, result_path, title_path, url_path, content_path, is_enabled) VALUES 
                ('Local Database', 'native', 'native_local_db', '', '', '', '', 1),
                ('Wikipedia', 'native', 'native_wiki', '', '', '', '', 1),
                ('DuckDuckGo (Needs Sidecar)', 'native', 'native_ddg', '', '', '', '', 0),
                
                ('Apple Podcasts', 'generic', 'https://itunes.apple.com/search?term={q}&entity=podcast&limit=5', 'results', 'collectionName', 'collectionViewUrl', 'artistName', 1),
                ('TVMaze (TV Shows)', 'generic', 'https://api.tvmaze.com/search/shows?q={q}', '', 'show.name', 'show.url', 'show.summary', 1),
                ('StackExchange', 'generic', 'https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q={q}&site=stackoverflow', 'items', 'title', 'link', 'title', 1),
                ('SearXNG (Public)', 'generic', 'https://searx.be/search?q={q}&format=json', 'results', 'title', 'url', 'content', 1)
            `);
        }

        checkSidecar();

    } catch (err) {
        console.error('Init failed:', err);
    }
}

async function checkSidecar() {
    try {
        const res = await fetch('http://localhost:3001/api/models', { method: 'HEAD' });
        sidecarAvailable = res.ok;
        const statusDiv = document.getElementById("status");
        if(sidecarAvailable && statusDiv) {
            statusDiv.innerHTML = `<span style="color:#64b5f6;">🚀 Sidecar Active (Scrapers Enabled)</span>`;
        }
    } catch(e) { sidecarAvailable = false; }
}

// --- 2. Data Access Helpers ---
const DB = {
    getConversations: async () => {
        const res = [];
        if(!db) return res;
        try {
            db.exec({
                sql: "SELECT id, title, created_at FROM conversations ORDER BY created_at DESC",
                rowMode: 'object',
                callback: (row) => res.push(row)
            });
        } catch(e) {} 
        return res;
    },
    createConversation: async (title) => {
        db.exec({ sql: "INSERT INTO conversations (title) VALUES (?)", bind: [title] });
        return { id: db.selectValue("SELECT last_insert_rowid()") };
    },
    getConversation: async (id) => {
        const msgs = [];
        db.exec({
            sql: "SELECT role, content, sources FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            bind: [id],
            rowMode: 'object',
            callback: (row) => msgs.push(row)
        });
        const note = db.selectValue("SELECT content FROM notes WHERE conversation_id = ?", [id]);
        return { messages: msgs, note_content: note };
    },
    addMessage: (convId, role, content, sources) => {
        db.exec({
            sql: "INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)",
            bind: [convId, role, content, sources]
        });
    },
    saveNote: (convId, content) => {
        db.exec({
            sql: "INSERT INTO notes (conversation_id, content) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET content=excluded.content",
            bind: [convId, content]
        });
    },
    deleteConversation: (id) => {
        // FIX: Moved bind array into the configuration object
        db.exec({
            sql: "DELETE FROM conversations WHERE id = ?", 
            bind: [id]
        });
    },
    getProviders: () => {
        if(!db) return [];
        const res = [];
        try {
            db.exec({
                sql: "SELECT * FROM search_providers",
                rowMode: 'object',
                callback: (row) => {
                    row.is_enabled = row.is_enabled === 1;
                    res.push(row);
                }
            });
        } catch(e) {}
        return res;
    },
    addProvider: (p) => {
        db.exec({
            sql: "INSERT INTO search_providers (name, type, api_url, api_headers, result_path, title_path, url_path, content_path) VALUES (?,?,?,?,?,?,?,?)",
            bind: [p.name, 'generic', p.api_url, p.api_headers, p.result_path, p.title_path, p.url_path, p.content_path]
        });
    },
    toggleProvider: (id, state) => {
        // FIX: Moved bind array into the configuration object
        db.exec({
            sql: "UPDATE search_providers SET is_enabled = ? WHERE id = ?", 
            bind: [state ? 1 : 0, id]
        });
    },
    deleteProvider: (id) => {
        // FIX: Moved bind array into the configuration object
        db.exec({
            sql: "DELETE FROM search_providers WHERE id = ?", 
            bind: [id]
        });
    },
    
    // --- Binary Export/Import ---
    exportDatabase: () => {
        try {
            const byteArray = sqlite3.capi.sqlite3_js_db_export(db);
            const blob = new Blob([byteArray.buffer], { type: "application/x-sqlite3" });
            const a = document.createElement("a");
            document.body.appendChild(a);
            a.href = window.URL.createObjectURL(blob);
            a.download = "bplus_research.db";
            a.click();
            a.remove();
        } catch(e) {
            alert("Export failed: " + e.message);
        }
    },
    
    importDatabase: async (file) => {
        const reader = new FileReader();
        reader.onload = async function() {
            const u8 = new Uint8Array(this.result);
            try {
                if(db) db.close();
                
                if (sqlite3.opfs) {
                    try {
                        const root = await navigator.storage.getDirectory();
                        const fileHandle = await root.getFileHandle('bplus_research.db', {create: true});
                        const writable = await fileHandle.createWritable();
                        await writable.write(u8);
                        await writable.close();
                        db = new sqlite3.oo1.OpfsDb('/bplus_research.db');
                    } catch(e) {
                        throw e;
                    }
                } else {
                    const pData = sqlite3.wasm.allocFromTypedArray(u8);
                    sqlite3.capi.sqlite3_js_posix_create_file('/bplus_memory.db', pData, u8.length);
                    sqlite3.wasm.dealloc(pData);
                    db = new sqlite3.oo1.DB('/bplus_memory.db', 'ct');
                }
                
                alert("Database imported successfully!");
                if(window.loadConversations) window.loadConversations();
                if(window.loadProviders) window.loadProviders();
                if(window.startNewChat) window.startNewChat();
                
            } catch (e) {
                console.error("Import Error details:", e);
                alert("Import failed: " + e.message);
            }
        };
        reader.readAsArrayBuffer(file);
    }
};

// --- 3. Isomorphic Search Logic ---
async function performDualSearch(query, activeProviders) {
    const results = [];
    const proxyProviders = [];
    const browserProviders = [];

    activeProviders.forEach(p => {
        if (p.api_url.startsWith('native_ddg') || 
            p.api_url.startsWith('native_reddit') || 
            p.api_url.startsWith('native_qwant') ||
            p.api_url.startsWith('native_mojeek')) {
            proxyProviders.push(p);
        } else {
            browserProviders.push(p);
        }
    });

    for(const p of browserProviders) {
        try {
            if(p.api_url === 'native_local_db') {
                const hits = [];
                db.exec({
                    sql: "SELECT * FROM messages WHERE content LIKE '%' || ? || '%' ORDER BY created_at DESC LIMIT 5",
                    bind: [query],
                    rowMode: 'object',
                    callback: (row) => hits.push({
                        title: `Local Chat: ${row.created_at}`,
                        url: '#',
                        content: row.content.substring(0, 150) + "...",
                        engine: 'LocalDB'
                    })
                });
                results.push(...hits);
            } else if (p.api_url === 'native_wiki') {
                const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&origin=*&utf8=1&format=json&srsearch=${encodeURIComponent(query)}`;
                const res = await fetch(url).then(r=>r.json());
                if(res.query && res.query.search) {
                    results.push(...res.query.search.map(i => ({
                        title: i.title,
                        url: `https://en.wikipedia.org/wiki/${i.title.replace(' ', '_')}`,
                        content: i.snippet.replace(/<[^>]*>?/gm, ''),
                        engine: 'Wikipedia'
                    })));
                }
            } else if (p.type === 'generic') {
                const url = p.api_url.replace('{q}', encodeURIComponent(query));
                const headers = p.api_headers ? JSON.parse(p.api_headers) : {};
                const res = await fetch(url, { headers }).then(r=>r.json());
                
                // Helper: Get nested value. If path is empty, return obj.
                const getVal = (obj, path) => {
                    if(!path || path === '') return obj;
                    return path.split('.').reduce((o, i) => (o ? o[i] : null), obj);
                };
                
                let items = p.result_path ? getVal(res, p.result_path) : res;
                
                if(Array.isArray(items)) {
                    results.push(...items.map(item => ({
                        title: getVal(item, p.title_path) || "Result",
                        url: getVal(item, p.url_path) || "#",
                        content: getVal(item, p.content_path) || "",
                        engine: p.name
                    })).filter(x => x.url !== '#'));
                }
            }
        } catch(e) { console.error("Search Error for " + p.name, e); }
    }

    if (proxyProviders.length > 0 && sidecarAvailable) {
        try {
            const proxyRes = await fetch('http://localhost:3001/api/proxy/search', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    query: query,
                    providers: proxyProviders.map(p => p.id)
                })
            });
            const proxyData = await proxyRes.json();
            results.push(...proxyData);
        } catch(e) { console.error("Sidecar error", e); }
    }

    return results;
}
