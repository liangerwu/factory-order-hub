import {flowStepNumber} from './workflow.mjs';
import { finalPaymentAmount } from './order-amounts.mjs';
// A small, dependency-free OOXML writer. All user content uses inline strings,
// preserving leading zeros and preventing spreadsheet formula execution.
const xml = value => String(value ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const column = index => { let s=''; for (let n=index+1;n;n=Math.floor((n-1)/26)) s=String.fromCharCode(65+(n-1)%26)+s; return s; };
function zip(entries) {
  const local=[],central=[]; let offset=0;
  const table=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  for (const [name,content] of entries) {
    const data=Buffer.from(content),filename=Buffer.from(name); let crc=0xffffffff;
    for(const b of data) crc=table[(crc^b)&255]^(crc>>>8); crc=(crc^0xffffffff)>>>0;
    const head=Buffer.alloc(30); head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt16LE(0x21,12);head.writeUInt32LE(crc,14);head.writeUInt32LE(data.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(filename.length,26);
    local.push(head,filename,data);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(0x21,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(filename.length,28);record.writeUInt32LE(offset,42);
    central.push(record,filename);offset+=head.length+filename.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
function singleTable(rows) {
  const parts=value=>{
    let text=String(value ?? '');const output=[];
    while(text.length>32767){let n=32767;if(/[\uD800-\uDBFF]/.test(text[n-1]))n--;output.push(text.slice(0,n));text=text.slice(n);}
    return [...output,text];
  };
  const split=rows.slice(1).map(row=>row.map(parts));
  const counts=rows[0].map((_,c)=>Math.max(1,...split.map(row=>row[c].length)));
  if(counts.reduce((sum,n)=>sum+n,0)>16384)throw new Error('导出内容过多，请缩小订单范围');
  return [rows[0].flatMap((heading,c)=>Array.from({length:counts[c]},(_,i)=>i?`${heading}（续${i}）`:heading)),...split.map(row=>row.flatMap((cells,c)=>Array.from({length:counts[c]},(_,i)=>cells[i]||'')))];
}
function sheet(rows) {
  if (rows.length>1048576) throw new Error('导出明细过多，请缩小日期范围');
  const last=column(rows[0].length-1)+rows.length;
  const widths=rows[0].map((heading,i)=>/流程进度|资金记录/.test(heading)?88:/产品明细|货品明细|特殊备注/.test(heading)?65:/地址/.test(heading)?38:i===0?22:24);
  const height=row=>Math.min(409,Math.max(42,...row.map((value,c)=>String(value??'').split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((width,char)=>width+(char.charCodeAt(0)>255?2:1),0)/widths[c])),0)*15+12)));
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width,i)=>`<col min="${i+1}" max="${i+1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.map((row,r)=>`<row r="${r+1}" ht="${r===0?30:height(row)}" customHeight="1">${row.map((value,c)=>`<c r="${column(c)}${r+1}" t="inlineStr" s="${r===0?1:0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}
export function exportOrders(orders, financial, shippingCost = false) {
  const value=(o,key)=>o.entryValues?.[key] ?? o[key] ?? '';
  const headers=['订单编号','订单日期','订单类型','采购方式','店铺名称','店铺订单号','收件人姓名','收件人电话','收件地址','客户要求物流信息','货品明细','特殊备注','物流单号','业务员','当前状态','当前责任岗位','货品图片数量','来源订单','原创建人','当前负责人'];
  if(financial) headers.push('历史订单单价','总货款','优惠金额','实际总货款','成本','毛利','运费','代收','预付款金额','尾款金额','预付款要求','实际到账金额','尚未到账金额','收款账户','付款凭证数量');
  headers.push('产品明细（含箱规）','流程进度','唛头描述','唛头图片数量','物流公司','发货日期','发货姓名','发货地址','发货件数');
  if(financial||shippingCost)headers.push('发货运费');
  if(financial)headers.push('资金记录');
  const summary=[headers];
  for(const o of orders) {
    const row=[o.id,o.orderDate||o.created,o.workflowLabel,o.businessSelfProcurement?'业务自行采购标贴':'按岗位流程',o.storeName||o.customer,o.shopOrderNumber,o.recipient,o.contact,o.address,o.logisticsRequirements||'',o.product,o.specialNotes||o.notes,o.trackingNumber,o.salesperson||o.creatorName,o.status,o.flowTasks.filter(t=>['待处理','待管理员审批'].includes(t.status)).map(t=>t.ownerRole).join('、'),o.images?.length||0,o.sourceOrderId,o.creatorName,o.ownerName||o.creatorName];
    if(financial) row.push(o.pricingVersion===1?'':value(o,'price'),o.grossAmount??value(o,'amount'),o.discountAmount??0,value(o,'amount'),value(o,'cost'),value(o,'grossProfit'),value(o,'freight'),value(o,'codAmount'),o.prepaymentAmount,finalPaymentAmount(o)??'待核实',o.depositRequirement||o.depositAmount,o.received,o.amountIsNumeric===false?'待核实':Math.max(0,Math.round((o.amount-o.received)*100)/100),o.paymentAccount,o.paymentProofs?.length||0);
    row.push(o.lineItems?.length?o.lineItems.map(p=>`${p.product}｜颜色：${p.color||'—'}｜规格：${p.specification||'—'}｜数量：${p.quantity}${p.unit||''}${financial?'｜单价：'+p.unitPrice+'｜金额：'+p.amount:''}`).join('\n'):(o.productItems||[]).map(p=>`${p.code}｜${p.name}｜规格／分类：${p.specification||p.category||'—'}｜数量：${p.quantity}${p.unit||''}｜箱规：${p.casePack??'—'}`).join('\n')||o.product);
    row.push(o.flowTasks.map(t=>`第${flowStepNumber(o,t)}步 ${t.name}｜${t.ownerRole}｜${t.status}${t.assignee?'｜经办：'+t.assignee:''}${t.completedAt?'｜完成：'+t.completedAt:''}`).join('\n'));
    row.push(o.shippingMarkDescription || '',o.shippingMarkImages?.length || 0,o.logistics || '',o.shipment?.date||'',o.shipment?.recipient??o.recipient,o.shipment?.address??o.address,o.shipment?.packageCount??'');
    if(financial||shippingCost)row.push(o.shipment?.freight??'');
    if(financial) {
      row.push([...(o.receipts||[]).map(r=>['客户到账',r.amount,r.date||r.createdAt,r.operator,r.note]),...(o.outgoingPayments||[]).map(r=>['工单付款',r.amount,r.createdAt,r.operator,r.note])].map(record=>record.map(v=>v??'').join('｜')).join('\n'));
    }
    summary.push(row);
  }
  const sheets=[['订单汇总',singleTable(summary)]];
  const entries=[['[Content_Types].xml',`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml',`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([name],i)=>`<sheet name="${name}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>']];
  sheets.forEach(([,rows],i)=>entries.push([`xl/worksheets/sheet${i+1}.xml`,sheet(rows)]));
  return zip(entries);
}
