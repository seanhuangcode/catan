/*
 * Browser UI: renders the board as SVG, the sidebar (log, players, bank), the
 * player's hand and action bar, and all dialogs (discard, steal, trading,
 * development cards, game over).
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const R = C.RESOURCES;
  const S = 60; // pixels per hex unit inside the SVG viewBox

  const RES_INFO = {
    wood: { name: 'Lumber', icon: '🌲', color: '#3f8f3a', light: '#6cbf55' },
    brick: { name: 'Brick', icon: '🧱', color: '#c2552c', light: '#e2804f' },
    sheep: { name: 'Wool', icon: '🐑', color: '#8dc24a', light: '#b7e27a' },
    wheat: { name: 'Grain', icon: '🌾', color: '#e8b923', light: '#f7d966' },
    ore: { name: 'Ore', icon: '⛰️', color: '#7f8791', light: '#aab1ba' },
    desert: { name: 'Desert', icon: '🌵', color: '#d8bd84', light: '#efdcab' },
  };
  const DEV_INFO = {
    knight: { name: 'Knight', icon: '⚔️', desc: 'Move the robber and steal 1 card from a player next to it.' },
    victoryPoint: { name: 'Victory Point', icon: '🏆', desc: 'Worth 1 victory point. Kept hidden until the game ends.' },
    roadBuilding: { name: 'Road Building', icon: '🛤️', desc: 'Build 2 roads for free.' },
    yearOfPlenty: { name: 'Year of Plenty', icon: '🎁', desc: 'Take any 2 resources from the bank.' },
    monopoly: { name: 'Monopoly', icon: '💰', desc: 'Name a resource. Every player gives you all of theirs.' },
  };
  const DIE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  C.RES_INFO = RES_INFO;
  C.DEV_INFO = DEV_INFO;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pt = (x, y) => `${(x * S).toFixed(1)},${(y * S).toFixed(1)}`;

  function costHtml(cost) {
    return R.filter(r => cost[r]).map(r => `<span class="mini-card res-${r}" title="${RES_INFO[r].name}">${RES_INFO[r].icon}</span>`.repeat(cost[r])).join('');
  }

  function diceHtml(d, rolling) {
    const pips = {
      1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9],
    }[d] || [];
    let cells = '';
    for (let i = 1; i <= 9; i++) cells += `<span class="${pips.includes(i) ? 'pip' : ''}"></span>`;
    return `<div class="die${rolling ? ' rolling' : ''}">${cells}</div>`;
  }

  class UI {
    constructor() {
      this.$ = id => document.getElementById(id);
      this.mode = null; // 'road' | 'settlement' | 'city' while choosing a spot
      this.dialog = null;
      this.logRendered = 0;
      this.seenRoll = 0;
      this.rollTime = 0;
      this.freshSeq = -1;
      this.gameOverShown = false;

      this.$('board').addEventListener('click', e => this.onBoardClick(e));
      this.$('actions').addEventListener('click', e => this.onActionClick(e));
      this.$('hand').addEventListener('click', e => this.onHandClick(e));
      this.$('modal-root').addEventListener('click', e => this.onDialogClick(e));
      this.$('modal-root').addEventListener('contextmenu', e => this.onDialogClick(e, true));
      document.addEventListener('keydown', e => this.onKey(e));
    }

    start(game, controller, human) {
      this.game = game;
      this.controller = controller;
      this.human = human;
      this.mode = null;
      this.dialog = null;
      this.drawDialog();
      this.logRendered = 0;
      this.$('log').innerHTML = '';
      this.seenRoll = 0;
      this.rollTime = 0;
      this.freshSeq = -1;
      this.gameOverShown = false;
      game.on(g => { if (g === this.game) this.render(); });
      this.render();
    }

    get me() { return this.game.players[this.human]; }
    get myTurn() { return this.game.current === this.human; }

    act(action) {
      const res = this.game.perform(this.human, action);
      if (!res.ok) this.toast(res.error);
      return res.ok;
    }

    toast(msg) {
      const t = this.$('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    }

    // ------------------------------------------------------------- render

    render() {
      const g = this.game;
      if (this.mode && !(this.myTurn && g.phase === 'main')) this.mode = null;
      if (g.rollCount !== this.seenRoll) {
        this.seenRoll = g.rollCount;
        this.rollTime = Date.now();
        clearTimeout(this.rollTimer);
        this.rollTimer = setTimeout(() => this.renderBoard(), 1700);
      }
      this.renderBoard();
      this.renderBanner();
      this.renderDice();
      this.renderLog();
      this.renderPlayers();
      this.renderBank();
      this.renderHand();
      this.renderActions();
      this.syncDialogs();
    }

    highlights() {
      const g = this.game;
      const me = this.human;
      if (g.phase === 'gameOver' || g.current !== me) return {};
      switch (g.phase) {
        case 'setupSettlement': return { vertices: g.validSettlementSpots(me, true) };
        case 'setupRoad':
        case 'roadBuilding': return { edges: g.validRoadSpots(me) };
        case 'moveRobber': return { hexes: g.validRobberHexes(me) };
        case 'main':
          if (this.mode === 'road') return { edges: g.validRoadSpots(me) };
          if (this.mode === 'settlement') return { vertices: g.validSettlementSpots(me, false) };
          if (this.mode === 'city') return { vertices: g.validCitySpots(me), city: true };
      }
      return {};
    }

    renderBoard() {
      const g = this.game;
      const out = [];
      const hl = this.highlights();
      const rollSum = g.dice ? g.dice[0] + g.dice[1] : 0;
      const flashing = Date.now() - this.rollTime < 1600 && rollSum !== 7;
      const fresh = g.lastBuild && g.lastBuild.seq !== this.freshSeq ? g.lastBuild : null;
      if (fresh) this.freshSeq = fresh.seq;

      out.push('<defs>');
      for (const r of Object.keys(RES_INFO)) {
        out.push(`<radialGradient id="grad-${r}" cx="50%" cy="40%" r="65%"><stop offset="0%" stop-color="${RES_INFO[r].light}"/><stop offset="100%" stop-color="${RES_INFO[r].color}"/></radialGradient>`);
      }
      out.push('<filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-opacity="0.45"/></filter>');
      out.push('</defs>');

      // Sea frame (a flat-topped hexagon around the island).
      const sea = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        sea.push(pt(5.35 * Math.cos(a), 5.35 * Math.sin(a)));
      }
      out.push(`<polygon class="sea" points="${sea.join(' ')}"/>`);

      // Harbors.
      for (const port of g.ports) {
        for (const vid of port.vertices) {
          const v = g.vertices[vid];
          out.push(`<line class="pier" x1="${port.x * S}" y1="${port.y * S}" x2="${(v.x + (port.x - v.x) * 0.25) * S}" y2="${(v.y + (port.y - v.y) * 0.25) * S}"/>`);
        }
        const label = port.type === 'any' ? '3:1' : '2:1';
        const title = port.type === 'any' ? 'Trade any 3 identical resources for 1' : `Trade 2 ${RES_INFO[port.type].name} for 1 resource`;
        out.push(`<g class="port"><title>${title}</title><circle cx="${port.x * S}" cy="${port.y * S}" r="${0.3 * S}"/>`);
        if (port.type === 'any') {
          out.push(`<text x="${port.x * S}" y="${port.y * S + 5}" class="port-ratio big">?</text>`);
          out.push(`<text x="${port.x * S}" y="${port.y * S + 0.5 * S}" class="port-label">${label}</text>`);
        } else {
          out.push(`<text x="${port.x * S}" y="${port.y * S + 6}" class="port-icon">${RES_INFO[port.type].icon}</text>`);
          out.push(`<text x="${port.x * S}" y="${port.y * S + 0.5 * S}" class="port-label">${label}</text>`);
        }
        out.push('</g>');
      }

      // Tiles.
      for (const h of g.hexes) {
        const pts = h.vertices.map(vid => pt(g.vertices[vid].x, g.vertices[vid].y)).join(' ');
        const producing = flashing && h.number === rollSum && h.id !== g.robber;
        out.push(`<g class="tile${producing ? ' producing' : ''}">`);
        out.push(`<title>${RES_INFO[h.resource].name}${h.number ? ' (' + h.number + ')' : ''}</title>`);
        out.push(`<polygon points="${pts}" fill="url(#grad-${h.resource})" class="tile-shape"/>`);
        out.push(`<text x="${h.x * S}" y="${h.y * S - 0.38 * S}" class="tile-icon">${RES_INFO[h.resource].icon}</text>`);
        if (h.number) {
          const red = h.number === 6 || h.number === 8;
          const cx = h.x * S;
          const cy = h.y * S + 0.14 * S;
          out.push(`<g class="token${red ? ' red' : ''}" filter="url(#shadow)"><circle cx="${cx}" cy="${cy}" r="${0.3 * S}"/>`);
          out.push(`<text x="${cx}" y="${cy + 3}" class="token-num">${h.number}</text>`);
          const n = C.PIPS[h.number];
          for (let i = 0; i < n; i++) out.push(`<circle class="token-pip" cx="${cx + (i - (n - 1) / 2) * 4}" cy="${cy + 0.17 * S}" r="1.6"/>`);
          out.push('</g>');
        }
        out.push('</g>');
      }

      // Robber.
      const rh = g.hexes[g.robber];
      const rx = rh.x * S + (rh.number ? 0.42 * S : 0);
      const ry = rh.y * S + 0.1 * S;
      out.push(`<g class="robber" transform="translate(${rx},${ry})" filter="url(#shadow)"><title>Robber</title><ellipse cx="0" cy="13" rx="10" ry="3.5" class="robber-shadow"/><path d="M-8.5 13 C-10 2 -6 -4 -4 -5 L4 -5 C6 -4 10 2 8.5 13 Z"/><circle cx="0" cy="-10" r="6.5"/></g>`);

      // Roads.
      for (const e of g.edges) {
        if (e.road === null) continue;
        const a = g.vertices[e.v[0]];
        const b = g.vertices[e.v[1]];
        const k = 0.17;
        const x1 = (a.x + (b.x - a.x) * k) * S, y1 = (a.y + (b.y - a.y) * k) * S;
        const x2 = (b.x + (a.x - b.x) * k) * S, y2 = (b.y + (a.y - b.y) * k) * S;
        const isFresh = fresh && fresh.kind === 'edge' && fresh.id === e.id;
        out.push(`<g class="road${isFresh ? ' fresh' : ''}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="road-outline"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${g.players[e.road].color}" class="road-fill"/></g>`);
      }

      // Settlements and cities.
      for (const v of g.vertices) {
        if (!v.building) continue;
        const color = g.players[v.building.player].color;
        const isFresh = fresh && fresh.kind === 'vertex' && fresh.id === v.id;
        const d = v.building.type === 'city'
          ? 'M-15 11 L15 11 L15 -4 L3 -4 L3 -9 L-6 -17 L-15 -9 Z'
          : 'M-10 10 L10 10 L10 -2 L0 -11 L-10 -2 Z';
        out.push(`<g class="building${isFresh ? ' fresh' : ''}" transform="translate(${v.x * S},${v.y * S})"><path d="${d}" fill="${color}" class="building-shape" filter="url(#shadow)"/></g>`);
      }

      // Clickable highlights.
      if (hl.hexes) {
        for (const hid of hl.hexes) {
          const h = g.hexes[hid];
          const pts = h.vertices.map(vid => pt(g.vertices[vid].x, g.vertices[vid].y)).join(' ');
          out.push(`<polygon class="hex-spot" data-hex="${hid}" points="${pts}"/>`);
        }
      }
      if (hl.edges) {
        for (const eid of hl.edges) {
          const e = g.edges[eid];
          const a = g.vertices[e.v[0]];
          const b = g.vertices[e.v[1]];
          out.push(`<g class="edge-spot" data-edge="${eid}"><line x1="${a.x * S}" y1="${a.y * S}" x2="${b.x * S}" y2="${b.y * S}" class="edge-hit"/><line x1="${(a.x * 0.8 + b.x * 0.2) * S}" y1="${(a.y * 0.8 + b.y * 0.2) * S}" x2="${(a.x * 0.2 + b.x * 0.8) * S}" y2="${(a.y * 0.2 + b.y * 0.8) * S}" class="edge-mark" stroke="${this.me.color}"/></g>`);
        }
      }
      if (hl.vertices) {
        for (const vid of hl.vertices) {
          const v = g.vertices[vid];
          out.push(`<circle class="spot${hl.city ? ' city-spot' : ''}" data-vertex="${vid}" cx="${v.x * S}" cy="${v.y * S}" r="${hl.city ? 17 : 10}" style="--c:${this.me.color}"/>`);
        }
      }

      this.$('board').innerHTML = out.join('');
    }

    renderBanner() {
      const g = this.game;
      const me = this.human;
      const cur = g.players[g.current];
      const mine = g.current === me;
      const name = `<b style="color:${cur.color}">${esc(cur.name)}</b>`;
      let text;
      switch (g.phase) {
        case 'setupSettlement':
          text = mine ? `Place your ${g.setupStep < g.players.length ? 'first' : 'second'} settlement` : `${name} is placing a settlement`;
          break;
        case 'setupRoad':
          text = mine ? 'Place a road next to your settlement' : `${name} is placing a road`;
          break;
        case 'preRoll':
          text = mine ? 'Your turn — roll the dice' : `${name} is rolling`;
          break;
        case 'discard':
          text = g.discardPending[me] ? `You rolled over 7 cards — discard ${g.discardPending[me]}` : 'Waiting for players to discard…';
          break;
        case 'moveRobber':
          text = mine ? 'Move the robber to a new tile' : `${name} is moving the robber`;
          break;
        case 'steal':
          text = mine ? 'Choose a player to steal from' : `${name} is stealing`;
          break;
        case 'roadBuilding':
          text = mine ? `Place ${g.freeRoads} free road${g.freeRoads === 1 ? '' : 's'}` : `${name} is building roads`;
          break;
        case 'main':
          if (!mine) text = `${name}'s turn`;
          else if (this.mode) text = `Choose where to build your ${this.mode} <span class="hint">(Esc to cancel)</span>`;
          else text = 'Build, trade, or end your turn';
          break;
        case 'gameOver': {
          const w = g.players[g.winner];
          text = g.winner === me ? '🏆 You win!' : `🏆 <b style="color:${w.color}">${esc(w.name)}</b> wins!`;
          break;
        }
      }
      const b = this.$('banner');
      b.innerHTML = text;
      b.classList.toggle('mine', mine && g.phase !== 'gameOver');
    }

    renderDice() {
      const g = this.game;
      const el = this.$('dice');
      if (!g.dice) { el.innerHTML = ''; return; }
      const rolling = Date.now() - this.rollTime < 600;
      const sum = g.dice[0] + g.dice[1];
      el.innerHTML = diceHtml(g.dice[0], rolling) + diceHtml(g.dice[1], rolling) + `<div class="dice-sum${sum === 7 ? ' seven' : ''}">${sum}</div>`;
    }

    logPart(part) {
      const g = this.game;
      if (typeof part === 'string') return esc(part);
      if (part.piece) {
        return `<span class="log-piece" style="color:${g.players[part.p].color}">${part.piece === 'road' ? '▬' : part.piece === 'city' ? '🏰' : '⌂'}</span> ${part.piece}`;
      }
      if (part.p !== undefined) {
        const p = g.players[part.p];
        return `<b class="pname" style="color:${p.color}">${esc(p.name)}</b>`;
      }
      if (part.r) {
        const card = `<span class="mini-card res-${part.r}" title="${RES_INFO[part.r].name}">${RES_INFO[part.r].icon}</span>`;
        if (part.plain) return card;
        return part.n > 5 ? `${card}×${part.n}` : card.repeat(part.n);
      }
      if (part.d) {
        if (part.d === 'hidden') return '<span class="mini-card dev-back">?</span> development card';
        return `<span class="mini-card dev">${DEV_INFO[part.d].icon}</span> ${DEV_INFO[part.d].name}`;
      }
      if (part.dice) {
        const sum = part.dice[0] + part.dice[1];
        return `<span class="log-dice">${DIE_FACES[part.dice[0]]}${DIE_FACES[part.dice[1]]}</span> <b class="${sum === 7 ? 'seven' : ''}">${sum}</b>`;
      }
      if (part.tile) return `${RES_INFO[part.tile].icon} ${RES_INFO[part.tile].name}${part.number ? ' ' + part.number : ''}`;
      if (part.award) return `<span class="award">${part.award === 'longestRoad' ? '🛣️ Longest Road' : '⚔️ Largest Army'}</span>`;
      return '';
    }

    renderLog() {
      const g = this.game;
      const box = this.$('log');
      if (this.logRendered > g.log.length) { box.innerHTML = ''; this.logRendered = 0; }
      if (this.logRendered === g.log.length) return;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      const frag = [];
      for (let i = this.logRendered; i < g.log.length; i++) {
        const entry = g.log[i];
        const first = entry.parts[0];
        if (first && first.turnStart !== undefined) {
          const p = g.players[first.turnStart];
          const label = first.turnStart === this.human ? 'Your turn' : `${esc(p.name)}'s turn`;
          frag.push(`<div class="log-turn" style="--c:${p.color}"><span>${label}</span></div>`);
          continue;
        }
        let parts = entry.priv && entry.priv.to.includes(this.human) ? entry.priv.parts : entry.parts;
        if (parts[0] && parts[0].p === this.human && typeof parts[1] === 'string' && parts[1].startsWith(' wants ')) {
          parts = [parts[0], ' want ' + parts[1].slice(7), ...parts.slice(2)];
        }
        frag.push(`<div class="log-entry">${parts.map(x => this.logPart(x)).join('')}</div>`);
      }
      box.insertAdjacentHTML('beforeend', frag.join(''));
      this.logRendered = g.log.length;
      if (atBottom) box.scrollTop = box.scrollHeight;
    }

    renderPlayers() {
      const g = this.game;
      const html = g.players.map(p => {
        const isMe = p.id === this.human;
        const vpPublic = g.victoryPoints(p.id, false);
        const vpAll = g.victoryPoints(p.id, true);
        const hidden = isMe && vpAll > vpPublic ? `<small title="Including your hidden Victory Point cards">(${vpAll})</small>` : '';
        const cards = C.handTotal(p.hand);
        const badges = [];
        if (g.longestRoadHolder === p.id) badges.push('<span class="badge" title="Longest Road (+2 VP)">🛣️</span>');
        if (g.largestArmyHolder === p.id) badges.push('<span class="badge" title="Largest Army (+2 VP)">⚔️</span>');
        const status = g.phase === 'discard' && g.discardPending[p.id] ? '<span class="status">discarding…</span>' : '';
        return `<div class="player${p.id === g.current && g.phase !== 'gameOver' ? ' current' : ''}${isMe ? ' me' : ''}" style="--c:${p.color}">
          <div class="avatar">${p.isBot ? '🤖' : '🙂'}</div>
          <div class="pinfo">
            <div class="pname-row"><span class="pname">${esc(p.name)}</span>${badges.join('')}${status}</div>
            <div class="pstats">
              <span title="Resource cards" class="${cards > 7 ? 'warn' : ''}"><i class="ic-card"></i>${cards}</span>
              <span title="Development cards"><i class="ic-dev"></i>${p.devCards.length}</span>
              <span title="Knights played">⚔️ ${p.knightsPlayed}</span>
              <span title="Longest road length">🛣️ ${p.roadLength}</span>
            </div>
          </div>
          <div class="vp" title="Victory points">${vpPublic}${hidden}</div>
        </div>`;
      }).join('');
      this.$('players').innerHTML = html;
    }

    renderBank() {
      const g = this.game;
      const cards = R.map(r => `<div class="bank-card res-${r}" title="${RES_INFO[r].name}"><span>${RES_INFO[r].icon}</span><b>${g.bank[r]}</b></div>`).join('');
      this.$('bank').innerHTML = `<div class="bank-title">Bank</div><div class="bank-cards">${cards}<div class="bank-card dev" title="Development cards"><span>🂠</span><b>${g.devDeck.length}</b></div></div>`;
    }

    renderHand() {
      const g = this.game;
      const p = this.me;
      const res = R.filter(r => p.hand[r] > 0).map(r =>
        `<div class="card res-${r}" title="${RES_INFO[r].name}"><span class="card-icon">${RES_INFO[r].icon}</span><span class="card-name">${RES_INFO[r].name}</span><span class="card-count">${p.hand[r]}</span></div>`
      );
      const groups = {};
      for (const c of p.devCards) {
        const gr = groups[c.type] || (groups[c.type] = { total: 0, playable: 0 });
        gr.total++;
        if (c.turnBought < g.turn) gr.playable++;
      }
      const canPlayNow = this.myTurn && (g.phase === 'preRoll' || g.phase === 'main') && !g.devPlayed;
      const devs = Object.keys(DEV_INFO).filter(t => groups[t]).map(t => {
        const gr = groups[t];
        const playable = t !== 'victoryPoint' && canPlayNow && gr.playable > 0;
        const fresh = gr.playable < gr.total && t !== 'victoryPoint';
        return `<div class="card dev-card${playable ? ' playable' : ''}${t === 'victoryPoint' ? ' vp-card' : ''}" data-dev="${t}" title="${DEV_INFO[t].name}: ${DEV_INFO[t].desc}${fresh ? ' (bought this turn)' : ''}">
          <span class="card-icon">${DEV_INFO[t].icon}</span><span class="card-name">${DEV_INFO[t].name}</span><span class="card-count">${gr.total}</span>${fresh ? '<span class="card-new">new</span>' : ''}</div>`;
      });
      const empty = !res.length && !devs.length ? '<div class="hand-empty">No cards in hand</div>' : '';
      this.$('hand').innerHTML = res.join('') + (devs.length && res.length ? '<div class="hand-sep"></div>' : '') + devs.join('') + empty;
    }

    renderActions() {
      const g = this.game;
      const p = this.me;
      const mine = this.myTurn;
      const main = mine && g.phase === 'main';
      const btn = (id, label, icon, cost, enabled, extra = '') =>
        `<button class="action${this.mode === id ? ' active' : ''}" data-action="${id}" ${enabled ? '' : 'disabled'} title="${label}">
          <span class="action-icon">${icon}</span><span class="action-label">${label}${extra}</span>${cost ? `<span class="action-cost">${costHtml(cost)}</span>` : ''}</button>`;
      const canRoad = main && p.roadsLeft > 0 && C.hasResources(p.hand, C.COSTS.road) && g.validRoadSpots(this.human).length > 0;
      const canSettle = main && p.settlementsLeft > 0 && C.hasResources(p.hand, C.COSTS.settlement) && g.validSettlementSpots(this.human).length > 0;
      const canCity = main && p.citiesLeft > 0 && C.hasResources(p.hand, C.COSTS.city) && g.validCitySpots(this.human).length > 0;
      const canDev = main && g.devDeck.length > 0 && C.hasResources(p.hand, C.COSTS.dev);
      const parts = [
        btn('trade', 'Trade', '⇄', null, main),
        btn('dev', 'Dev Card', '🂠', C.COSTS.dev, canDev),
        btn('road', 'Road', `<span class="piece road-piece" style="--c:${p.color}"></span>`, C.COSTS.road, canRoad, ` <small>${p.roadsLeft}</small>`),
        btn('settlement', 'Settlement', `<span class="piece settle-piece" style="--c:${p.color}"></span>`, C.COSTS.settlement, canSettle, ` <small>${p.settlementsLeft}</small>`),
        btn('city', 'City', `<span class="piece city-piece" style="--c:${p.color}"></span>`, C.COSTS.city, canCity, ` <small>${p.citiesLeft}</small>`),
      ];
      if (mine && g.phase === 'preRoll') parts.push('<button class="action primary" data-action="roll" title="Roll dice (Space)"><span class="action-icon">🎲</span><span class="action-label">Roll Dice</span></button>');
      else parts.push(`<button class="action primary" data-action="end" ${main ? '' : 'disabled'} title="End turn (Space)"><span class="action-icon">⏭</span><span class="action-label">End Turn</span></button>`);
      this.$('actions').innerHTML = parts.join('');
    }

    // ------------------------------------------------------------- input

    onBoardClick(e) {
      const g = this.game;
      const t = e.target.closest('[data-vertex],[data-edge],[data-hex]');
      if (!t) return;
      if (t.dataset.vertex !== undefined) {
        const vertex = Number(t.dataset.vertex);
        if (g.phase === 'setupSettlement') this.act({ type: 'placeSetupSettlement', vertex });
        else if (this.mode === 'settlement') { this.mode = null; this.act({ type: 'buildSettlement', vertex }); }
        else if (this.mode === 'city') { this.mode = null; this.act({ type: 'buildCity', vertex }); }
      } else if (t.dataset.edge !== undefined) {
        const edge = Number(t.dataset.edge);
        if (g.phase === 'setupRoad') this.act({ type: 'placeSetupRoad', edge });
        else if (g.phase === 'roadBuilding') this.act({ type: 'placeFreeRoad', edge });
        else if (this.mode === 'road') { this.mode = null; this.act({ type: 'buildRoad', edge }); }
      } else if (t.dataset.hex !== undefined) {
        this.act({ type: 'moveRobber', hex: Number(t.dataset.hex) });
      }
    }

    onActionClick(e) {
      const b = e.target.closest('button[data-action]');
      if (!b || b.disabled) return;
      const a = b.dataset.action;
      if (a === 'roll') this.act({ type: 'rollDice' });
      else if (a === 'end') this.act({ type: 'endTurn' });
      else if (a === 'dev') this.act({ type: 'buyDevCard' });
      else if (a === 'trade') this.openTrade();
      else {
        this.mode = this.mode === a ? null : a;
        this.render();
      }
    }

    onHandClick(e) {
      const c = e.target.closest('[data-dev]');
      if (!c) return;
      const type = c.dataset.dev;
      if (type === 'victoryPoint') { this.toast('Victory Point cards count automatically.'); return; }
      if (!c.classList.contains('playable')) {
        const g = this.game;
        if (!this.myTurn) this.toast('You can only play development cards on your turn.');
        else if (g.devPlayed) this.toast('You can only play one development card per turn.');
        else this.toast("You can't play a card on the turn you bought it.");
        return;
      }
      if (type === 'knight') this.act({ type: 'playKnight' });
      else if (type === 'roadBuilding') this.act({ type: 'playRoadBuilding' });
      else if (type === 'yearOfPlenty') this.openYearOfPlenty();
      else if (type === 'monopoly') this.openMonopoly();
    }

    onKey(e) {
      if (!this.game || e.target.tagName === 'INPUT') return;
      const g = this.game;
      if (e.key === 'Escape') {
        if (this.dialog && this.dialog.closable) this.closeDialog();
        else if (this.mode) { this.mode = null; this.render(); }
        return;
      }
      if (this.dialog) return;
      if (e.code === 'Space' && this.myTurn) {
        e.preventDefault();
        if (g.phase === 'preRoll') this.act({ type: 'rollDice' });
        else if (g.phase === 'main') this.act({ type: 'endTurn' });
      }
    }

    // ----------------------------------------------------------- dialogs

    /**
     * Opens a dialog. spec = {id, title, closable, draw() -> html, on: {action(dataset, isRightClick)}}
     * Elements with data-act="name" inside the dialog call spec.on[name].
     */
    openDialog(spec) {
      this.dialog = spec;
      this.drawDialog();
    }

    drawDialog() {
      const root = this.$('modal-root');
      const d = this.dialog;
      if (!d) { root.innerHTML = ''; root.className = ''; return; }
      root.className = 'open' + (d.wide ? ' wide' : '');
      root.innerHTML = `<div class="modal"><div class="modal-head"><h3>${d.title}</h3>${d.closable ? '<button class="modal-x" data-act="close" title="Close">×</button>' : ''}</div><div class="modal-body">${d.draw()}</div></div>`;
    }

    closeDialog() {
      const d = this.dialog;
      this.dialog = null;
      this.drawDialog();
      if (d && d.onClose) d.onClose();
    }

    onDialogClick(e, right) {
      const t = e.target.closest('[data-act]');
      if (!t || !this.dialog) return;
      if (right) e.preventDefault();
      if (t.disabled) return;
      const act = t.dataset.act;
      if (act === 'close') { this.closeDialog(); return; }
      const fn = this.dialog.on && this.dialog.on[act];
      if (fn) {
        const spec = this.dialog;
        fn(t.dataset, right);
        if (this.dialog === spec) this.drawDialog();
      }
    }

    /** Opens/closes dialogs that are driven by game state. */
    syncDialogs() {
      const g = this.game;
      const me = this.human;
      const id = this.dialog && this.dialog.id;
      if (g.phase === 'gameOver') {
        if (!this.gameOverShown) {
          this.gameOverShown = true;
          if (this.dialog && this.dialog.onClose) this.dialog.onClose();
          this.openGameOver();
        }
        return;
      }
      if (id === 'discard' && !(g.phase === 'discard' && g.discardPending[me])) this.closeDialog();
      if (id === 'steal' && !(g.phase === 'steal' && this.myTurn)) this.closeDialog();
      if (id === 'trade' && !(g.phase === 'main' && this.myTurn)) this.closeDialog();
      if (this.dialog && this.dialog.id === 'trade') this.drawDialog();

      if (!this.dialog && g.phase === 'discard' && g.discardPending[me]) this.openDiscard();
      if (!this.dialog && g.phase === 'steal' && this.myTurn) this.openSteal();
    }

    resourcePicker(sel, opts) {
      // Renders one row of resource steppers. opts: {act, max(r), sub(r)}
      return `<div class="picker">${R.map(r => {
        const max = opts.max ? opts.max(r) : Infinity;
        return `<div class="pick res-${r}${sel[r] ? ' on' : ''}">
          <button class="pick-card" data-act="${opts.act}" data-r="${r}" data-d="1" ${sel[r] >= max ? 'disabled' : ''} title="Click to add, right-click to remove">
            <span class="card-icon">${RES_INFO[r].icon}</span>${sel[r] ? `<span class="pick-count">${sel[r]}</span>` : ''}
          </button>
          <div class="pick-sub">${opts.sub ? opts.sub(r) : ''}</div>
          <button class="pick-minus" data-act="${opts.act}" data-r="${r}" data-d="-1" ${sel[r] ? '' : 'disabled'}>−</button>
        </div>`;
      }).join('')}</div>`;
    }

    openDiscard() {
      const g = this.game;
      const me = this.human;
      const sel = C.emptyHand();
      this.openDialog({
        id: 'discard',
        title: 'Discard cards',
        draw: () => {
          const n = g.discardPending[me] || 0;
          const left = n - C.handTotal(sel);
          return `<p>You have more than 7 cards. Choose <b>${n}</b> to give back to the bank.</p>
            ${this.resourcePicker(sel, { act: 'pick', max: r => this.me.hand[r], sub: r => `${this.me.hand[r] - sel[r]} left` })}
            <div class="modal-actions"><button class="btn primary" data-act="ok" ${left === 0 ? '' : 'disabled'}>${left === 0 ? 'Discard' : `Select ${left} more`}</button></div>`;
        },
        on: {
          pick: (d, right) => {
            const delta = right ? -1 : Number(d.d);
            const r = d.r;
            const n = g.discardPending[me];
            if (delta > 0 && (sel[r] >= this.me.hand[r] || C.handTotal(sel) >= n)) return;
            sel[r] = Math.max(0, sel[r] + delta);
          },
          ok: () => {
            const cards = Object.assign({}, sel);
            this.dialog = null;
            this.drawDialog();
            if (!this.act({ type: 'discard', cards })) this.openDiscard();
          },
        },
      });
    }

    openSteal() {
      const g = this.game;
      this.openDialog({
        id: 'steal',
        title: 'Steal a card',
        draw: () => `<p>Choose a player to steal from:</p><div class="choice-list">${g.stealCandidates.map(pid => {
          const p = g.players[pid];
          return `<button class="btn choice" data-act="pick" data-p="${pid}" style="--c:${p.color}"><span class="dot"></span>${esc(p.name)} <small>${C.handTotal(p.hand)} cards</small></button>`;
        }).join('')}</div>`,
        on: {
          pick: d => {
            this.dialog = null;
            this.drawDialog();
            this.act({ type: 'steal', victim: Number(d.p) });
          },
        },
      });
    }

    openYearOfPlenty() {
      const g = this.game;
      const sel = C.emptyHand();
      this.openDialog({
        id: 'yop',
        title: `${DEV_INFO.yearOfPlenty.icon} Year of Plenty`,
        closable: true,
        draw: () => {
          const left = 2 - C.handTotal(sel);
          return `<p>Take any 2 resources from the bank.</p>
            ${this.resourcePicker(sel, { act: 'pick', max: r => g.bank[r], sub: r => `bank ${g.bank[r]}` })}
            <div class="modal-actions"><button class="btn primary" data-act="ok" ${left === 0 ? '' : 'disabled'}>${left === 0 ? 'Take resources' : `Select ${left} more`}</button></div>`;
        },
        on: {
          pick: (d, right) => {
            const delta = right ? -1 : Number(d.d);
            if (delta > 0 && (C.handTotal(sel) >= 2 || sel[d.r] >= g.bank[d.r])) return;
            sel[d.r] = Math.max(0, sel[d.r] + delta);
          },
          ok: () => {
            const resources = [];
            for (const r of R) for (let i = 0; i < sel[r]; i++) resources.push(r);
            this.closeDialog();
            this.act({ type: 'playYearOfPlenty', resources });
          },
        },
      });
    }

    openMonopoly() {
      this.openDialog({
        id: 'monopoly',
        title: `${DEV_INFO.monopoly.icon} Monopoly`,
        closable: true,
        draw: () => `<p>Choose a resource. Every other player must give you all of theirs.</p>
          <div class="picker">${R.map(r => `<div class="pick res-${r}"><button class="pick-card" data-act="pick" data-r="${r}"><span class="card-icon">${RES_INFO[r].icon}</span></button><div class="pick-sub">${RES_INFO[r].name}</div></div>`).join('')}</div>`,
        on: {
          pick: d => {
            this.closeDialog();
            this.act({ type: 'playMonopoly', resource: d.r });
          },
        },
      });
    }

    openTrade() {
      const g = this.game;
      const me = this.human;
      const give = C.emptyHand();
      const get = C.emptyHand();
      const st = { responses: null, waiting: false };
      const reset = () => { st.responses = null; };
      const bankValid = () => {
        let credits = 0;
        for (const r of R) {
          if (!give[r]) continue;
          if (get[r]) return false;
          const ratio = g.tradeRatio(me, r);
          if (give[r] % ratio) return false;
          credits += give[r] / ratio;
        }
        const want = C.handTotal(get);
        return want > 0 && want === credits && C.hasResources(g.bank, get);
      };
      this.openDialog({
        id: 'trade',
        title: 'Trade',
        closable: true,
        wide: true,
        draw: () => {
          const canOffer = C.handTotal(give) > 0 && C.handTotal(get) > 0 && R.every(r => !(give[r] && get[r]));
          let responses = '';
          if (st.waiting) responses = '<div class="responses"><em>Waiting for responses…</em></div>';
          else if (st.responses) {
            responses = `<div class="responses">${st.responses.map(rsp => {
              const p = g.players[rsp.pid];
              return `<div class="response" style="--c:${p.color}"><span class="dot"></span><b>${esc(p.name)}</b>${rsp.accept
                ? `<button class="btn small accept" data-act="accept" data-p="${rsp.pid}">✓ Accept trade</button>`
                : '<span class="declined">✗ Declined</span>'}</div>`;
            }).join('')}</div>`;
          }
          return `<div class="trade-row"><div class="trade-label">You give</div>
              ${this.resourcePicker(give, { act: 'give', max: r => this.me.hand[r], sub: r => `<span title="Your bank trade ratio">${g.tradeRatio(me, r)}:1</span> · have ${this.me.hand[r]}` })}</div>
            <div class="trade-row"><div class="trade-label">You get</div>
              ${this.resourcePicker(get, { act: 'get', sub: r => `bank ${g.bank[r]}` })}</div>
            <div class="modal-actions">
              <button class="btn" data-act="clear">Clear</button>
              <button class="btn" data-act="bank" ${bankValid() ? '' : 'disabled'} title="Trade with the bank using your best ratio">🏦 Trade with bank</button>
              <button class="btn primary" data-act="offer" ${canOffer && !st.waiting ? '' : 'disabled'}>👥 Offer to players</button>
            </div>${responses}`;
        },
        on: {
          give: (d, right) => {
            const delta = right ? -1 : Number(d.d);
            if (delta > 0 && give[d.r] >= this.me.hand[d.r]) return;
            give[d.r] = Math.max(0, give[d.r] + delta);
            if (delta > 0) get[d.r] = 0;
            reset();
          },
          get: (d, right) => {
            const delta = right ? -1 : Number(d.d);
            get[d.r] = Math.max(0, get[d.r] + delta);
            if (delta > 0) give[d.r] = 0;
            reset();
          },
          clear: () => { R.forEach(r => { give[r] = 0; get[r] = 0; }); reset(); },
          bank: () => {
            if (this.act({ type: 'bankTrade', give: Object.assign({}, give), get: Object.assign({}, get) })) {
              R.forEach(r => { give[r] = 0; get[r] = 0; });
              reset();
            }
          },
          offer: () => {
            st.waiting = true;
            const spec = this.dialog;
            const g2 = Object.assign({}, give);
            const w2 = Object.assign({}, get);
            this.controller.humanOffer(me, g2, w2).then(res => {
              st.waiting = false;
              if (this.dialog !== spec) return;
              st.responses = res;
              st.offer = { give: g2, get: w2 };
              this.drawDialog();
            });
          },
          accept: d => {
            const to = Number(d.p);
            if (this.act({ type: 'playerTrade', to, give: st.offer.give, get: st.offer.get })) {
              R.forEach(r => { give[r] = 0; get[r] = 0; });
              reset();
            }
          },
        },
      });
    }

    /** Asked by the controller when a bot offers a trade. Resolves to true/false. */
    askTradeOffer(fromPid, offer) {
      const g = this.game;
      const p = g.players[fromPid];
      return new Promise(resolve => {
        const prev = this.dialog;
        const finish = ok => {
          this.dialog = prev;
          this.drawDialog();
          resolve(ok);
        };
        this.openDialog({
          id: 'offer',
          title: 'Trade offer',
          draw: () => `<p><b style="color:${p.color}">${esc(p.name)}</b> wants to trade with you.</p>
            <div class="offer-box"><div><div class="trade-label">You get</div>${this.offerCards(offer.give)}</div><div class="offer-arrow">⇄</div><div><div class="trade-label">You give</div>${this.offerCards(offer.get)}</div></div>
            <div class="modal-actions"><button class="btn" data-act="no">✗ Decline</button><button class="btn primary" data-act="yes">✓ Accept</button></div>`,
          on: { yes: () => finish(true), no: () => finish(false) },
          onClose: () => resolve(false),
        });
      });
    }

    offerCards(h) {
      return `<div class="offer-cards">${R.filter(r => h[r]).map(r => `<div class="card res-${r}"><span class="card-icon">${RES_INFO[r].icon}</span><span class="card-name">${RES_INFO[r].name}</span><span class="card-count">${h[r]}</span></div>`).join('')}</div>`;
    }

    openGameOver() {
      const g = this.game;
      const w = g.players[g.winner];
      const rows = g.players
        .map(p => ({ p, vp: g.victoryPoints(p.id, true) }))
        .sort((a, b) => (b.p.id === g.winner) - (a.p.id === g.winner) || b.vp - a.vp)
        .map(({ p, vp }) => {
          const vpCards = p.devCards.filter(c => c.type === 'victoryPoint').length;
          const extras = [];
          if (g.longestRoadHolder === p.id) extras.push('🛣️');
          if (g.largestArmyHolder === p.id) extras.push('⚔️');
          if (vpCards) extras.push(`🏆×${vpCards}`);
          return `<tr style="--c:${p.color}"><td><span class="dot"></span>${esc(p.name)}</td><td>${5 - p.settlementsLeft}</td><td>${4 - p.citiesLeft}</td><td>${extras.join(' ')}</td><td class="vp-cell">${vp}</td></tr>`;
        }).join('');
      const max = Math.max(1, ...Object.values(g.diceStats));
      let bars = '';
      for (let s = 2; s <= 12; s++) {
        const n = g.diceStats[s];
        const expected = (6 - Math.abs(7 - s)) / 36 * g.rollCount;
        bars += `<div class="bar-col" title="${s}: rolled ${n} times (expected ${expected.toFixed(1)})"><div class="bar-n">${n}</div><div class="bar" style="height:${(n / max) * 100}%"></div><div class="bar-label">${s}</div></div>`;
      }
      this.openDialog({
        id: 'gameover',
        title: '🏆 Game over',
        closable: true,
        wide: true,
        draw: () => `<p class="winner-line">${g.winner === this.human ? 'You' : `<b style="color:${w.color}">${esc(w.name)}</b>`} won in ${g.turn} turns!</p>
          <table class="results"><thead><tr><th>Player</th><th>Settlements</th><th>Cities</th><th>Bonuses</th><th>VP</th></tr></thead><tbody>${rows}</tbody></table>
          <h4>Dice rolls</h4><div class="dice-chart">${bars}</div>
          <div class="modal-actions"><button class="btn" data-act="close">View board</button><button class="btn primary" data-act="again">New game</button></div>`,
        on: { again: () => C.newGame() },
      });
    }
  }

  C.UI = UI;
})(Catan);
