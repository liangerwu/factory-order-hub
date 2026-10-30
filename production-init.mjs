import fs from 'node:fs';
import path from 'node:path';
export function initializeProduction(db,root){
 if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='must_change_password'))db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
 db.exec('CREATE TABLE IF NOT EXISTS installation_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 if(db.prepare("SELECT 1 FROM installation_meta WHERE key='admin-bootstrap-v1'").get())return;
 // Never turn an existing database into a new installation implicitly.
 if(db.prepare('SELECT count(*) n FROM users').get().n||db.prepare('SELECT count(*) n FROM orders').get().n)throw Error('初始化已停止：数据库已有账号或订单。请使用空数据库安装，已有数据请先备份并单独迁移。');
 const admins=JSON.parse(fs.readFileSync(path.join(root,'deploy/initial-admins.json'),'utf8'));
 const catalog=path.join(root,'deploy/products.json');
 const products=fs.existsSync(catalog)?JSON.parse(fs.readFileSync(catalog,'utf8')):[];
 if(admins.length!==3||admins.some(a=>!/^1[3-9]\d{9}$/.test(a.phone)||!/^\w{32}:[a-f0-9]{128}$/.test(a.hash)))throw Error('管理员初始化资料不完整');
 db.exec('BEGIN IMMEDIATE');
 try{
  for(const a of admins)db.prepare('INSERT INTO users(username,name,role,password_hash,active,phone,must_change_password) VALUES(?,?,?,?,1,?,1)').run(a.phone,a.name,'超级管理员',a.hash,a.phone);
  for(const p of products)db.prepare('INSERT OR IGNORE INTO products(code,name,specification,unit,category,created_at) VALUES(?,?,?,?,?,?)').run(p.code,p.name,p.specification,p.unit,p.category,p.created_at);
  db.prepare('INSERT INTO installation_meta VALUES(?,?)').run('admin-bootstrap-v1',new Date().toISOString());db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
