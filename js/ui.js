(function(){
  const {CONFIG, getKlines, EMA, RSI, Stoch, ATR, tfToMs, expiryBars} = window.App;

  // RULE “dễ nổ” nhưng vẫn hợp lý:
  // BUY: EMA21>EMA50>EMA200 & RSI>52  OR  Stoch K cắt lên D dưới 60
  // SELL: EMA21<EMA50<EMA200 & RSI<48  OR  Stoch K cắt xuống D trên 40
  function generateSignals(bars){
    const closes = bars.map(b=>b.c), highs=bars.map(b=>b.h), lows=bars.map(b=>b.l);
    const ema21 = EMA(closes, CONFIG.ema[0]), ema50 = EMA(closes, CONFIG.ema[1]), ema200 = EMA(closes, CONFIG.ema[2]);
    const rsi = RSI(closes, CONFIG.rsiPeriod);
    const {k:stK,d:stD} = Stoch(highs,lows,closes, CONFIG.stoch[0], CONFIG.stoch[1]);
    const atr = ATR(highs,lows,closes, CONFIG.atr);

    const sigs=[];
    for(let i=200;i<bars.length;i++){
      const up =  ema21[i]>ema50[i] && ema50[i]>ema200[i];
      const dn =  ema21[i]<ema50[i] && ema50[i]<ema200[i];
      const stCrossUp   = stK[i-1]!=null && stD[i-1]!=null && stK[i-1]<stD[i-1] && stK[i]>=stD[i] && stK[i]<60;
      const stCrossDown = stK[i-1]!=null && stD[i-1]!=null && stK[i-1]>stD[i-1] && stK[i]<=stD[i] && stK[i]>40;

      if( (up && rsi[i]>52) || stCrossUp ){
        const e = bars[i].c, stop = Math.max(bars[i].l - 0.6*atr[i], bars[i].l*0.998);
        const risk = e - stop;
        const tp1 = e + CONFIG.tpR[0]*risk;
        const tp2 = e + CONFIG.tpR[1]*risk;
        const tp3 = e + CONFIG.tpR[2]*risk;
        const conf = Math.min(100, Math.round((up?40:15) + Math.max(0,rsi[i]-50) + (stCrossUp?20:0)));
        sigs.push({i, side:'BUY', entry:e, sl:stop, tp:[tp1,tp2,tp3], conf});
      }

      if( (dn && rsi[i]<48) || stCrossDown ){
        const e = bars[i].c, stop = Math.min(bars[i].h + 0.6*atr[i], bars[i].h*1.002);
        const risk = stop - e;
        const tp1 = e - CONFIG.tpR[0]*risk;
        const tp2 = e - CONFIG.tpR[1]*risk;
        const tp3 = e - CONFIG.tpR[2]*risk;
        const conf = Math.min(100, Math.round((dn?40:15) + Math.max(0,50-rsi[i]) + (stCrossDown?20:0)));
        sigs.push({i, side:'SELL', entry:e, sl:stop, tp:[tp1,tp2,tp3], conf});
      }
    }
    return sigs;
  }

  function simulate(signal, bars, tf){
    const start = signal.i;
    const qty   = (CONFIG.risk.perTradeUSD * CONFIG.risk.leverage) / signal.entry; // 100x25
    const eBars = expiryBars(tf);
    let hit=[0,0,0], when=start;

    for(let j=start+1; j<bars.length && j<=start+eBars; j++){
      const b = bars[j]; when=j;
      if(signal.side==='BUY'){
        if(b.l<=signal.sl) return {status:'SL', when, qty, pnl:(signal.sl - signal.entry)*qty, filled:hit};
        if(!hit[0] && b.h>=signal.tp[0]) hit[0]=1;
        if(!hit[1] && b.h>=signal.tp[1]) hit[1]=1;
        if(!hit[2] && b.h>=signal.tp[2]) hit[2]=1;
      } else {
        if(b.h>=signal.sl) return {status:'SL', when, qty, pnl:(signal.entry - signal.sl)*qty, filled:hit};
        if(!hit[0] && b.l<=signal.tp[0]) hit[0]=1;
        if(!hit[1] && b.l<=signal.tp[1]) hit[1]=1;
        if(!hit[2] && b.l<=signal.tp[2]) hit[2]=1;
      }
      if(hit[2]) return tpResult(when, hit, qty, signal);
      if(hit[1]) return tpResult(when, hit, qty, signal);
      if(hit[0]) return tpResult(when, hit, qty, signal);
    }
    const px = bars[Math.min(start+eBars, bars.length-1)].c;
    const pnl = (signal.side==='BUY'? (px - signal.entry) : (signal.entry - px)) * qty;
    return {status:'EXPIRED', when, qty, pnl, filled:hit};
  }

  function tpResult(when, filled, qty, s){
    const w = CONFIG.tpSplit;
    let pnl=0;
    for(let k=0;k<3;k++){
      if(filled[k]){
        const leg = (s.side==='BUY'? (s.tp[k]-s.entry) : (s.entry - s.tp[k])) * qty * w[k];
        pnl += leg;
      }
    }
    return {status:'TP', when, qty, pnl, filled};
  }

  function fmt2(x){ return (Math.round(x*100)/100).toFixed(2); }

  // ====== UI ======
  let state = {ex:CONFIG.defaultExchange, sym:'BTCUSDT', tf:'1h', auto:false, rows:[]};

  async function run(){
    try{
      const bars = await getKlines(state.ex, state.sym, state.tf, CONFIG.candlesLimit);
      let sigs = generateSignals(bars);

      // luôn có card: nếu ít quá thì tạo bổ sung từ giao-cắt EMA gần đây (fallback hiển thị)
      if(sigs.length < 3){
        const closes = bars.map(b=>b.c);
        const ema21 = EMA(closes, CONFIG.ema[0]);
        const ema50 = EMA(closes, CONFIG.ema[1]);
        for(let i=bars.length-80;i<bars.length-1;i++){
          if(ema21[i] && ema50[i] && Math.abs(ema21[i]-ema50[i])/bars[i].c < 0.003){
            const atr=ATR(bars.map(b=>b.h),bars.map(b=>b.l),closes,14)[i]|| (0.005*bars[i].c);
            const e=bars[i].c, stop=e-0.6*atr, risk=e-stop;
            const tp=[e+0.8*risk, e+1.4*risk, e+2*risk];
            sigs.push({i, side:'BUY', entry:e, sl:stop, tp, conf:55});
          }
        }
      }

      const rows = sigs.slice(-12).map(s=>{
        const r = simulate(s, bars, state.tf);
        const entryTs = new Date(bars[s.i].t).toLocaleString();
        return {s, r, entryTs, lastPx: bars[bars.length-1].c};
      }).reverse();

      state.rows = rows;
      render(rows);
    }catch(err){
      alert('Lỗi tải dữ liệu: ' + (err.message||err));
      console.error(err);
    }
  }

  function render(rows){
    const cards = document.getElementById('cards');
    cards.innerHTML='';
    let buy=0,sell=0,done=0,active=0,tpWins=0,slLoss=0;

    rows.forEach(row=>{
      if(row.s.side==='BUY') buy++; else sell++;
      if(row.r.status==='TP' || row.r.status==='SL') done++; else active++;
      if(row.r.status==='TP') tpWins++; if(row.r.status==='SL') slLoss++;
    });
    const wr = done? (tpWins/done*100).toFixed(2)+'%':'0%';
    document.getElementById('activeCount').textContent = active;
    document.getElementById('doneCount').textContent = done;
    document.getElementById('buyCount').textContent = buy;
    document.getElementById('sellCount').textContent = sell;
    document.getElementById('wr').textContent = wr;

    rows.forEach(({s,r,entryTs,lastPx})=>{
      const card = document.createElement('div'); card.className='card';
      const sideClass = s.side==='BUY'?'side-buy':'side-sell';
      const pnlTag = r.pnl>=0? 'pct-pos':'pct-neg';
      const tpPills = [1,2,3].map(k=>{
        const hit = r.filled && r.filled[k-1]===1;
        return `<span class="pill">${hit? '✓':''} TP${k} · ${Math.round(CONFIG.tpSplit[k-1]*100)}%</span>`;
      }).join('');
      const statusBtn = r.status==='TP'? `<button class="btn neutral">TP hit</button>`
                      : r.status==='SL'? `<button class="btn neutral">Stopped</button>`
                      : `<button class="btn primary">⏳ ACTIVE</button>`;

      card.innerHTML = `
        <div class="card-head">
          <div class="asset"><div class="name">${state.sym}</div><span class="badge">NEW</span></div>
          <div class="actions">${statusBtn}<button class="btn">Details</button></div>
        </div>

        <div class="grid2">
          <div class="h-row">
            <div class="kv"><div class="k">Side</div><div class="v ${sideClass}">${s.side}</div></div>
            <div class="kv"><div class="k">Entry</div><div class="v">$${fmt2(s.entry)}</div></div>
            <div class="kv"><div class="k">Current</div><div class="v">$${fmt2(lastPx)}</div></div>
            <div class="kv"><div class="k">Time</div><div class="v">${(r.when - s.i) || 0} bars</div></div>
            <div class="kv"><div class="k">P&L (25x)</div><div class="v ${pnlTag}">${r.pnl>=0?'+':''}${fmt2(r.pnl)}</div></div>
          </div>
          <div class="h-row">
            <div class="kv"><div class="k sl">SL</div><div class="v sl">$${fmt2(s.sl)}</div></div>
            <div class="kv"><div class="k">TF</div><div class="v">${state.tf}</div></div>
            <div class="kv"><div class="k">Conf</div><div class="v">${s.conf}%</div></div>
            <div class="kv"><div class="k">R/R (TP1..3)</div><div class="v">${CONFIG.tpR.join(' / ')}</div></div>
          </div>
        </div>

        <div class="h-row">
          <div class="tp">${tpPills}</div>
          <div class="kv"><div class="k">Timestamp</div><div class="v">${entryTs}</div></div>
        </div>
      `;
      cards.appendChild(card);
    });
  }

  // ====== Controls ======
  const exSel = document.getElementById('exSel');
  const symSel= document.getElementById('symSel');
  const tfSel = document.getElementById('tfSel');
  document.getElementById('refreshBtn').addEventListener('click', run);
  const autoBtn = document.getElementById('autoBtn');
  autoBtn.addEventListener('click', ()=>{ state.auto=!state.auto; autoBtn.textContent = state.auto? 'Auto: ON':'Auto: OFF'; });

  exSel.addEventListener('change', e=> state.ex=e.target.value);
  symSel.addEventListener('change', e=> state.sym=e.target.value);
  tfSel.addEventListener('change',  e=> state.tf=e.target.value);

  let state = {ex:CONFIG.defaultExchange, sym:'BTCUSDT', tf:'1h', auto:false, rows:[]};

  (async function loop(){
    while(true){
      if(state.auto){ await run(); await new Promise(r=>setTimeout(r, tfToMs(state.tf))); }
      else { await new Promise(r=>setTimeout(r, 1000)); }
    }
  })();

  run();
})();
