// All calendar dates in this internal system follow the company's China timezone.
export function businessDate(value = new Date(), offset = 0) {
  return new Date(new Date(value).getTime() + 8 * 3600000 + offset * 86400000).toISOString().slice(0,10);
}
export function moneyCents(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
export function statusClass(status = '') {
  if (status.includes('驳回') || status.includes('异常') || status.includes('未到账')) return 'red';
  if (status.includes('审批') || status.includes('待') || status.includes('部分')) return 'amber';
  if (status.includes('完成') || status.includes('全额到账') || status === '已核对' || status === '已发货') return 'green';
  return '';
}
// This is a submission identifier, not an authentication token. getRandomValues
// is available on LAN HTTP where browsers may not expose randomUUID.
export function createRequestId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues !== 'function') throw new Error('当前浏览器不支持生成提交标识，请使用新版浏览器');
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte=>byte.toString(16).padStart(2,'0')).join('');
}

// Parse pasted delivery text locally. Missing/ambiguous values are left for review.
export function parseShippingAddress(input) {
  let text=String(input??'').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\r/g,'').trim().slice(0,5000);
  if(!text)return {};
  const receiver=text.search(/收件人姓名|收货人姓名|收件人|收货人|收方/);
  if(receiver>=0&&/(?:寄件|寄方|发件|发货人)/.test(text))text=text.slice(receiver).split(/寄件人|寄件地址|寄方|发件人|发货人/)[0];
  const labels={收件人姓名:'recipient',收货人姓名:'recipient',收件人电话:'contact',收货人电话:'contact',收件人地址:'address',收货人地址:'address',收件电话:'contact',收货电话:'contact',联系电话:'contact',手机号码:'contact',收件地址:'address',收货地址:'address',详细地址:'address',收件人:'recipient',收货人:'recipient',联系人:'recipient',手机号:'contact',姓名:'recipient',电话:'contact',手机:'contact',地址:'address',收方:'recipient'};
  const marker=new RegExp(Object.keys(labels).join('|'),'g'),matches=[...text.matchAll(marker)],explicit={};
  const trim=s=>s.replace(/^[\s:：,，;；|]+|[\s,，;；|]+$/g,'');
  for(let i=0;i<matches.length;i++){
    const key=labels[matches[i][0]],start=matches[i].index+matches[i][0].length,end=matches[i+1]?.index??text.length;
    const value=trim(text.slice(start,end));if(value&&!explicit[key])explicit[key]=value;
  }
  const phonePattern=/(?:\+?86[\s-]*)?1[3-9]\d[\s-]*\d{4}[\s-]*\d{4}|0\d{2,3}[-\s]?\d{7,8}(?:\s*(?:转|ext\.?|分机)\s*\d{1,6})?|\+\d(?:[\d ()-]{5,24})\d/gi;
  const findPhones=s=>[...s.matchAll(phonePattern)].filter(m=>!/[\d]/.test(s[m.index-1]||'')&&!/[\d]/.test(s[m.index+m[0].length]||'')).map(m=>trim(m[0]));
  const phones=[...new Set(findPhones(explicit.contact||text))];
  const result={};if(phones.length===1)result.contact=phones[0].replace(/\s+/g,' ').trim();
  const removePhones=s=>s.replace(phonePattern,' ').replace(marker,' ').replace(/[:：]/g,' ');
  const validName=s=>/^[\p{L}·. ]{2,40}$/u.test(s)&&!/(省|市|区|县|路|街|号|地址|电话|收件|收货|备注)/.test(s);
  const rawName=explicit.recipient?trim(removePhones(explicit.recipient).split(/[\n,，;；|]/)[0]):'';
  const namePart=rawName.split(/\s{2,}/)[0];if(validName(namePart))result.recipient=namePart;
  if(explicit.address)result.address=trim(removePhones(explicit.address));
  let remaining=trim(removePhones(text));
  if(result.recipient)remaining=remaining.replace(result.recipient,' ');
  if(!result.address){
    const region=/(?:北京市|天津市|上海市|重庆市|内蒙古(?:自治区)?|广西(?:壮族自治区)?|宁夏(?:回族自治区)?|新疆(?:维吾尔自治区)?|西藏(?:自治区)?|香港(?:特别行政区)?|澳门(?:特别行政区)?|(?:黑龙江|吉林|辽宁|河北|河南|山西|陕西|山东|安徽|江苏|浙江|福建|江西|湖北|湖南|广东|海南|四川|贵州|云南|甘肃|青海|台湾)省|[\u4e00-\u9fff]{2,8}市)/;
    const match=remaining.match(region);
    if(match){
      const prefix=trim(remaining.slice(0,match.index));if(!result.recipient&&validName(prefix))result.recipient=prefix;
      let address=trim(remaining.slice(match.index));
      const chunks=address.split(/[\n,，;；|]|\s{2,}/).map(trim).filter(Boolean);
      const tail=chunks.at(-1);if(!result.recipient&&chunks.length>1&&validName(tail)){result.recipient=tail;chunks.pop();address=chunks.join('');}
      result.address=address.replace(/\s*\n\s*/g,'');
    }
  }
  if(!result.recipient&&result.address){const rest=trim(remaining.replace(result.address,' '));if(validName(rest))result.recipient=rest;}
  if(!result.address){const chunks=remaining.split(/[\n,，;；|]/).map(trim).filter(Boolean);if(chunks.length>=2){if(!result.recipient&&validName(chunks[0]))result.recipient=chunks.shift();const address=chunks.join(' ');if(/\d/.test(address)&&/(?:路|街|号|楼|室|村|镇|Road|Street|Ave|邮编)/i.test(address))result.address=address;}}
  if(!result.address&&!result.contact&&!explicit.recipient)delete result.recipient;
  return result;
}
