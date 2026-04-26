import { applyItem } from './items.js';

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
    document.getElementById('enemy-name').textContent    = this.monster.name;
    document.getElementById('enemy-sprite').textContent  = this.monster.emoji;
    document.getElementById('enemy-element').textContent = `${this.monster.element}属性`;
    document.getElementById('enemy-element').style.color = '#fff';

    const pct = Math.max(0, this.monster.hp / this.monster.maxHp) * 100;
    const bar = document.getElementById('enemy-hp-bar');
    bar.style.width      = pct + '%';
    bar.style.background = pct > 50 ? '#4caf50' : pct > 25 ? '#ffc107' : '#f44336';

    document.getElementById('enemy-stat-text').textContent =
      `HP ${this.monster.hp}/${this.monster.maxHp}  ATK ${this.monster.atk}  DEF ${this.monster.def}`;
    document.getElementById('enemy-rarity').textContent  = `[${this.monster.rarity}]`;
    document.getElementById('enemy-rarity').style.color  = this.monster.rarityColor;

    document.getElementById('player-hp').textContent =
      `HP: ${this.player.hp}/${this.player.maxHp}`;
  }

  // ── プレイヤーアクション ──

  attack() {
    if (this._busy) return;
    const dmg = this._calcDmg(this.player.atk, this.monster.def, 1.0);
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    this.log(`⚔️ こうげき！ ${dmg} ダメージ！`);
    this.updateUI();
    this._checkEnemyDead() || this._enemyTurn();
  }

  skill() {
    if (this._busy) return;
    const dmg = this._calcDmg(this.player.atk, this.monster.def, 2.0);
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    this.log(`✨ スキル！ ${dmg} の大ダメージ！`);
    this.updateUI();
    this._checkEnemyDead() || this._enemyTurn();
  }

  useItem(item) {
    if (this._busy) return;
    const { msg, consumed } = applyItem(item, this.player, this.monster);
    this.log(msg);
    this.updateUI();
    if (!consumed) return;

    if (this._checkEnemyDead()) return;
    this._enemyTurn();
  }

  run() {
    if (this._busy) return;
    if (this.monster.isBoss) {
      this.log('💢 ボスからは逃げられない！');
      this._enemyTurn();
      return;
    }
    if (Math.random() > 0.45) {
      this.log('💨 逃げ切った！');
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
      // スキルチャージ蓄積
      this.monster.skillCharge = (this.monster.skillCharge ?? 0) + 1;

      // 3ターンでスキル発動
      if (this.monster.skillCharge >= 3) {
        this.monster.skillCharge = 0;
        this._useEnemySkill();
      } else {
        this._enemyNormalAttack();
      }
    }, 550);
  }

  _enemyNormalAttack() {
    const dmg = this._calcDmg(this.monster.atk, this.player.def);
    this.player.hp = Math.max(0, this.player.hp - dmg);
    this.log(`💥 ${this.monster.name} の攻撃！ ${dmg} ダメージ！`);
    this.updateUI();
    this._checkPlayerDead();
  }

  _useEnemySkill() {
    const sk = this.monster.skill;
    if (!sk) { this._enemyNormalAttack(); return; }

    if (sk.healSelf > 0) {
      // 自己回復スキル（光属性）
      const heal = Math.floor(this.monster.maxHp * sk.healSelf);
      this.monster.hp = Math.min(this.monster.maxHp, this.monster.hp + heal);
      this.log(`🌟 ${this.monster.name} が「${sk.name}」を使った！ HPが${heal}回復！`);
      this.updateUI();
      this._busy = false;
    } else if (sk.poison) {
      // 毒スキル（闇属性）
      const dmg = this._calcDmg(this.monster.atk, this.player.def, sk.mult);
      this.player.hp = Math.max(0, this.player.hp - dmg);
      this.log(`☠️ ${this.monster.name} が「${sk.name}」を使った！ ${dmg} ダメージ＋毒！`);
      this.updateUI();
      this._checkPlayerDead();
    } else {
      // 攻撃スキル
      const dmg = this._calcDmg(this.monster.atk, this.player.def, sk.mult);
      this.player.hp = Math.max(0, this.player.hp - dmg);
      this.log(`🔥 ${this.monster.name} が「${sk.name}」を使った！ ${dmg} ダメージ！`);
      this.updateUI();
      this._checkPlayerDead();
    }
  }

  _checkPlayerDead() {
    if (this.player.hp > 0) { this._busy = false; return; }
    this.log('💀 倒れてしまった...');
    setTimeout(() => this.onEnd('lose'), 900);
  }
}
