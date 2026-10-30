import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const run=promisify(execFile),source=fileURLToPath(new URL('./shipping-ocr.swift',import.meta.url));
const digest=createHash('sha256').update(readFileSync(source)).digest('hex').slice(0,16);
const cache=path.join(tmpdir(),'order-hub-local-ocr-'+process.getuid?.()),binary=path.join(cache,'vision-'+digest);
let compile, busy=0;
async function ensureBinary(){
 if(process.platform!=='darwin')throw Object.assign(new Error('当前服务器尚未配置文字识别，可手动填写；本机测试支持macOS识别'),{status:503});
 if(!compile)compile=(async()=>{await mkdir(cache,{recursive:true,mode:0o700});try{await access(binary);}catch{await run('/usr/bin/xcrun',['swiftc',source,'-o',binary],{timeout:120000,maxBuffer:100000});}})().catch(e=>{compile=null;throw e;});
 await compile;return binary;
}
const carriers=[
 ['豪翔运输',/豪翔(?:运输|物流)/i],['德坤浩运',/德坤|\bDEKUN\b/i],
 ['鸿泰物流',/鸿泰物流/i],['创新物流',/创新物流|chuangxin56\.cn/i],
 ['顺丰',/顺丰|SF\s*EXPRESS/i],['京东',/京东|JD\s*LOGISTICS/i],
 ['中通快运',/中通\s*快运|zto56\.com/i],['中通',/中通|ZTO/i],
 ['圆通',/圆通|YTO/i],['申通',/申通|STO\s*EXPRESS/i],
 ['韵达快运',/韵达\s*快运/],['韵达',/韵达|YUNDA/i],
 ['极兔',/极兔|J&T|J T EXPRESS/i],['德邦',/德邦|DEPPON/i],
 ['邮政EMS',/\bEMS\b|中国邮政/i],['百世',/百世|BEST\s*EXPRESS/i],['安能',/安能|ANE\s*LOGISTICS/i]
];
const trackingLabel=/(?:快递单号|物流单号|运单号码?|票号|单号|Waybill\s*(?:No\.?|Number)|Tracking\s*(?:No\.?|Number))\s*[:：]?/i;
function validNumber(value){
 const n=String(value).replace(/[\s-]/g,'').toUpperCase();
 return /^(?:[A-Z]{1,4})?\d{8,24}$/.test(n)&&!/^20\d{6}$/.test(n)?n:null;
}
function numberAtStart(value){
 // Stop at the next field: never join a tracking number to a phone or date.
 const cleaned=String(value).trim();
 if(/^(?:电话|手机|日期|时间)|^https?:|^\d{4}[-/.年]\d{1,2}[-/.月]/i.test(cleaned))return null;
 const token=cleaned.match(/^(?:[A-Z]{1,4}\s*)?\d(?:[\d -]*\d)?/i)?.[0];
 return token?validNumber(token):null;
}
export function analyzeShippingFields(lines=[],barcodes=[],logoEvidence=[]){
 const rows=lines.map(s=>String(s).normalize('NFKC').trim()).filter(Boolean),all=rows.join('\n');
 const headers=logoEvidence.map(e=>(e.texts||[]).map(t=>String(t).normalize('NFKC').replace(/\s+/g,'')).join('\n'));
 let companies=carriers.filter(([,re])=>[all,...headers].some(text=>re.test(text))).map(([name])=>name);
 // A damaged decorative logo can retain its distinctive three characters.
 // Require a DK waybill as corroboration; DK alone is never a carrier match.
 if(headers.some(t=>/坤浩运/.test(t))&&/\bDK\d{8,24}\b/i.test(all))companies.push('德坤浩运');
 if(headers.some(t=>/韵达/.test(t)&&/快运/.test(t)))companies.push('韵达快运');
 companies=[...new Set(companies)].filter(n=>!((n==='中通'&&companies.includes('中通快运'))||(n==='韵达'&&companies.includes('韵达快运'))));
 const labelled=[];
 for(let i=0;i<rows.length;i++){
  const match=rows[i].match(trackingLabel);if(!match)continue;
  const rest=rows[i].slice(match.index+match[0].length).replace(/^[\s:：]+/,'');
  const number=numberAtStart(rest||rows[i+1]||'');if(number)labelled.push(number);
 }
 const barcodeNumbers=barcodes.map(s=>/^(?:[A-Z]{1,4})?\d{8,24}$/i.test(String(s).trim())?validNumber(String(s).trim()):null).filter(Boolean);
 const prefixed=[...all.matchAll(/\b(?:SF|JT|JD|YT|DK)\d{10,22}\b/gi)].map(m=>m[0].toUpperCase());
 const top=rows.slice(0,3).filter(s=>/^\d{8,24}$/.test(s)&&!/^1[3-9]\d{9}$/.test(s)).map(validNumber).filter(Boolean);
 const numbers=[...new Set(labelled.length?labelled:barcodeNumbers.length?barcodeNumbers:prefixed.length?prefixed:top)];
 const fields={};if(companies.length===1)fields.logistics=companies[0];if(numbers.length===1)fields.trackingNumber=numbers[0];
 return {fields,status:{logistics:companies.length>1?'conflict':companies.length?'recognized':'missing',trackingNumber:numbers.length>1?'conflict':numbers.length?'recognized':'missing'},candidates:{logistics:companies,trackingNumber:numbers}};
}
export function extractShippingFields(lines=[],barcodes=[],logoEvidence=[]){return analyzeShippingFields(lines,barcodes,logoEvidence).fields;}
export async function recognizeImageText(images,{products=false}={}){
 if(busy>=2)throw Object.assign(new Error('当前正在识别其他图片，请稍后重试'),{status:429});
 busy++;let dir;
 try{const bin=await ensureBinary();dir=await mkdtemp(path.join(tmpdir(),'order-label-'));const paths=[];for(const [i,img]of images.entries()){const p=path.join(dir,String(i)+'.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[img.mime]));await writeFile(p,img.bytes,{mode:0o600});paths.push(p);}const {stdout}=await run(bin,products?['--products',...paths]:paths,{timeout:45000,maxBuffer:500000});return JSON.parse(stdout);
 }catch(e){if(e.status)throw e;throw Object.assign(new Error('识别失败，请上传清晰正向图片，或手动填写'),{status:422});}finally{busy--;if(dir)await rm(dir,{recursive:true,force:true});}
}

export async function recognizeShipping(images){
 const raw=await recognizeImageText(images);
 const pages=(raw.pages?.length?raw.pages:[raw]).map((page,index)=>({page:index+1,...analyzeShippingFields(page.lines,page.barcodes,page.logoEvidence)}));
 const fields={},status={},candidates={};
 for(const key of ['logistics','trackingNumber']){
  const values=[...new Set(pages.flatMap(p=>p.candidates[key]))];candidates[key]=values;
  status[key]=values.length>1?'conflict':values.length?'recognized':'missing';
  if(values.length===1)fields[key]=values[0];
 }
 // Different waybills must not silently become one combined shipment.
 if(status.trackingNumber==='conflict'){delete fields.logistics;status.logistics='conflict';}
 return {fields,status,candidates,pages,text:(raw.lines||[]).join('\n').slice(0,12000)};
}
