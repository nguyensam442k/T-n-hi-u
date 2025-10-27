// ====== CONFIG & HELPERS ======
window.App = {
  CONFIG: {
    defaultExchange: 'binance',
    symbols: ['BTCUSDT','ETHUSDT','SOLUSDT'],
    timeframes: ['15m','1h','4h'],
    candlesLimit: 750,                           // đủ dữ liệu cho EMA/SMA/ATR
    risk: { perTradeUSD: 100, leverage: 25 },    // 100u x 25
    tpSplit: [0.30,0.30,0.40],                   // TP1/TP2/TP3
    tpR: [0.8, 1.4, 2.0],                        // RR cho TP1..3
    slR: 1.0,
    ema: [21,50,200],
    rsiPeriod: 14,
    stoch: [14,3],
    atr: 14,
    ccKey: ''                                    // dán key CryptoCompare nếu muốn
  },

  tfToMs(tf){
    const m = tf.match(/(\d+)([mhdw])/); if(!m) return 60000;
    const n=+m[1], u=m[2]; const k = u==='m'?60000: u==='h'?3600000: u==='d'?86400000: 604800000; return n*k;
  },
  expiryBars(tf){ if(tf==='15m') return 16; if(tf==='1h') return 24; if(tf==='4h') return 36; return 24; },

  // ====== DATA SOURCES ======
  async fetchBinance(symbol, interval, limit=500){
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url); if(!res.ok) throw new Error('binance fail');
    const data = await res.json();
    return data.map(k=>({t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5]}));
  },
  async fetchBybit(symbol, interval, limit=500){
    const map = { '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','2h':'120','4h':'240','6h':'360','12h':'720','1d':'D','1w':'W'};
    const iv = map[interval] || '15';
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${Math.min(limit,1000)}`;
    const res = await fetch(url); if(!res.ok) throw new Error('bybit fail');
    const j = await res.json(); const arr = j.result?.list||[];
    return arr.reverse().map(k=>({t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5]}));
  },
  async fetchCC(symbol, interval, limit=400){
    const fsym = symbol.replace(/USDT$/,''); const tsym='USDT';
    const base='https://min-api.cryptocompare.com/data';
    const path = interval.endsWith('m')? 'histominute' : interval.endsWith('h')? 'histohour' : 'histoday';
    const aggregate = parseInt(interval) || (interval==='1h'?1:(interval==='4h'?4:1));
    const url = `${base}/${path}?fsym=${fsym}&tsym=${tsym}&limit=${Math.min(limit,2000)}&aggregate=${aggregate}&e=CCCAGG`;
    const headers = this.CONFIG.ccKey? { headers:{Authorization:`Apikey ${this.CONFIG.ccKey}`}} : {};
    const res = await fetch(url, headers); if(!res.ok) throw new Error('cc fail');
    const j = await res.json(); const arr = j.Data || j.Data?.Data || j.Data?.data || j.Data;
    return (arr||[]).map(k=>({t:(k.time)*1000, o:+k.open, h:+k.high, l:+k.low, c:+k.close, v:+k.volumefrom}));
  },
  // Fallback: ưu tiên exchange bạn chọn → rồi thử 2 nguồn còn lại
  async getKlines(ex,sym,tf,limit){
    const tryList = [
      ex==='binance' ? () => this.fetchBinance(sym,tf,limit) : null,
      ex==='bybit' ? () => this.fetchBybit(sym,tf,limit) : null,
      ex==='cryptocompare' ? () => this.fetchCC(sym,tf,limit) : null,
      () => this.fetchBinance(sym,tf,limit),
      () => this.fetchBybit(sym,tf,limit),
      () => this.fetchCC(sym,tf,limit)
    ].filter(Boolean);

    for(const job of tryList){
      try{ const bars = await job(); if(bars?.length>300) return bars; }catch(e){}
    }
    throw new Error('Không tải được dữ liệu nến.');
  },

  // ===== INDICATORS =====
  SMA(values, period){ const out=[]; let sum=0;
    for(let i=0;i<values.length;i++){ sum+=values[i]; if(i>=period) sum-=values[i-period]; out.push(i>=period-1? sum/period : null); }
    return out;
  },
  EMA(values, period){ const k=2/(period+1), out=[]; let prev=null;
    for(let i=0;i<values.length;i++){ const v=values[i]; prev = (prev===null? v : v*k + prev*(1-k)); out.push(prev); }
    return out;
  },
  RSI(closes, period=14){
    const rsis=Array(closes.length).fill(null);
    let gains=0, losses=0;
    for(let i=1;i<=period;i++){ const ch=closes[i]-closes[i-1]; gains+=Math.max(ch,0); losses+=Math.max(-ch,0); }
    let avgG=gains/period, avgL=losses/period; rsis[period]=100 - 100/(1+ (avgL===0? 100: avgG/avgL));
    for(let i=period+1;i<closes.length;i++){ const ch=closes[i]-closes[i-1]; const g=Math.max(ch,0), l=Math.max(-ch,0);
      avgG=(avgG*(period-1)+g)/period; avgL=(avgL*(period-1)+l)/period;
      const rs= avgL===0? 100: avgG/avgL; rsis[i]=100 - 100/(1+rs);
    } return rsis;
  },
  Stoch(highs,lows,closes,p=14,sig=3){
    const k=[]; for(let i=0;i<closes.length;i++){ const a=Math.max(0,i-p+1);
      const hh=Math.max(...highs.slice(a,i+1)); const ll=Math.min(...lows.slice(a,i+1));
      k[i]=(hh===ll)?50: ((closes[i]-ll)/(hh-ll))*100;
    } const d=this.SMA(k, sig); return {k,d};
  },
  ATR(highs,lows,closes,period=14){
    const tr=[null]; for(let i=1;i<closes.length;i++){ const hl=highs[i]-lows[i]; const hc=Math.abs(highs[i]-closes[i-1]); const lc=Math.abs(lows[i]-closes[i-1]); tr[i]=Math.max(hl,hc,lc); }
    const a=this.SMA(tr.slice(1),period); a.unshift(null); return a;
  }
};
