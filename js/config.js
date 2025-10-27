// Danny Signals — CryptoCompare only (fix this-binding)
window.App = {
  CONFIG: {
    symbols: ['BTCUSDT','ETHUSDT','SOLUSDT'],
    timeframe: '15m',
    candlesLimit: 750,                        // số điểm (bars) muốn lấy
    risk: { perTradeUSD: 100, leverage: 25 }, // 100u x 25
    tpSplit: [0.30,0.30,0.40],
    tpR: [0.8, 1.4, 2.0],
    ema: [21,50,200], rsiPeriod: 14, stoch:[14,3], atr:14,
  },

  // ===== Debug banner =====
  showError(msg){
    let el = document.getElementById('debugBanner');
    if(!el){
      el = document.createElement('div');
      el.id = 'debugBanner';
      el.style.cssText =
        'margin:10px 0;padding:10px;border:1px solid #fca5a5;background:#fee2e2;color:#991b1b;border-radius:8px;font-size:14px';
      document.querySelector('.wrap')?.prepend(el);
    }
    el.textContent = 'DEBUG: ' + msg;
    console.warn('DEBUG:', msg);
  },

  // ===== CryptoCompare (minute/hour/day auto) =====
  async fetchCC(symbol, interval='15m', limit=500){
    // symbol: BTCUSDT → fsym=BTC, tsym=USDT
    const fsym = symbol.replace(/USDT$/,'');
    const tsym = 'USDT';
    const base = 'https://min-api.cryptocompare.com/data';
    const path = interval.endsWith('m')
      ? 'histominute'
      : interval.endsWith('h')
      ? 'histohour'
      : 'histoday';
    const aggregate = parseInt(interval) || 15;          // 15m → aggregate=15
    const url = `${base}/${path}?fsym=${fsym}&tsym=${tsym}` +
                `&limit=${Math.min(limit,2000)}&aggregate=${aggregate}&e=CCCAGG`;

    const r = await fetch(url);
    if(!r.ok) throw new Error('CryptoCompare ' + r.status);
    const j = await r.json();
    if(j.Response === 'Error') throw new Error(j.Message || 'CC error');

    // Một số payload có dạng Data.Data
    const arr = (j.Data && (j.Data.Data || j.Data)) || j;
    return arr.map(k => ({
      t: (k.time || k.time_close) * 1000,
      o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +(k.volumefrom || k.volume || 0)
    }));
  },

  // ===== Lấy dữ liệu: chỉ CC =====
  async getKlines(symbol, interval='15m', limit=500){
    try {
      const bars = await window.App.fetchCC(symbol, interval, limit);
      window.App.showError(`OK CC ${symbol}: ${bars.length} bars`);
      if(!bars || bars.length < 200) throw new Error('CC returned too few bars');
      return bars;
    } catch(e){
      window.App.showError(`${symbol} → ${e.message || e}`);
      throw e;
    }
  },

  // ===== Indicators =====
  SMA(a, n){ const o=[]; let s=0; for(let i=0;i<a.length;i++){ s+=a[i]; if(i>=n) s-=a[i-n]; o.push(i>=n-1?s/n:null);} return o; },
  EMA(a, n){ const k=2/(n+1), o=[]; let p=null; for(let i=0;i<a.length;i++){ const v=a[i]; p=(p===null?v:v*k+p*(1-k)); o.push(p);} return o; },
  RSI(c, p=14){ const r=Array(c.length).fill(null); let g=0,l=0; for(let i=1;i<=p;i++){ const d=c[i]-c[i-1]; g+=Math.max(d,0); l+=Math.max(-d,0);} let G=g/p, L=l/p; r[p]=100-100/(1+ (L===0?100:G/L)); for(let i=p+1;i<c.length;i++){ const d=c[i]-c[i-1]; G=(G*(p-1)+Math.max(d,0))/p; L=(L*(p-1)+Math.max(-d,0))/p; const RS=L===0?100:G/L; r[i]=100-100/(1+RS);} return r; },
  Stoch(H,L,C,p=14,s=3){ const K=[]; for(let i=0;i<C.length;i++){ const a=Math.max(0,i-p+1), hh=Math.max(...H.slice(a,i+1)), ll=Math.min(...L.slice(a,i+1)); K[i]=(hh===ll)?50:((C[i]-ll)/(hh-ll))*100 } const D=window.App.SMA(K,s); return {k:K,d:D}; },
  ATR(H,L,C,p=14){ const tr=[null]; for(let i=1;i<C.length;i++){ const hl=H[i]-L[i], hc=Math.abs(H[i]-C[i-1]), lc=Math.abs(L[i]-C[i-1]); tr[i]=Math.max(hl,hc,lc);} const a=window.App.SMA(tr.slice(1),p); a.unshift(null); return a; },

  expiryBars(){ return 16 }, // ~4h trên khung 15m
  fmt2:(x)=> (Math.round(x*100)/100).toFixed(2)
};
