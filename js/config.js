// Danny Signals — 15m ICT/SMC + EMA21 + Stoch + RSI (CCCAGG + Binance live)
(function(){
  const CONFIG = {
    symbols: ['BTCUSDT','ETHUSDT','SOLUSDT'],
    timeframe: '15m',

    // ====== chỉ 3 ngày gần đây ======
    days: 3,                     // <- số ngày muốn lấy
    warmMinutes: 30,             // buffer 30 phút để tính chỉ báo mượt
    risk: { perTradeUSD: 100, leverage: 25 },

    // Chế độ
    mode: 'live',                // 'live' | 'backtest'
    useBinanceWS: true,

    // ===== mốc tính/ghi log (LOCAL TIME) =====
    session: { startTodayHHmm: '01:15' },

    // Chỉ báo
    ema21: 21,
    atr: 14,

    // ==== ICT / SMC ====
    ict: {
      swingLen: 3,
      structureLookback: 120,
      bosTolerance: 0.0005,
      useFVG: true,   fvgLookback: 40,
      useOB:  true,   obLookback: 30,
      entryMode: 'mitigation',
      allowSweepEntry: true,
      retestBarsMax: 20
    },

    // ==== Filters (KHÔNG dùng MACD) ====
    stoch: { k:14, d:3, smooth:3, buyZone:[20,60], sellZone:[40,80] },
    rsi:   { period:14, buyMin:48, sellMax:52 }, // Buy: RSI ≥ 48 và dốc lên; Sell: RSI ≤ 52 và dốc xuống
    filters: { useEMA:true, useStoch:true, useRSI:true, maxDistATR21: 1.2 },

    // Risk/RR/expiry
    slATR: 1.2,
    tpR: [1.0, 1.8, 2.6],
    tpSplit: [0.30,0.30,0.40],
    expiryBars15m: 20,
  };

  // ===== DEBUG banner =====
  function showError(msg){
    let el = document.getElementById('debugBanner');
    if(!el){
      el = document.createElement('div');
      el.id = 'debugBanner';
      el.style.cssText = 'margin:10px 0;padding:10px;border:1px solid #fca5a5;background:#fee2e2;color:#991b1b;border-radius:8px;font-size:14px';
      document.querySelector('.wrap')?.prepend(el);
    }
    el.textContent = 'DEBUG: ' + msg;
    console.warn('DEBUG:', msg);
  }

  // ======= CryptoCompare (minute) =======
  const ccBase = 'https://min-api.cryptocompare.com/data';

  async function fetchMinutesPaged(symbol, minutesNeeded){
    const fsym = symbol.replace(/USDT$/,'');
    const tsym = 'USDT';
    const perCall = 2000; // tối đa mỗi call
    const data = [];
    let toTs = undefined;

    while(data.length < minutesNeeded){
      const url = `${ccBase}/histominute?fsym=${fsym}&tsym=${tsym}`+
                  `&limit=${perCall}&aggregate=1&e=CCCAGG${toTs?`&toTs=${toTs}`:''}`;
      const r = await fetch(url);
      if(!r.ok) throw new Error('CC ' + r.status);
      const j = await r.json();
      if(j.Response==='Error') throw new Error(j.Message||'CC error');
      const arr = (j.Data && (j.Data.Data || j.Data)) || [];
      if(!arr.length) break;
      if(toTs===undefined) data.push(...arr); else data.unshift(...arr);
      toTs = arr[0].time - 1;
      if(data.length >= minutesNeeded) break;
    }
    return data.map(k=>({ t:k.time*1000, o:+k.open, h:+k.high, l:+k.low, c:+k.close, v:+(k.volumefrom||0) }));
  }

  function resample15(mins){
    const m = new Map();
    for(const x of mins){
      const sec = Math.floor(x.t/1000), b = Math.floor(sec/900)*900, k=b*1000;
      const cur = m.get(k);
      if(!cur) m.set(k,{t:k,o:x.o,h:x.h,l:x.l,c:x.c,v:x.v});
      else { cur.h=Math.max(cur.h,x.h); cur.l=Math.min(cur.l,x.l); cur.c=x.c; cur.v+=x.v; }
    }
    return Array.from(m.values()).sort((a,b)=>a.t-b.t);
  }

  // ===== Binance last price (merge live) =====
  async function fetchBinanceLast(symbol){
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
    const r = await fetch(url);
    if(!r.ok) throw new Error('BN last ' + r.status);
    const j = await r.json();
    return parseFloat(j.price);
  }

  function mergeLivePrice15(bars15, lastPrice){
    if(!bars15.length) return bars15;
    const now = Date.now();
    const bucket = Math.floor(now/900000)*900000;
    const lastBar = bars15[bars15.length-1];
    if (lastBar.t < bucket){
      bars15.push({ t: bucket, o:lastPrice, h:lastPrice, l:lastPrice, c:lastPrice, v:0 });
    } else {
      lastBar.c = lastPrice;
      lastBar.h = Math.max(lastBar.h, lastPrice);
      lastBar.l = Math.min(lastBar.l, lastPrice);
    }
    return bars15;
  }

  async function getKlines(symbol, interval='15m'){
    if(interval!=='15m') throw new Error('Only 15m supported');
    const minutesNeeded = CONFIG.days * 1440 + (CONFIG.warmMinutes||0);
    const mins = await fetchMinutesPaged(symbol, minutesNeeded);
    showError(`${symbol}: loaded ${mins.length} minutes (last ${CONFIG.days} days)`);

    let m15  = resample15(mins);
    // giữ đúng 3 ngày 15m: 3*24*4 = 288 bar (+1 khi merge live có thể thành 289)
    const target15 = CONFIG.days * 24 * 4;
    if (m15.length > target15) m15 = m15.slice(-target15);

    if (CONFIG.mode==='live'){
      try{
        const last = await fetchBinanceLast(symbol);
        m15 = mergeLivePrice15(m15, last);
      }catch(e){ console.warn('Live merge error', e); }
    }
    return m15;
  }

  // ===== Indicators =====
  const SMA=(a,n)=>{const o=[];let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];o.push(i>=n-1?s/n:null)}return o;}
  const EMA=(a,n)=>{const k=2/(n+1),o=[];let p=null;for(let i=0;i<a.length;i++){const v=a[i];p=(p===null?v:v*k+p*(1-k));o.push(p)}return o;}
  function RSI(c,p=14){const r=Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}let G=g/p,L=l/p;r[p]=100-100/(1+(L===0?100:G/L));for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];G=(G*(p-1)+Math.max(d,0))/p;L=(L*(p-1)+Math.max(-d,0))/p;const RS=L===0?100:G/L;r[i]=100-100/(1+RS)}return r;}
  function Stoch(H,L,C,k=14,d=3,s=3){const K=[];for(let i=0;i<C.length;i++){const a=Math.max(0,i-k+1),hh=Math.max(...H.slice(a,i+1)),ll=Math.min(...L.slice(a,i+1));K[i]=(hh===ll)?50:((C[i]-ll)/(hh-ll))*100}const KD=SMA(K,d);const KD2=SMA(KD.slice(0),s);return {k:K,d:KD2};}
  function ATR(H,L,C,p=14){const tr=[null];for(let i=1;i<C.length;i++){const hl=H[i]-L[i],hc=Math.abs(H[i]-C[i-1]),lc=Math.abs(L[i]-C[i-1]);tr[i]=Math.max(hl,hc,lc)}const a=SMA(tr.slice(1),p);a.unshift(null);return a;}

  function expiryBars(){ return CONFIG.expiryBars15m || 20 }
  const fmt2 = (x)=> (Math.round(x*100)/100).toFixed(2);

  function sessionStartTsLocal(){
    const [hh,mm] = (CONFIG.session?.startTodayHHmm||'00:00').split(':').map(Number);
    const d = new Date(); d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }

  window.App = {
    CONFIG, showError, getKlines,
    SMA, EMA, RSI, Stoch, ATR, expiryBars, fmt2,
    sessionStartTsLocal
  };
})();
