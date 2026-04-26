export class Battle {
  constructor(player, monster, onEnd) {
    this.player  = { ...player };
    this.monster = { ...monster };
    this.onEnd   = onEnd;
    this._log    = [];
    this._busy   = false;
  }

  log(msg) {
    this._log.push(msg);
    const el = document.getElementById('battle-log');
    if (!el) return;
    el.innerHTML = this._log.slice(-5).map(l => `<p>${l}</p>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  updateUI() {
    document.getElementById('enemy-name').textContent = this.monster.name;
    document.getElementById('enemy-sprite').textContent = this.monster.emoji;

    const pct = Math.max(0, this.monster.hp / this.monster.maxHp) * 100;
    const bar = document.getElementById('enemy-hp-bar');
    bar.style.width = pct + '%';
    bar.style.background = pct > 50 ? '#4caf50' : pct > 25 ? '#ffc107' : '#f44336';

    document.getElementById('enemy-stat-text').textContent =
      `HP ${this.monster.hp}/${this.monster.maxHp}  ATK ${this.monster.atk}  DEF ${this.monster.def}`;

    document.getElementById('player-hp').textContent =
      `HP: ${this.player.hp}/${this.player.maxHp}`;
  }

  // ── プレイヤーアクション ──

  attack() {
    if (this._busy) return;
    const dmg = this._calcDmg(this.player.atk, this.monster.def, 1.0);
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    this.log(`⚔️ ${dmg} のダメージ！`);
    this.updateUI();
    this._checkEnemyDead() || this._enemyTurn();
  }

  skill() {
    if (this._busy) return;
    const dmg = this._calcDmg(this.player.atk, this.monster.def, 1.9);
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    this.log(`✨ スキル！ ${dmg} の大ダメージ！`);
    this.updateUI();
    this._checkEnemyDead() || this._enemyTurn();
  }

  run() {
    if (this._busy) return;
    if (this.monster.isBoss) {
      this.log('💢 ボスからは逃げられない！');
      this._enemyTurn();
      return;
    }
    if (Math.random() > 0.45) {
      this.log('💨 うまく逃げ切った！');
      setTimeout(() => this.onEnd('run'), 400);
    } else {
      this.log('💨 逃げられなかった！');
      this._enemyTurn();
    }
  }

  // ── 内部 ──

  _calcDmg(atk, def, mult = 1) {
    const base = Math.max(1, atk - def);
    const roll = 1 + Math.floor(Math.random() * Math.ceil(base * 0.4));
    return Math.floor((base + roll) * mult);
  }

  _checkEnemyDead() {
    if (this.monster.hp > 0) return false;
    this.log(`✨ ${this.monster.name} を倒した！`);
    this._busy = true;
    setTimeout(() => this.onEnd('win', this.monster), 900);
    return true;
  }

  _enemyTurn() {
    this._busy = true;
    setTimeout(() => {
      const dmg = this._calcDmg(this.monster.atk, this.player.def);
      this.player.hp = Math.max(0, this.player.hp - dmg);
      this.log(`💥 ${this.monster.name} の攻撃！ ${dmg} ダメージ！`);
      this.updateUI();

      if (this.player.hp <= 0) {
        this.log('💀 倒れてしまった...');
        setTimeout(() => this.onEnd('lose'), 900);
      } else {
        this._busy = false;
      }
    }, 550);
  }
}
