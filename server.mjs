import {initializeProduction} from './production-init.mjs';
import {detectedImageMime} from './image-validation.mjs';
import {recognizeShipping} from './shipping-ocr.mjs';
import {workNotifications} from './work-notifications.mjs';
import http from 'node:http';
import {businessDate, moneyCents} from './order-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { activeTasks, ready, shippingChecks, customDisplayOrder, requiresAdminApproval, isCustomWorkflow, applyProcurementMode, procurementModeLocked, removePackagingSteps } from './workflow.mjs';
import { searchProducts } from './product-search.mjs';
import { filterOrders, validOrderDate } from './order-list.mjs';
import { exportOrders } from './order-export.mjs';
import { employeeAdministration, ownsOrder } from './employees.mjs';
import { finalPaymentAmount, calculateOrderPricing } from './order-amounts.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = process.env.ORDER_HUB_DB || path.join(dataDir, 'order-hub.sqlite');
const db = new DatabaseSync(dbFile);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(code TEXT PRIMARY KEY, name TEXT NOT NULL, specification TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '件', category TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_accounts(name TEXT PRIMARY KEY, source_order INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS order_images(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), mime TEXT NOT NULL, bytes BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS order_notifications(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), revision INTEGER NOT NULL, actor TEXT NOT NULL, changed_fields TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id,revision));
CREATE TABLE IF NOT EXISTS notification_reads(notification_id TEXT NOT NULL REFERENCES order_notifications(id), user_id INTEGER NOT NULL REFERENCES users(id), read_at TEXT NOT NULL, PRIMARY KEY(notification_id,user_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, actor TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);`);

const roles = ['超级管理员', '业务员', '财务', '美工', '采购', '仓库', '生产车间'];
if (!db.prepare('PRAGMA table_info(products)').all().some(column => column.name === 'category')) db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT ''");
const workflowLabels = { custom: '定制客户', regular: '常规订单', urgent: '加急订单', foreign: '外贸订单' };
const workflowDefinitions = {
  custom: [
    ['业务接单——根据客户需求个性化定制（给客户核价并且报价）', '业务员'],
    ['财务确认收款', '财务'],
    ['产品包装设计', '美工'],
    ['财务确认工单付款', '财务'],
    ['仓库确认收到所有的生产包装', '仓库'],
    ['车间投入生产前再次向业务确认产品细节确认生产', '生产车间'],
    ['生产完成回传业务向客服索要支付尾款（确认发货时间及方式：物流或者自提）', '业务员'],
    ['财务审核尾款', '财务'],
    ['仓库根据订单明细确认出货', '仓库'],
    ['业务跟进及售后', '业务员'],
    ['订单存档', '业务员']
  ],
  regular: [
    ['业务接单', '业务员'], ['财务审核', '财务'], ['生产车间', '生产车间'], ['仓库发货', '仓库'], ['业务跟踪售后', '业务员']
  ],
  urgent: [
    ['业务接单', '业务员'], ['财务审核', '财务'], ['仓库发货', '仓库']
  ]
};
workflowDefinitions.foreign = workflowDefinitions.custom;
const isoDate = (offset = 0) => businessDate(new Date(), offset);
const now = () => new Date().toISOString();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected?.length === actual.length * 2 && crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

db.prepare("UPDATE users SET role='超级管理员' WHERE username='boss' AND role IN ('负责人','管理员')").run();
db.prepare("UPDATE users SET role='业务员' WHERE username='sales' AND role='销售'").run();
db.prepare("UPDATE users SET role='生产车间' WHERE role='生产'").run();
db.prepare("UPDATE users SET role='仓库' WHERE role='仓库发货'").run();
db.prepare("UPDATE users SET role='美工', name=CASE WHEN name='设计员' THEN '美工' ELSE name END WHERE role='设计'").run();
const requiredUsers = [
  ['admin', '超级管理员', '超级管理员'], ['sales_a', '业务员A', '业务员'], ['sales_b', '业务员B', '业务员'],
  ['finance', '财务员', '财务'], ['designer', '美工', '美工'], ['buyer', '采购员', '采购'],
  ['warehouse', '仓库员', '仓库'], ['production', '生产主管', '生产车间']
];
const addUser = db.prepare('INSERT OR IGNORE INTO users(username,name,role,password_hash) VALUES(?,?,?,?)');
// Production release never creates demo users.

function buildFlow(type, completedThrough = 1) {
  const tasks = workflowDefinitions[type].map(([name, ownerRole], index) => ({
    step: isCustomWorkflow(type)?customDisplayOrder[index]:index+1, name, ownerRole,
    status: index + 1 <= completedThrough ? '已完成' : index + 1 === completedThrough + 1 ? '待处理' : '未开始',
    assignee: index === 0 ? '创建人' : '', note: '', completedAt: index === 0 ? now() : ''
  }));
  return isCustomWorkflow(type) ? tasks.sort((a,b) => customDisplayOrder.indexOf(a.step) - customDisplayOrder.indexOf(b.step)) : tasks;
}
function syncOrderStatus(order) {
  const current = activeTasks(order);
  if (order.flowTasks.every(task => task.status === '已完成')) { order.status = '已完成'; order.completedAt ||= now(); return; }
  order.status = current.map(task => task.status === '待管理员审批' ? `${task.name}待审批` : `${task.name}处理中`).join('＋') || '等待前置任务完成';
}
function advanceFlow(order) {
  order.flowTasks.forEach(task => {
    if (task.status === '已完成' || task.status === '待管理员审批') return;
    task.status = ready(order, task) ? '待处理' : '未开始';
  });
  syncOrderStatus(order);
}

const fallbackSales = db.prepare("SELECT id,username,name FROM users WHERE username='sales_a'").get();
for (const row of db.prepare('SELECT id,data FROM orders').all()) {
  const order = JSON.parse(row.data);
  if (!order.workflowType) order.workflowType = order.type === 'A' ? 'regular' : 'custom';
  order.workflowLabel = workflowLabels[order.workflowType];
  order.creatorUserId ||= fallbackSales?.id;
  order.creatorUsername ||= fallbackSales?.username;
  order.creatorName ||= fallbackSales?.name;
  order.orderDate ||= order.created || isoDate();
  order.storeName ||= order.customer || '';
  order.recipient ||= '';
  order.codAmount = Number(order.codAmount || 0);
  order.logistics ||= '';
  order.paymentAccount ||= '';
  order.freight = Number(order.freight || 0);
  order.cost = Number(order.cost || 0);
  order.grossProfit = Number(order.grossProfit ?? (Number(order.amount || 0) - order.cost - order.freight));
  order.received = Number(order.received || 0);
  order.receipts ||= [];
  order.outgoingPayments ||= [];
  if (order.depositAmount === undefined) order.depositAmount = isCustomWorkflow(order) ? Math.round(Number(order.amount || 0) * 30) / 100 : Number(order.amount || 0);
  if (!Array.isArray(order.flowTasks)) {
    let completedThrough = 1;
    if (order.received > 0 || order.financeStatus === '已核对') completedThrough = 2;
    order.flowTasks = buildFlow(order.workflowType, completedThrough);
  }
  for (const task of [...(order.flowTasks || []), ...(order.tasks || [])]) {
    if (task.ownerRole === '设计') task.ownerRole = '美工';
    if (task.assignee === '设计员') task.assignee = '美工';
  }
  order.paymentRequests ||= [];
  order.materialReceipts ||= [];
  order.noFee ||= {};
  if (isCustomWorkflow(order) && order.flowVersion !== 4) {
    const changed=removePackagingSteps(order);
    for(const task of order.flowTasks)[task.name,task.ownerRole]=workflowDefinitions.custom[customDisplayOrder.indexOf(task.step)];
    if(changed)db.prepare('INSERT INTO audit(order_id,actor,role,action,detail,created_at) VALUES(?,?,?,?,?,?)').run(order.id,'系统','系统','取消包材采购流程','移除原第5、6步，历史环节与付款记录保留',now());
  }
  applyProcurementMode(order);
  for (const task of order.flowTasks) {
    if (task.status !== '待管理员审批' || task.ownerRole !== '业务员' || requiresAdminApproval(order,task) || !ready(order,task)) continue;
    task.previousApprovalRequest = {by:task.approvalRequestedBy,at:task.approvalRequestedAt};
    task.status = '已完成';
    task.completedAt = task.approvalRequestedAt || now();
    task.approvalRequestedBy = ''; task.approvalRequestedAt = '';
    db.prepare('INSERT INTO audit(order_id,actor,role,action,detail,created_at) VALUES(?,?,?,?,?,?)').run(order.id,'系统','系统','业务确认流程调整',`已提交的第${task.step}步改为业务直接确认，不再经过管理员审批`,now());
  }
  advanceFlow(order);
  db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(order), order.id);
}

const sessions = new Map();
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const readJson = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > 90_000_000) { reject(new Error('请求数据过大')); req.destroy(); } });
  req.on('end', () => { try {
    const body=raw ? JSON.parse(raw) : {};
    if(new URL(req.url,'http://localhost').pathname!=='/api/login')requireUser(currentUser(req));
    resolve(body);
  } catch(error) { reject(error.status?error:new Error('请求格式错误')); } });
  req.on('error', reject);
});
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim().split('=')).filter(item => item.length === 2)); }
function currentUser(req) {
  const token = cookies(req).orderhub_session, session = sessions.get(token);
  if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  const employee=db.prepare('SELECT id,username,name,role,phone,active,auth_version,must_change_password FROM users WHERE id=?').get(session.user.id);
  if(!employee?.active||employee.auth_version!==session.authVersion){sessions.delete(token);return null;}
  return {id:employee.id,username:employee.username,name:employee.name,role:employee.role,phone:employee.phone||'',mustChangePassword:!!employee.must_change_password};
}
function requireUser(user) { if (!user) throw Object.assign(new Error('请先登录'), { status: 401 }); }
function requireRole(user, allowed) { requireUser(user); if (!allowed.includes(user.role)) throw Object.assign(new Error('当前岗位无权执行此操作'), { status: 403 }); }
function canViewOrder(user, order) { return user.role !== '业务员' || ownsOrder(user,order); }
function requireOrderAccess(user, order) { requireUser(user); if (!canViewOrder(user, order)) throw Object.assign(new Error('无权查看或操作其他业务员的订单'), { status: 403 }); }
const canSeeFinance = user => ['业务员','财务'].includes(user.role);
function orderFor(user, order) {
  const owner=db.prepare('SELECT id,username,name FROM users WHERE id=?').get(order.ownerUserId ?? order.creatorUserId);
  order={...order,ownerUserId:owner?.id ?? order.ownerUserId ?? order.creatorUserId,ownerUsername:owner?.username ?? order.ownerUsername ?? order.creatorUsername,ownerName:owner?.name ?? order.ownerName ?? order.creatorName};
  if (canSeeFinance(user)) return {...order,finalPaymentAmount:finalPaymentAmount(order)};
  const fields = ['id','sourceOrderId','workflowType','workflowLabel','businessSelfProcurement','orderDate','storeName','shopOrderNumber','customer','recipient','contact','product','qty','trackingNumber','logistics','delivery','pack','address','logisticsRequirements','notes','specialNotes','images','shippingMarkDescription','shippingMarkImages','creatorUserId','creatorUsername','creatorName','ownerUserId','ownerUsername','ownerName','handoverHistory','created','status','completedAt','flowVersion','shipment','infoRevision'];
  const visible = Object.fromEntries(fields.filter(key=>order[key] !== undefined).map(key=>[key,order[key]]));
  if(order.pricingVersion===1){visible.pricingVersion=1;visible.lineItems=(order.lineItems||[]).map(p=>Object.fromEntries(['product','color','specification','quantity','unit','code'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]])));}
  visible.productItems = (order.productItems || []).map(item=>Object.fromEntries(['code','name','specification','unit','category','quantity','casePack'].filter(key=>item[key] !== undefined).map(key=>[key,item[key]])));
  visible.flowTasks = order.flowTasks.map(task=>Object.fromEntries(['step','name','ownerRole','status','assignee','completedAt','approvalRequestedBy','approvalRequestedAt','approvedBy','approvedAt'].filter(key=>task[key] !== undefined).map(key=>[key,task[key]])));
  if (visible.shipment) visible.shipment = {date:visible.shipment.date,method:visible.shipment.method,operator:visible.shipment.operator,trackingNumber:visible.shipment.trackingNumber,logistics:visible.shipment.logistics,recipient:visible.shipment.recipient,address:visible.shipment.address,packageCount:visible.shipment.packageCount,...(user.role==='仓库'?{freight:visible.shipment.freight,documents:visible.shipment.documents||[]}:{})};
  return visible;
}
function allOrdersFor(user) { return db.prepare('SELECT data FROM orders ORDER BY created_at DESC').all().map(row => JSON.parse(row.data)).filter(order => canViewOrder(user, order)).map(order=>orderFor(user,order)); }
function getOrder(id) { const row = db.prepare('SELECT data FROM orders WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
function decodeImages(images = []) {
  if (!Array.isArray(images) || images.length > 4) throw Object.assign(new Error('最多上传4张图片'), { status: 400 });
  return images.map(image => {
    if (!image || typeof image !== 'object') throw Object.assign(new Error('图片内容无效'),{status:400});
    const match = String(image.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw Object.assign(new Error('仅支持JPG、PNG、WebP、GIF图片'), { status: 400 });
    const bytes = Buffer.from(match[2], 'base64'), mime = detectedImageMime(bytes);
    if (!mime || bytes.length > 5 * 1024 * 1024) throw Object.assign(new Error('图片内容无效或超过5MB'), { status: 400 });
    return { id: crypto.randomUUID(), name: String(image.name || '图片').slice(0,200), mime, bytes };
  });
}
function saveOrder(order) { db.prepare('UPDATE orders SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(order), now(), order.id); }
function audit(user, orderId, action, detail) { db.prepare('INSERT INTO audit(order_id,actor,role,action,detail,created_at) VALUES(?,?,?,?,?,?)').run(orderId || null, user.name, user.role, action, detail, now()); }
function currentTask(order) { return activeTasks(order)[0]; }
function isShippingTask(task) { return task && task.ownerRole === '仓库' && (task.name.includes('发货') || task.name.includes('出货')); }
function shippingGate(order) {
  return { allowed: shippingChecks(order).every(([,ok]) => ok) };
}
function nextOrderId() {
  const prefix = `DA${isoDate().replaceAll('-', '')}`;
  const ids = db.prepare('SELECT id FROM orders WHERE id LIKE ?').all(`${prefix}%`);
  const serial = ids.reduce((max,row)=>Math.max(max, Number(row.id.slice(prefix.length)) || 0),0)+1;
  return `${prefix}${String(serial).padStart(3, '0')}`;
}
function completeTask(order, task, user, note = '') {
  task.status = '已完成'; task.assignee = user.name; task.note = String(note || ''); task.completedAt = now();
  task.approvalRequestedBy = ''; task.approvalRequestedAt = '';
  advanceFlow(order);
}
function staticFile(pathname) {
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '');
  if (!['index.html','app.js','styles.css','polish.css','workflow.mjs','product-search.mjs','order-list.mjs','order-amounts.mjs','employees-ui.mjs','order-utils.mjs','work-notifications-ui.mjs'].includes(relative)) return null;
  const target = path.resolve(root, relative);
  if (!target.startsWith(root) || target.includes(`${path.sep}data${path.sep}`)) return null;
  return target;
}
function mime(file) { return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream'; }
const invalidateSessions=id=>{for(const [token,session] of sessions)if(session.user.id===id)sessions.delete(token);};
const handleEmployees=employeeAdministration({db,roles,hashPassword,readJson,json,requireRole,now,invalidateSessions,audit});

initializeProduction(db,root);
const workNotices=workNotifications({db,now,currentUser,canViewOrder,requireUser,json});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const identifier=String(body.username||'').trim();
      const row = db.prepare('SELECT * FROM users WHERE (username=? OR phone=?) AND active=1').get(identifier,identifier);
      if (!row || !verifyPassword(String(body.password || ''), row.password_hash)) return json(res, 401, { error: '用户名或密码错误' });
      const token = crypto.randomBytes(32).toString('hex'), user = { id: row.id, username: row.username, name: row.name, role: row.role, phone:row.phone||'',mustChangePassword:!!row.must_change_password };
      sessions.set(token, { user, authVersion:row.auth_version, expires: Date.now() + 12 * 60 * 60 * 1000 });
      audit(user, null, '登录系统', '登录成功');
      return json(res, 200, { user }, { 'set-cookie': `orderhub_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const token = cookies(req).orderhub_session; if (token) sessions.delete(token);
      return json(res, 200, { ok: true }, { 'set-cookie': 'orderhub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    const user = currentUser(req);
    if(url.pathname==='/api/change-password'&&req.method==='POST'){
      requireUser(user);const body=await readJson(req),row=db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      if(!verifyPassword(String(body.currentPassword||''),row.password_hash))return json(res,400,{error:'原密码不正确'});
      const password=String(body.newPassword||'');
      if(password.length<8||password.length>128||password===String(body.currentPassword))return json(res,400,{error:'新密码须为8至128位，且不能与原密码相同'});
      db.prepare('UPDATE users SET password_hash=?,must_change_password=0,auth_version=auth_version+1 WHERE id=?').run(hashPassword(password),user.id);
      invalidateSessions(user.id);audit(user,null,'修改密码','密码已更新，旧会话失效');
      return json(res,200,{ok:true},{'set-cookie':'orderhub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    }
    if(url.pathname.startsWith('/api/')&&user?.mustChangePassword&&url.pathname!=='/api/me')return json(res,403,{error:'请先修改初始密码'});
    if(await handleEmployees(req,url,user,res))return;
    if(await workNotices.handle(req,url,user,res,readJson))return;
    const ocrMatch=url.pathname.match(/^\/api\/orders\/([^/]+)\/shipping-ocr$/);
    if(ocrMatch&&req.method==='POST'){
      requireRole(user,['仓库']);const order=getOrder(ocrMatch[1]);if(!order)return json(res,404,{error:'订单不存在'});requireOrderAccess(user,order);
      if(!order.shipment)return json(res,409,{error:'请先确认发货，再补填物流信息'});
      const body=await readJson(req);if(!Array.isArray(body.images)||body.images.length<1||body.images.length>2)return json(res,400,{error:'请上传1至2张面单或物流单图片'});
      const result=await recognizeShipping(decodeImages(body.images));requireRole(currentUser(req),['仓库']);
      return json(res,200,result);
    }
    const imageMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/images\/([^/]+)$/);
    if (imageMatch && req.method === 'GET') {
      const order = getOrder(imageMatch[1]);
      if (!order) return json(res, 404, { error: '订单不存在' });
      requireOrderAccess(user, order);
      if (!canSeeFinance(user) && ![...(order.images || []),...(order.shippingMarkImages || []),...(user.role==='仓库'?(order.shipment?.documents||[]):[])].some(image=>image.id === imageMatch[2])) return json(res,403,{error:'当前岗位无权查看付款凭证'});
      const image = db.prepare('SELECT mime,bytes FROM order_images WHERE id=? AND order_id=?').get(imageMatch[2], order.id);
      if (!image) return json(res, 404, { error: '图片不存在' });
      res.writeHead(200, { 'content-type': image.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      return res.end(Buffer.from(image.bytes));
    }
    if (url.pathname === '/api/me') { requireUser(user); return json(res, 200, { user }); }
    if (url.pathname === '/api/notifications' && req.method === 'GET') {
      requireRole(user,['财务']);
      const unreadCount=db.prepare('SELECT count(*) AS n FROM order_notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=? WHERE r.read_at IS NULL').get(user.id).n;
      const notifications=db.prepare('SELECT n.*,r.read_at,o.data FROM order_notifications n JOIN orders o ON o.id=n.order_id LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=? ORDER BY (r.read_at IS NULL) DESC,n.created_at DESC,n.rowid DESC LIMIT 100').all(user.id).map(({changed_fields,data,...notice})=>{
        const order=JSON.parse(data);
        return {...notice,changedFields:JSON.parse(changed_fields),storeName:order.storeName||order.customer,status:order.status};
      });
      return json(res,200,{notifications,unreadCount});
    }
    const readNotice=url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (readNotice && req.method === 'POST') {
      requireRole(user,['财务']);
      if (!db.prepare('SELECT id FROM order_notifications WHERE id=?').get(readNotice[1])) return json(res,404,{error:'提醒不存在'});
      db.prepare('INSERT OR IGNORE INTO notification_reads(notification_id,user_id,read_at) VALUES(?,?,?)').run(readNotice[1],user.id,now());
      workNotices.publish();
      return json(res,200,{ok:true});
    }
    if (url.pathname === '/api/payment-accounts' && req.method === 'GET') {
      requireRole(user, ['业务员','财务']);
      const query = String(url.searchParams.get('q') || '').trim().slice(0,160);
      const accounts = db.prepare('SELECT name,source_order FROM payment_accounts ORDER BY source_order,name').all();
      const result = searchProducts(accounts.map(item => ({ code: item.name, name: item.name })), query, 100);
      return json(res, 200, { accounts: result.products.map(item => ({ name: item.name })), total: result.total });
    }
    if (url.pathname === '/api/products' && req.method === 'GET') {
      requireRole(user, roles);
      const query = String(url.searchParams.get('q') || '').trim().slice(0,160);
      const catalog = db.prepare('SELECT code,name,specification,unit,category FROM products ORDER BY code').all();
      return json(res, 200, searchProducts(catalog, query));
    }
    if (url.pathname === '/api/products' && req.method === 'POST') {
      requireRole(user, ['业务员','超级管理员']);
      const body = await readJson(req);
      const product = { code: String(body.code || '').trim(), name: String(body.name || '').trim(), specification: String(body.specification || '').trim(), unit: String(body.unit || '件').trim() };
      if (!product.code || !product.name || Object.values(product).some(value => value.length > 160)) throw Object.assign(new Error('请填写产品编码和名称，每项不超过160字'), { status: 400 });
      if (db.prepare('SELECT code FROM products WHERE code=?').get(product.code)) throw Object.assign(new Error('该产品编码已存在，请搜索选择'), { status: 409 });
      db.prepare('INSERT INTO products(code,name,specification,unit,created_at) VALUES(?,?,?,?,?)').run(product.code, product.name, product.specification, product.unit, now());
      audit(user,null,'新增产品编码',product.code + ' · ' + product.name);
      return json(res, 201, { product });
    }
    if (url.pathname === '/api/workflows' && req.method === 'GET') {
      requireRole(user, roles);
      return json(res, 200, { workflows: Object.keys(workflowDefinitions).map(type => ({ type, label: workflowLabels[type], parallel: false, steps: buildFlow(type).map(({step,name,ownerRole}) => ({step,name,ownerRole})) })) });
    }
    if (url.pathname === '/api/orders' && req.method === 'GET') {
      requireRole(user, roles);
      const from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'';
      if ((from && !validOrderDate(from)) || (to && !validOrderDate(to)) || (from && to && from>to)) return json(res,400,{error:'请填写有效的起止日期，开始日期不能晚于结束日期'});
      return json(res,200,{orders:filterOrders(allOrdersFor(user),{from,to})});
    }
    if (url.pathname === '/api/orders/export' && req.method === 'POST') {
      requireRole(user,roles);
      const body=await readJson(req);
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length>5000 || body.ids.some(id=>typeof id!=='string')) return json(res,400,{error:'请选择1至5000个订单导出'});
      const ids=[...new Set(body.ids)];
      const orders=ids.map(id=>{
        const order=getOrder(id);
        if (!order) throw Object.assign(new Error('所选订单已不存在，请刷新后重试'),{status:404});
        requireOrderAccess(user,order);
        return orderFor(user,order);
      });
      const file=exportOrders(orders,canSeeFinance(user),user.role==='仓库');
      audit(user,null,'导出订单',`共${orders.length}单`);
      res.writeHead(200,{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':`attachment; filename="orders-${isoDate()}-${orders.length}.xlsx"`,'cache-control':'private, no-store','content-length':file.length});
      return res.end(file);
    }
    const editMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if ((url.pathname === '/api/orders' && req.method === 'POST') || (editMatch && req.method === 'PUT')) {
      requireRole(user, ['业务员']);
      const body = await readJson(req);
      const existing = editMatch && req.method === 'PUT' ? getOrder(editMatch[1]) : null;
      if (editMatch && !existing) return json(res, 404, { error: '订单不存在' });
      if (existing) {
        requireOrderAccess(user, existing);
        if (body.workflowType !== existing.workflowType) return json(res, 409, { error: '已建工单不能更改订单类型' });
        if (Number(body.infoRevision) !== (existing.infoRevision || 0)) return json(res, 409, { error: '订单资料已更新，请重新打开后修改' });
      }
      if (!Array.isArray(body.paymentProofs ?? []) || (body.paymentProofs || []).length > 4) return json(res,400,{error:'最多上传4张付款凭证'});
      const paymentProofs = existing && body.paymentProofs === undefined ? [] : (body.paymentProofs || []).flatMap(image => {
        if (!image?.sourceImageId) return decodeImages([image]);
        const metadata = existing?.paymentProofs?.find(item => item.id === image.sourceImageId);
        const stored = metadata && db.prepare('SELECT mime,bytes FROM order_images WHERE id=? AND order_id=?').get(metadata.id, existing.id);
        if (!stored) throw Object.assign(new Error('付款凭证无效，请重新上传'), { status: 400 });
        return [{id:metadata.id,name:metadata.name,mime:stored.mime,bytes:stored.bytes}];
      });
      if (!Array.isArray(body.paymentProofs ?? []) || paymentProofs.length > 4) return json(res,400,{error:'最多上传4张付款凭证'});
      const prepaymentAmount = String(body.prepaymentAmount ?? '').trim();
      if (prepaymentAmount && (!/^\d+(\.\d{1,2})?$/.test(prepaymentAmount) || Number(prepaymentAmount) > 1e12)) return json(res, 400, { error: '预付款金额请填写有效金额，最多两位小数' });
      let sourceOrder = existing;
      if (!existing && body.sourceOrderId) {
        sourceOrder = getOrder(String(body.sourceOrderId));
        if (!sourceOrder) return json(res, 404, { error: '来源订单不存在' });
        requireOrderAccess(user, sourceOrder);
      }
      if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length > 4)) return json(res, 400, { error: '最多上传4张图片' });
      const images = (body.images || []).flatMap(image => {
        if (!image?.sourceImageId) return decodeImages([image]);
        const metadata = sourceOrder?.images?.find(item => item.id === image.sourceImageId);
        const stored = metadata && db.prepare('SELECT mime,bytes FROM order_images WHERE id=? AND order_id=?').get(metadata.id, sourceOrder.id);
        if (!stored) throw Object.assign(new Error('来源图片无效，请重新上传'), { status: 400 });
        return [{ id: existing ? metadata.id : crypto.randomUUID(), name: metadata.name, mime: stored.mime, bytes: stored.bytes }];
      });
      if (body.shippingMarkImages !== undefined && (!Array.isArray(body.shippingMarkImages) || body.shippingMarkImages.length > 4)) return json(res,400,{error:'最多上传4张唛头图片'});
      const shippingMarkImages = body.workflowType === 'foreign' ? (body.shippingMarkImages || []).flatMap(image => {
        if (!image?.sourceImageId) return decodeImages([image]);
        const metadata = sourceOrder?.shippingMarkImages?.find(item=>item.id===image.sourceImageId);
        const stored = metadata && db.prepare('SELECT mime,bytes FROM order_images WHERE id=? AND order_id=?').get(metadata.id,sourceOrder.id);
        if (!stored) throw Object.assign(new Error('唛头图片无效，请重新上传'),{status:400});
        return [{id:existing?metadata.id:crypto.randomUUID(),name:metadata.name,mime:stored.mime,bytes:stored.bytes}];
      }) : [];
      for (const key of ['orderDate', 'recipient', 'address']) if (!String(body[key] ?? '').trim()) throw Object.assign(new Error(`请填写${key}`), { status: 400 });
      if (!Object.hasOwn(workflowDefinitions,body.workflowType)) throw Object.assign(new Error('订单类型无效'), { status: 400 });
      if (!validOrderDate(body.orderDate)) return json(res,400,{error:'请填写有效的订单日期'});
      const standard = ['regular','urgent'].includes(body.workflowType);
      let productItems = [];
      if (standard && body.productItems !== undefined) {
        if (!Array.isArray(body.productItems) || body.productItems.length < 1 || body.productItems.length > 100) throw Object.assign(new Error('请选择1至100条产品明细'), { status: 400 });
        const codes = new Set();
        productItems = body.productItems.map(item => {
          if (!item || typeof item !== 'object') throw Object.assign(new Error('产品明细无效'),{status:400});
          const product = db.prepare('SELECT code,name,specification,unit,category FROM products WHERE code=?').get(String(item.code || ''));
          const quantity = Number(item.quantity);
          const casePack = item.casePack === undefined || item.casePack === null || String(item.casePack).trim() === '' ? null : Number(item.casePack);
          if (casePack !== null && (!Number.isSafeInteger(casePack) || casePack <= 0 || casePack > 1e9)) throw Object.assign(new Error('箱规请填写大于0的整数，或留空'), { status: 400 });
          if (!product || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9 || codes.has(product.code)) throw Object.assign(new Error('产品编码、数量无效或存在重复产品'), { status: 400 });
          codes.add(product.code);
          return { ...product, quantity, casePack };
        });
      }
      const usesPricing=body.pricingVersion===1;
      if(body.pricingVersion!==undefined&&body.pricingVersion!==1)throw Object.assign(new Error('计价版本无效'),{status:400});
      if(existing?.pricingVersion===1&&!usesPricing)throw Object.assign(new Error('请按产品明细计价后保存，不能改回手工总额'),{status:409});
      let pricing=null;
      if(usesPricing){
        try{pricing=calculateOrderPricing(body.lineItems,body.freight,body.discountAmount);}catch(e){throw Object.assign(e,{status:400});}
        if(standard){
          if(new Set(pricing.lineItems.map(p=>p.code)).size!==pricing.lineItems.length||pricing.lineItems.length!==productItems.length)throw Object.assign(new Error('计价明细与产品明细不一致'),{status:400});
          pricing.lineItems=pricing.lineItems.map(line=>{const item=productItems.find(p=>p.code===line.code);if(!item||item.quantity!==line.quantity)throw Object.assign(new Error('计价数量与产品明细不一致'),{status:400});return {...line,product:item.name,specification:item.specification||line.specification,unit:item.unit};});
        }
        const prepay=prepaymentAmount?moneyCents(prepaymentAmount):0;
        if(prepay>moneyCents(pricing.amount))throw Object.assign(new Error('预付款不能超过实际总货款'),{status:400});
      }else if(!String(body.amount??'').trim())throw Object.assign(new Error('请填写总货款'),{status:400});
      const specialNotes = usesPricing ? String(body.specialNotes??'') : standard ? String(body.specialNotes ?? body.product ?? '') : '';
      const productSummary = pricing ? pricing.lineItems.map(p=>`${p.product} ${p.color} ${p.specification} × ${p.quantity}${p.unit}`).join('；') : productItems.length ? productItems.map(item => `${item.code} ${item.name}${item.specification ? '（' + item.specification + '）' : ''} × ${item.quantity}${item.unit}`).join('；') : String(body.product || '');
      if (!productSummary.trim()) throw Object.assign(new Error('请填写货品明细或选择产品'), { status: 400 });
      const entryValues = Object.fromEntries(['recipient', 'contact', 'codAmount', 'address', 'product', 'trackingNumber', 'paymentAccount', 'freight', 'price', 'amount', 'cost', 'grossProfit', 'salesperson'].map(key => [key, String(body[key] ?? '')]));
      entryValues.trackingNumber = String(existing?.trackingNumber || '');
      if(!pricing&&body.price===undefined)entryValues.price=String(existing?.entryValues?.price??existing?.price??'');
      if(pricing){entryValues.amount=pricing.amount.toFixed(2);entryValues.freight=pricing.freight.toFixed(2);entryValues.price='';}
      const numericValue = key => { const value = Number(entryValues[key]); return Number.isFinite(value) && value >= 0 ? value : 0; };
      const qty = null, price = pricing?0:numericValue('price'), amount = Math.round(numericValue('amount') * 100) / 100;
      const freight = numericValue('freight'), cost = numericValue('cost'), codAmount = numericValue('codAmount');
      const id = existing?.id || nextOrderId();
      // Legacy requirement fields are retained on edits for historical records only.
      if(body.businessSelfProcurement!==undefined&&typeof body.businessSelfProcurement!=='boolean')throw Object.assign(new Error('自行采购选项无效'),{status:400});
      const businessSelfProcurement=body.businessSelfProcurement??existing?.businessSelfProcurement??sourceOrder?.businessSelfProcurement??false;
      if(businessSelfProcurement&&!isCustomWorkflow(body.workflowType))throw Object.assign(new Error('业务自行采购适用于定制和外贸订单'),{status:400});
      if(existing&&businessSelfProcurement!==Boolean(existing.businessSelfProcurement)&&procurementModeLocked(existing))throw Object.assign(new Error('标贴、包材或对应付款环节已确认，不能切换采购方式'),{status:409});
      const logisticsRequirements=String(body.logisticsRequirements ?? existing?.logisticsRequirements ?? sourceOrder?.logisticsRequirements ?? '').trim();
      if(logisticsRequirements.length>2000)throw Object.assign(new Error('客户要求物流信息请控制在2000字以内'),{status:400});
      const depositRequirement = existing?.depositRequirement ?? '';
      const depositConfirmed = existing?.depositConfirmed ?? true;
      const depositAmount = existing?.depositAmount ?? null;
      let order = {
        id, sourceOrderId: sourceOrder?.id || null, workflowType: body.workflowType, workflowLabel: workflowLabels[body.workflowType], businessSelfProcurement,
        orderDate: String(body.orderDate || isoDate()), storeName: String(body.storeName || ''), shopOrderNumber: String(body.shopOrderNumber || ''), customer: String(body.storeName || body.recipient), recipient: String(body.recipient), contact: String(body.contact ?? existing?.contact ?? ''),
        product: productSummary, productItems, specialNotes, ...(pricing?{pricingVersion:1,lineItems:pricing.lineItems,itemsSubtotal:pricing.itemsSubtotal,grossAmount:pricing.grossAmount,discountAmount:pricing.discountAmount,productSourceText:String(body.productSourceText??'').slice(0,20000)}:{}), qty, price, amount, codAmount, trackingNumber: String(existing?.trackingNumber || ''), logistics: '', paymentAccount: String(body.paymentAccount || ''),
        freight, cost, grossProfit: Number.isFinite(Number(body.grossProfit)) ? Number(body.grossProfit) : 0,
        entryValues, amountIsNumeric: pricing?true:Number.isFinite(Number(body.amount)) && Number(body.amount) >= 0, salesperson: entryValues.salesperson,
        delivery: '', pack: '', address: String(body.address), logisticsRequirements, notes: specialNotes,
        shippingMarkDescription: body.workflowType === 'foreign' ? String(body.shippingMarkDescription ?? existing?.shippingMarkDescription ?? '') : '',
        productSourceImages:existing?.productSourceImages||[],
        shippingMarkImages: shippingMarkImages.map(image=>({id:image.id,name:image.name,url:`/api/orders/${id}/images/${image.id}`})),
        images: images.map(image => ({ id: image.id, name: image.name, url: `/api/orders/${id}/images/${image.id}` })),
        prepaymentAmount, paymentProofs: paymentProofs.map(image => ({ id: image.id, name: image.name, url: `/api/orders/${id}/images/${image.id}` })),
        depositAmount, depositRequirement, depositConfirmed, received: 0, receipts: [], outgoingPayments: [], financeStatus: '未到账', creatorUserId: user.id, creatorUsername: user.username,
        creatorName: user.name, ownerUserId:user.id,ownerUsername:user.username,ownerName:user.name,created: isoDate(), flowTasks: buildFlow(body.workflowType, 1), status: '',
        flowVersion: 4, paymentRequests: [], noFee: {}, materialReceipts: []
      };
      if (existing) {
        if (existing.received > 0 && (!order.amountIsNumeric || amount < existing.received)) return json(res,409,{error:'总货款不能低于财务已核实的到账金额'});
        const editable = [...(pricing?['pricingVersion','lineItems','itemsSubtotal','grossAmount','discountAmount','productSourceText']:[]),'businessSelfProcurement','orderDate','storeName','shopOrderNumber','customer','recipient','contact','product','productItems','specialNotes','price','amount','codAmount','trackingNumber','paymentAccount','freight','cost','grossProfit','entryValues','amountIsNumeric','salesperson','address','logisticsRequirements','notes','images','productSourceImages','shippingMarkDescription','shippingMarkImages','prepaymentAmount','paymentProofs','depositAmount','depositRequirement','depositConfirmed'];
        if (body.images === undefined) order.images = existing.images || [];
        if (body.shippingMarkImages === undefined) order.shippingMarkImages = existing.shippingMarkImages || [];
        if (body.paymentProofs === undefined) order.paymentProofs = existing.paymentProofs || [];
        const changes = editable.filter(key => JSON.stringify(existing[key] ?? null) !== JSON.stringify(order[key] ?? null)).map(key => ({field:key,before:existing[key] ?? null,after:order[key] ?? null}));
        order = {...existing,...Object.fromEntries(editable.map(key=>[key,order[key]])), infoRevision:(existing.infoRevision || 0)+1, infoUpdatedAt:now(), infoUpdatedBy:user.name,
          changeHistory:[...(existing.changeHistory || []),{operator:user.name,username:user.username,createdAt:now(),changes}]};
        order.financeStatus = order.received > 0 ? (order.received >= order.amount ? '已全额到账' : '部分到账') : existing.financeStatus;
      }
      if(!existing||businessSelfProcurement!==Boolean(existing.businessSelfProcurement)){order.flowTasks=structuredClone(order.flowTasks);applyProcurementMode(order);advanceFlow(order);}
      db.exec('BEGIN');
      try {
        if (existing) saveOrder(order);
        else db.prepare('INSERT INTO orders(id,data,created_at,updated_at) VALUES(?,?,?,?)').run(id, JSON.stringify(order), now(), now());
        const insertImage = db.prepare('INSERT OR IGNORE INTO order_images(id,order_id,mime,bytes) VALUES(?,?,?,?)');
        for (const image of [...images, ...paymentProofs, ...shippingMarkImages]) insertImage.run(image.id, id, image.mime, image.bytes);
        if (existing && order.changeHistory.at(-1).changes.length) {
          const changedFields=order.changeHistory.at(-1).changes.map(change=>change.field);
          db.prepare('INSERT INTO order_notifications(id,order_id,revision,actor,changed_fields,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),id,order.infoRevision,user.name,JSON.stringify(changedFields),order.infoUpdatedAt);
        }
        workNotices.record(order,existing,{edited:!!existing&&!!order.changeHistory.at(-1).changes.length});
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      workNotices.publish();
      audit(user, id, existing ? '修改工单资料' : '新建订单', `${order.workflowLabel} · ${order.customer} · ${order.product}${!existing && sourceOrder ? ' · 复制自 ' + sourceOrder.id : ''}`);
      return json(res, existing ? 200 : 201, { order:orderFor(user,order) });
    }

    const match = url.pathname.match(/^\/api\/orders\/([^/]+)\/(task|task-approval|receipt|ship|tracking)$/);
    if (match && req.method === 'POST') {
      requireUser(user);
      const body = await readJson(req), action = match[2];
      const order = getOrder(match[1]);
      if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
      requireOrderAccess(user, order);
      const beforeAction=structuredClone(order);
      db.exec('BEGIN IMMEDIATE');
      try {
      if (action === 'receipt') {
        requireRole(user, ['财务']);
        const cents = moneyCents(body.amount), receivedCents = moneyCents(order.received), totalCents = moneyCents(order.amount);
        if (cents === null || cents <= 0 || receivedCents === null || totalCents === null) throw Object.assign(new Error('到账金额请填写有效正数，最多两位小数'),{status:400});
        const receiptDate = body.date || isoDate();
        if (!validOrderDate(receiptDate)) throw Object.assign(new Error('到账日期无效'),{status:400});
        const requestId = String(body.requestId || '');
        if (requestId.length > 100) throw Object.assign(new Error('提交标识无效'),{status:400});
        const previous = requestId && order.receipts.find(item=>item.requestId===requestId);
        if (previous) {
          if (moneyCents(previous.amount)!==cents || previous.date!==receiptDate || previous.note!==String(body.note||'')) throw Object.assign(new Error('重复提交内容不一致，请重新打开收款窗口'),{status:409});
          db.exec('COMMIT');
          return json(res,200,{order:orderFor(user,order)});
        }
        if (receivedCents + cents > totalCents) throw Object.assign(new Error('到账金额不能超过尚未到账金额'),{status:400});
        const amount = cents / 100;
        order.received = (receivedCents + cents) / 100;
        order.receipts.push({ amount, date:receiptDate, note:String(body.note || ''), operator:user.name, createdAt:now(), ...(requestId ? {requestId} : {}) });
        order.financeStatus = receivedCents+cents >= totalCents ? '已全额到账' : '部分到账';
        audit(user, order.id, '登记客户到账', `本次 ${amount}；累计 ${order.received}`);
      }
      if (action === 'task') {
        const task = order.flowTasks.find(item => item.step === Number(body.step));
        if (!task || task.status !== '待处理' || !ready(order, task)) throw Object.assign(new Error('该任务尚未开放或已处理'), { status: 409 });
        requireRole(user, [task.ownerRole]);
        if (isShippingTask(task)) throw Object.assign(new Error('发货节点必须通过发货放行操作'), { status: 409 });
        if (['财务确认收款', '财务审核', '财务审核尾款'].includes(task.name) && order.amountIsNumeric === false) throw Object.assign(new Error('总货款包含文字，请先由财务核实金额'), { status: 409 });
        if (task.name === '财务确认工单付款') {
          const paid = Number(body.outgoingAmount);
          if (moneyCents(body.outgoingAmount) === null || paid <= 0) throw Object.assign(new Error('请填写本次工单付款金额'), { status: 400 });
          order.outgoingPayments.push({ step: task.step, amount: paid, note: String(body.note || ''), operator: user.name, createdAt: now() });
        }
        if (requiresAdminApproval(order, task)) {
          task.status = '待管理员审批'; task.assignee = user.name; task.note = String(body.note || ''); task.approvalRequestedBy = user.name; task.approvalRequestedAt = now();
          syncOrderStatus(order); audit(user, order.id, '提交状态审批', `第${task.step}步 ${task.name}`);
        } else {
          completeTask(order, task, user, body.note); audit(user, order.id, '完成流程节点', `第${task.step}步 ${task.name}`);
        }
      }
      if (action === 'task-approval') {
        requireRole(user, ['超级管理员']);
        const task = order.flowTasks.find(item => item.step === Number(body.step));
        if (!task || task.status !== '待管理员审批' || !ready(order,task)) throw Object.assign(new Error('没有可批准的状态修改，或前置条件尚未满足'), { status: 409 });
        if (body.action === 'approve') {
          const requester = task.approvalRequestedBy;
          completeTask(order, task, user, task.note); task.approvedBy = user.name; task.approvedAt = now();
          audit(user, order.id, '批准状态修改', `批准 ${requester} 完成第${task.step}步 ${task.name}`);
        } else {
          task.status = '待处理'; task.rejectionReason = String(body.reason || '请核实后重新提交'); advanceFlow(order);
          audit(user, order.id, '驳回状态修改', `第${task.step}步：${task.rejectionReason}`);
        }
      }
      if (action === 'tracking') {
        requireRole(user, ['仓库']);
        if (!order.shipment || !order.flowTasks.some(t => isShippingTask(t) && t.status === '已完成')) throw Object.assign(new Error('尚未发货，请在确认发货时填写物流信息'),{status:409});
        if (Number(body.infoRevision) !== (order.infoRevision || 0)) throw Object.assign(new Error('订单资料已更新，请重新打开后保存'),{status:409});
        const trackingNumber=String(body.trackingNumber ?? '').trim(), logistics=String(body.logistics ?? '').trim();
        if (!trackingNumber) throw Object.assign(new Error('请填写物流单号'),{status:400});
        if (trackingNumber.length>200 || logistics.length>200) throw Object.assign(new Error('物流公司和单号请控制在200字以内'),{status:400});
        const shipmentDate=body.date??order.shipment.date;
        if(!validOrderDate(shipmentDate))throw Object.assign(new Error('发货日期无效'),{status:400});
        const recipient=String(body.recipient??order.shipment.recipient??order.recipient??'').trim();
        const address=String(body.address??order.shipment.address??order.address??'').trim();
        if(recipient.length>200||address.length>2000)throw Object.assign(new Error('姓名最多200字，地址最多2000字'),{status:400});
        const countInput=body.packageCount??order.shipment.packageCount??'';
        const packageCount=String(countInput).trim()===''?null:Number(countInput);
        if(packageCount!==null&&(!Number.isInteger(packageCount)||packageCount<=0||packageCount>1e9))throw Object.assign(new Error('件数请填写有效正整数'),{status:400});
        const freightInput=body.freight??order.shipment.freight??'';
        const freight=String(freightInput).trim()===''?null:Number(freightInput);
        if(freight!==null&&(moneyCents(freightInput)===null||freight>1e12))throw Object.assign(new Error('运费请填写有效非负金额，最多两位小数'),{status:400});
        let documents=order.shipment.documents||[];
        if(body.documents!==undefined){
          if(!Array.isArray(body.documents)||body.documents.length>2)throw Object.assign(new Error('最多上传2张面单或物流单图片'),{status:400});
          documents=body.documents.map(image=>{
            if(image?.sourceImageId){const item=(order.shipment.documents||[]).find(d=>d.id===image.sourceImageId);if(!item)throw Object.assign(new Error('面单图片无效'),{status:400});return item;}
            const decoded=decodeImages([image])[0];db.prepare('INSERT INTO order_images(id,order_id,mime,bytes) VALUES(?,?,?,?)').run(decoded.id,order.id,decoded.mime,decoded.bytes);
            return {id:decoded.id,name:decoded.name,url:`/api/orders/${order.id}/images/${decoded.id}`};
          });
        }
        order.trackingNumber=trackingNumber;order.logistics=logistics;
        if(order.entryValues)order.entryValues.trackingNumber=trackingNumber;
        order.shipment={...order.shipment,date:shipmentDate,recipient,address,packageCount,freight,documents,trackingNumber,logistics,logisticsUpdatedAt:now(),logisticsUpdatedBy:user.name};
        order.infoRevision=(order.infoRevision||0)+1;
        audit(user,order.id,'更新物流信息',`原单号：${beforeAction.trackingNumber||'未填写'}；新单号：${trackingNumber}；物流公司：${logistics}`);
      }
      if (action === 'ship') {
        requireRole(user, ['仓库']);
        const gate = shippingGate(order);
        if (!gate.allowed) throw Object.assign(new Error('未满足发货条件，服务器已拦截'), { status: 409 });
        if (body.date && !validOrderDate(body.date)) throw Object.assign(new Error('发货日期无效'),{status:400});
        if (body.method && !['物流','客户自提','自提'].includes(body.method)) throw Object.assign(new Error('发货方式无效'),{status:400});
        const task = activeTasks(order).find(isShippingTask);
        const trackingNumber = String(body.trackingNumber ?? order.trackingNumber ?? '').trim();
        const logistics = String(body.logistics ?? order.logistics ?? '').trim();
        if (trackingNumber.length > 200 || logistics.length > 200) throw Object.assign(new Error('物流公司和单号请控制在200字以内'),{status:400});
        order.trackingNumber = trackingNumber;
        order.logistics = logistics;
        if (order.entryValues) order.entryValues.trackingNumber = trackingNumber;
        order.infoRevision = (order.infoRevision || 0) + 1;
        order.shipment = { date: body.date || isoDate(), method: String(body.method || '物流'), trackingNumber, logistics, note: String(body.note || ''), operator: user.name };
        const shippingDetail = [order.shipment.method,logistics,trackingNumber,order.shipment.note].filter(Boolean).join('；');
        completeTask(order, task, user, shippingDetail);
        audit(user, order.id, '确认发货', shippingDetail);
      }
      if(action !== 'tracking') advanceFlow(order);
      saveOrder(order);
      workNotices.record(order,beforeAction);
      db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      workNotices.publish();
      return json(res, 200, { order:orderFor(user,order) });
    }

    if (url.pathname === '/api/audit' && req.method === 'GET') {
      requireRole(user, roles);
      const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all();
      const visibleIds = new Set(allOrdersFor(user).map(order => order.id));
      const visibleRows = user.role === '业务员' ? rows.filter(row => !row.order_id || visibleIds.has(row.order_id)) : rows;
      return json(res, 200, { audit:canSeeFinance(user) ? visibleRows : visibleRows.map(({detail,...row})=>row) });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });
    const file = staticFile(url.pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not Found'); }
    const extension = path.extname(file);
    res.writeHead(200, { 'content-type': mime(file), 'cache-control': ['.html', '.js', '.mjs'].includes(extension) ? 'no-store' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    json(res, error.status || 500, { error: error.message || '服务器错误' });
  }
});

const host = process.env.ORDER_HUB_HOST || '127.0.0.1';
const port = Number(process.env.ORDER_HUB_PORT) || 4318;
server.listen(port, host, () => console.log(`联单订单协同系统：http://${host}:${port}`));
