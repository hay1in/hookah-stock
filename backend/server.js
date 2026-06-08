const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// Настройка безопасности
app.use(cors());
app.use(express.json());

// Подключаем SQL.js
const initSqlJs = require('sql.js');
let db;

// Инициализация базы данных
async function initDatabase() {
    const SQL = await initSqlJs();
    
    // Пытаемся загрузить существующую базу или создаём новую
    const dbPath = path.join(__dirname, 'hookah.db');
    
    try {
        if (fs.existsSync(dbPath)) {
            const fileBuffer = fs.readFileSync(dbPath);
            db = new SQL.Database(fileBuffer);
            console.log('✅ База данных загружена с диска');
        } else {
            db = new SQL.Database();
            console.log('✅ Создана новая база данных');
        }
    } catch (error) {
        console.log('⚠️ Ошибка загрузки, создаю новую базу:', error.message);
        db = new SQL.Database();
    }
    
    // Создаём таблицы
    db.run(`
        CREATE TABLE IF NOT EXISTS inventory (
            id TEXT PRIMARY KEY,
            brand TEXT NOT NULL,
            flavor TEXT NOT NULL,
            weight INTEGER NOT NULL,
            packs INTEGER DEFAULT 0,
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
    
    console.log('✅ Таблицы готовы');
    saveDatabase();
}

// Сохранение базы на диск
function saveDatabase() {
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(path.join(__dirname, 'hookah.db'), buffer);
    } catch (error) {
        console.error('❌ Ошибка сохранения базы:', error);
    }
}

// Вспомогательные функции для конвертации результатов
function rowToObject(row) {
    if (!row || !row.columns || !row.values) {
        return {};
    }
    const obj = {};
    for (let i = 0; i < row.columns.length; i++) {
        obj[row.columns[i]] = row.values[i];
    }
    return obj;
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

// 🔵 Получить всё содержимое склада
app.get('/api/inventory', (req, res) => {
    try {
        const items = runQuery('SELECT * FROM inventory ORDER BY brand, flavor');
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔵 Получить список брендов
app.get('/api/brands', (req, res) => {
    try {
        const brands = runQuery('SELECT DISTINCT brand FROM inventory ORDER BY brand');
        res.json(brands.map(b => b.brand));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔵 Получить вкусы бренда
app.get('/api/flavors/:brand', (req, res) => {
    try {
        const brand = decodeURIComponent(req.params.brand);
        const flavors = runQuery(
            'SELECT DISTINCT flavor FROM inventory WHERE brand = ? ORDER BY flavor',
            [brand]
        );
        res.json(flavors.map(f => f.flavor));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔵 Получить граммовки для бренда+вкуса
app.get('/api/weights/:brand/:flavor', (req, res) => {
    try {
        const brand = decodeURIComponent(req.params.brand);
        const flavor = decodeURIComponent(req.params.flavor);
        const weights = runQuery(
            'SELECT DISTINCT weight FROM inventory WHERE brand = ? AND flavor = ? ORDER BY weight',
            [brand, flavor]
        );
        res.json(weights.map(w => w.weight));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🟢 ЗАКУП
app.post('/api/buy', (req, res) => {
    const { brand, flavor, weight, quantity } = req.body;
    
    if (!brand || !flavor || !weight || !quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Заполните все поля корректно' });
    }

    const id = `${brand}::${flavor}::${weight}`;

    try {
        // Проверяем существование записи
        const existing = runQuery('SELECT * FROM inventory WHERE id = ?', [id]);
        
        if (existing.length > 0) {
            db.run('UPDATE inventory SET packs = packs + ?, updated_at = datetime("now") WHERE id = ?', 
                   [quantity, id]);
        } else {
            db.run('INSERT INTO inventory (id, brand, flavor, weight, packs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime("now"), datetime("now"))',
                   [id, brand, flavor, weight, quantity]);
        }

        // Добавляем в логи
        const message = `📥 ЗАКУП: ${brand} "${flavor}" ${weight}г (+${quantity} уп.)`;
        db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))',
               ['BUY', brand, flavor, weight, quantity, message]);

        saveDatabase();
        
        const updatedItem = runQuery('SELECT * FROM inventory WHERE id = ?', [id])[0];
        res.json({ success: true, item: updatedItem, message: 'Закуп выполнен!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔴 РАСХОД
app.post('/api/spend', (req, res) => {
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

        db.run('UPDATE inventory SET packs = packs - ?, updated_at = datetime("now") WHERE id = ?',
               [quantity, id]);

        const message = `📤 РАСХОД: ${brand} "${flavor}" ${weight}г (-${quantity} уп.)`;
        db.run('INSERT INTO logs (type, brand, flavor, weight, quantity, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))',
               ['SPEND', brand, flavor, weight, -quantity, message]);

        saveDatabase();
        
        const updatedItem = runQuery('SELECT * FROM inventory WHERE id = ?', [id])[0];
        res.json({ success: true, item: updatedItem, message: 'Расход записан!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📊 СТАТИСТИКА
app.get('/api/statistics', (req, res) => {
    try {
        // Топ-10 самых расходуемых вкусов
        const topSpent = runQuery(`
            SELECT brand, flavor, SUM(ABS(quantity)) as total_spent
            FROM logs 
            WHERE type = 'SPEND'
            GROUP BY brand, flavor
            ORDER BY total_spent DESC
            LIMIT 10
        `);

        // Общая статистика
        const stats = runQuery(`
            SELECT 
                COUNT(DISTINCT brand) as total_brands,
                COUNT(DISTINCT flavor) as total_flavors,
                SUM(CASE WHEN packs > 0 THEN 1 ELSE 0 END) as in_stock_items,
                SUM(CASE WHEN packs = 0 THEN 1 ELSE 0 END) as out_of_stock_items,
                COALESCE(SUM(packs * weight), 0) as total_grams_in_stock
            FROM inventory
        `)[0] || { total_brands: 0, total_flavors: 0, in_stock_items: 0, out_of_stock_items: 0, total_grams_in_stock: 0 };

        // Расход по месяцам
        const monthlyStats = runQuery(`
            SELECT 
                strftime('%Y-%m', timestamp) as month,
                COUNT(*) as operations,
                SUM(CASE WHEN type='BUY' THEN quantity ELSE 0 END) as total_bought,
                SUM(CASE WHEN type='SPEND' THEN ABS(quantity) ELSE 0 END) as total_spent
            FROM logs
            GROUP BY month
            ORDER BY month DESC
            LIMIT 12
        `);

        res.json({
            topSpent,
            stats,
            monthlyStats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📥 ЭКСПОРТ В EXCEL
app.get('/api/export/excel', (req, res) => {
    try {
        const inventory = runQuery('SELECT * FROM inventory ORDER BY brand, flavor, weight');
        const logs = runQuery('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 500');
        
        const workbook = XLSX.utils.book_new();
        
        // Лист 1: Склад
        const inventoryData = inventory.map(item => ({
            'Бренд': item.brand,
            'Вкус': item.flavor,
            'Граммовка (г)': item.weight,
            'Упаковок': item.packs,
            'Всего грамм': item.packs * item.weight,
            'Статус': item.packs > 0 ? 'В наличии' : 'Выбыл',
            'Последнее обновление': item.updated_at
        }));
        
        const ws1 = XLSX.utils.json_to_sheet(inventoryData);
        XLSX.utils.book_append_sheet(workbook, ws1, 'Склад');
        
        // Лист 2: История операций
        const logsData = logs.map(log => ({
            'Дата': log.timestamp,
            'Тип': log.type === 'BUY' ? 'Закуп' : 'Расход',
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

// 📜 История операций
app.get('/api/logs', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = runQuery('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?', [limit]);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ❤️ Проверка работы сервера
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        database: 'connected'
    });
});

// Запуск сервера
async function startServer() {
    await initDatabase();
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущен на порту ${PORT}`);
        console.log(`📍 Локальный адрес: http://localhost:${PORT}`);
        console.log(`📊 Проверка: http://localhost:${PORT}/api/health`);
    });
}

startServer();