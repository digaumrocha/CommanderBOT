-- Table for Marketplace Items
CREATE TABLE IF NOT EXISTS marketplace (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    descricao TEXT NOT NULL,
    preco INTEGER NOT NULL,
    quantidade INTEGER DEFAULT -1, -- -1 = infinite stock
    role_id TEXT, -- Role to be given upon purchase (optional)
    UNIQUE(nome)
);

-- Table for Purchase History
CREATE TABLE IF NOT EXISTS purchase_history (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT,
    item_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    date TEXT,
    time TEXT
);

-- Table for User Inventory
CREATE TABLE IF NOT EXISTS inventory (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    purchase_timestamp BIGINT NOT NULL,
    UNIQUE(user_id, item_id)
);

-- Table for Market State (e.g., log channel IDs)
CREATE TABLE IF NOT EXISTS market_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
