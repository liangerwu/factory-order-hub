import readline from 'node:readline/promises';
import {Writable} from 'node:stream';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),file=path.join(root,'deploy/initial-admins.json');
if(!process.stdin.isTTY)throw Error('请在交互终端运行初始化工具');
if(fs.existsSync(file))throw Error('初始化配置已存在，不覆盖；如需修改已有账号，请通过系统管理流程处理');
let hidden=false;const output=new Writable({write(chunk,encoding,callback){if(!hidden)process.stdout.write(chunk);callback();}});
const rl=readline.createInterface({input:process.stdin,output,terminal:true});
try{
 const admins=[];
 for(let i=1;i<=3;i++){
  const phone=(await rl.question(`管理员${i}手机号：`)).trim();
  if(!/^1[3-9]\d{9}$/.test(phone)||admins.some(a=>a.phone===phone))throw Error('手机号无效或重复');
  process.stdout.write('初始密码（输入隐藏）：');hidden=true;let password;
  try{password=await rl.question('');}finally{hidden=false;process.stdout.write('\n');}
  if(password.length<6||password.length>128)throw Error('初始密码须6至128位');
  const salt=crypto.randomBytes(16).toString('hex');
  admins.push({phone,name:`超级管理员${i}`,hash:salt+':'+crypto.scryptSync(password,salt,64).toString('hex')});
 }
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(admins,null,2),{mode:0o600,flag:'wx'});
 console.log('已生成本地初始化哈希。请勿提交此文件到Git。首次登录将要求修改密码。');
}finally{rl.close();}
