// Danny Signals — CryptoCompare minute paging -> 15m resample (no `this`)
(function () {
  const CONFIG = {
    symbols: ['BTCUSDT','ETHUSDT','SOLUSDT'],
    timeframe: '15m',
    candlesLimit: 450,                         // số 15m bars mong muốn
    risk: { perTradeUSD: 100, leverage: 25 },  // 100u x 25
    tpSplit: [0.30,0.30,0.40], tpR: [0.8,1.4,2.0],
    ema: [21,50,200], rsiPeriod: 14, stoch:[14,3], atr:14,
  };

  // --- DEBUG banner ---
  function showError(msg){
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
  }

  // --- helpers ---
  const ccBase = 'https://min-api.cryptocompare.com/data';

  // Lấy dữ liệu 1-phút theo pages (tối đa ~2000 per call), có thể thêm API_KEY vào url nếu có
  async function fetchMinutesPaged(symbol, minutesNeeded){
    const fsym = symbol.replace(/USDT$/,'');
    const tsym = 'USDT';
    const perCall = 2000;           // CC giới hạn
    const data = [];
    let toTs = undefined;
    while(data.length < minutesNeeded){
      const url = `${ccBase}/histominute?fsym=${fsym}&tsym=${tsym}` +
                  `&limit=${perCall}&aggregate=1&e=CCCAGG` +
                  (toTs ? `&toTs=${toTs}` : '');
      const r = await fetch(url);
      if(!r.ok) throw new Error('CC ' + r.status);
      const j = await r.json();
      if(j.Response === 'Error') throw new Error(j.Message || 'CC error');

      const arr = (j.Data && (j.Data.Data || j.Data)) || [];
      if(!arr.length) break;

      // arr oldest -> newest
      // Khi phân trang, set toTs cho lần kế tiếp = oldest.time - 1
      if(toTs === undefined) {
        data.push(...arr); // newest chunk cuối cùng
      } else {
        data.unshift(...arr); // ghép phía trước
      }
      toTs = arr[0].time - 1;

      // tránh spam quá nhiều call
      if(data.length >= minutesNeeded) break;
    }
    // dữ liệu có thể dư; chuẩn hoá
    // data oldest -> newest
    return data.map(k=>({ t:k.time*1000, o:+k.open, h:+k.high, l:+k.low, c:+k.close, v:+(k.volumefrom||0) }));
  }

  // Gom 1-phút → 15-phút (align 00/15/30/45)
  function resampleTo15m(mins){
    const buckets = new Map(); // key: epochSec aligned to 15m
    for(const m of mins){
      const sec = Math.floor(m.t/1000);
      const b = Math.floor(sec/900)*900; // 900s = 15m
      const k = b*1000;
      const cur = buckets.get(k);
      if(!cur){
        buckets.set(k, {t:k, o:m.o, h:m.h, l:m.l, c:m.c, v:m.v});
      }else{
        cur.h = Math.max(cur.h, m.h);
        cur.l = Math.min(cur.l, m.l);
        cur.c = m.c;
        cur.v += m.v;
      }
    }
    const out = Array.from(buckets.values()).sort((a,b)=>a.t-b.t);
    return out;
  }

  // API chính: trả về mảng 15-phút đủ dài cho EMA200
  async function getKlines(symbol, interval='15m', limit15m=450){
    if(interval !== '15m') throw new Error('Only 15m supported in this demo');
    // số phút cần = (limit + warmup) * 15
    const warmup = 60;                       // dư để tính chỉ báo mượt hơn
    const minutesNeeded = (limit15m + warmup) * 15;
    const mins = await fetchMinutesPaged(symbol, minutesNeeded);
    showError(`OK CC ${symbol}: minutes=${mins.length}`);
    if(mins.length < 300) throw new Error('Too few minute bars from CC');

    const m15 = resampleTo15m(mins);
    // lấy phần đuôi theo limit15m
    return m15.slice(-limit15m);
  }

  // --- Indicators ---
  function SMA(a, n){ const o=[]; let s=0; for(let i=0;i<a.length;i++){ s+=a[i]; if(i>=n) s-=a[i-n]; o.push(i>=n-1?s/n:null);} return o; }
  function EMA(a, n){ const k=2/(n+1), o=[]; let p=null; for(let i=0;i<a.length;i++){ const v=a[i]; p=(p===null?v:v*k+p*(1-k)); o.push(p);} return o; }
  function RSI(c, p=14){ const r=Array(c.length).fill(null); let g=0,l=0; for(let i=1;i<=p;i++){ const d=c[i]-c[i-1]; g+=Math.max(d,0); l+=Math.max(-d,0);} let G=g/p, L=l/p; r[p]=100-100/(1+(L===0?100:G/L)); for(let i=p+1;i<c.length;i++){ const d=c[i]-c[i-1]; G=(G*(p-1)+Math.max(d,0))/p; L=(L*(p-1)+Math.max(-d,0))/p; const RS=L===0?100:G/L; r[i]=100-100/(1+RS);} return r; }
  function Stoch(H,L,C,p=14,s=3){ const K=[]; for(let i=0;i<C.length;i++){ const a=Math.max(0,i-p+1), hh=Math.max(...H.slice(a,i+1)), ll=Math.min(...L.slice(a,i+1)); K[i]=(hh===ll)?50:((C[i]-ll)/(hh-ll))*100 } const D=SMA(K,s); return {k:K,d:D}; }
  function ATR(H,L,C,p=14){ const tr=[null]; for(let i=1;i<C.length;i++){ const hl=H[i]-L[i], hc=Math.abs(H[i]-C[i-1]), lc=Math.abs(L[i]-C[i-1]); tr[i]=Math.max(hl,hc,lc);} const a=SMA(tr.slice(1),p); a.unshift(null); return a; }

  function expiryBars(){ return 16 } // 4h trên khung 15m
  const fmt2 = (x)=> (Math.round(x*100)/100).toFixed(2);

  // expose
  window.App = { CONFIG, showError, getKlines, SMA, EMA, RSI, Stoch, ATR, expiryBars, fmt2 };
})();
