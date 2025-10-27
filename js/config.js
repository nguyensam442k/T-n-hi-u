// Cấu hình: 1 nguồn (Binance), 3 symbol, TF 15m
window.App = {
  CONFIG: {
    symbols: ['BTCUSDT','ETHUSDT','SOLUSDT'],
    timeframe: '15m',
    candlesLimit: 750,
    risk: { perTradeUSD: 100, leverage: 25 }, // 100u x 25
    tpSplit: [0.30,0.30,0.40],                // TP1/2/3 phân bổ
    tpR: [0.8, 1.4, 2.0],                     // RR TP1..3
    ema: [21,50,200], rsiPeriod: 14, stoch:[14,3], atr:14,
  },

  // === Data: Binance only ===
  async getKlines(symbol, interval='15m', limit=500){
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error('Binance fetch failed: ' + res.status);
    const data = await res.json();
    return data.map(k=>({t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5]}));
  },

  // === Indicators ===
  SMA(a, n){ const o=[]; let s=0; for(let i=0;i<a.length;i++){ s+=a[i]; if(i>=n) s-=a[i-n]; o.push(i>=n-1?s/n:null);} return o; },
  EMA(a, n){ const k=2/(n+1), o=[]; let p=null; for(let i=0;i<a.length;i++){ const v=a[i]; p=(p===null?v:v*k+p*(1-k)); o.push(p);} return o; },
  RSI(c, p=14){ const r=Array(c.length).fill(null); let g=0,l=0; for(let i=1;i<=p;i++){ const d=c[i]-c[i-1]; g+=Math.max(d,0); l+=Math.max(-d,0);} let G=g/p, L=l/p; r[p]=100-100/(1+ (L===0?100:G/L)); for(let i=p+1;i<c.length;i++){ const d=c[i]-c[i-1]; G=(G*(p-1)+Math.max(d,0))/p; L=(L*(p-1)+Math.max(-d,0))/p; const RS=L===0?100:G/L; r[i]=100-100/(1+RS);} return r; },
  Stoch(H,L,C,p=14,s=3){ const K=[]; for(let i=0;i<C.length;i++){ const a=Math.max(0,i-p+1), hh=Math.max(...H.slice(a,i+1)), ll=Math.min(...L.slice(a,i+1)); K[i]=(hh===ll)?50:((C[i]-ll)/(hh-ll))*100 } const D=this.SMA(K,s); return {k:K,d:D}; },
  ATR(H,L,C,p=14){ const tr=[null]; for(let i=1;i<C.length;i++){ const hl=H[i]-L[i], hc=Math.abs(H[i]-C[i-1]), lc=Math.abs(L[i]-C[i-1]); tr[i]=Math.max(hl,hc,lc);} const a=this.SMA(tr.slice(1),p); a.unshift(null); return a; },

  expiryBars(){ return 16 }, // 15m ~ 4h
  fmt2:(x)=> (Math.round(x*100)/100).toFixed(2)
};
