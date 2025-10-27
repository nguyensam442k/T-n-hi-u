(function(){
  const {CONFIG, getKlines, EMA, ATR, RSI, Stoch, MACD, expiryBars, fmt2, showError} = window.App;

  // ===== utils / storage =====
  const LS_KEY = 'danny_order_log';
  const loadLog=()=>{try{return JSON.parse(localStorage.getItem(LS_KEY)||'[]')}catch{return[]}}
  const saveLog=(x)=>localStorage.setItem(LS_KEY,JSON.stringify(x));
  const fmtMoney = (x)=> (x>=0?'+':'−') + '$' + fmt2(Math.abs(x));

  // ===== ICT helpers =====
  function swingHigh(H,i,n){return i>=n && i+n<H.length && H.slice(i-n,i).every(x=>x<H[i]) && H.slice(i+1,i+n+1).every(x=>x<H[i]);}
  function swingLow (L,i,n){return i>=n && i+n<L.length && L.slice(i-n,i).every(x=>x>L[i]) && L.slice(i+1,i+n+1).every(x=>x>L[i]);}

  function lastStructure(H,L,i,look,sn){
    const sH=[], sL=[];
    for(let k=Math.max(0,i-look);k<=i;k++){
      if(swingHigh(H,k,sn)) sH.push({i:k,p:H[k]});
      if(swingLow(L,k,sn))  sL.push({i:k,p:L[k]});
    }
    if(sH.length<2 || sL.length<2) return {dir:null,sH,sL};
    const hh=sH[sH.length-1], ph=sH[sH.length-2];
    const ll=sL[sL.length-1], pl=sL[sL.length-2];
    const up = hh.p>ph.p && ll.p>pl.p;
    const dn = hh.p<ph.p && ll.p<pl.p;
    return {dir: up?'UP':(dn?'DOWN':null),sH,sL,hh,ll};
  }
  function bosUp(C,H,i,tol, sH){
    if(!sH?.length) return null; const ref=sH[sH.length-1].p; return (C[i]>ref*(1+tol))?ref:null;
  }
  function bosDown(C,L,i,tol, sL){
    if(!sL?.length) return null; const ref=sL[sL.length-1].p; return (C[i]<ref*(1-tol))?ref:null;
  }
  function findFVG(H,L,dir,iStart,look){
    for(let i=iStart;i>=Math.max(2,iStart-look);i--){
      if(dir==='UP'){ if (L[i] > H[i-2])  return {i:i-2, hi:H[i-2], lo:L[i], mid:(H[i-2]+L[i])/2}; }
      else         { if (H[i] < L[i-2])  return {i:i-2, hi:H[i],  lo:L[i-2], mid:(H[i]+L[i-2])/2}; }
    }
    return null;
  }
  function findOB(H,L,C,dir,iStart,look){
    for(let i=iStart;i>=Math.max(1,iStart-look);i--){
      const bull=C[i]>C[i-1], bear=C[i]<C[i-1];
      if(dir==='UP' && bear)  return {i,hi:H[i],lo:L[i],mid:(H[i]+L[i])/2};
      if(dir==='DOWN'&& bull) return {i,hi:H[i],lo:L[i],mid:(H[i]+L[i])/2};
    }
    return null;
  }
  function hadSweep(H,L,C,dir,i){
    const w=5; if(i-w<1) return false;
    if(dir==='UP'){ const lowRef=Math.min(...L.slice(i-w,i)); return (L[i]<lowRef)&&(C[i]>L[i]); }
    else          { const hiRef =Math.max(...H.slice(i-w,i)); return (H[i]>hiRef)&&(C[i]<H[i]); }
  }

  // ===== Strategy: ICT-first (EMA21+Stoch timing + MACD confirm) =====
  function generateSignals(bars){
    const C=bars.map(b=>b.c), H=bars.map(b=>b.h), L=bars.map(b=>b.l);
    const e21=EMA(C, CONFIG.ema21), atr=ATR(H,L,C, CONFIG.atr), rsi=RSI(C,14);
    const {k:K,d:D} = Stoch(H,L,C, CONFIG.stoch.k, CONFIG.stoch.d, CONFIG.stoch.smooth);
    const {hist}   = MACD(C, CONFIG.macd.fast, CONFIG.macd.slow, CONFIG.macd.sig);

    const ict=CONFIG.ict, flt=CONFIG.filters;
    const out=[], start=Math.max(220, ict.structureLookback);

    for(let i=start;i<bars.length;i++){
      // 1) BOS
      const st = lastStructure(H,L,i-1, ict.structureLookback, ict.swingLen);
      const upRef = bosUp(C,H,i, ict.bosTolerance, st.sH);
      const dnRef = bosDown(C,L,i, ict.bosTolerance, st.sL);
      let dir=null; if(upRef) dir='UP'; else if(dnRef) dir='DOWN'; else continue;

      // 2) Zone (FVG -> OB)
      let zone=null;
      if(dir==='UP' && ict.useFVG) zone = findFVG(H,L,'UP',i,ict.fvgLookback);
      if(dir==='UP' && !zone && ict.useOB) zone = findOB(H,L,C,'UP',i,ict.obLookback);
      if(dir==='DOWN'&& ict.useFVG) zone = findFVG(H,L,'DOWN',i,ict.fvgLookback);
      if(dir==='DOWN'&& !zone && ict.useOB) zone = findOB(H,L,C,'DOWN',i,ict.obLookback);
      if(!zone) continue;

      // 3) retest về zone
      let hit=null, end=Math.min(i+ict.retestBarsMax, bars.length-1);
      for(let k=i+1;k<=end;k++){
        const level = ict.entryMode==='mitigation' ? zone.mid : (dir==='UP'? zone.lo : zone.hi);
        const inZone = dir==='UP'
          ? (L[k] <= level && H[k] >= zone.lo)
          : (H[k] >= level && L[k] <= zone.hi);
        if(inZone){ hit=k; break; }
      }
      if(hit==null) continue;

      // 4) sweep yêu cầu
      if(ict.allowSweepEntry && !hadSweep(H,L,C,dir,hit)) continue;

      // 5) Filters phụ
      if(flt.useEMA){
        const slope = e21[hit]-e21[hit-2];
        if(dir==='UP'   && !(C[hit]>=e21[hit] && slope>0)) continue;
        if(dir==='DOWN' && !(C[hit]<=e21[hit] && slope<0)) continue;
        const dist = Math.abs(C[hit]-e21[hit]) / Math.max(atr[hit]||0.0001,1e-8);
        if(dist > (flt.maxDistATR21||1.2)) continue;
      }
      if(flt.useStoch){
        if(dir==='UP'){
          const [a,b]=CONFIG.stoch.buyZone;
          const ok = K[hit-1]<D[hit-1] && K[hit]>=D[hit] && K[hit]>=a && K[hit]<=b;
          if(!ok) continue;
        } else {
          const [a,b]=CONFIG.stoch.sellZone;
          const ok = K[hit-1]>D[hit-1] && K[hit]<=D[hit] && K[hit]>=a && K[hit]<=b;
          if(!ok) continue;
        }
      }
      if(flt.useMACD){
        if(dir==='UP'   && !(hist[hit]>=0)) continue;
        if(dir==='DOWN' && !(hist[hit]<=0)) continue;
      }

      // 6) Entry/SL/TP
      const a = atr[hit]||0;
      let entry, sl;
      if(dir==='UP'){
        entry = Math.min(C[hit], ict.entryMode==='mitigation'? zone.mid : C[hit]);
        sl    = Math.min(zone.lo, entry - CONFIG.slATR*a);
      }else{
        entry = Math.max(C[hit], ict.entryMode==='mitigation'? zone.mid : C[hit]);
        sl    = Math.max(zone.hi, entry + CONFIG.slATR*a);
      }
      const risk = Math.max(dir==='UP'? (entry-sl) : (sl-entry), 1e-8);
      const tp = CONFIG.tpR.map(R => dir==='UP'? entry + R*risk : entry - R*risk);

      // 7) confidence
      let conf = 60 + (flt.useEMA?6:0) + (flt.useStoch?6:0) + (flt.useMACD?6:0) + (ict.allowSweepEntry?6:0);
      conf = Math.min(100, Math.max(40, Math.round(conf)));

      out.push({ i:hit, side: dir==='UP'?'BUY':'SELL', entry, sl, tp, conf,
                 ict:{dir, bosAt:i, zone} });
    }
    return out;
  }

  // fallback tạo 1 kèo LIVE tối giản nếu chưa có
  function ensureLiveSignal(bars, sigs){
    if(sigs.length && sigs[sigs.length-1].i===bars.length-1) return sigs[sigs.length-1];
    const C=bars.map(b=>b.c), H=bars.map(b=>b.h), L=bars.map(b=>b.l);
    const e21=EMA(C, CONFIG.ema21), atr=ATR(H,L,C, CONFIG.atr);
    const {k:K,d:D}=Stoch(H,L,C, CONFIG.stoch.k, CONFIG.stoch.d, CONFIG.stoch.smooth);
    const i=bars.length-1;
    const side = (C[i]>=e21[i] && K[i]>=D[i]) ? 'BUY':'SELL';
    const a=atr[i]||0, entry=C[i], sl = side==='BUY'? entry-CONFIG.slATR*a : entry+CONFIG.slATR*a;
    const risk = Math.max(side==='BUY'? entry-sl : sl-entry, 1e-8);
    const tp = CONFIG.tpR.map(R => side==='BUY'? entry+R*risk : entry-R*risk);
    const s = {i, side, entry, sl, tp, conf:50, live:true};
    sigs.push(s); return s;
  }

  // ===== Simulate / PnL =====
  function simulate(s,bars){
    const qty = (CONFIG.risk.perTradeUSD * CONFIG.risk.leverage) / s.entry;
    const eBars = expiryBars();
    const riskAbs = Math.abs((s.side==='BUY'? (s.entry-s.sl):(s.sl-s.entry))*qty);
    let hit=[0,0,0], when=s.i;

    for(let j=s.i+1;j<bars.length && j<=s.i+eBars;j++){
      const b=bars[j]; when=j;
      if(s.side==='BUY'){
        if(b.l<=s.sl) return {status:'SL',when,qty,pnl:-riskAbs,rr:-1,filled:hit};
        if(!hit[0]&&b.h>=s.tp[0]) hit[0]=1; if(!hit[1]&&b.h>=s.tp[1]) hit[1]=1; if(!hit[2]&&b.h>=s.tp[2]) hit[2]=1;
      }else{
        if(b.h>=s.sl) return {status:'SL',when,qty,pnl:-riskAbs,rr:-1,filled:hit};
        if(!hit[0]&&b.l<=s.tp[0]) hit[0]=1; if(!hit[1]&&b.l<=s.tp[1]) hit[1]=1; if(!hit[2]&&b.l<=s.tp[2]) hit[2]=1;
      }
      if(hit[0]||hit[1]||hit[2]){
        const w=CONFIG.tpSplit||[0.3,0.3,0.4]; let pnl=0;
        for(let k=0;k<3;k++) if(hit[k]) pnl += (s.side==='BUY'?(s.tp[k]-s.entry):(s.entry-s.tp[k]))*qty*w[k];
        const rr=riskAbs>0?pnl/riskAbs:0;
        return {status:'TP',when:j,qty,pnl,rr,filled:hit};
      }
    }
    const lastIdx = bars.length-1;
    if(lastIdx < (s.i + eBars)){
      const last = bars[lastIdx].c;
      const pnl  = (s.side==='BUY' ? (last - s.entry) : (s.entry - last)) * qty;
      const rr   = riskAbs>0 ? pnl/riskAbs : 0;
      return {status:'ACTIVE',when:lastIdx,qty,pnl,rr,filled:hit};
    }
    return {status:'EXPIRED',when:Math.min(s.i+eBars,bars.length-1),qty,pnl:0,rr:0,filled:hit};
  }

  // ===== UI =====
  function skeletonCard(sym){
    const d=document.createElement('div'); d.className='card';
    d.innerHTML=`<div class="head"><div class="asset"><div class="sym">${sym}</div><span class="badge">m15</span></div><div class="badge">Loading…</div></div><div style="color:#93a4bf">Đang tải dữ liệu…</div>`;
    return d;
  }
  function renderCard(sym,bars,signal,sim){
    const last=bars[bars.length-1].c, pnlPct=((last-signal.entry)/signal.entry)*(signal.side==='BUY'?100:-100);
    const liveBadge = signal.live ? `<span class="badge-live">LIVE</span>` : '';
    const d=document.createElement('div'); d.className='card';
    d.innerHTML=`
      <div class="head">
        <div class="asset"><div class="sym">${sym}</div><span class="badge">m15</span> ${liveBadge}</div>
        <div class="badge">Last: $${fmt2(last)}</div>
      </div>
      <div class="kgrid">
        <div class="kv"><div class="k">ENTRY</div><div class="v">$${fmt2(signal.entry)}</div></div>
        <div class="kv"><div class="k">CURRENT</div><div class="v">$${fmt2(last)}</div></div>
        <div class="kv"><div class="k">TIME</div><div class="v">15m</div></div>
        <div class="kv"><div class="k">P&L %</div><div class="v ${pnlPct>=0?'pct-pos':'pct-neg'}">${pnlPct.toFixed(2)}%</div></div>
        <div class="kv"><div class="k">PROFIT (25x)</div><div class="v ${sim.pnl>=0?'pct-pos':'pct-neg'}">${fmtMoney(sim.pnl)}</div></div>
        <div class="kv"><div class="k">STATUS</div><div class="v"><span class="status">${sim.status}</span></div></div>
      </div>
      <div class="row">
        <div class="${signal.side==='BUY'?'side-buy':'side-sell'}">SIDE ${signal.side}</div>
        <div>CONF ${signal.conf}%</div>
        <div class="sl">▼ SL $${fmt2(signal.sl)}</div>
      </div>
      <div class="row tp">
        <span class="pill">🎯 TP1 • $${fmt2(signal.tp[0])}</span>
        <span class="pill">🎯 TP2 • $${fmt2(signal.tp[1])}</span>
        <span class="pill">🎯 TP3 • $${fmt2(signal.tp[2])}</span>
        <button class="pill">Details</button>
      </div>`;
    return d;
  }
  function renderErrorCard(sym,msg){
    const d=document.createElement('div'); d.className='card';
    d.innerHTML=`<div class="head"><div class="asset"><div class="sym">${sym}</div><span class="badge">m15</span></div><div class="badge">Data error</div></div><div style="color:#93a4bf">${msg}</div>`;
    return d;
  }

  // order log
  function upsertOrderLog(symbol, s, sim){
    const log=loadLog(); const id=`${symbol}-${s.i}`; const ix=log.findIndex(x=>x.id===id);
    const exitPrice = (sim.status==='TP') ? s.tp[(sim.filled?.[2]?2:sim.filled?.[1]?1:0)]
                     : (sim.status==='SL' ? s.sl : null);
    const row={ id, time: new Date(barsTime(s.i) || Date.now()).toISOString(), symbol, side:s.side, conf:s.conf,
      entry:s.entry, sl:s.sl, tp1:s.tp[0], tp2:s.tp[1], tp3:s.tp[2], status:sim.status, exit:exitPrice, pnl:sim.pnl, rr:sim.rr };
    if(ix>=0) log[ix]=row; else log.push(row); saveLog(log);
  }
  function renderOrderLog(){
    const log = loadLog().sort((a,b)=>new Date(b.time)-new Date(a.time));
    const tb = document.querySelector('#logTable tbody'); tb.innerHTML='';
    let pnl=0,w=0,l=0,a=0,e=0;
    for(const r of log){
      pnl+=(r.pnl||0); if(r.status==='TP')w++; else if(r.status==='SL')l++; else if(r.status==='ACTIVE')a++; else if(r.status==='EXPIRED')e++;
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${new Date(r.time).toLocaleString()}</td><td>${r.symbol}</td><td>${r.side}</td><td>${r.conf||'-'}%</td>
      <td>${fmt2(r.entry)}</td><td>${fmt2(r.sl)}</td><td>${fmt2(r.tp1)}</td><td>${fmt2(r.tp2)}</td><td>${fmt2(r.tp3)}</td>
      <td>${r.status}</td><td>${r.exit?fmt2(r.exit):'-'}</td>
      <td class="${(r.pnl||0)>=0?'pnl-pos':'pnl-neg'}">${fmtMoney(r.pnl||0)}</td><td>${(r.rr||0).toFixed(2)}</td>`;
      tb.appendChild(tr);
    }
    document.getElementById('logSummary').textContent =
      `Orders: ${log.length} • Win: ${w} • Loss: ${l} • Active: ${a} • Expired: ${e} • Total PnL (25x): ${fmtMoney(pnl)}`;
  }

  // handy to map i -> time when bars cached in build()
  let _barsTime = [];
  const barsTime=(i)=>_barsTime[i];

  // ===== Build =====
  async function build(){
    let total=0, win=0, loss=0, exp=0, rrSum=0, rrN=0, pnlSum=0;
    const cards=document.getElementById('cards'); cards.innerHTML='';
    const skels={}; for(const sym of CONFIG.symbols){ const s=skeletonCard(sym.replace('USDT','')); skels[sym]=s; cards.appendChild(s); }

    _barsTime = []; // reset

    for(const sym of CONFIG.symbols){
      const symShort=sym.replace('USDT','');
      try{
        const bars=await getKlines(sym, CONFIG.timeframe, CONFIG.candlesLimit);
        _barsTime = bars.map(b=>b.t);

        let sigs=generateSignals(bars);
        const latest = ensureLiveSignal(bars, sigs);

        // backtest stats (narrow) or live-only
        const list = (CONFIG.mode==='live') ? [latest] : (sigs.length?sigs.slice(-30):[latest]);
        for(const s of list){
          const sr=simulate(s,bars);
          total++; if(sr.status==='TP'){win++; pnlSum+=sr.pnl; rrSum+=sr.rr; rrN++;} else if(sr.status==='SL'){loss++; pnlSum+=sr.pnl; rrSum+=sr.rr; rrN++;} else {exp++;}
        }

        const sim = simulate(latest,bars);
        upsertOrderLog(symShort, latest, sim);

        const card=renderCard(symShort,bars,latest,sim);
        cards.replaceChild(card, skels[sym]);

      }catch(e){
        cards.replaceChild(renderErrorCard(symShort, e.message||e), skels[sym]);
        showError(`${sym}: ${e.message||e}`);
      }
    }

    // Summary
    if(CONFIG.mode==='live'){
      const log=loadLog(); const wins=log.filter(x=>x.status==='TP').length;
      const los =log.filter(x=>x.status==='SL').length;
      const exd =log.filter(x=>x.status==='EXPIRED').length;
      const act =log.filter(x=>x.status==='ACTIVE').length;
      const pnl =log.reduce((s,x)=>s+(x.pnl||0),0);

      document.getElementById('sumTotal').textContent=wins+los+exd+act;
      document.getElementById('sumWin').textContent=wins;
      document.getElementById('sumLoss').textContent=los;
      document.getElementById('sumExp').textContent=exd;
      document.getElementById('sumWR').textContent=(wins+los>0?((wins/(wins+los))*100).toFixed(2):'0')+'%';
      document.getElementById('sumRR').textContent='—';
      const el=document.getElementById('sumPnL'); el.textContent=(pnl>=0?'+':'−')+'$'+fmt2(Math.abs(pnl)); el.style.color=pnl>=0?'var(--green)':'var(--red)';
    }else{
      const wr = total? ((win/total)*100).toFixed(2)+'%':'0%';
      const rrAvg = rrN? (rrSum/rrN).toFixed(2) : '0.00';
      document.getElementById('sumTotal').textContent=total;
      document.getElementById('sumWin').textContent=win;
      document.getElementById('sumLoss').textContent=loss;
      document.getElementById('sumExp').textContent=exp;
      document.getElementById('sumWR').textContent=wr;
      document.getElementById('sumRR').textContent=rrAvg;
      const el=document.getElementById('sumPnL'); el.textContent=(pnlSum>=0?'+':'−')+'$'+fmt2(Math.abs(pnlSum)); el.style.color=pnlSum>=0?'var(--green)':'var(--red)';
    }

    renderOrderLog();
  }

  // ===== Binance WS for CURRENT/PnL (optional) =====
  if (CONFIG.useBinanceWS){
    try{
      const streams=CONFIG.symbols.map(s=>s.toLowerCase().replace('usdt','usdt@miniTicker')).join('/');
      const ws=new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
      ws.onmessage=(ev)=>{
        const m=JSON.parse(ev.data); if(!m?.data?.c||!m?.stream) return;
        const sym=m.stream.split('@')[0].toUpperCase(); const price=parseFloat(m.data.c);
        document.querySelectorAll('.card').forEach(card=>{
          const s=card.querySelector('.asset .sym')?.textContent; if(!s|| (s+'USDT')!==sym) return;
          const curEl=[...card.querySelectorAll('.kv .k')].find(k=>k.textContent==='CURRENT')?.parentElement?.querySelector('.v');
          if(curEl) curEl.textContent='$'+fmt2(price);
          const entryEl=[...card.querySelectorAll('.kv .k')].find(k=>k.textContent==='ENTRY')?.parentElement?.querySelector('.v');
          const entry=entryEl?parseFloat(entryEl.textContent.replace('$','')):null;
          const sideTxt=card.querySelector('.row .side-buy, .row .side-sell')?.textContent||'';
          const side=sideTxt.includes('BUY')?'BUY':'SELL';
          if(entry){
            const pnlPct=((price-entry)/entry)*(side==='BUY'?100:-100);
            const pnlEl=[...card.querySelectorAll('.kv .k')].find(k=>k.textContent==='P&L %')?.parentElement?.querySelector('.v');
            if(pnlEl){ pnlEl.textContent=pnlPct.toFixed(2)+'%'; pnlEl.classList.toggle('pct-pos',pnlPct>=0); pnlEl.classList.toggle('pct-neg',pnlPct<0); }
          }
        });
      };
    }catch(e){ console.warn('WS error',e); }
  }

  document.getElementById('refreshBtn').addEventListener('click', build);
  setInterval(build, 60*1000);
  build();
})();
