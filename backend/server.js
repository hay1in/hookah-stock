const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============== НАСТРОЙКИ АВТОРИЗАЦИИ ==============
const USERS = {
    'HP Life': { password: 'flavorteam', role: 'admin' },
    'test': { password: 'test', role: 'guest' }
};

function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Требуется авторизация' });
    const base64Credentials = authHeader.split(' ')[1];
    if (!base64Credentials) return res.status(401).json({ error: 'Неверный формат авторизации' });
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');
    if (!USERS[username] || USERS[username].password !== password) return res.status(401).json({ error: 'Неверный логин или пароль' });
    req.user = { username: username, role: USERS[username].role };
    next();
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Недостаточно прав. Только для администратора.' });
    next();
}

// ============== БАЗА ДАННЫХ ==============
const initSqlJs = require('sql.js');
let db;

async function initDatabase() {
    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, 'hookah.db');
    
    try {
        if (fs.existsSync(dbPath)) {
            const fileBuffer = fs.readFileSync(dbPath);
            db = new SQL.Database(fileBuffer);
            console.log('✅ База данных загружена');
        } else {
            db = new SQL.Database();
            console.log('✅ Создана новая база данных');
        }
    } catch (error) {
        db = new SQL.Database();
        console.log('✅ Новая база (после ошибки)');
    }
    
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY, brand TEXT NOT NULL, flavor TEXT NOT NULL,
        weight INTEGER NOT NULL, packs INTEGER DEFAULT 0, tags TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL, brand TEXT NOT NULL, flavor TEXT NOT NULL,
        weight INTEGER, quantity INTEGER, message TEXT)`);
    
    db.run(`CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, color TEXT DEFAULT '#BB86FC')`);
    
    console.log('✅ Таблицы готовы');
    saveDatabase();
}

function saveDatabase() {
    try {
        const data = db.export();
        fs.writeFileSync(path.join(__dirname, 'hookah.db'), Buffer.from(data));
    } catch (error) { console.error('❌ Ошибка сохранения:', error); }
}

function runQuery(sql, params = []) {
    try {
        const results = db.exec(sql, params);
        if (results.length === 0) return [];
        const columns = results[0].columns;
        const values = results[0].values;
        return values.map(row => { const obj = {}; columns.forEach((col, i) => { obj[col] = row[i]; }); return obj; });
    } catch (error) { console.error('SQL Error:', error); throw error; }
}

// Цвета для новых тегов
const TAG_COLORS = ['#FF5252','#448AFF','#FF9100','#FFEB3B','#00E676','#FF4081','#FFC107','#E91E63','#9C27B0','#FF9800','#FFAB40','#8D6E63','#795548','#FF8A65','#6D4C41','#CDDC39','#4CAF50','#C0CA33','#D32F2F','#FDD835','#AED581','#F9A825','#FBC02D','#64FFDA','#BB86FC'];
let colorIndex = 0;

function getNextColor() {
    const color = TAG_COLORS[colorIndex % TAG_COLORS.length];
    colorIndex++;
    return color;
}

function getOrCreateTags(tagNames) {
    const tags = [];
    tagNames.forEach(name => {
        if (!name || name.trim() === '') return;
        name = name.trim();
        let existing = runQuery('SELECT * FROM tags WHERE name = ?', [name]);
        if (existing.length === 0) {
            const color = getNextColor();
            db.run('INSERT INTO tags (name, color) VALUES (?, ?)', [name, color]);
            existing = runQuery('SELECT * FROM tags WHERE name = ?', [name]);
        }
        tags.push(existing[0]);
    });
    return tags;
}

// ============== API РОУТЫ ==============

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
    if (!USERS[username] || USERS[username].password !== password) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = Buffer.from(username + ':' + password).toString('base64');
    res.json({ success: true, token: token, role: USERS[username].role, username: username });
});

app.get('/api/tags', authMiddleware, (req, res) => {
    try { res.json(runQuery('SELECT * FROM tags ORDER BY name')); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/inventory', authMiddleware, (req, res) => {
    try {
        const items = runQuery('SELECT * FROM inventory ORDER BY brand, flavor');
        items.forEach(item => { item.tagsArray = item.tags ? item.tags.split(',').filter(t => t) : []; });
        res.json(items);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/brands', authMiddleware, (req, res) => {
    try { res.json(runQuery('SELECT DISTINCT brand FROM inventory ORDER BY brand').map(b => b.brand)); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/flavors/:brand', authMiddleware, (req, res) => {
    try {
        const brand = decodeURIComponent(req.params.brand);
        res.json(runQuery('SELECT DISTINCT flavor FROM inventory WHERE brand = ? ORDER BY flavor', [brand]).map(f => f.flavor));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/weights/:brand/:flavor', authMiddleware, (req, res) => {
    try {
        const brand = decodeURIComponent(req.params.brand);
        const flavor = decodeURIComponent(req.params.flavor);
        res.json(runQuery('SELECT DISTINCT weight FROM inventory WHERE brand = ? AND flavor = ? ORDER BY weight', [brand, flavor]).map(w => w.weight));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ✏️ ОБНОВИТЬ ТЕГИ ПОЗИЦИИ
app.put('/api/inventory/:id/tags', authMiddleware, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { tags } = req.body;
    
    try {
        const existing = runQuery('SELECT * FROM inventory WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Позиция не найдена' });
        }
        
        const tagsStr = tags ? tags.join(',') : '';
        
        if (tags && tags.length > 0) {
            tags.forEach(tagName => {
                if (!tagName || tagName.trim() === '') return;
                tagName = tagName.trim();
                let tagExists = runQuery('SELECT * FROM tags WHERE name = ?', [tagName]);
                if (tagExists.length === 0) {
                    const color = getNextColor();
                    db.run('INSERT INTO tags (name, color) VALUES (?, ?)', [tagName, color]);
                }
            });
        }
        
        db.run('UPDATE inventory SET tags = ?, updated_at = datetime("now") WHERE id = ?', [tagsStr, id]);
        saveDatabase();
        
        const updatedItem = runQuery('SELECT * FROM inventory WHERE id = ?', [id])[0];
        updatedItem.tagsArray = updatedItem.tags ? updatedItem.tags.split(',').filter(t => t) : [];
        
        const message = `✏️ ОБНОВЛЕНЫ ТЕГИ: ${updatedItem.brand} "${updatedItem.flavor}" ${updatedItem.weight}г`;
        db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))', ['EDIT_TAGS', updatedItem.brand, updatedItem.flavor, updatedItem.weight, 0, message]);
        
        res.json({ success: true, item: updatedItem, message: 'Теги обновлены!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🟢 ЗАКУП
app.post('/api/buy', authMiddleware, requireAdmin, (req, res) => {

app.post('/api/buy', authMiddleware, requireAdmin, (req, res) => {
    const { brand, flavor, weight, quantity, tags } = req.body;
    if (!brand || !flavor || !weight || !quantity || quantity <= 0) return res.status(400).json({ error: 'Заполните все поля корректно' });
    
    const id = `${brand}::${flavor}::${weight}`;
    const tagsStr = tags ? tags.join(',') : '';
    
    // Создаём теги если их нет
    if (tags && tags.length > 0) getOrCreateTags(tags);

    try {
        const existing = runQuery('SELECT * FROM inventory WHERE id = ?', [id]);
        if (existing.length > 0) {
            db.run('UPDATE inventory SET packs = packs + ?, tags = ?, updated_at = datetime("now") WHERE id = ?', [quantity, tagsStr, id]);
        } else {
            db.run('INSERT INTO inventory (id, brand, flavor, weight, packs, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))', [id, brand, flavor, weight, quantity, tagsStr]);
        }
        const message = `📥 ЗАКУП: ${brand} "${flavor}" ${weight}г (+${quantity} уп.)`;
        db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))', ['BUY', brand, flavor, weight, quantity, message]);
        saveDatabase();
        const updatedItem = runQuery('SELECT * FROM inventory WHERE id = ?', [id])[0];
        updatedItem.tagsArray = updatedItem.tags ? updatedItem.tags.split(',').filter(t => t) : [];
        res.json({ success: true, item: updatedItem, message: 'Закуп выполнен!' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/spend', authMiddleware, requireAdmin, (req, res) => {
    const { brand, flavor, weight, quantity } = req.body;
    if (!brand || !flavor || !weight || !quantity || quantity <= 0) return res.status(400).json({ error: 'Заполните все поля корректно' });
    const id = `${brand}::${flavor}::${weight}`;
    try {
        const existing = runQuery('SELECT * FROM inventory WHERE id = ?', [id]);
        if (existing.length === 0 || existing[0].packs < quantity) return res.status(400).json({ error: `Недостаточно! В наличии: ${existing.length > 0 ? existing[0].packs : 0} уп.` });
        db.run('UPDATE inventory SET packs = packs - ?, updated_at = datetime("now") WHERE id = ?', [quantity, id]);
        const message = `📤 РАСХОД: ${brand} "${flavor}" ${weight}г (-${quantity} уп.)`;
        db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))', ['SPEND', brand, flavor, weight, -quantity, message]);
        saveDatabase();
        const updatedItem = runQuery('SELECT * FROM inventory WHERE id = ?', [id])[0];
        updatedItem.tagsArray = updatedItem.tags ? updatedItem.tags.split(',').filter(t => t) : [];
        res.json({ success: true, item: updatedItem, message: 'Расход записан!' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/clear-position', authMiddleware, requireAdmin, (req, res) => {
    const { brand, flavor, weight } = req.body;
    if (!brand || !flavor) return res.status(400).json({ error: 'Укажите бренд и вкус' });
    try {
        let items = weight ? runQuery('SELECT * FROM inventory WHERE brand = ? AND flavor = ? AND weight = ?', [brand, flavor, weight]) : runQuery('SELECT * FROM inventory WHERE brand = ? AND flavor = ?', [brand, flavor]);
        if (items.length === 0) return res.status(400).json({ error: 'Позиция не найдена' });
        let totalCleared = 0;
        items.forEach(item => {
            if (item.packs > 0) {
                totalCleared += item.packs;
                db.run('UPDATE inventory SET packs = 0, updated_at = datetime("now") WHERE id = ?', [item.id]);
                db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))', ['CLEAR', item.brand, item.flavor, item.weight, -item.packs, `🗑️ ВЫБИТО: ${item.brand} "${item.flavor}" ${item.weight}г (-${item.packs} уп.)`]);
            }
        });
        saveDatabase();
        res.json({ success: true, message: `Выбито: ${brand} "${flavor}" - ${totalCleared} уп.`, totalCleared: totalCleared });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/statistics', authMiddleware, (req, res) => {
    try {
        const topSpent = runQuery(`SELECT brand, flavor, SUM(ABS(quantity)) as total_spent FROM logs WHERE type = 'SPEND' GROUP BY brand, flavor ORDER BY total_spent DESC LIMIT 10`);
        const stats = runQuery(`SELECT COUNT(DISTINCT brand) as total_brands, COUNT(DISTINCT flavor) as total_flavors, SUM(CASE WHEN packs > 0 THEN 1 ELSE 0 END) as in_stock_items, SUM(CASE WHEN packs = 0 THEN 1 ELSE 0 END) as out_of_stock_items, COALESCE(SUM(packs * weight), 0) as total_grams_in_stock FROM inventory`)[0] || { total_brands: 0, total_flavors: 0, in_stock_items: 0, out_of_stock_items: 0, total_grams_in_stock: 0 };
        res.json({ topSpent, stats });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/statistics/brands', authMiddleware, (req, res) => {
    try { res.json(runQuery(`SELECT brand, COUNT(DISTINCT flavor) as total_flavors, SUM(packs) as total_packs, SUM(packs * weight) as total_grams, SUM(CASE WHEN packs > 0 THEN 1 ELSE 0 END) as in_stock, SUM(CASE WHEN packs = 0 THEN 1 ELSE 0 END) as out_of_stock FROM inventory GROUP BY brand ORDER BY brand`)); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/statistics/flavors', authMiddleware, (req, res) => {
    try {
        const flavors = runQuery(`SELECT brand, flavor, SUM(packs) as total_packs, SUM(packs * weight) as total_grams, GROUP_CONCAT(DISTINCT weight) as weights, tags FROM inventory GROUP BY brand, flavor ORDER BY brand, flavor`);
        flavors.forEach(f => { f.tagsArray = f.tags ? f.tags.split(',').filter(t => t) : []; });
        res.json(flavors);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/statistics/in-stock', authMiddleware, (req, res) => {
    try { const items = runQuery(`SELECT * FROM inventory WHERE packs > 0 ORDER BY brand, flavor, weight`); items.forEach(i => { i.tagsArray = i.tags ? i.tags.split(',').filter(t => t) : []; }); res.json(items); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/statistics/out-of-stock', authMiddleware, (req, res) => {
    try { const items = runQuery(`SELECT * FROM inventory WHERE packs = 0 ORDER BY brand, flavor, weight`); items.forEach(i => { i.tagsArray = i.tags ? i.tags.split(',').filter(t => t) : []; }); res.json(items); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/statistics/weights', authMiddleware, (req, res) => {
    try { res.json(runQuery(`SELECT weight, COUNT(*) as total_items, SUM(packs) as total_packs, SUM(packs * weight) as total_grams, SUM(CASE WHEN packs > 0 THEN 1 ELSE 0 END) as in_stock FROM inventory GROUP BY weight ORDER BY weight`)); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/export/excel', authMiddleware, (req, res) => {
    try {
        const inventory = runQuery('SELECT * FROM inventory ORDER BY brand, flavor, weight');
        const logs = runQuery('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 500');
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(inventory.map(i => ({ 'Бренд': i.brand, 'Вкус': i.flavor, 'Граммовка': i.weight, 'Упаковок': i.packs, 'Всего грамм': i.packs * i.weight, 'Теги': i.tags || '', 'Статус': i.packs > 0 ? 'В наличии' : 'Выбыл' }))), 'Склад');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(logs.map(l => ({ 'Дата': l.timestamp, 'Тип': l.type === 'BUY' ? 'Закуп' : (l.type === 'SPEND' ? 'Расход' : 'Выбито'), 'Бренд': l.brand, 'Вкус': l.flavor, 'Граммовка': l.weight, 'Количество': Math.abs(l.quantity), 'Описание': l.message }))), 'История');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=hookah-stock-${new Date().toISOString().split('T')[0]}.xlsx`);
        res.send(buffer);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/logs', authMiddleware, (req, res) => {
    try { res.json(runQuery('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?', [parseInt(req.query.limit) || 100])); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/health', (req, res) => { res.json({ status: 'ok', timestamp: new Date().toISOString(), database: 'connected' }); });

async function startServer() { await initDatabase(); app.listen(PORT, () => { console.log(`🚀 Сервер запущен на порту ${PORT}`); }); }
startServer();
