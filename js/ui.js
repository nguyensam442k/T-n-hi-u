(function(){
  const {CONFIG, getKlines, EMA, RSI, Stoch, ATR, expiryBars, fmt2, showError} = window.App;

  // ====== Notifier (giữ nguyên đơn giản) ======
  const LAST_SEEN = {};
  function alertSignal(sym, s) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`Danny: ${sym} • ${s.side}`, {
          body: `Entry ${s.entry.toFixed(2)} | SL ${s.sl.toFixed(2)}`
        });
      }
    } catch(e){}
  }

  // ====== Strategy m15 ======
  function generateSignals(bars){
    const C=bars.map(b=>b.c), H=bars.map(b=>b.h), L=bars.map(b=>b.l);
    const e21=EMA(C, CONFIG.ema[0]), e50=EMA(C, CONFIG.ema[1]), e200=EMA(C, CONFIG.ema[2]);
    const rsi=RSI(C, CONFIG.rsiPeriod);
    const {k:K,d:D}=Stoch(H,L,C, CONFIG.stoch?.[0]||14, CONFIG.stoch?.[1]||3);
    const atr=ATR(H,L,C, CONFIG.atr);

    const out=[];
    for(let i=200;i<bars.length;i++){
      const up = e21[i]>e50[i] && e50[i]>e200[i];
      const dn = e21[i]<e50[i] && e50[i]<e200[i];
      const crossUp   = K[i-1]!=null && D[i-1]!=null && K[i-1]<D[i-1] && K[i]>=D[i] && K[i]<60;
      const crossDown = K[i-1]!=null && D[i-1]!=null && K[i-1]>D[i-1] && K[i]<=D[i] && K[i]>40;

      if( (up && rsi[i]>52) || crossUp ){
        const e=bars[i].c, stop=Math.max(bars[i].l - 0.6*atr[i], bars[i].l*0.998);
        const risk=e-stop; const tp=[e+0.8*risk, e+1.4*risk, e+2*risk];
        const conf=Math.min(100, Math.round((up?40:15) + Math.max(0,rsi[i]-50) + (crossUp?20:0)));
        out.push({i, side:'BUY', entry:e, sl:stop, tp, conf});
      }
      if( (dn && rsi[i]<48) || crossDown ){
        const e=bars[i].c, stop=Math.min(bars[i].h + 0.6*atr[i], bars[i].h*1.002);
        const risk=stop-e; const tp=[e-0.8*risk, e-1.4*risk, e-2*risk];
        const conf=Math.min(100, Math.round((dn?40:15) + Math.max(0,50-rsi[i]) + (crossDown?20:0)));
        out.push({i, side:'SELL', entry:e, sl:stop, tp, conf});
      }
    }

    // Fallback: nếu quá ít, thêm 1-2 tín hiệu EMA21~EMA50 gần nhất để luôn có card minh hoạ
    if(out.length < 1){
      for(let i=bars.length-80;i<bars.length-1;i++){
        if(e21[i] && e50[i] && Math.abs(e21[i]-e50[i])/bars[i].c < 0.003){
          const atrv=ATR(H,L,C,14)[i] || (0.005*bars[i].c);
          const e=bars[i].c, stop=e-0.6*atrv, risk=e-stop;
          out.push({i, side:'BUY', entry:e, sl:stop, tp:[e+0.8*risk,e+1.4*risk,e+2*risk], conf:55});
          break;
        }
      }
    }
    return out;
  }

  // ====== Backtest ngắn hạn cho 1 lệnh ======
  function simulate(s, bars){
    const qty = (CONFIG.risk.perTradeUSD * CONFIG.risk.leverage) / s.entry;
    const eBars = expiryBars();
    const riskAbs = Math.abs((s.side==='BUY' ? (s.entry - s.sl) : (s.sl - s.entry)) * qty);

    let hit=[0,0,0], when=s.i;

    for(let j=s.i+1;j<bars.length && j<=s.i+eBars;j++){
      const b=bars[j]; when=j;
      if(s.side==='BUY'){
        if(b.l<=s.sl) return {status:'SL', when, qty, pnl:-riskAbs, rr:-1, filled:hit};
        if(!hit[0]&&b.h>=s.tp[0]) hit[0]=1;
        if(!hit[1]&&b.h>=s.tp[1]) hit[1]=1;
        if(!hit[2]&&b.h>=s.tp[2]) hit[2]=1;
      } else {
        if(b.h>=s.sl) return {status:'SL', when, qty, pnl:-riskAbs, rr:-1, filled:hit};
        if(!hit[0]&&b.l<=s.tp[0]) hit[0]=1;
        if(!hit[1]&&b.l<=s.tp[1]) hit[1]=1;
        if(!hit[2]&&b.l<=s.tp[2]) hit[2]=1;
      }
      if(hit[2]||hit[1]||hit[0]){
        const w=[0.30,0.30,0.40];
        let pnl=0;
        for(let k=0;k<3;k++) if(hit[k]) pnl += (s.side==='BUY'?(s.tp[k]-s.entry):(s.entry-s.tp[k]))*qty*w[k];
        const rr = riskAbs>0 ? pnl / riskAbs : 0;
        return {status:'TP', when, qty, pnl, rr, filled:hit};
      }
    }
    return {status:'EXPIRED', when:Math.min(s.i+eBars,bars.length-1), qty, pnl:0, rr:0, filled:hit};
  }

  const fmtMoney = (x)=> (x>=0?'+':'−') + '$' + fmt2(Math.abs(x));

  async function build(){
    // summary
    let total=0, win=0, loss=0, exp=0, rrSum=0, rrN=0, pnlSum=0;

    const cards = document.getElementById('cards');
    cards.innerHTML = '';

    for(const sym of CONFIG.symbols){
      let bars=null, sigs=[];
      try{
        bars = await getKlines(sym, CONFIG.timeframe, CONFIG.candlesLimit);
        sigs = generateSignals(bars);
      }catch(e){
        showError(`${sym}: ${e.message||e}`);
      }

      const card = document.createElement('div'); card.className='card';

      if(!bars || !bars.length){
        card.innerHTML = `<div class="head"><div class="asset"><div class="sym">${sym.replace('USDT','')}</div><span class="badge">m15</span></div><div class="badge">Data error</div></div><div style="color:#93a4bf">Không tải được dữ liệu cho ${sym}. Thử Refresh hoặc đợi 1–2 phút.</div>`;
        cards.appendChild(card); continue;
      }

      // detect new signal → notify
      const latest = sigs.length ? sigs[sigs.length-1] : null;
      if (latest && LAST_SEEN[sym] !== latest.i) {
        if (LAST_SEEN[sym] !== undefined) alertSignal(sym, latest);
        LAST_SEEN[sym] = latest.i;
      }

      // thống kê (30 tín hiệu gần nhất)
      const recent = sigs.slice(-30);
      for(const s of recent){
        const sr = simulate(s, bars);
        total++;
        if(sr.status==='TP'){ win++; pnlSum+=sr.pnl; rrSum+=sr.rr; rrN++; }
        else if(sr.status==='SL'){ loss++; pnlSum+=sr.pnl; rrSum+=sr.rr; rrN++; }
        else { exp++; }
      }

      const s = latest;
      const last = bars[bars.length-1].c;

      if(!s){
        card.innerHTML = `<div class="head"><div class="asset"><div class="sym">${sym.replace('USDT','')}</div><span class="badge">m15</span></div><div class="badge">Last: $${fmt2(last)}</div></div><div style="color:#93a4bf">Không có tín hiệu gần đây.</div>`;
        cards.appendChild(card); continue;
      }

      const r = simulate(s, bars);
      const pnlPct = ((last - s.entry) / s.entry) * (s.side==='BUY'?100:-100);
      const pnlTag = r.pnl>=0 ? 'pct-pos' : 'pct-neg';

      card.innerHTML = `
        <div class="head">
          <div class="asset"><div class="sym">${sym.replace('USDT','')}</div><span class="badge">m15</span></div>
          <div class="badge">Last: $${fmt2(last)}</div>
        </div>

        <div class="kgrid">
          <div class="kv"><div class="k">ENTRY</div><div class="v">$${fmt2(s.entry)}</div></div>
          <div class="kv"><div class="k">CURRENT</div><div class="v">$${fmt2(last)}</div></div>
          <div class="kv"><div class="k">TIME</div><div class="v">15m</div></div>
          <div class="kv"><div class="k">P&L %</div><div class="v ${pnlPct>=0?'pct-pos':'pct-neg'}">${pnlPct.toFixed(2)}%</div></div>
          <div class="kv"><div class="k">PROFIT (25x)</div><div class="v ${pnlTag}">${fmtMoney(r.pnl)}</div></div>
          <div class="kv"><div class="k">STATUS</div><div class="v"><span class="status">${r.status}</span></div></div>
        </div>

        <div class="row">
          <div class="${s.side==='BUY'?'side-buy':'side-sell'}">SIDE ${s.side}</div>
          <div>CONF ${s.conf}%</div>
          <div class="sl">▼ SL $${fmt2(s.sl)}</div>
        </div>

        <div class="row tp">
          <span class="pill">🎯 TP1 • $${fmt2(s.tp[0])}</span>
          <span class="pill">🎯 TP2 • $${fmt2(s.tp[1])}</span>
          <span class="pill">🎯 TP3 • $${fmt2(s.tp[2])}</span>
          <button class="pill">Details</button>
        </div>
      `;
      cards.appendChild(card);
    }

    // update summary
    const wr = total? ((win/total)*100).toFixed(2)+'%':'0%';
    const rrAvg = rrN? (rrSum/rrN).toFixed(2) : '0.00';
    document.getElementById('sumTotal').textContent = total;
    document.getElementById('sumWin').textContent   = win;
    document.getElementById('sumLoss').textContent  = loss;
    document.getElementById('sumExp').textContent   = exp;
    document.getElementById('sumWR').textContent    = wr;
    document.getElementById('sumRR').textContent    = rrAvg;
    const sumEl = document.getElementById('sumPnL');
    sumEl.textContent = (pnlSum>=0?'+':'−') + '$' + fmt2(Math.abs(pnlSum));
    sumEl.style.color = pnlSum>=0 ? 'var(--green)' : 'var(--red)';
  }

  document.getElementById('refreshBtn').addEventListener('click', build);

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  setInterval(build, 60 * 1000);

  build();
})();
