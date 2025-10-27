(function(){
  const {CONFIG, getKlines, EMA, RSI, Stoch, ATR, expiryBars, fmt2, showError} = window.App;

  // ========= Local Storage Order Log =========
  const LS_KEY = 'danny_order_log';
  function loadLog(){ try{ return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }catch{ return [] } }
  function saveLog(arr){ localStorage.setItem(LS_KEY, JSON.stringify(arr)); }

  // ========= Notifier =========
  const LAST_SEEN = {};
  function alertSignal(sym, s) {
    try { if ('Notification' in window && Notification.permission==='granted')
      new Notification(`Danny: ${sym} • ${s.side}`, { body:`Entry ${s.entry.toFixed(2)} | SL ${s.sl.toFixed(2)}` });
    } catch(e){}
  }
  const fmtMoney = (x)=> (x>=0?'+':'−') + '$' + fmt2(Math.abs(x));

  // ========= Strategy (mềm) =========
  function generateSignals(bars){
    const C=bars.map(b=>b.c), H=bars.map(b=>b.h), L=bars.map(b=>b.l);
    const e21=EMA(C, CONFIG.ema[0]), e50=EMA(C, CONFIG.ema[1]), e200=EMA(C, CONFIG.ema[2]);
    const rsi=RSI(C, CONFIG.rsiPeriod);
    const {k:K,d:D}=Stoch(H,L,C, CONFIG.stoch?.[0]||14, CONFIG.stoch?.[1]||3);
    const atr=ATR(H,L,C, CONFIG.atr);

    const out=[]; const start=Math.max(200,CONFIG.ema[2]);
    for(let i=start;i<bars.length;i++){
      const up=e21[i]>e50[i]&&e50[i]>e200[i], dn=e21[i]<e50[i]&&e50[i]<e200[i];
      const crossUp=K[i-1]!=null&&D[i-1]!=null&&K[i-1]<D[i-1]&&K[i]>=D[i]&&K[i]<70;
      const crossDown=K[i-1]!=null&&D[i-1]!=null&&K[i-1]>D[i-1]&&K[i]<=D[i]&&K[i]>30;
      const basicUp=up&&C[i]>e21[i]&&rsi[i]>50, basicDown=dn&&C[i]<e21[i]&&rsi[i]<50;

      if((up&&rsi[i]>52)||crossUp||basicUp){
        const e=bars[i].c, atrv=atr[i]||0, sl=Math.max(bars[i].l-0.6*atrv, bars[i].l*0.998);
        const risk=Math.max(e-sl,1e-8), tp=[e+0.8*risk,e+1.4*risk,e+2*risk];
        const conf=Math.min(100,Math.round((up?45:20)+(rsi[i]-50)+(crossUp?15:0)+(basicUp?10:0)));
        out.push({i,side:'BUY',entry:e,sl,tp,conf});
      }
      if((dn&&rsi[i]<48)||crossDown||basicDown){
        const e=bars[i].c, atrv=atr[i]||0, sl=Math.min(bars[i].h+0.6*atrv, bars[i].h*1.002);
        const risk=Math.max(sl-e,1e-8), tp=[e-0.8*risk,e-1.4*risk,e-2*risk];
        const conf=Math.min(100,Math.round((dn?45:20)+(50-rsi[i])+(crossDown?15:0)+(basicDown?10:0)));
        out.push({i,side:'SELL',entry:e,sl,tp,conf});
      }
    }
    return out;
  }

  // luôn có kèo “live” ở nến cuối nếu chưa có
  function ensureLiveSignal(bars, sigs){
    const C=bars.map(b=>b.c), H=bars.map(b=>b.h), L=bars.map(b=>b.l);
    const e21=EMA(C, CONFIG.ema[0]), e50=EMA(C, CONFIG.ema[1]);
    const rsi=RSI(C, CONFIG.rsiPeriod), atr=ATR(H,L,C, CONFIG.atr);
    const i = bars.length-1;
    const haveLatest = sigs.length && sigs[sigs.length-1].i === i;
    if (haveLatest) return sigs[sigs.length-1];

    const side = (e21[i] >= e50[i] && rsi[i] >= 50) ? 'BUY' : 'SELL';
    const e = bars[i].c, atrv=atr[i]||0;
    const sl = side==='BUY' ? Math.max(bars[i].l-0.6*atrv, bars[i].l*0.998)
                            : Math.min(bars[i].h+0.6*atrv, bars[i].h*1.002);
    const risk = Math.max(side==='BUY'? e-sl : sl-e, 1e-8);
    const tp = side==='BUY' ? [e+0.8*risk, e+1.4*risk, e+2*risk]
                            : [e-0.8*risk, e-1.4*risk, e-2*risk];
    const live = { i, side, entry:e, sl, tp, conf:55, live:true };
    sigs.push(live);
    return live;
  }

  // Backtest / Active PnL
  function simulate(s, bars){
    const qty = (CONFIG.risk.perTradeUSD * CONFIG.risk.leverage) / s.entry;
    const eBars = expiryBars();
    const riskAbs = Math.abs((s.side==='BUY' ? (s.entry - s.sl) : (s.sl - s.entry)) * qty);
    let hit=[0,0,0], when=s.i;

    for(let j=s.i+1;j<bars.length && j<=s.i+eBars;j++){
      const b=bars[j]; when=j;
      if(s.side==='BUY'){ if(b.l<=s.sl) return {status:'SL',when,qty,pnl:-riskAbs,rr:-1,filled:hit};
        if(!hit[0]&&b.h>=s.tp[0]) hit[0]=1; if(!hit[1]&&b.h>=s.tp[1]) hit[1]=1; if(!hit[2]&&b.h>=s.tp[2]) hit[2]=1; }
      else { if(b.h>=s.sl) return {status:'SL',when,qty,pnl:-riskAbs,rr:-1,filled:hit};
        if(!hit[0]&&b.l<=s.tp[0]) hit[0]=1; if(!hit[1]&&b.l<=s.tp[1]) hit[1]=1; if(!hit[2]&&b.l<=s.tp[2]) hit[2]=1; }
      if(hit[0]||hit[1]||hit[2]){
        const w=[0.30,0.30,0.40]; let pnl=0;
        for(let k=0;k<3;k++) if(hit[k]) pnl += (s.side==='BUY'?(s.tp[k]-s.entry):(s.entry-s.tp[k]))*qty*w[k];
        const rr = riskAbs>0 ? pnl/riskAbs : 0;
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

  // ====== UI helpers ======
  function skeletonCard(sym){
    const d=document.createElement('div'); d.className='card';
    d.innerHTML=`<div class="head"><div class="asset"><div class="sym">${sym}</div><span class="badge">m15</span></div><div class="badge">Loading…</div></div><div style="color:#93a4bf">Đang tải dữ liệu…</div>`;
    return d;
  }
  function renderCard(sym, bars, signal, simResult){
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
        <div class="kv"><div class="k">PROFIT (25x)</div><div class="v ${simResult.pnl>=0?'pct-pos':'pct-neg'}">${fmtMoney(simResult.pnl)}</div></div>
        <div class="kv"><div class="k">STATUS</div><div class="v"><span class="status">${simResult.status}</span></div></div>
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

  // --------- Order Log ----------
  function upsertOrderLog(symbol, signal, sim){
    const log = loadLog();
    const id = `${symbol}-${signal.i}`;
    const idx = log.findIndex(x=>x.id===id);

    const exitPrice = (sim.status==='TP') ? signal.tp[(sim.filled?.[2]?2:sim.filled?.[1]?1:0)]
                     : (sim.status==='SL') ? signal.sl
                     : null;

    const row = {
      id,
      time: new Date(signal.iTime || Date.now()).toISOString(),
      symbol, side: signal.side, conf: signal.conf,
      entry: signal.entry, sl: signal.sl, tp1: signal.tp[0], tp2: signal.tp[1], tp3: signal.tp[2],
      status: sim.status, exit: exitPrice, pnl: sim.pnl, rr: sim.rr
    };
    if(idx>=0) log[idx]=row; else log.push(row);
    saveLog(log);
  }
  function renderOrderLog(){
    const log = loadLog().sort((a,b)=>new Date(b.time)-new Date(a.time));
    const tb = document.querySelector('#logTable tbody'); tb.innerHTML='';
    let pnl=0, wins=0, loss=0, act=0, exp=0;
    for(const r of log){
      pnl += (r.pnl||0);
      if(r.status==='TP') wins++; else if(r.status==='SL') loss++;
      else if(r.status==='ACTIVE') act++; else if(r.status==='EXPIRED') exp++;
      const tr=document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(r.time).toLocaleString()}</td>
        <td>${r.symbol}</td>
        <td>${r.side}</td>
        <td>${r.conf||'-'}%</td>
        <td>${fmt2(r.entry)}</td><td>${fmt2(r.sl)}</td>
        <td>${fmt2(r.tp1)}</td><td>${fmt2(r.tp2)}</td><td>${fmt2(r.tp3)}</td>
        <td>${r.status}</td>
        <td>${r.exit?fmt2(r.exit):'-'}</td>
        <td class="${(r.pnl||0)>=0?'pnl-pos':'pnl-neg'}">${fmtMoney(r.pnl||0)}</td>
        <td>${(r.rr||0).toFixed(2)}</td>`;
      tb.appendChild(tr);
    }
    document.getElementById('logSummary').textContent =
      `Orders: ${log.length} • Win: ${wins} • Loss: ${loss} • Active: ${act} • Expired: ${exp} • Total PnL (25x): ${fmtMoney(pnl)}`;
  }

  // --------- Build ----------
  async function build(){
    let total=0, win=0, loss=0, exp=0, rrSum=0, rrN=0, pnlSum=0;
    const cards=document.getElementById('cards'); cards.innerHTML='';
    const skels={}; for(const sym of CONFIG.symbols){ const s=skeletonCard(sym.replace('USDT','')); skels[sym]=s; cards.appendChild(s); }

    for(const sym of CONFIG.symbols){
      const symShort=sym.replace('USDT','');
      try{
        showError(`Fetching ${sym}…`);
        const bars=await getKlines(sym, CONFIG.timeframe, CONFIG.candlesLimit);
        let sigs=generateSignals(bars);
        const latest = ensureLiveSignal(bars, sigs); // luôn có LIVE ở nến cuối

        if (latest && LAST_SEEN[sym] !== latest.i) {
          if (LAST_SEEN[sym] !== undefined) alertSignal(sym, latest);
          LAST_SEEN[sym] = latest.i;
        }

        // thống kê
        const list = sigs.length ? sigs.slice(-30) : [latest];
        for(const s of list){
          const sr=simulate(s,bars);
          total++; if(sr.status==='TP'){win++; pnlSum+=sr.pnl; rrSum+=sr.rr; rrN++;}
          else if(sr.status==='SL'){loss++; pnlSum+=sr.pnl; rrSum+=sr.rr; rrN++;}
          else {exp++;}
        }

        // log / journal: ghi lại kèo mới nhất
        const sim = simulate(latest,bars);
        latest.iTime = bars[latest.i]?.t || Date.now();
        upsertOrderLog(symShort, latest, sim);

        const card=renderCard(symShort,bars,latest,sim);
        cards.replaceChild(card, skels[sym]);

      }catch(e){
        cards.replaceChild(renderErrorCard(symShort, e.message||e), skels[sym]);
        showError(`${sym}: ${e.message||e}`);
      }
    }

    // Summary
    const wr = total? ((win/total)*100).toFixed(2)+'%':'0%';
    const rrAvg = rrN? (rrSum/rrN).toFixed(2) : '0.00';
    document.getElementById('sumTotal').textContent = total;
    document.getElementById('sumWin').textContent   = win;
    document.getElementById('sumLoss').textContent  = loss;
    document.getElementById('sumExp').textContent   = exp;
    document.getElementById('sumWR').textContent    = wr;
    document.getElementById('sumRR').textContent    = rrAvg;
    const sumEl=document.getElementById('sumPnL');
    sumEl.textContent=(pnlSum>=0?'+':'−')+'$'+fmt2(Math.abs(pnlSum));
    sumEl.style.color=pnlSum>=0?'var(--green)':'var(--red)';

    renderOrderLog(); // vẽ bảng nhật ký
  }

  document.getElementById('refreshBtn').addEventListener('click', build);
  if ('Notification' in window && Notification.permission==='default'){ Notification.requestPermission(); }
  setInterval(build, 60*1000); // auto refresh mỗi phút
  build();
})();
