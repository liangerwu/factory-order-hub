function cents(value) {
  const text=String(value ?? '').trim();
  if(!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole,fraction='']=text.split('.');
  const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(result)?result:null;
}
// Declared balance after prepayment; actual outstanding receipts remain separate.
export function finalPaymentAmount(order) {
  const total=cents(order.entryValues?.amount ?? order.amount),prepayment=cents(order.pricingVersion===1&&String(order.prepaymentAmount??'').trim()===''?0:order.prepaymentAmount);
  if(total===null||prepayment===null||prepayment>total)return null;
  return (total-prepayment)/100;
}

export function calculateOrderPricing(items, freight = '', discount = '') {
  if(!Array.isArray(items)||!items.length||items.length>100)throw new Error('请添加1至100条产品明细');
  let subtotal=0n;
  const lines=items.map((item,index)=>{
    if(!item||typeof item!=='object')throw new Error('产品明细无效');
    const product=String(item.product??item.name??'').trim(),color=String(item.color??'').trim(),specification=String(item.specification??'').trim();
    if(!product||product.length>300||color.length>100||specification.length>300)throw new Error(`第${index+1}行产品、颜色或规格无效`);
    const quantity=String(item.quantity??'').trim(),price=cents(item.unitPrice);
    if(!/^\d+(\.\d{1,3})?$/.test(quantity)||Number(quantity)<=0||Number(quantity)>1e9)throw new Error(`第${index+1}行数量请填写正数，最多3位小数`);
    if(price===null||price>1e14)throw new Error(`第${index+1}行待补价格：请填写有效单价，最多两位小数`);
    const [whole,part='']=quantity.split('.'),scaled=BigInt(whole)*1000n+BigInt(part.padEnd(3,'0'));
    const amount=(scaled*BigInt(price)+500n)/1000n;subtotal+=amount;
    if(subtotal>100000000000000n)throw new Error('订单金额超过允许范围');
    return {product,color,specification,quantity:Number(quantity),unitPrice:price/100,amount:Number(amount)/100,unit:String(item.unit??'').slice(0,20),code:String(item.code??'').slice(0,300)};
  });
  const freightCents=cents(String(freight).trim()===''?'0':freight),discountCents=cents(String(discount).trim()===''?'0':discount);
  if(freightCents===null||freightCents>1e14)throw new Error('运费请填写有效非负金额，最多两位小数');
  if(discountCents===null)throw new Error('优惠金额请填写有效非负金额，最多两位小数');
  const gross=subtotal+BigInt(freightCents);
  if(gross>100000000000000n)throw new Error('订单金额超过允许范围');
  if(BigInt(discountCents)>gross)throw new Error('优惠金额不能超过总货款');
  return {lineItems:lines,itemsSubtotal:Number(subtotal)/100,freight:freightCents/100,grossAmount:Number(gross)/100,discountAmount:discountCents/100,amount:Number(gross-BigInt(discountCents))/100};
}

export function parseProductDescription(value) {
  const variantPattern='(?:透明色|透明|黑色|棕色|无色|白色|蓝色|黄色|红色|绿色|粉色|黑盒|棕盒|白盒|蓝盒|黄盒|红盒|绿盒|粉盒)';
  // A new variant after a quantity starts a separate line, with or without spaces.
  const chunks=String(value??'').normalize('NFKC').replace(new RegExp('(\\d+(?:\\.\\d{1,3})?\\s*(?:只|盒|瓶|套|包|件|张|个|支|桶|袋|箱))\\s*(?='+variantPattern+')','g'),'$1\n').split(/[\n;；、，,]+/).map(s=>s.trim()).filter(Boolean);
  const items=[],unparsed=[];let lastProduct='',lastSpec='';
  for(const chunk of chunks){
    if(/^(?:备注|包装要求|装一箱|装\d+箱|一箱|请|如果|联系|发货要求)/.test(chunk)){unparsed.push(chunk);continue;}
    const priceMatch=chunk.match(/(?:(?:单价|价格)\s*[:：]?\s*|每(?:只|盒|瓶|套|包|件|张|个|支)?\s*|@\s*)(\d+(?:\.\d{1,2})?)\s*元?|(?:^|\s)(\d+(?:\.\d{1,2})?)\s*元\s*[\/／]\s*(?:只|盒|瓶|套|包|件|张|个|支)/i);
    let remaining=priceMatch?chunk.replace(priceMatch[0],' '):chunk;
    const quantities=[...remaining.matchAll(/(\d+(?:\.\d{1,3})?)\s*(只|盒|瓶|套|包|件|张|个|支|桶|袋|箱)/g)],q=quantities.at(-1);
    if(!q||Number(q[1])<=0){unparsed.push(chunk);continue;}
    remaining=remaining.slice(0,q.index)+remaining.slice(q.index+q[0].length);
    const spec=remaining.match(/\d+(?:\.\d+)?\s*(?:kg|ml|g|l|毫升|克|千克|升)(?:\s*[×x*]\s*\d+)?/i);
    if(spec)remaining=remaining.replace(spec[0],' ');
    const colors=[...remaining.matchAll(new RegExp(variantPattern,'g'))].map(match=>match[0]);
    remaining=remaining.replace(new RegExp(variantPattern,'g'),' ');
    remaining=remaining.replace(/(?:[¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*元)/g,' ');
    let product=remaining.replace(/^[\s,，:：-]+|[\s,，:：-]+$/g,'').replace(/\s+/g,' ');
    const inherited=!product;if(inherited)product=lastProduct;
    if(!product){unparsed.push(chunk);continue;}
    const specification=spec?.[0]||(inherited?lastSpec:'');
    items.push({product,name:product,color:[...new Set(colors)].join(' / '),specification,quantity:q[1],unit:q[2],unitPrice:priceMatch?(priceMatch[1]??priceMatch[2]):''});lastProduct=product;lastSpec=specification;
  }
  return {items,unparsed};
}
