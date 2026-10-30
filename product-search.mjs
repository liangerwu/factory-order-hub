const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const normalize = value => String(value || '').normalize('NFKC').toLowerCase();

export function searchProducts(catalog, query, limit = 30) {
  const normalized = normalize(query).trim();
  const tokens = [...new Set([...segmenter.segment(normalized)]
    .filter(part => part.isWordLike)
    .flatMap(part => part.segment.match(/[\p{Script=Han}]+|[a-z]+|\d+(?:\.\d+)?|[\p{L}]+/gu) || []))];
  // Symbol-only product codes (e.g. "*" in the supplied catalog) remain searchable.
  if (!tokens.length && normalized) tokens.push(normalized);
  const matches = catalog.filter(product => {
    const fields = [product.code,product.name,product.specification,product.category].map(normalize);
    return tokens.every(token => fields.some(field => field.includes(token)));
  });
  matches.sort((a,b) => Number(normalize(b.code) === normalized) - Number(normalize(a.code) === normalized));
  return { products: matches.slice(0,limit), total: catalog.length, matched: matches.length };
}
