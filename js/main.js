/* Start screen and game bootstrap. */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const COLORS = [
    { id: 'red', hex: '#e0393e' },
    { id: 'blue', hex: '#2f7ee6' },
    { id: 'orange', hex: '#f0891c' },
    { id: 'green', hex: '#2fa24f' },
  ];
  const BOT_NAMES = ['Ava', 'Bjorn', 'Chloe', 'Dmitri', 'Elena', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jasper', 'Kira', 'Leon', 'Mila', 'Nico', 'Olga', 'Pavel'];
  const SPEEDS = { slow: 1200, normal: 750, fast: 350, instant: 40 };

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('catan-prefs')) || {}; } catch (e) { return {}; }
  }

  function savePrefs(p) {
    try { localStorage.setItem('catan-prefs', JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
  }

  function init() {
    const form = document.getElementById('start-form');
    const picker = document.getElementById('color-pick');
    const prefs = loadPrefs();

    picker.innerHTML = COLORS.map(c =>
      `<label class="swatch" style="--c:${c.hex}" title="${c.id}"><input type="radio" name="color" value="${c.id}"><span></span></label>`
    ).join('');
    const setValue = (name, value) => {
      if (value === undefined) return;
      const el = form.elements[name];
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = value;
    };
    setValue('name', prefs.name);
    setValue('bots', prefs.bots);
    setValue('vp', prefs.vp);
    setValue('speed', prefs.speed);
    setValue('friendly', prefs.friendly);
    const colorInput = form.querySelector(`input[name=color][value="${prefs.color || 'red'}"]`) || form.querySelector('input[name=color]');
    colorInput.checked = true;

    form.addEventListener('submit', e => {
      e.preventDefault();
      const opts = {
        name: (form.elements.name.value || 'You').trim().slice(0, 16) || 'You',
        color: form.querySelector('input[name=color]:checked').value,
        bots: Number(form.elements.bots.value),
        vp: Number(form.elements.vp.value),
        speed: form.elements.speed.value,
        friendly: form.elements.friendly.checked,
      };
      savePrefs(opts);
      startGame(opts);
    });
  }

  function startGame(opts) {
    const mine = COLORS.find(c => c.id === opts.color);
    const others = C.shuffle(COLORS.filter(c => c !== mine));
    const names = C.shuffle(BOT_NAMES.slice());
    const seats = [{ name: opts.name, color: mine.hex, isBot: false }];
    for (let i = 0; i < opts.bots; i++) seats.push({ name: names[i], color: others[i].hex, isBot: true });
    // Random seating; the engine also picks a random first player.
    C.shuffle(seats);
    const human = seats.findIndex(s => !s.isBot);

    const game = new C.Game({ players: seats, vpToWin: opts.vp, friendlyRobber: opts.friendly });
    const ui = C.ui || (C.ui = new C.UI());
    const controller = new C.Controller(game, ui, { delay: SPEEDS[opts.speed] || SPEEDS.normal });

    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('game').classList.remove('hidden');
    ui.start(game, controller, human);
    controller.schedule();
    C.current = { game, ui, controller };
  }

  // Ends the current game and returns to the start screen.
  C.newGame = function () {
    if (C.current) C.current.controller.stop();
    C.current = null;
    if (C.ui) C.ui.closeDialog();
    document.getElementById('game').classList.add('hidden');
    document.getElementById('start-screen').classList.remove('hidden');
  };

  document.addEventListener('DOMContentLoaded', init);
})(Catan);
