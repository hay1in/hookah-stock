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
    
    if (!authHeader) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    const base64Credentials = authHeader.split(' ')[1];
    if (!base64Credentials) {
        return res.status(401).json({ error: 'Неверный формат авторизации' });
    }
    
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');
    
    if (!USERS[username] || USERS[username].password !== password) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    req.user = { username: username, role: USERS[username].role };
    next();
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав. Только для администратора.' });
    }
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
        console.log('✅ Создана новая база данных (после ошибки)');
    }
    
    db.run(`
        CREATE TABLE IF NOT EXISTS inventory (
            id TEXT PRIMARY KEY,
            brand TEXT NOT NULL,
            flavor TEXT NOT NULL,
            weight INTEGER NOT NULL,
            packs INTEGER DEFAULT 0,
            tags TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            type TEXT NOT NULL,
            brand TEXT NOT NULL,
            flavor TEXT NOT NULL,
            weight INTEGER,
            quantity INTEGER,
            message TEXT
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            color TEXT DEFAULT '#BB86FC'
        )
    `);
    
    // Предустановленные теги
    const defaultTags = [
        ['Малина', '#FF5252'],
        ['Черника', '#448AFF'],
        ['Грейпфрут', '#FF9100'],
        ['Лимон', '#FFEB3B'],
        ['Мята', '#00E676'],
        ['Арбуз', '#FF4081'],
        ['Дыня', '#FFC107'],
        ['Клубника', '#E91E63'],
        ['Виноград', '#9C27B0'],
        ['Апельсин', '#FF9800'],
        ['Манго', '#FFAB40'],
        ['Кокос', '#8D6E63'],
        ['Ваниль', '#FFE0B2'],
        ['Шоколад', '#795548'],
        ['Карамель', '#FF8A65'],
        ['Кофе', '#6D4C41'],
        ['Лайм', '#CDDC39'],
        ['Персик', '#FFCCBC'],
        ['Яблоко', '#4CAF50'],
        ['Груша', '#C0CA33'],
        ['Вишня', '#D32F2F'],
        ['Банан', '#FDD835'],
        ['Киви', '#AED581'],
        ['Маракуйя', '#F9A825'],
        ['Ананас', '#FBC02D']
    ];
    
    const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)');
    defaultTags.forEach(tag => {
        insertTag.run(tag);
    });
    
    console.log('✅ Таблицы готовы');
    saveDatabase();
}

function saveDatabase() {
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(path.join(__dirname, 'hookah.db'), buffer);
    } catch (error) {
        console.error('❌ Ошибка сохранения:', error);
    }
}

function runQuery(sql, params = []) {
    try {
        const results = db.exec(sql, params);
        if (results.length === 0) {
            return [];
        }
        
        const columns = results[0].columns;
        const values = results[0].values;
        
        return values.map(row => {
            const obj = {};
            columns.forEach((col, index) => {
                obj[col] = row[index];
            });
            return obj;
        });
    } catch (error) {
        console.error('SQL Error:', error);
        throw error;
    }
}

// ============== API РОУТЫ ==============

// 🔑 ЛОГИН
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Введите логин и пароль' });
    }
    
    if (!USERS[username] || USERS[username].password !== password) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const token = Buffer.from(username + ':' + password).toString('base64');
    
    res.json({ 
        success: true, 
        token: token,
        role: USERS[username].role,
        username: username
    });
});

// 🏷️ ПОЛУЧИТЬ ВСЕ ТЕГИ
app.get('/api/tags', authMiddleware, (req, res) => {
    try {
        const tags = runQuery('SELECT * FROM tags ORDER BY name');
        res.json(tags);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🏷️ ДОБАВИТЬ ТЕГ (админ)
app.post('/api/tags', authMiddleware, requireAdmin, (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Укажите название тега' });
    
    try {
        db.run('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)', [name, color || '#BB86FC']);
        saveDatabase();
        const tag = runQuery('SELECT * FROM tags WHERE name = ?', [name])[0];
        res.json({ success: true, tag: tag });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔵 СКЛАД
app.get('/api/inventory', authMiddleware, (req, res) => {
    try {
        const items = runQuery('SELECT * FROM inventory ORDER BY brand, flavor');
        // Парсим теги для каждого item
        items.forEach(item => {
            item.tagsArray = item.tags ? item.tags.split(',').filter(t => t) : [];
        });
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔵 БРЕНДЫ
app.get('/api/brands', authMiddleware, (req, res) => {
    try {
        const brands = runQuery('SELECT DISTINCT brand FROM inventory ORDER BY brand');
        res.json(brands.map(b => b.brand));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔵 ВКУСЫ БРЕНДА
app.get('/api/flavors/:brand', authMiddleware, (req, res) => {
    try {
        const brand = decodeURIComponent(req.params.brand);
        const flavors = runQuery('SELECT DISTINCT flavor FROM inventory WHERE brand = ? ORDER BY flavor', [brand]);
        res.json(flavors.map(f => f.flavor));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔵 ГРАММОВКИ
app.get('/api/weights/:brand/:flavor', authMiddleware, (req, res) => {
    try {
        const brand = decodeURIComponent(req.params.brand);
        const flavor = decodeURIComponent(req.params.flavor);
        const weights = runQuery('SELECT DISTINCT weight FROM inventory WHERE brand = ? AND flavor = ? ORDER BY weight', [brand, flavor]);
        res.json(weights.map(w => w.weight));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🟢 ЗАКУП
app.post('/api/buy', authMiddleware, requireAdmin, (req, res) => {
    const { brand, flavor, weight, quantity, tags } = req.body;
    
    if (!brand || !flavor || !weight || !quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Заполните все поля корректно' });
    }

    const id = `${brand}::${flavor}::${weight}`;
    const tagsStr = tags ? tags.join(',') : '';

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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔴 РАСХОД
app.post('/api/spend', authMiddleware, requireAdmin, (req, res) => {
    const { brand, flavor, weight, quantity } = req.body;
    
    if (!brand || !flavor || !weight || !quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Заполните все поля корректно' });
    }

    const id = `${brand}::${flavor}::${weight}`;

    try {
        const existing = runQuery('SELECT * FROM inventory WHERE id = ?', [id]);
        
        if (existing.length === 0 || existing[0].packs < quantity) {
            return res.status(400).json({ 
                error: `Недостаточно! В наличии: ${existing.length > 0 ? existing[0].packs : 0} уп.` 
            });
        }

        db.run('UPDATE inventory SET packs = packs - ?, updated_at = datetime("now") WHERE id = ?', [quantity, id]);

        const message = `📤 РАСХОД: ${brand} "${flavor}" ${weight}г (-${quantity} уп.)`;
        db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))', ['SPEND', brand, flavor, weight, -quantity, message]);

        saveDatabase();
        
        const updatedItem = runQuery('SELECT * FROM inventory WHERE id = ?', [id])[0];
        updatedItem.tagsArray = updatedItem.tags ? updatedItem.tags.split(',').filter(t => t) : [];
        res.json({ success: true, item: updatedItem, message: 'Расход записан!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🗑️ ВЫБИТЬ ПОЗИЦИЮ
app.post('/api/clear-position', authMiddleware, requireAdmin, (req, res) => {
    const { brand, flavor, weight } = req.body;
    
    if (!brand || !flavor) {
        return res.status(400).json({ error: 'Укажите бренд и вкус' });
    }

    try {
        let items;
        let totalCleared = 0;
        
        if (weight) {
            items = runQuery('SELECT * FROM inventory WHERE brand = ? AND flavor = ? AND weight = ?', [brand, flavor, weight]);
        } else {
            items = runQuery('SELECT * FROM inventory WHERE brand = ? AND flavor = ?', [brand, flavor]);
        }
        
        if (items.length === 0) {
            return res.status(400).json({ error: 'Позиция не найдена' });
        }
        
        items.forEach(item => {
            if (item.packs > 0) {
                const cleared = item.packs;
                db.run('UPDATE inventory SET packs = 0, updated_at = datetime("now") WHERE id = ?', [item.id]);
                
                const message = `🗑️ ВЫБИТО: ${item.brand} "${item.flavor}" ${item.weight}г (списано ${cleared} уп.)`;
                db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))', ['CLEAR', item.brand, item.flavor, item.weight, -cleared, message]);
                
                totalCleared += cleared;
            }
        });
        
        saveDatabase();
        
        res.json({ 
            success: true, 
            message: `Выбито с полки: ${brand} "${flavor}" - ${totalCleared} уп.`,
            totalCleared: totalCleared
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🗑️ ВЫБИТЬ БРЕНД
app.post('/api/clear-brand', authMiddleware, requireAdmin, (req, res) => {
    const { brand } = req.body;
    
    if (!brand) {
        return res.status(400).json({ error: 'Укажите бренд' });
    }

    try {
        const items = runQuery('SELECT * FROM inventory WHERE brand = ? AND packs > 0', [brand]);
        
        if (items.length === 0) {
            return res.status(400).json({ error: 'Нет активных позиций этого бренда' });
        }
        
        let totalCleared = 0;
        
        items.forEach(item => {
            const cleared = item.packs;
            db.run('UPDATE inventory SET packs = 0, updated_at = datetime("now") WHERE id = ?', [item.id]);
            
            const message = `🗑️ ВЫБИТ БРЕНД: ${item.brand} "${item.flavor}" ${item.weight}г (списано ${cleared} уп.)`;
            db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))', ['CLEAR_BRAND', item.brand, item.flavor, item.weight, -cleared, message]);
            
            totalCleared += cleared;
        });
        
        saveDatabase();
        
        res.json({ 
            success: true, 
            message: `Бренд ${brand} полностью выбит! Списано ${totalCleared} уп.`,
            totalCleared: totalCleared
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📊 СТАТИСТИКА
app.get('/api/statistics', authMiddleware, (req, res) => {
    try {
        const topSpent = runQuery(`
            SELECT brand, flavor, SUM(ABS(quantity)) as total_spent
            FROM logs 
            WHERE type = 'SPEND'
            GROUP BY brand, flavor
            ORDER BY total_spent DESC
            LIMIT 10
        `);

        const stats = runQuery(`
            SELECT 
                COUNT(DISTINCT brand) as total_brands,
                COUNT(DISTINCT flavor) as total_flavors,
                SUM(CASE WHEN packs > 0 THEN 1 ELSE 0 END) as in_stock_items,
                SUM(CASE WHEN packs = 0 THEN 1 ELSE 0 END) as out_of_stock_items,
                COALESCE(SUM(packs * weight), 0) as total_grams_in_stock
            FROM inventory
        `)[0] || { total_brands: 0, total_flavors: 0, in_stock_items: 0, out_of_stock_items: 0, total_grams_in_stock: 0 };

        res.json({ topSpent, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/statistics/brands', authMiddleware, (req, res) => {
    try {
        const brands = runQuery(`
            SELECT 
                brand,
                COUNT(DISTINCT flavor) as total_flavors,
                SUM(packs) as total_packs,
                SUM(packs * weight) as total_grams,
                SUM(CASE WHEN packs > 0 THEN 1 ELSE 0 END) as in_stock,
                SUM(CASE WHEN packs = 0 THEN 1 ELSE 0 END) as out_of_stock
            FROM inventory
            GROUP BY brand
            ORDER BY brand
        `);
        res.json(brands);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/statistics/flavors', authMiddleware, (req, res) => {
    try {
        const flavors = runQuery(`
            SELECT 
                brand,
                flavor,
                SUM(packs) as total_packs,
                SUM(packs * weight) as total_grams,
                GROUP_CONCAT(DISTINCT weight) as weights,
                tags
            FROM inventory
            GROUP BY brand, flavor
            ORDER BY brand, flavor
        `);
        flavors.forEach(f => {
            f.tagsArray = f.tags ? f.tags.split(',').filter(t => t) : [];
        });
        res.json(flavors);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/statistics/in-stock', authMiddleware, (req, res) => {
    try {
        const items = runQuery(`SELECT * FROM inventory WHERE packs > 0 ORDER BY brand, flavor, weight`);
        items.forEach(item => {
            item.tagsArray = item.tags ? item.tags.split(',').filter(t => t) : [];
        });
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/statistics/out-of-stock', authMiddleware, (req, res) => {
    try {
        const items = runQuery(`SELECT * FROM inventory WHERE packs = 0 ORDER BY brand, flavor, weight`);
        items.forEach(item => {
            item.tagsArray = item.tags ? item.tags.split(',').filter(t => t) : [];
        });
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/statistics/weights', authMiddleware, (req, res) => {
    try {
        const weights = runQuery(`
            SELECT 
                weight,
                COUNT(*) as total_items,
                SUM(packs) as total_packs,
                SUM(packs * weight) as total_grams,
                SUM(CASE WHEN packs > 0 THEN 1 ELSE 0 END) as in_stock
            FROM inventory
            GROUP BY weight
            ORDER BY weight
        `);
        res.json(weights);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📥 EXCEL
app.get('/api/export/excel', authMiddleware, (req, res) => {
    try {
        const inventory = runQuery('SELECT * FROM inventory ORDER BY brand, flavor, weight');
        const logs = runQuery('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 500');
        
        const workbook = XLSX.utils.book_new();
        
        const inventoryData = inventory.map(item => ({
            'Бренд': item.brand,
            'Вкус': item.flavor,
            'Граммовка (г)': item.weight,
            'Упаковок': item.packs,
            'Всего грамм': item.packs * item.weight,
            'Теги': item.tags || '',
            'Статус': item.packs > 0 ? 'В наличии' : 'Выбыл'
        }));
        
        const ws1 = XLSX.utils.json_to_sheet(inventoryData);
        XLSX.utils.book_append_sheet(workbook, ws1, 'Склад');
        
        const logsData = logs.map(log => ({
            'Дата': log.timestamp,
            'Тип': log.type === 'BUY' ? 'Закуп' : (log.type === 'SPEND' ? 'Расход' : 'Выбито'),
            'Бренд': log.brand,
            'Вкус': log.flavor,
            'Граммовка': log.weight,
            'Количество': Math.abs(log.quantity),
            'Описание': log.message
        }));
        
        const ws2 = XLSX.utils.json_to_sheet(logsData);
        XLSX.utils.book_append_sheet(workbook, ws2, 'История');
        
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=hookah-stock-${new Date().toISOString().split('T')[0]}.xlsx`);
        res.send(buffer);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📜 ИСТОРИЯ
app.get('/api/logs', authMiddleware, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = runQuery('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?', [limit]);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ❤️ ПРОВЕРКА
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        database: 'connected'
    });
});

// 🚀 ЗАПУСК
async function startServer() {
    await initDatabase();
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущен на порту ${PORT}`);
    });
}

startServer();
