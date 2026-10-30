import crypto from 'node:crypto';

export const ownsOrder = (employee, order) => order.ownerUserId != null
  ? Number(order.ownerUserId) === Number(employee.id)
  : Number(order.creatorUserId) === Number(employee.id) || order.creatorUsername === employee.username;

export function employeeAdministration({db,roles,hashPassword,readJson,json,requireRole,now,invalidateSessions,audit}) {
  const columns=new Set(db.prepare('PRAGMA table_info(users)').all().map(c=>c.name));
  if(!columns.has('phone'))db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
  if(!columns.has('auth_version'))db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS employee_phone_unique ON users(phone) WHERE phone IS NOT NULL AND phone!='';
    CREATE TABLE IF NOT EXISTS employee_handovers(id TEXT PRIMARY KEY,from_user_id INTEGER NOT NULL REFERENCES users(id),to_user_id INTEGER NOT NULL REFERENCES users(id),from_name TEXT NOT NULL,to_name TEXT NOT NULL,role TEXT NOT NULL,actor TEXT NOT NULL,order_ids TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
  const getEmployee=id=>db.prepare('SELECT id,username,name,role,phone,active,auth_version FROM users WHERE id=?').get(id);
  const allOrders=()=>db.prepare('SELECT id,data,updated_at FROM orders ORDER BY id').all().map(row=>({...row,order:JSON.parse(row.data)}));
  const publicEmployee=employee=>{const {auth_version,...visible}=employee;return {...visible,phone:employee.phone||''};};
  const checkPhone=(phone,id)=>{
    if(phone&&!/^1[3-9]\d{9}$/.test(phone))fail('请填写有效的11位手机号');
    if(phone&&db.prepare('SELECT id FROM users WHERE (phone=? OR username=?) AND id!=?').get(phone,phone,id||-1))fail('该手机号已被其他账号使用',409);
  };
  function preview(fromId,toId) {
    const from=getEmployee(fromId),to=getEmployee(toId);
    if(!from||!to)fail('交接员工不存在',404);
    if(from.id===to.id)fail('接替人不能是本人');
    if(from.role==='超级管理员')fail('主账号不办理员工离职交接');
    if(!to.active)fail('接替账号已停用',409);
    if(to.role!==from.role)fail('请选择相同岗位的接替人员',409);
    const rows=allOrders().filter(row=>ownsOrder(from,row.order));
    const token=crypto.createHash('sha256').update(JSON.stringify({from,to,rows:rows.map(r=>[r.id,r.data])})).digest('hex');
    return {from,to,rows,token};
  }
  function summarize(p) {
    return {from:publicEmployee(p.from),to:publicEmployee(p.to),previewToken:p.token,
      total:p.rows.length,completed:p.rows.filter(r=>r.order.status==='已完成').length,
      inProgress:p.rows.filter(r=>r.order.status!=='已完成').length,
      pendingTasks:p.rows.reduce((n,r)=>n+r.order.flowTasks.filter(t=>t.ownerRole===p.from.role&&['待处理','待管理员审批'].includes(t.status)).length,0),
      orders:p.rows.map(({order:o})=>({id:o.id,storeName:o.storeName||o.customer,status:o.status,workflowLabel:o.workflowLabel}))};
  }
  return async function handleEmployees(req,url,user,res) {
    if(!url.pathname.startsWith('/api/employees'))return false;
    requireRole(user,['超级管理员']);
    if(url.pathname==='/api/employees'&&req.method==='GET') {
      const orders=allOrders();
      const employees=db.prepare('SELECT id,username,name,role,phone,active,auth_version FROM users ORDER BY active DESC,id').all().map(employee=>{
        const assigned=orders.filter(r=>ownsOrder(employee,r.order));
        return {...publicEmployee(employee),orderCount:assigned.length,activeOrderCount:assigned.filter(r=>r.order.status!=='已完成').length};
      }).sort((a,b)=>Number(b.id===user.id)-Number(a.id===user.id)||b.active-a.active||b.orderCount-a.orderCount||a.id-b.id);
      const handovers=db.prepare('SELECT * FROM employee_handovers ORDER BY created_at DESC,rowid DESC LIMIT 100').all().map(({order_ids,...record})=>({...record,orderCount:JSON.parse(order_ids).length}));
      json(res,200,{employees,handovers,roles:roles.filter(r=>r!=='超级管理员')});return true;
    }
    if(url.pathname==='/api/employees'&&req.method==='POST') {
      const body=await readJson(req),name=String(body.name||'').trim(),phone=String(body.phone||'').trim(),role=String(body.role||'');
      if(!name||name.length>40)fail('姓名请填写1至40字');
      if(!phone)fail('请填写登录手机号');checkPhone(phone);
      if(!roles.includes(role)||role==='超级管理员')fail('请选择员工岗位');
      const password=String(body.password||'');if(password.length<8||password.length>128)fail('初始密码请设置8至128位');
      const result=db.prepare('INSERT INTO users(username,name,role,password_hash,active,phone) VALUES(?,?,?,?,1,?)').run('staff_'+crypto.randomUUID().slice(0,13),name,role,hashPassword(password),phone);
      audit(user,null,'新增员工',`${name} · ${role}`);
      json(res,201,{employee:publicEmployee(getEmployee(Number(result.lastInsertRowid)))});return true;
    }
    const match=url.pathname.match(/^\/api\/employees\/(\d+)(?:\/(handover-preview|handover))?$/);
    if(!match)fail('员工管理接口不存在',404);
    const id=Number(match[1]),action=match[2];
    if(action==='handover-preview'&&req.method==='GET') {
      json(res,200,summarize(preview(id,Number(url.searchParams.get('to')))));return true;
    }
    if(action==='handover'&&req.method==='POST') {
      const body=await readJson(req);let record;
      db.exec('BEGIN IMMEDIATE');
      try {
        const p=preview(id,Number(body.toEmployeeId));
        if(typeof body.previewToken!=='string'||body.previewToken!==p.token)fail('订单或员工信息已变化，请重新预览后交接',409);
        const timestamp=now(),handoverId=crypto.randomUUID();
        for(const {order} of p.rows) {
          order.ownerUserId=p.to.id;order.ownerUsername=p.to.username;order.ownerName=p.to.name;
          order.infoRevision=(order.infoRevision||0)+1;
          order.handoverHistory=[...(order.handoverHistory||[]),{handoverId,fromId:p.from.id,fromName:p.from.name,toId:p.to.id,toName:p.to.name,operator:user.name,createdAt:timestamp}];
          db.prepare('UPDATE orders SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(order),timestamp,order.id);
        }
        db.prepare('UPDATE users SET active=0,auth_version=auth_version+1 WHERE id=?').run(p.from.id);
        const note=String(body.note||'').trim().slice(0,500);
        db.prepare('INSERT INTO employee_handovers(id,from_user_id,to_user_id,from_name,to_name,role,actor,order_ids,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(handoverId,p.from.id,p.to.id,p.from.name,p.to.name,p.from.role,user.name,JSON.stringify(p.rows.map(r=>r.id)),note,timestamp);
        record={id:handoverId,fromName:p.from.name,toName:p.to.name,orderCount:p.rows.length,createdAt:timestamp};
        audit(user,null,'员工离职交接',`${record.fromName} → ${record.toName} · ${record.orderCount}单`);
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
      invalidateSessions(id);json(res,200,{handover:record});return true;
    }
    if(!action&&req.method==='PUT') {
      const body=await readJson(req),employee=getEmployee(id);if(!employee)fail('员工不存在',404);
      const name=String(body.name??employee.name).trim(),phone=String(body.phone??employee.phone??'').trim(),role=String(body.role??employee.role),active=body.active===undefined?employee.active:body.active===true||body.active===1?1:body.active===false||body.active===0?0:NaN;
      if(!name||name.length>40)fail('姓名请填写1至40字');checkPhone(phone,id);
      if((!roles.includes(role)&&role!==employee.role)||!Number.isFinite(active))fail('岗位或账号状态无效');
      if(role==='超级管理员'&&employee.role!=='超级管理员')fail('不能将员工账号改为主账号');
      if(id===user.id&&(!active||role!==employee.role))fail('不能停用本人或移除本人的主账号权限',409);
      if(employee.role==='超级管理员'&&(!active||role!==employee.role)&&!db.prepare("SELECT id FROM users WHERE role='超级管理员' AND active=1 AND id!=?").get(id))fail('至少保留一个启用的主账号',409);
      if(role!==employee.role&&allOrders().some(row=>ownsOrder(employee,row.order)))fail('该员工仍负责订单，请先完成交接再调整岗位',409);
      db.prepare('UPDATE users SET name=?,phone=?,role=?,active=?,auth_version=auth_version+1 WHERE id=?').run(name,phone||null,role,active,id);
      audit(user,null,'修改员工账号',`${name} · ${role} · ${active?'启用':'停用'}`);
      invalidateSessions(id);json(res,200,{employee:publicEmployee(getEmployee(id))});return true;
    }
    fail('不支持的员工管理操作',405);
  };
}
