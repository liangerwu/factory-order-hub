import {activeTasks} from './workflow.mjs';

export function workNotifications({db,now,currentUser,canViewOrder,requireUser,json}) {
  db.exec(`CREATE TABLE IF NOT EXISTS work_notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT UNIQUE NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),role TEXT NOT NULL,kind TEXT NOT NULL,step INTEGER,title TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_notification_reads(event_id INTEGER NOT NULL REFERENCES work_notifications(id),user_id INTEGER NOT NULL REFERENCES users(id),read_at TEXT NOT NULL,PRIMARY KEY(event_id,user_id));
    CREATE TABLE IF NOT EXISTS work_notification_sounds(event_id INTEGER NOT NULL REFERENCES work_notifications(id),user_id INTEGER NOT NULL REFERENCES users(id),claimed_at TEXT NOT NULL,PRIMARY KEY(event_id,user_id));`);
  const streams=new Set();
  const add=db.prepare('INSERT OR IGNORE INTO work_notifications(event_key,order_id,role,kind,step,title,created_at) VALUES(?,?,?,?,?,?,?)');
  function record(order,before,{bootstrap=false,edited=false}={}) {
    for(const task of activeTasks(order).filter(t=>t.status==='待处理')) {
      if(before?.flowTasks.some(t=>t.step===task.step&&t.status==='待处理'&&t.ownerRole===task.ownerRole))continue;
      const shipped=!before?.shipment&&order.shipment;
      const title=shipped&&task.ownerRole==='业务员'?`仓库已发货，请跟进售后`:`待处理：${task.name}`;
      const reassigned=before?.flowTasks.some(t=>t.step===task.step&&t.ownerRole!==task.ownerRole);
      add.run(reassigned?`${order.id}:task:${task.step}:assignment:${order.infoRevision}`:`${order.id}:task:${task.step}`,order.id,task.ownerRole,'task',task.step,title,now());
    }
    if(!bootstrap&&!before?.shipment&&order.shipment&&!activeTasks(order).some(t=>t.status==='待处理'&&t.ownerRole==='业务员'))add.run(`${order.id}:shipped`,order.id,'业务员','shipped',null,'仓库已发货',now());
    if(edited)add.run(`${order.id}:edit:${order.infoRevision}`,order.id,'财务','edit',null,'业务修改了工单，仅需查看，无需审批',now());
  }
  // Existing work is visible as unread, but the browser treats the first load as a silent baseline.
  for(const row of db.prepare('SELECT data FROM orders').all())record(JSON.parse(row.data),null,{bootstrap:true});
  for(const row of db.prepare('SELECT * FROM order_notifications').all())add.run(`${row.order_id}:edit:${row.revision}`,row.order_id,'财务','edit',null,'业务修改了工单，仅需查看，无需审批',row.created_at);
  function visible(user) {
    const events=db.prepare(`SELECT n.*,r.read_at,o.data FROM work_notifications n JOIN orders o ON o.id=n.order_id LEFT JOIN work_notification_reads r ON r.event_id=n.id AND r.user_id=? WHERE n.role=? ORDER BY n.id DESC`).all(user.id,user.role);
    const seenTasks=new Set();
    return events.flatMap(({data,...event})=>{
      const order=JSON.parse(data);if(!canViewOrder(user,order))return [];
      if(event.kind==='task'){const task=order.flowTasks.find(t=>t.step===event.step);if(task?.ownerRole!==user.role)return [];const key=order.id+':'+event.step;if(seenTasks.has(key))return [];seenTasks.add(key);}
      if(event.kind==='edit'&&!event.read_at)event.read_at=db.prepare('SELECT r.read_at FROM order_notifications n JOIN notification_reads r ON r.notification_id=n.id WHERE n.order_id=? AND n.revision=? AND r.user_id=?').get(order.id,Number(event.event_key.split(':').at(-1)),user.id)?.read_at;
      return [{id:event.id,order_id:order.id,kind:event.kind,step:event.step,title:event.title,created_at:event.created_at,read_at:event.read_at||null,storeName:order.storeName||order.customer,taskStatus:order.flowTasks.find(t=>t.step===event.step)?.status||null,...(order.shipment&&event.role==='业务员'?{logistics:order.logistics||'',trackingNumber:order.trackingNumber||''}:{})}];
    });
  }
  function publish(){for(const entry of streams){if(entry.res.writableEnded){streams.delete(entry);continue;}if(currentUser(entry.req)?.id!==entry.userId){entry.res.write('event: expired\ndata: {}\n\n');entry.res.end();continue;}entry.res.write('event: changed\ndata: {}\n\n');}}
  function pendingFor(user){
    return db.prepare('SELECT data FROM orders ORDER BY created_at DESC').all().flatMap(row=>{
      const order=JSON.parse(row.data);if(!canViewOrder(user,order))return [];
      return activeTasks(order).filter(task=>(task.status==='待处理'&&task.ownerRole===user.role)||(user.role==='超级管理员'&&task.status==='待管理员审批')).map(task=>({order_id:order.id,storeName:order.storeName||order.customer,step:task.step,title:task.name}));
    });
  }
  async function handle(req,url,user,res,readJson) {
    if(!url.pathname.startsWith('/api/work-notifications'))return false;
    requireUser(user);
    if(url.pathname==='/api/work-notifications/stream'&&req.method==='GET'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform',connection:'keep-alive','x-accel-buffering':'no'});
      res.write('event: changed\ndata: {}\n\n');
      const entry={req,res,userId:user.id};streams.add(entry);
      const timer=setInterval(()=>{if(currentUser(req)?.id!==user.id){res.write('event: expired\ndata: {}\n\n');res.end();}else res.write(': heartbeat\n\n');},15000);
      timer.unref();const cleanup=()=>{clearInterval(timer);streams.delete(entry);};res.on('close',cleanup);res.on('error',cleanup);return true;
    }
    if(url.pathname==='/api/work-notifications'&&req.method==='GET'){
      const all=visible(user);json(res,200,{notifications:all.slice(0,100),unreadCount:all.filter(n=>!n.read_at).length,cursor:all[0]?.id||0,pendingTasks:pendingFor(user),information:all.filter(n=>n.kind!=='task'&&!n.read_at)});return true;
    }
    const match=url.pathname.match(/^\/api\/work-notifications\/(\d+)\/(read|sound-claim)$/);
    if(match&&req.method==='POST'){
      await readJson(req);
      const event=visible(user).find(n=>n.id===Number(match[1]));
      if(!event){json(res,404,{error:'提醒不存在或当前账号无权查看'});return true;}
      if(match[2]==='sound-claim'){
        const claimed=!event.read_at&&(event.kind!=='task'||event.taskStatus==='待处理')&&db.prepare('INSERT OR IGNORE INTO work_notification_sounds(event_id,user_id,claimed_at) VALUES(?,?,?)').run(event.id,user.id,now()).changes===1;
        json(res,200,{claimed});return true;
      }
      db.prepare('INSERT OR IGNORE INTO work_notification_reads(event_id,user_id,read_at) VALUES(?,?,?)').run(event.id,user.id,now());
      if(event.kind==='edit'){
        const key=db.prepare('SELECT event_key FROM work_notifications WHERE id=?').get(event.id).event_key;
        const old=db.prepare('SELECT id FROM order_notifications WHERE order_id=? AND revision=?').get(event.order_id,Number(key.split(':').at(-1)));
        if(old)db.prepare('INSERT OR IGNORE INTO notification_reads(notification_id,user_id,read_at) VALUES(?,?,?)').run(old.id,user.id,now());
      }
      json(res,200,{ok:true});publish();return true;
    }
    json(res,404,{error:'提醒接口不存在'});return true;
  }
  return {record,publish,handle};
}
