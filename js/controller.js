/*
 * Drives bot players in the browser: whenever the game changes and a bot has
 * to act, it waits a moment (so the human can follow along) and performs the
 * bot's next action. Also brokers trade offers between players.
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const sleep = ms => new Promise(res => setTimeout(res, ms));

  class Controller {
    constructor(game, ui, opts) {
      this.game = game;
      this.ui = ui;
      this.delay = opts.delay;
      this.busy = false;
      this.timer = null;
      this.stopped = false;
      // Bots with brain === 'neural' are driven by the trained policy network.
      this.neural = {};
      for (const p of game.players) {
        if (p.brain === 'neural' && Controller.hasModel()) {
          this.neural[p.id] = { agent: new C.RL.PolicyAgent(Controller.model(), { greedy: true }), ctx: C.RL.newContext() };
        }
      }
      game.on(() => this.schedule());
    }

    static hasModel() { return !!(C.RL && C.RL.PolicyAgent && C.RL_MODEL); }

    static model() {
      if (!Controller.net) Controller.net = C.RL.importModel(C.RL_MODEL);
      return Controller.net;
    }

    botDiscard(pid) {
      const g = this.game;
      const nb = this.neural[pid];
      if (nb) return nb.agent.chooseDiscard(g, pid, g.discardPending[pid], nb.ctx);
      return C.AI.chooseDiscard(g, pid, g.discardPending[pid]);
    }

    /** Whether bot `pid` takes `from`'s offer of offer.give for offer.get. */
    botAccepts(pid, from, offer) {
      const nb = this.neural[pid];
      if (nb) return nb.agent.respond(this.game, pid, from, offer, nb.ctx);
      return C.AI.evaluateTrade(this.game, pid, from, offer.give, offer.get);
    }

    botDecide(pid) {
      const g = this.game;
      const nb = this.neural[pid];
      if (!nb) return C.AI.decide(g, pid);
      C.RL.syncTurn(nb.ctx, g);
      const action = nb.agent.decide(g, pid, nb.ctx);
      if (g.phase === 'main') nb.ctx.mainActions++;
      if (action.type === 'offer') C.RL.noteOffer(nb.ctx, C.RL.fromAction(g, pid, action));
      return action;
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
    }

    schedule() {
      if (this.stopped || this.busy || this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.tick();
      }, 0);
    }

    delayFor(phase) {
      if (phase === 'main') return this.delay * 0.8;
      if (phase === 'setupRoad' || phase === 'steal') return this.delay * 0.6;
      return this.delay;
    }

    async tick() {
      const g = this.game;
      if (this.stopped || g.phase === 'gameOver') return;
      this.busy = true;
      let acted = false;
      try {
        if (g.phase === 'discard') {
          for (const pid of g.pendingActors()) {
            if (!g.players[pid].isBot) continue;
            await sleep(this.delay * 0.5);
            if (this.stopped) return;
            g.perform(pid, { type: 'discard', cards: this.botDiscard(pid) });
            acted = true;
          }
          return;
        }
        const pid = g.current;
        if (!g.players[pid].isBot) return;
        await sleep(this.delayFor(g.phase));
        if (this.stopped || g.phase === 'gameOver') return;
        const action = this.botDecide(pid);
        acted = true;
        if (action.type === 'offer') {
          await this.botOffer(pid, action);
        } else {
          const res = g.perform(pid, action);
          if (!res.ok) {
            console.warn('Bot action rejected', action, res.error);
            if (g.phase === 'main') g.perform(pid, { type: 'endTurn' });
            else if (g.phase === 'preRoll') g.perform(pid, { type: 'rollDice' });
          }
        }
      } finally {
        this.busy = false;
        if (acted) this.schedule();
      }
    }

    /** A bot proposes a trade to everyone; the human is asked via a dialog. */
    async botOffer(pid, offer) {
      const g = this.game;
      g.addLog([{ p: pid }, ' wants to give ', ...C.logCards(offer.give), ' for ', ...C.logCards(offer.get)]);
      g.emit();
      const accepters = [];
      for (const o of g.players) {
        if (o.id === pid) continue;
        if (o.isBot) {
          if (this.botAccepts(o.id, pid, offer)) accepters.push(o.id);
        } else if (C.hasResources(o.hand, offer.get)) {
          if (await this.ui.askTradeOffer(pid, offer)) accepters.push(o.id);
        }
        if (this.stopped) return;
      }
      await sleep(this.delay * 0.5);
      if (!accepters.length) {
        g.addLog(['No one accepted the trade']);
        g.emit();
        return;
      }
      // Bots slightly prefer trading with other bots over the human.
      const humanIdx = accepters.findIndex(id => !g.players[id].isBot);
      const to = accepters.length > 1 && humanIdx >= 0 && g.rng() < 0.5
        ? accepters.filter(id => g.players[id].isBot)[0]
        : accepters[Math.floor(g.rng() * accepters.length)];
      g.perform(pid, { type: 'playerTrade', to, give: offer.give, get: offer.get });
    }

    /** The human (current player) offers a trade; returns each bot's answer. */
    async humanOffer(pid, give, get) {
      const g = this.game;
      g.addLog([{ p: pid }, ' wants to give ', ...C.logCards(give), ' for ', ...C.logCards(get)]);
      g.emit();
      await sleep(Math.min(600, this.delay));
      return g.players
        .filter(o => o.id !== pid)
        .map(o => ({ pid: o.id, accept: o.isBot && this.botAccepts(o.id, pid, { give, get }) }));
    }
  }

  C.Controller = Controller;
})(Catan);
